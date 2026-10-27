import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import notesExtension, { parseNotes, renderNotesWidget } from "../extensions/notes.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;
type Identity = { repository: string; worktree: string; gitDir: string };

async function harness(t: TestContext) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-notes-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	const repository = join(agentDir, "repo.git");
	const first = join(agentDir, "first");
	const second = join(agentDir, "second");
	const firstGitDir = join(repository, "worktrees", "first");
	const secondGitDir = join(repository, "worktrees", "second");
	await Promise.all([first, second, firstGitDir, secondGitDir].map((path) => mkdir(path, { recursive: true })));
	const canonicalRepository = await realpath(repository);
	const identities = new Map<string, Identity>([
		[first, { repository: canonicalRepository, worktree: await realpath(first), gitDir: await realpath(firstGitDir) }],
		[second, { repository: canonicalRepository, worktree: await realpath(second), gitDir: await realpath(secondGitDir) }],
	]);
	const killed = new Set<string>();
	const handlers: Record<string, CommandHandler> = {};
	let sessionStart: ((event: unknown, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	const pi = {
		exec: async (_command: string, _args: string[], options: { cwd?: string }) => {
			const identity = options.cwd ? identities.get(options.cwd) : undefined;
			if (options.cwd && killed.has(options.cwd)) return { code: 1, killed: true, stdout: "", stderr: "" };
			return identity
				? { code: 0, killed: false, stdout: `${identity.worktree}\n${identity.repository}\n${identity.gitDir}\n`, stderr: "" }
				: { code: 128, killed: false, stdout: "", stderr: "kein Git-Repository" };
		},
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			if (event === "session_start") sessionStart = handler;
		},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			handlers[name] = options.handler;
		},
	} as unknown as ExtensionAPI;

	let widget: string[] | undefined;
	let notified: string | undefined;
	let select: ((options: string[]) => Promise<string | undefined>) | undefined;
	const context = (cwd: string) => ({
		cwd,
		mode: "tui",
		ui: {
			setWidget(_key: string, content: unknown) {
				widget = typeof content === "function"
					? (content as () => { render(width: number): string[] })().render(80)
					: content as string[] | undefined;
			},
			notify(message: string) { notified = message; },
			select(_title: string, options: string[]) { return select ? select(options) : Promise.resolve(undefined); },
		},
	}) as unknown as ExtensionContext;

	notesExtension(pi);
	return {
		agentDir,
		first,
		second,
		firstGitDir,
		identities,
		killed,
		handlers,
		context,
		runSessionStart: (ctx: ExtensionContext) => sessionStart!({}, ctx),
		widget: () => widget,
		notified: () => notified,
		resetNotification: () => { notified = undefined; },
		pickWith: (fn: (options: string[]) => Promise<string | undefined>) => { select = fn; },
	};
}

test("parseNotes validates safe worktree records", () => {
	const valid = {
		repository: "/repo/.git",
		worktree: "/repo",
		gitDir: "/repo/.git/worktrees/current",
		generation: "1:2:3",
		notes: [" a ", "b"],
	};
	assert.deepEqual(parseNotes(JSON.stringify(valid)), { ...valid, notes: ["a", "b"] });
	assert.throws(() => parseNotes(JSON.stringify({ ...valid, notes: ["a", "b", "c", "d", "e"] })), TypeError);
	assert.throws(() => parseNotes(JSON.stringify({ ...valid, repository: "relative" })), TypeError);
	assert.throws(() => parseNotes(JSON.stringify({ ...valid, notes: ["  "] })), TypeError);
	assert.throws(() => parseNotes(JSON.stringify({ ...valid, notes: ["safe", "\u001b]52;c;payload\u0007"] })), TypeError);
	assert.throws(() => parseNotes('{broken'), SyntaxError);
});

test("widget limits each note to two lines", () => {
	assert.deepEqual(
		renderNotesWidget(["short", "alpha beta gamma delta"], 12),
		["1. short", "2. alpha", "beta gamma…"],
	);
});

test("notes persist independently per worktree without creating config on startup", async (t) => {
	const h = await harness(t);
	const firstCtx = h.context(h.first);
	const secondCtx = h.context(h.second);
	await h.runSessionStart(firstCtx);
	assert.equal(h.widget(), undefined);
	await assert.rejects(readdir(join(h.agentDir, "config", "pi-notes")), { code: "ENOENT" });

	await h.handlers.note!("\u001b[2J", firstCtx);
	assert.match(h.notified()!, /control characters/i);
	await assert.rejects(readdir(join(h.agentDir, "config", "pi-notes")), { code: "ENOENT" });

	await h.handlers.note!("first note", firstCtx);
	await h.runSessionStart(secondCtx);
	assert.equal(h.widget(), undefined);
	await h.handlers.note!("second note", secondCtx);
	assert.equal((await readdir(join(h.agentDir, "config", "pi-notes"))).filter((name) => name.endsWith(".json")).length, 2);

	await h.runSessionStart(firstCtx);
	assert.deepEqual(h.widget(), ["1. first note"]);
	await h.runSessionStart(secondCtx);
	assert.deepEqual(h.widget(), ["1. second note"]);
});

