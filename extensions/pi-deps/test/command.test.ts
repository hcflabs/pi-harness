import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import depsExtension from "../extensions/deps.ts";

function git(cwd: string, ...args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd }, (error) => (error ? reject(error) : resolve()));
	});
}

async function makeRepo(parent: string, name: string): Promise<string> {
	const root = join(parent, name);
	await mkdir(root, { recursive: true });
	await git(root, "init", "-q");
	return root;
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(() => true, () => false);
}

/** Run the real extension with a Git-backed `pi.exec`. `cwd` is the session directory. */
async function session(t: TestContext, cwd: string) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const notices: string[] = [];
	const widgets: string[][] = [];
	const statuses: (string | undefined)[] = [];
	const cleared = Promise.withResolvers<void>();
	depsExtension({
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
		exec: (program: string, args: string[], options: { cwd: string }) => new Promise((resolve) => {
			execFile(program, args, { cwd: options.cwd }, (error, stdout, stderr) => {
				resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, killed: false, stdout, stderr });
			});
		}),
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd,
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (_key: string, text: string | undefined) => {
				statuses.push(text);
				if (text === undefined) cleared.resolve();
			},
			setWidget: (_key: string, content: string[]) => widgets.push(content),
			notify: (message: string) => notices.push(message),
		},
	} as unknown as ExtensionCommandContext;
	t.after(() => handlers.get("session_shutdown")!({}, ctx));
	await handlers.get("session_start")!({}, ctx);
	return { notices, widgets, statuses, cleared: cleared.promise, run: (args: string) => command!(args, ctx) };
}

async function parentWithRepos(t: TestContext, names: string[]): Promise<{ parent: string; roots: string[] }> {
	const parent = await realpath(await mkdtemp(join(tmpdir(), "pi-deps-parent-")));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const roots = [];
	for (const name of names) roots.push(await makeRepo(parent, name));
	return { parent, roots };
}

test("/deps without an argument in a parent directory names the repo argument and lists repos", async (t) => {
	const { parent } = await parentWithRepos(t, ["app", "tools/cli"]);
	const run = await session(t, parent);
	await assert.rejects(run.run(""), (error: Error) => {
		assert.match(error.message, /\/deps <repo>/);
		assert.match(error.message, /not a Git repository/);
		assert.match(error.message, /app/);
		assert.match(error.message, /tools\/cli/);
		assert.doesNotMatch(error.message, /Cannot locate shared Git directory/);
		return true;
	});
});

test("/deps without an argument lists a bounded set of repos", async (t) => {
	const names = Array.from({ length: 14 }, (_, index) => `repo-${String(index).padStart(2, "0")}`);
	const { parent } = await parentWithRepos(t, names);
	const run = await session(t, parent);
	await assert.rejects(run.run(""), (error: Error) => {
		assert.match(error.message, /repo-00/);
		assert.match(error.message, /repo-09/);
		assert.doesNotMatch(error.message, /repo-10/);
		assert.match(error.message, /more repos/i);
		return true;
	});
});

test("/deps without an argument in an empty parent directory says that no repo was found", async (t) => {
	const { parent } = await parentWithRepos(t, []);
	const run = await session(t, parent);
	await assert.rejects(run.run(""), /\/deps <repo>.*No repo found/s);
});

test("/deps <repo> in a parent directory toggles the hook of that repo", async (t) => {
	const { parent, roots } = await parentWithRepos(t, ["app", "other"]);
	const run = await session(t, parent);
	const hook = join(roots[0]!, ".git", "hooks", "post-checkout");
	await run.run("app");
	assert.ok(await exists(hook));
	assert.equal(await exists(join(roots[1]!, ".git", "hooks", "post-checkout")), false);
	assert.match(run.notices.at(-1)!, /enabled/);
	await run.run(" app ");
	assert.equal(await exists(hook), false);
	assert.match(run.notices.at(-1)!, /disabled/);
});

test("/deps <repo> rejects a selector that is not a Repository target", async (t) => {
	const { parent } = await parentWithRepos(t, ["app"]);
	await mkdir(join(parent, "app", "src"));
	const run = await session(t, parent);
	await assert.rejects(run.run("../elsewhere"), /\.\./);
	await assert.rejects(run.run("missing"), /does not exist/);
	await assert.rejects(run.run("app/src"), /not a Git top-level directory/);
	assert.equal(await exists(join(parent, "app", ".git", "hooks", "post-checkout")), false);
});

test("/deps without an argument in a repo still toggles the hook of that repo", async (t) => {
	const { roots } = await parentWithRepos(t, ["app"]);
	const run = await session(t, roots[0]!);
	const hook = join(roots[0]!, ".git", "hooks", "post-checkout");
	await run.run("");
	assert.ok(await exists(hook));
	await run.run("");
	assert.equal(await exists(hook), false);
});

test("/deps without an argument in a subdirectory of a repo toggles the hook of that repo", async (t) => {
	const { roots } = await parentWithRepos(t, ["app"]);
	await mkdir(join(roots[0]!, "src"));
	const run = await session(t, join(roots[0]!, "src"));
	await run.run("");
	assert.ok(await exists(join(roots[0]!, ".git", "hooks", "post-checkout")));
});

test("a parent session watches the repo that /deps enabled", async (t) => {
	const { parent, roots } = await parentWithRepos(t, ["app"]);
	const stateDir = join(roots[0]!, ".git", "pi-deps");
	await mkdir(stateDir);
	await writeFile(join(stateDir, "status.json"), JSON.stringify({ state: "error", message: "pnpm exited 1" }));
	const run = await session(t, parent);
	assert.deepEqual(run.widgets, []); // nothing to watch before /deps selects a repo
	await run.run("app");
	await run.cleared;
	assert.match(run.widgets[0]![0]!, /install failed: pnpm exited 1/);
	assert.match(run.widgets[0]![1]!, /pi-deps\/install\.log$/);
});

test("a parent session does not watch a repo that /deps disabled", async (t) => {
	const { parent, roots } = await parentWithRepos(t, ["app"]);
	const run = await session(t, parent);
	await run.run("app"); // enable
	await delay(200); // the watcher finds no status and stops
	const stateDir = join(roots[0]!, ".git", "pi-deps");
	await mkdir(stateDir);
	await writeFile(join(stateDir, "status.json"), JSON.stringify({ state: "error", message: "late" }));
	await run.run("app"); // disable
	await delay(200);
	assert.deepEqual(run.widgets, []);
});
