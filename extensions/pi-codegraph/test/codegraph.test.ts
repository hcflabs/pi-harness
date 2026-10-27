import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import codegraphExtension from "../extensions/codegraph.ts";
import { readDiagnostics } from "@hcflabs/pi-config-store";

const exec = promisify(execFile);

async function fixture(t: TestContext) {
	const base = await realpath(await mkdtemp(join(tmpdir(), "pi-codegraph-test-")));
	t.after(() => rm(base, { recursive: true, force: true }));
	const primary = join(base, "primary with spaces");
	const worktree = join(base, "worktree with spaces");
	await mkdir(primary);
	await exec("git", ["init", "-q", primary]);
	await exec("git", ["-C", primary, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "initial"]);
	await exec("git", ["-C", primary, "worktree", "add", "-qb", "worker", worktree]);
	const { stdout } = await exec("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"]);
	return { base, primary, worktree, lock: join(stdout.trim(), "pi-codegraph-init.lock") };
}

async function index(root: string) {
	await mkdir(join(root, ".codegraph"), { recursive: true });
	await writeFile(join(root, ".codegraph", "codegraph.db"), "index");
}

function harness(cwd: string, options: {
	hasUI?: boolean;
	mode?: "tui" | "rpc";
	version?: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	init?: (signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;
	gitProbe?: (args: string[], signal?: AbortSignal) => Promise<Awaited<ReturnType<ExtensionAPI["exec"]>> | undefined>;
	explore?: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	onStatus?: (text: string | undefined) => void;
	confirm?: boolean | ((signal?: AbortSignal) => Promise<boolean>);
	reindexRecommended?: boolean;
	status?: Awaited<ReturnType<ExtensionAPI["exec"]>>;
} = {}) {
	let start!: (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
	let shutdown!: typeof start;
	const notices: { message: string; level: string }[] = [];
	const calls: { command: string; args: string[]; cwd: string; timeout?: number }[] = [];
	const servers = new Map<string, unknown>();
	const prompts: string[] = [];
	let tool!: ToolDefinition;
	const pi = {
		registerCommand: () => {},
		registerMcpServer: (name: string, config: unknown) => servers.set(name, config),
		unregisterMcpServer: (name: string) => servers.delete(name),
		on: (name: string, handler: typeof start) => {
			if (name === "session_start") start = handler;
			else if (name === "session_shutdown") shutdown = handler;
		},
		registerTool: (definition: ToolDefinition) => { tool = definition; },
		exec: async (command: string, args: string[], opts: { cwd: string; timeout?: number; signal?: AbortSignal }) => {
			calls.push({ command, args, cwd: opts.cwd, ...(args[0] === "explore" && { timeout: opts.timeout }) });
			if (command === "codegraph") {
				if (args[0] === "--version") return options.version ?? { code: 0, stdout: "1.6.0", stderr: "", killed: false };
				if (args[0] === "explore") return options.explore ?? { code: 0, stdout: "explored", stderr: "", killed: false };
				if (args[0] === "status") {
					if (options.status) return options.status;
					const index = { state: "complete", reindexRecommended: options.reindexRecommended ?? false };
					return { code: 0, stdout: JSON.stringify({ index }), stderr: "", killed: false };
				}
				if (options.init) return options.init(opts.signal);
				if (args[0] === "init") await index(opts.cwd);
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			if (command === "git" && options.gitProbe) {
				const result = await options.gitProbe(args, opts.signal);
				if (result) return result;
			}
			try {
				const result = await exec(command, args, { cwd: opts.cwd, signal: opts.signal });
				return { ...result, code: 0, killed: false };
			} catch (error) {
				return error;
			}
		},
	} as unknown as ExtensionAPI;
	const statuses: (string | undefined)[] = [];
	const ctx = {
		cwd,
		mode: options.mode ?? "rpc",
		hasUI: options.hasUI ?? true,
		ui: {
			theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
			notify: (message: string, level: string) => notices.push({ message, level }),
			confirm: async (title: string, _message: string, opts?: { signal?: AbortSignal }) => {
				prompts.push(title);
				return typeof options.confirm === "function" ? options.confirm(opts?.signal) : options.confirm ?? false;
			},
			setStatus: (_key: string, text: string | undefined) => { statuses.push(text); options.onStatus?.(text); },
		},
	} as unknown as ExtensionContext;
	codegraphExtension(pi);
	const explore = (params: Record<string, unknown>) => tool.execute("call", params, undefined, undefined, ctx as never);
	return { start: () => start({}, ctx), shutdown: (reason = "quit") => shutdown({ reason }, ctx), explore, tool, notices, calls, statuses, servers, prompts };
}

test("initializes an opted-in linked worktree at its root once, including nested launches", async (t) => {
	const { primary, worktree, lock } = await fixture(t);
	await index(primary);
	const nested = join(worktree, "src");
	await mkdir(nested);
	const run = harness(nested);
	await run.start();
	await run.start();
	assert.deepEqual(run.calls.filter(({ command, args }) => command === "codegraph" && args[0] === "init"), [
		{ command: "codegraph", args: ["init", "--yes", worktree], cwd: worktree },
	]);
	assert.ok(run.statuses.some((text) => text?.includes("CG · indexing")));
	assert.equal(run.statuses.at(-1), "<success>✓</success> CG");
	assert.deepEqual(run.servers.get("pi-codegraph"), { command: "codegraph", args: ["serve", "--mcp", "--path", worktree], cwd: worktree, exposure: "hidden" });
	await assert.rejects(rmdir(lock), { code: "ENOENT" });
});

test("offers one time to index the primary checkout, then seeds the worktree from it", async (t) => {
	const declined = await fixture(t);
	// Non-TUI modes await setup during session_start, so a dialog there could never be answered.
	const headless = harness(declined.worktree, { confirm: true });
	await headless.start();
	assert.deepEqual(headless.prompts, []);
	const no = harness(declined.worktree, { mode: "tui" });
	no.start();
	await no.shutdown("new");
	no.start();
	await no.shutdown("new");
	assert.equal(no.prompts.length, 1);
	assert.equal(no.calls.some(({ args }) => args[0] === "init"), false);
	assert.equal(no.statuses.at(-1), "<dim>○</dim> CG");
	assert.equal(no.servers.size, 0);
	const { primary, worktree } = await fixture(t);
	const yes = harness(worktree, { mode: "tui", confirm: true });
	yes.start();
	await yes.shutdown("new");
	assert.deepEqual(yes.calls.filter(({ command }) => command === "codegraph").map(({ args }) => args.join(" ")), ["--version", `init --yes ${primary}`, `init --yes ${worktree}`]);
	assert.equal(yes.statuses.at(-1), "<success>✓</success> CG");
});

test("a dismissed prompt is not a decline, and a failed primary init keeps the primary lock", async (t) => {
	const { primary, worktree, lock: worktreeLock } = await fixture(t);
	const asked = Promise.withResolvers<void>();
	const dismissed = harness(worktree, { mode: "tui", confirm: (signal) => {
		asked.resolve();
		return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(false), { once: true }));
	} });
	dismissed.start();
	await asked.promise;
	// An open dialog holds no lock: other sessions proceed, and a killed Pi leaves nothing stale.
	await assert.rejects(stat(worktreeLock), { code: "ENOENT" });
	await dismissed.shutdown();
	await assert.rejects(stat(join(primary, ".git", "pi-codegraph-declined")), { code: "ENOENT" });
	const failed = harness(worktree, { mode: "tui", confirm: true, init: async () => {
		await index(primary);
		return { code: 1, stdout: "", stderr: "primary init failed", killed: false };
	} });
	failed.start();
	await failed.shutdown("new");
	const lock = join(primary, ".git", "pi-codegraph-init.lock");
	assert.ok(failed.notices[0]!.message.includes(lock));
	await rmdir(lock);
});

test("does not offer to index a bare repository", async (t) => {
	const { base, primary } = await fixture(t);
	const bare = join(base, "bare.git");
	const worktree = join(base, "bare-worktree");
	await exec("git", ["clone", "-q", "--bare", primary, bare]);
	await exec("git", ["-C", bare, "worktree", "add", "-q", "--detach", worktree]);
	const run = harness(worktree, { mode: "tui", confirm: true });
	run.start();
	await run.shutdown("new");
	assert.deepEqual(run.prompts, []);
	assert.equal(run.calls.some(({ args }) => args[0] === "init"), false);
});

test("seeds from the closest usable index, then syncs", async (t) => {
	const scenarios = [
		{ built: "1.6.0", calls: ["status", "sync"], seed: "closest" },
		{ built: "1.5.0", calls: ["init"] },
		// A CodeGraph writer holds the closest index, so its snapshot could fall inside a sync.
		{ built: "1.6.0", busy: true, calls: ["status", "sync"], seed: "older" },
		// CodeGraph reports that its current extraction engine would rebuild the copied index.
		{ built: "1.6.0", reindexRecommended: true, calls: ["status", "status", "init"] },
		// Different extension mappings change how unchanged files parse, which sync does not redo.
		{ built: "1.6.0", config: true, calls: ["init"] },
	];
	for (const { built, busy, reindexRecommended, config, calls, seed } of scenarios) {
		const { base, primary, worktree } = await fixture(t);
		const old = (await exec("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
		await writeFile(join(worktree, "a.ts"), "export const a = 1;\n");
		await exec("git", ["-C", worktree, "add", "a.ts"]);
		await exec("git", ["-C", worktree, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "a"]);
		const head = (await exec("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
		const other = join(base, "other");
		await exec("git", ["-C", primary, "worktree", "add", "-q", "--detach", other, "worker"]);
		for (const [root, sha] of [[primary, old], [other, head]]) {
			await mkdir(join(root, ".codegraph"));
			const db = new DatabaseSync(join(root, ".codegraph", "codegraph.db"));
			db.exec(`CREATE TABLE project_metadata (key TEXT PRIMARY KEY, value TEXT);
				INSERT INTO project_metadata VALUES ('index_state', 'complete'), ('indexed_with_version', '${built}'), ('indexed_at_commit', '${sha}');`);
			db.close();
		}
		const writerLock = join(other, ".codegraph", "codegraph.lock");
		if (busy) await writeFile(writerLock, "1");
		if (config) await writeFile(join(worktree, "codegraph.json"), '{"extensions":{".tpl":"html"}}');
		const run = harness(worktree, { reindexRecommended });
		await run.start();
		assert.deepEqual(run.calls.filter(({ args }) => args.includes(worktree)).map(({ args }) => args[0]), calls);
		assert.equal(run.statuses.at(-1), "<success>✓</success> CG");
		// Only the writer that took a lock releases it.
		if (busy) await stat(writerLock);
		else await assert.rejects(stat(writerLock), { code: "ENOENT" });
		if (!seed) continue;
		const seeded = new DatabaseSync(join(worktree, ".codegraph", "codegraph.db"), { readOnly: true });
		assert.equal(seeded.prepare("SELECT value FROM project_metadata WHERE key = 'indexed_at_commit'").get()?.value, seed === "closest" ? head : old);
		seeded.close();
	}
});

test("seed failures record one warning before init without a notification or console output", async (t) => {
	const stderr = t.mock.method(process.stderr, "write", () => true);
	const warn = t.mock.method(console, "warn", () => {});
	const error = t.mock.method(console, "error", () => {});
	const log = t.mock.method(console, "log", () => {});
	for (const failure of ["no candidate", "lock", "copy", "status JSON", "status rejected"]) {
		const { primary, worktree } = await fixture(t);
		await mkdir(join(primary, ".codegraph"));
		const source = join(primary, ".codegraph", "codegraph.db");
		const head = (await exec("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
		const db = new DatabaseSync(source);
		db.exec(`CREATE TABLE project_metadata (key TEXT PRIMARY KEY, value TEXT);
			INSERT INTO project_metadata VALUES ('index_state', 'complete'), ('indexed_with_version', '${failure === "no candidate" ? "old" : "1.6.0"}'), ('indexed_at_commit', '${head}');`);
		db.close();
		if (failure === "lock") await writeFile(join(primary, ".codegraph", "codegraph.lock"), "1");
		const before = readDiagnostics().length;
		const run = harness(worktree, {
			status: failure === "status JSON" ? { code: 0, stdout: "{", stderr: "", killed: false } : undefined,
			reindexRecommended: failure === "status rejected",
			gitProbe: async (args) => {
				if (failure === "copy" && args[0] === "diff") await writeFile(source, "not a database");
				return undefined;
			},
		});
		await run.start();
		assert.equal(readDiagnostics().length, before + 1, failure);
		const event = readDiagnostics().at(-1)!;
		assert.equal(event.source, "pi-codegraph");
		assert.equal(event.level, "warning");
		assert.match(event.message, /^Seed failed: .+ CodeGraph will run init\.$/);
		assert.deepEqual(run.notices, []);
		assert.ok(run.calls.some(({ args }) => args[0] === "init"));
	}
	assert.equal(stderr.mock.callCount() + warn.mock.callCount() + error.mock.callCount() + log.mock.callCount(), 0);
});

test("never passes indexed metadata to Git as an option", async (t) => {
	const { base, primary, worktree } = await fixture(t);
	const output = join(base, "overwritten");
	await mkdir(join(primary, ".codegraph"));
	const db = new DatabaseSync(join(primary, ".codegraph", "codegraph.db"));
	db.exec(`CREATE TABLE project_metadata (key TEXT PRIMARY KEY, value TEXT);
		INSERT INTO project_metadata VALUES ('index_state', 'complete'), ('indexed_with_version', '1.6.0'), ('indexed_at_commit', '--output=${output}');`);
	db.close();
	const run = harness(worktree);
	await run.start();
	assert.equal(run.calls.some(({ command, args }) => command === "git" && args[0] === "diff"), false);
	await assert.rejects(stat(output), { code: "ENOENT" });
	assert.equal(run.statuses.at(-1), "<success>✓</success> CG");
});

test("a failed setup stops watching the checkout of an earlier session", async (t) => {
	const { worktree } = await fixture(t);
	await index(worktree);
	let fail = false;
	const run = harness(worktree, { gitProbe: async (args) => fail && args.includes("--absolute-git-dir") ? { code: 1, stdout: "", stderr: "boom", killed: false } : undefined });
	await run.start();
	assert.equal(run.servers.size, 1);
	fail = true;
	await run.start();
	assert.match(run.notices[0]!.message, /boom/);
	assert.equal(run.servers.size, 0);
});

test("TUI indexing survives session replacement and replaces its dim animation with an indexed badge", async (t) => {
	const { primary, worktree, lock } = await fixture(t);
	await index(primary);
	t.mock.timers.enable({ apis: ["Date", "setInterval"] });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const cleared = Promise.withResolvers<void>();
	let indexing = false;
	let initSignal: AbortSignal | undefined;
	const run = harness(worktree, {
		mode: "tui",
		onStatus: (text) => {
			if (text?.includes("indexing")) indexing = true;
			else if (indexing && text === undefined) cleared.resolve();
		},
		init: async (signal) => {
			initSignal = signal;
			entered.resolve();
			await release.promise;
			await index(worktree);
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
	});
	t.after(() => run.shutdown());
	assert.equal(run.start(), undefined);
	await entered.promise;
	assert.equal(run.statuses.at(-1), "<dim>⠋ CG · indexing 0s</dim>");
	t.mock.timers.tick(100);
	assert.equal(run.statuses.at(-1), "<dim>⠙ CG · indexing 0s</dim>");
	t.mock.timers.tick(1100);
	assert.match(run.statuses.at(-1)!, /indexing 1s/);
	assert.equal(run.start(), undefined); // Repeated starts reuse this initializer.
	let replaced = false;
	const replacement = Promise.resolve(run.shutdown("new")).then(() => { replaced = true; });
	await setImmediate();
	assert.equal(replaced, false);
	assert.equal(initSignal?.aborted, false);
	assert.equal(run.calls.filter(({ args }) => args[0] === "init").length, 1);
	release.resolve();
	await replacement;
	await cleared.promise;
	assert.equal(run.statuses.at(-1), "<success>✓</success> CG");
	await assert.rejects(rmdir(lock), { code: "ENOENT" });
	await setImmediate();
	const count = run.statuses.length;
	t.mock.timers.tick(1000);
	assert.equal(run.statuses.length, count);
	assert.deepEqual(run.notices, []);
});

test("shutdown stops a waiting TUI spinner without removing another initializer's lock", async (t) => {
	const { primary, worktree, lock } = await fixture(t);
	await index(primary);
	await mkdir(lock);
	t.mock.timers.enable({ apis: ["Date", "setInterval"] });
	const waiting = Promise.withResolvers<void>();
	const run = harness(worktree, { mode: "tui", onStatus: (text) => {
		if (text?.includes("waiting for index")) waiting.resolve();
	} });
	run.start();
	await waiting.promise;
	await run.shutdown();
	await setImmediate();
	assert.equal(run.statuses.at(-1), undefined);
	const count = run.statuses.length;
	t.mock.timers.tick(1000);
	assert.equal(run.statuses.length, count);
	assert.deepEqual(run.notices, []);
	await rmdir(lock);
});

test("shutdown cancels every Git probe without starting more setup work", async (t) => {
	const { primary, worktree, lock } = await fixture(t);
	await index(primary);
	for (const probe of ["--show-toplevel", "--absolute-git-dir", "list"]) {
		const entered = Promise.withResolvers<void>();
		const run = harness(worktree, { mode: "tui", gitProbe: async (args, signal) => {
			if (!args.includes(probe)) return;
			assert.ok(signal);
			entered.resolve();
			return new Promise((resolve) => signal.addEventListener("abort", () => {
				resolve({ code: 0, stdout: "", stderr: "", killed: true });
			}, { once: true }));
		} });
		run.start();
		await entered.promise;
		const count = run.calls.length;
		await run.shutdown();
		assert.equal(run.calls.length, count);
		assert.deepEqual(run.notices, []);
		await assert.rejects(rmdir(lock), { code: "ENOENT" });
	}
});

test("does not index non-Git directories, unopted repositories, or existing indexes", async (t) => {
	const { base, primary, worktree, lock } = await fixture(t);
	for (const cwd of [base, primary, worktree]) {
		const run = harness(cwd);
		await run.start();
		assert.equal(run.calls.some(({ command, args }) => command === "codegraph" && args[0] === "init"), false);
		// A non-Git directory gets one short notice and no badge.
		assert.deepEqual(run.notices.map(({ level }) => level), cwd === base ? ["info"] : []);
		assert.equal(run.statuses.at(-1), cwd === base ? undefined : "<dim>○</dim> CG");
	}
	await index(worktree);
	const existing = harness(worktree);
	await existing.start();
	assert.equal(existing.calls.some(({ command, args }) => command === "codegraph" && args[0] === "init"), false);
	assert.deepEqual(existing.notices, []);
	assert.equal(existing.statuses.at(-1), "<success>✓</success> CG");
	await assert.rejects(rmdir(lock), { code: "ENOENT" });
});

test("warns with the install command when the CLI is unavailable without creating a lock", async (t) => {
	const { worktree, lock } = await fixture(t);
	// Even an existing index still needs a working CLI for codegraph_explore.
	await index(worktree);
	const options = { version: { code: 1, stdout: "", stderr: "", killed: false } };
	const warn = t.mock.method(console, "warn", () => {});
	const error = t.mock.method(console, "error", () => {});
	const log = t.mock.method(console, "log", () => {});
	const stderr = t.mock.method(process.stderr, "write", () => true);
	const run = harness(worktree, options);
	await run.start();
	assert.equal(readDiagnostics().at(-1)!.source, "pi-codegraph");
	assert.equal(readDiagnostics().at(-1)!.level, "warning");
	assert.match(readDiagnostics().at(-1)!.message, /codegraph --version failed/);
	assert.equal(warn.mock.callCount() + error.mock.callCount() + log.mock.callCount() + stderr.mock.callCount(), 0);
	assert.deepEqual(run.calls, [{ command: "codegraph", args: ["--version"], cwd: worktree }]);
	assert.equal(run.notices[0]!.level, "warning");
	assert.equal(run.statuses.at(-1), "<warning>!</warning> CG: prerequisites missing");
	assert.ok(run.notices[0]!.message.includes("npm install -g @colbymchenry/codegraph"));
	await assert.rejects(rmdir(lock), { code: "ENOENT" });
	const headless = harness(worktree, { ...options, hasUI: false });
	await headless.start();
	assert.deepEqual(stderr.mock.calls[0]!.arguments, [`${readDiagnostics().at(-1)!.message}\n`]);
	assert.equal(warn.mock.callCount(), 0);
	const timeout = harness(worktree, { version: { code: 0, stdout: "", stderr: "", killed: true } });
	await timeout.start();
	assert.match(timeout.notices[0]!.message, /timed out or killed/);
	assert.equal(timeout.notices[0]!.level, "warning");
});

test("serializes simultaneous sessions and does not accept an in-progress partial database", async (t) => {
	const { primary, worktree } = await fixture(t);
	await index(primary);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const waiting = Promise.withResolvers<void>();
	let attempts = 0;
	const first = harness(worktree, { init: async () => {
		attempts++;
		await index(worktree);
		entered.resolve();
		await release.promise;
		return { code: 0, stdout: "", stderr: "", killed: false };
	} });
	const second = harness(worktree, { onStatus: (text) => {
		if (text?.includes("waiting for index")) waiting.resolve();
	} });
	const firstRun = first.start();
	await entered.promise;
	const secondRun = second.start();
	await waiting.promise;
	release.resolve();
	await Promise.all([firstRun, secondRun]);
	assert.equal(attempts, 1);
	assert.equal(second.calls.some(({ command, args }) => command === "codegraph" && args[0] === "init"), false);
	assert.deepEqual(second.notices, []);
});

test("failed init preserves its lock, reports recovery, and a later launch rejects the partial DB", async (t) => {
	const { primary, worktree, lock } = await fixture(t);
	await index(primary);
	const failed = harness(worktree, { init: async () => {
		await index(worktree);
		return { code: 1, stderr: "index worker failed", stdout: "", killed: false };
	} });
	await failed.start();
	assert.match(failed.notices[0]!.message, /index worker failed/);
	assert.ok(failed.notices[0]!.message.includes(lock));
	assert.equal(failed.notices[0]!.level, "error");
	assert.equal(failed.statuses.at(-1), "<error>!</error> CG: setup failed");
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const waiting = Promise.withResolvers<void>();
	const retry = harness(worktree, { onStatus: (text) => {
		if (text?.includes("waiting for index")) waiting.resolve();
	} });
	const retryRun = retry.start();
	await waiting.promise;
	t.mock.timers.tick(5 * 60_000);
	await retryRun;
	assert.match(retry.notices[0]!.message, /Timed out waiting/);
	assert.equal(retry.calls.some(({ command, args }) => command === "codegraph" && args[0] === "init"), false);
	await rmdir(lock); // explicit recovery, never automatic deletion
});

test("missing CLI, killed init, and success without a database all report setup failure", async (t) => {
	const { primary, worktree, lock } = await fixture(t);
	await index(primary);
	for (const init of [
		async () => { throw new Error("spawn codegraph ENOENT"); },
		async () => ({ code: 0, stdout: "", stderr: "", killed: true }),
		async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
	]) {
		const run = harness(worktree, { init });
		await run.start();
		assert.equal(run.notices[0]!.level, "error");
		assert.ok(run.notices[0]!.message.includes(lock));
		await rmdir(lock);
	}
});

test("rejects an alternate CODEGRAPH_DIR instead of indexing a different directory", async (t) => {
	const { worktree } = await fixture(t);
	const original = process.env.CODEGRAPH_DIR;
	process.env.CODEGRAPH_DIR = ".custom-codegraph";
	t.after(() => { if (original === undefined) delete process.env.CODEGRAPH_DIR; else process.env.CODEGRAPH_DIR = original; });
	const run = harness(worktree);
	await run.start();
	assert.match(run.notices[0]!.message, /requires the default CODEGRAPH_DIR/);
	assert.equal(run.calls.some(({ command, args }) => command === "codegraph" && args[0] === "init"), false);
});

async function scratch(t: TestContext) {
	const base = await realpath(await mkdtemp(join(tmpdir(), "pi-codegraph-parent-")));
	t.after(() => rm(base, { recursive: true, force: true }));
	return base;
}

async function repository(dir: string, indexed: boolean) {
	await mkdir(dir, { recursive: true });
	await exec("git", ["init", "-q", dir]);
	if (indexed) await index(dir);
	return dir;
}

test("codegraph_explore passes the query, file cap, and repository root to the CLI", async (t) => {
	const base = await scratch(t);
	const repo = await repository(join(base, "repo"), true);
	await mkdir(join(repo, "src"));
	const run = harness(repo);
	assert.equal(run.tool.name, "codegraph_explore");
	assert.deepEqual(await run.explore({ query: "how does init work" }), { content: [{ type: "text", text: "explored" }], details: undefined });
	// A directory inside the repository resolves to the Git top level that holds the index.
	await run.explore({ query: "initialize", maxFiles: 3, projectPath: join(repo, "src") });
	assert.deepEqual(run.calls.filter(({ command }) => command === "codegraph"), [
		{ command: "codegraph", args: ["explore", "--path", repo, "--max-files", "12", "how does init work"], cwd: repo, timeout: 120_000 },
		{ command: "codegraph", args: ["explore", "--path", repo, "--max-files", "3", "initialize"], cwd: repo, timeout: 120_000 },
	]);
});

test("codegraph_explore surfaces the CLI stderr tail on failure", async (t) => {
	const repo = await repository(join(await scratch(t), "repo"), true);
	const run = harness(repo, { explore: { code: 1, stdout: "", stderr: `${"x".repeat(3000)}CodeGraph not initialized\n`, killed: false } });
	await assert.rejects(run.explore({ query: "q" }), (error: Error) => {
		assert.match(error.message, /^codegraph explore failed \(exit 1\): x+CodeGraph not initialized$/);
		assert.ok(error.message.length < 2100);
		return true;
	});
});

test("codegraph_explore in a non-Git parent directory names the indexed repositories below it", async (t) => {
	const base = await scratch(t);
	const api = await repository(join(base, "api"), true);
	const web = await repository(join(base, "team", "web"), true);
	const docs = await repository(join(base, "docs"), false);
	const run = harness(base);
	await assert.rejects(run.explore({ query: "q" }), (error: Error) => {
		assert.match(error.message, /is not in a Git repository/);
		assert.match(error.message, /Pass projectPath/);
		assert.ok(error.message.includes(api) && error.message.includes(web));
		assert.equal(error.message.includes(docs), false);
		return true;
	});
	assert.equal(run.calls.some(({ args }) => args[0] === "explore"), false);
	// The list is bounded.
	for (let n = 0; n < 12; n++) await repository(join(base, "many", `r${String(n).padStart(2, "0")}`), true);
	await assert.rejects(run.explore({ query: "q" }), (error: Error) => {
		assert.equal(error.message.split("\n").filter((line) => line.startsWith("- ")).length, 10);
		assert.match(error.message, /4 more/);
		return true;
	});
});

test("codegraph_explore does not use the outer repository of a plain directory", async (t) => {
	const base = await scratch(t);
	const outer = await repository(join(base, "outer"), false);
	const child = await repository(join(outer, "code", "api"), true);
	const run = harness(join(outer, "code"));
	await assert.rejects(run.explore({ query: "q" }), (error: Error) => {
		assert.ok(error.message.includes(`${outer} has no CodeGraph index`));
		assert.match(error.message, /Pass projectPath/);
		assert.ok(error.message.includes(child));
		return true;
	});
	assert.equal(run.calls.some(({ args }) => args[0] === "explore"), false);
	// A projectPath that names the indexed repository works from the same session.
	await run.explore({ query: "q", projectPath: child });
	assert.deepEqual(run.calls.filter(({ args }) => args[0] === "explore").map(({ args }) => args[2]), [child]);
});

test("codegraph_explore reports a repository without an index and a bad projectPath", async (t) => {
	const base = await scratch(t);
	const bare = await repository(join(base, "unindexed"), false);
	const run = harness(bare);
	await assert.rejects(run.explore({ query: "q" }), (error: Error) => {
		assert.ok(error.message.includes(`${bare} has no CodeGraph index`));
		assert.match(error.message, /No indexed repository found below/);
		return true;
	});
	await assert.rejects(run.explore({ query: "q", projectPath: join(base, "missing") }), /missing is not an existing directory/);
	await writeFile(join(base, "file.txt"), "");
	await assert.rejects(run.explore({ query: "q", projectPath: join(base, "file.txt") }), /file\.txt is not an existing directory/);
	assert.equal(run.calls.some(({ args }) => args[0] === "explore"), false);
});

test("session setup in a non-Git parent directory shows one short notice and indexes no child repository", async (t) => {
	const base = await scratch(t);
	await repository(join(base, "api"), true);
	await repository(join(base, "docs"), false);
	const run = harness(base, { mode: "tui", confirm: true });
	run.start();
	await run.shutdown("new");
	run.start();
	await run.shutdown("new");
	assert.equal(run.notices.length, 1);
	assert.equal(run.notices[0]!.level, "info");
	assert.match(run.notices[0]!.message, /not in a Git repository/);
	assert.match(run.notices[0]!.message, /projectPath/);
	assert.ok(run.notices[0]!.message.length < 200);
	assert.deepEqual(run.prompts, []);
	assert.equal(run.calls.some(({ command, args }) => command === "codegraph" && args[0] !== "--version"), false);
	assert.equal(run.servers.size, 0);
	assert.equal(run.statuses.at(-1), undefined);
	const headless = harness(base, { hasUI: false });
	await headless.start();
	assert.deepEqual(headless.notices, []);
});

test("session setup does not read Git messages to find a non-Git directory", async (t) => {
	const base = await scratch(t);
	// Git prints this text with a German locale.
	const run = harness(base, { gitProbe: async (args) => args.includes("--show-toplevel")
		? { code: 128, stdout: "", stderr: "fatal: kein Git-Repository (oder irgendein Elternverzeichnis bis zum Einhängepunkt): .git", killed: false } : undefined });
	await run.start();
	assert.deepEqual(run.notices.map(({ level }) => level), ["info"]);
	assert.equal(run.statuses.at(-1), undefined);
});

test("session setup does not offer to index the outer repository of a plain directory", async (t) => {
	const { primary, worktree } = await fixture(t);
	const plain = join(worktree, "plain");
	await mkdir(plain);
	const run = harness(plain, { mode: "tui", confirm: true });
	run.start();
	await run.shutdown("new");
	assert.deepEqual(run.prompts, []);
	assert.equal(run.calls.some(({ command, args }) => command === "codegraph" && args[0] === "init"), false);
	assert.equal(run.statuses.at(-1), "<dim>○</dim> CG");
	await assert.rejects(stat(join(primary, ".codegraph")), { code: "ENOENT" });
});

test("a submodule never offers to index its Git directory", async (t) => {
	const base = await scratch(t);
	const upstream = await repository(join(base, "upstream"), false);
	await exec("git", ["-C", upstream, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "initial"]);
	const parent = await repository(join(base, "parent"), false);
	await exec("git", ["-C", parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "mod"]);
	const module = join(parent, "mod");
	const gitDir = (await exec("git", ["-C", module, "rev-parse", "--absolute-git-dir"])).stdout.trim();
	const run = harness(module, { mode: "tui", confirm: true });
	run.start();
	await run.shutdown("new");
	assert.deepEqual(run.prompts, []);
	assert.equal(run.calls.some(({ command, args }) => command === "codegraph" && args[0] === "init"), false);
	await assert.rejects(stat(join(gitDir, ".codegraph")), { code: "ENOENT" });
	assert.equal(run.statuses.at(-1), "<dim>○</dim> CG");
	// An index in the submodule checkout is used as usual.
	await index(module);
	const indexed = harness(module);
	await indexed.start();
	assert.equal(indexed.statuses.at(-1), "<success>✓</success> CG");
	assert.deepEqual(indexed.servers.get("pi-codegraph"), { command: "codegraph", args: ["serve", "--mcp", "--path", module], cwd: module, exposure: "hidden" });
});