test("recreated worktree at same path does not inherit old notes", async (t) => {
	const h = await harness(t);
	const ctx = h.context(h.first);
	await h.handlers.note!("old generation", ctx);
	await rm(h.firstGitDir, { recursive: true });
	await mkdir(h.firstGitDir, { recursive: true });

	await h.runSessionStart(ctx);
	assert.equal(h.widget(), undefined);
});

test("duplicate removal and stale selections preserve correct worktree notes", async (t) => {
	const h = await harness(t);
	const ctx = h.context(h.first);
	for (const note of ["todo", "middle", "todo"]) await h.handlers.note!(note, ctx);
	const dir = join(h.agentDir, "config", "pi-notes");
	const path = join(dir, (await readdir(dir)).find((name) => name.endsWith(".json"))!);

	h.pickWith(async (options) => options[2]);
	await h.handlers["note-rm"]!("", ctx);
	assert.deepEqual(parseNotes(await readFile(path, "utf8")).notes, ["todo", "middle"]);

	h.pickWith(async (options) => {
		const record = parseNotes(await readFile(path, "utf8"));
		await writeFile(path, JSON.stringify({ ...record, notes: ["middle", "replacement"] }));
		return options[1];
	});
	h.resetNotification();
	await h.handlers["note-rm"]!("", ctx);
	assert.match(h.notified()!, /changed elsewhere/i);
	assert.deepEqual(parseNotes(await readFile(path, "utf8")).notes, ["middle", "replacement"]);
});

test("startup and mutations prune stale records, preserve malformed files, and clear current notes", async (t) => {
	const h = await harness(t);
	const firstCtx = h.context(h.first);
	await h.handlers.note!("keep", firstCtx);
	await h.handlers.note!("stale", h.context(h.second));
	const dir = join(h.agentDir, "config", "pi-notes");
	const records = await Promise.all((await readdir(dir)).filter((name) => name.endsWith(".json")).map(async (name) => ({
		path: join(dir, name),
		record: parseNotes(await readFile(join(dir, name), "utf8")),
	})));
	const stalePath = records.find(({ record }) => record.worktree === h.identities.get(h.second)!.worktree)!.path;
	const staleRecord = await readFile(stalePath, "utf8");
	const malformedPath = join(dir, "malformed.json");
	await writeFile(malformedPath, "{broken user data");

	h.identities.delete(h.second);
	await h.runSessionStart(firstCtx);
	assert.equal((await readdir(dir)).filter((name) => name.endsWith(".json")).length, 3);

	await rm(h.second, { recursive: true });
	await h.runSessionStart(firstCtx);
	assert.equal((await readdir(dir)).filter((name) => name.endsWith(".json")).length, 2);
	assert.equal(await readFile(malformedPath, "utf8"), "{broken user data");

	await writeFile(stalePath, staleRecord);
	await h.handlers.note!("mutation prunes", firstCtx);
	await assert.rejects(readFile(stalePath, "utf8"), { code: "ENOENT" });
	assert.equal(await readFile(malformedPath, "utf8"), "{broken user data");

	const currentPath = join(dir, (await readdir(dir)).find((name) => name.endsWith(".json") && name !== "malformed.json")!);
	await writeFile(currentPath, staleRecord);
	await h.runSessionStart(firstCtx);
	assert.deepEqual(h.widget(), ["Worktree notes belong to an old worktree; run /note-clear to reset."]);
	await writeFile(currentPath, "{broken current data");
	await h.runSessionStart(firstCtx);
	assert.match(h.widget()![0]!, /malformed/i);
	h.resetNotification();
	await h.handlers.note!("blocked", firstCtx);
	assert.match(h.notified()!, /malformed/i);
	assert.equal(await readFile(currentPath, "utf8"), "{broken current data");

	await h.handlers["note-clear"]!("", firstCtx);
	assert.equal(h.widget(), undefined);
	await assert.rejects(readFile(currentPath, "utf8"), { code: "ENOENT" });
	assert.equal(await readFile(malformedPath, "utf8"), "{broken user data");
});

const notesDir = (agentDir: string) => join(agentDir, "config", "pi-notes");
const noteFiles = async (agentDir: string) => (await readdir(notesDir(agentDir)).catch(() => [])).filter((name) => name.endsWith(".json"));

test("outside a Git repository, notes use the real path of cwd as key", async (t) => {
	const h = await harness(t);
	const plain = join(h.agentDir, "plain");
	const link = join(h.agentDir, "link");
	await mkdir(plain);
	await symlink(plain, link);
	const real = await realpath(plain);
	const ctx = h.context(link);

	await h.runSessionStart(ctx);
	assert.equal(h.widget(), undefined);
	assert.equal(h.notified(), undefined);
	await h.handlers.note!("parent note", ctx);
	assert.equal(h.notified(), undefined);
	assert.deepEqual(h.widget(), ["1. parent note"]);
	const expected = `${createHash("sha256").update(real).digest("hex")}.json`;
	assert.deepEqual(await noteFiles(h.agentDir), [expected]);
	const record = parseNotes(await readFile(join(notesDir(h.agentDir), expected), "utf8"));
	assert.equal(record.worktree, real);

	await h.runSessionStart(h.context(plain));
	assert.deepEqual(h.widget(), ["1. parent note"]);
	const sibling = join(h.agentDir, "sibling");
	await mkdir(sibling);
	await h.runSessionStart(h.context(sibling));
	assert.equal(h.widget(), undefined);

	h.pickWith(async (options) => options[0]);
	await h.handlers["note-rm"]!("", ctx);
	assert.equal(h.notified(), undefined);
	assert.equal(h.widget(), undefined);
	await h.handlers.note!("again", ctx);
	await h.handlers["note-clear"]!("", ctx);
	assert.equal(h.notified(), undefined);
	assert.equal(h.widget(), undefined);
	assert.deepEqual(await noteFiles(h.agentDir), []);
});

test("startup removes notes of a deleted directory and keeps notes of an existing directory", async (t) => {
	const h = await harness(t);
	const kept = join(h.agentDir, "kept");
	const gone = join(h.agentDir, "gone");
	await Promise.all([mkdir(kept), mkdir(gone)]);
	await h.handlers.note!("kept", h.context(kept));
	await h.handlers.note!("gone", h.context(gone));
	assert.equal((await noteFiles(h.agentDir)).length, 2);
	await rm(gone, { recursive: true });
	await h.runSessionStart(h.context(kept));
	assert.equal((await noteFiles(h.agentDir)).length, 1);
	assert.deepEqual(h.widget(), ["1. kept"]);
});

test("a directory that becomes a repository keeps its notes file until /note-clear", async (t) => {
	const h = await harness(t);
	const dir = join(h.agentDir, "later-repo");
	const gitDir = join(dir, ".git");
	await mkdir(dir);
	const ctx = h.context(dir);
	await h.handlers.note!("before git init", ctx);
	await mkdir(gitDir);
	h.identities.set(dir, { repository: await realpath(gitDir), worktree: await realpath(dir), gitDir: await realpath(gitDir) });
	await h.runSessionStart(ctx);
	assert.equal((await noteFiles(h.agentDir)).length, 1);
	assert.match(h.widget()![0]!, /old worktree/);
	await h.handlers["note-clear"]!("", ctx);
	assert.equal(h.widget(), undefined);
	assert.deepEqual(await noteFiles(h.agentDir), []);
});

test("other Git failures stay errors and write nothing", async (t) => {
	const h = await harness(t);
	const killedDir = join(h.agentDir, "killed");
	const brokenDir = join(h.agentDir, "broken");
	const missingGitDir = join(h.agentDir, "missing-git");
	await Promise.all([killedDir, brokenDir, missingGitDir].map((path) => mkdir(path)));
	// A .git file with invalid content makes Git fail although the directory has a repository marker.
	await writeFile(join(brokenDir, ".git"), "not a gitfile\n");
	h.killed.add(killedDir);

	const check = async (dir: string) => {
		const ctx = h.context(dir);
		h.resetNotification();
		await h.runSessionStart(ctx);
		assert.equal(h.widget(), undefined);
		await h.handlers.note!("must fail", ctx);
		assert.ok(h.notified(), `/note in ${dir} must report an error`);
		h.resetNotification();
		await h.handlers["note-clear"]!("", ctx);
		assert.ok(h.notified(), `/note-clear in ${dir} must report an error`);
		h.resetNotification();
		await h.handlers["note-rm"]!("", ctx);
		assert.ok(h.notified(), `/note-rm in ${dir} must report an error`);
		assert.deepEqual(await noteFiles(h.agentDir), []);
	};
	await check(killedDir);
	await check(brokenDir);

	const previousPath = process.env.PATH;
	process.env.PATH = join(h.agentDir, "no-such-bin");
	t.after(() => { process.env.PATH = previousPath; });
	await check(missingGitDir);
});
