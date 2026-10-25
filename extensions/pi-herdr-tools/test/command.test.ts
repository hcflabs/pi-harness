import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readDiagnostics } from "@hcflabs/pi-config-store";
import herdrCommandExtension, { CHECKOUT_ACTIVITY_END, CHECKOUT_ACTIVITY_START, jobStatus, parseCommandParams } from "../internal/command.ts";
import { shellProbe, success, withPane, type ExecResult } from "./helper.ts";

const RUNNER = fileURLToPath(new URL("../internal/command-runner.mjs", import.meta.url));
const hasLsof = spawnSync("lsof", ["-v"]).status === 0;

async function tempDir(t: { after: (callback: () => Promise<void>) => void }, prefix: string) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

async function job(t: { after: (callback: () => Promise<void>) => void }, command: string, args: string[], maxRuntimeMs = 60_000) {
	const directory = await tempDir(t, "pi-herdr-command-job-");
	const token = "t".repeat(32);
	await writeFile(join(directory, "launch.json"), JSON.stringify({ id: "cmd-test", token, command, args, cwd: directory, maxRuntimeMs }), { mode: 0o600 });
	await writeFile(join(directory, "process.lease"), "", { mode: 0o600 });
	return { directory, token };
}

async function runRunner(directory: string) {
	const child = spawn(process.execPath, [RUNNER, directory], { stdio: "ignore" });
	await new Promise((resolve) => child.once("exit", resolve));
}

test("restore failures record a diagnostic without console output with UI", async (t) => {
	await withPane("w1:p1", async () => {
		const app = await commandHarness(t);
		const id = "cmd-0123456789abcdef";
		const directory = join(app.agentDir, "config", "pi-herdr-tools", "commands", id);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "job.json"), "{");
		const error = t.mock.method(console, "error", () => {});
		const warn = t.mock.method(console, "warn", () => {});
		const log = t.mock.method(console, "log", () => {});
		const stderr = t.mock.method(process.stderr, "write", () => true);
		await app.handlers.get("session_start")!({}, { ...app.ctx, hasUI: true });
		const event = readDiagnostics().at(-1)!;
		assert.equal(event.source, "pi-herdr-tools");
		assert.equal(event.level, "error");
		assert.match(event.message, /job cmd-0123456789abcdef could not be restored/);
		assert.equal(error.mock.callCount() + warn.mock.callCount() + log.mock.callCount() + stderr.mock.callCount(), 0);
	});
});

test("parseCommandParams accepts each action only with its own fields", () => {
	assert.deepEqual(parseCommandParams({ action: "start", command: "make", args: ["test"], access: "write" }),
		{ action: "start", command: "make", args: ["test"], access: "write" });
	assert.deepEqual(parseCommandParams({ action: "read", id: "cmd-0123456789abcdef", lines: 20 }), { action: "read", id: "cmd-0123456789abcdef", lines: 20 });
	for (const [value, pattern] of [
		[{ action: "start", command: "make" }, /requires command and access/],
		[{ action: "start", command: "make", access: "read", id: "cmd-0123456789abcdef" }, /does not accept id or lines/],
		[{ action: "read" }, /requires id/],
		[{ action: "read", id: "cmd-0123456789abcdef", command: "make" }, /does not accept command/],
		[{ action: "stop", id: "cmd-0123456789abcdef", lines: 5 }, /does not accept lines/],
		[{ action: "stop", id: "w1:p2" }, /parameters are invalid/],
		[{ action: "start", command: "make", access: "read", shell: "make test" }, /parameters are invalid/],
		[{ action: "start", command: "make", args: ["a\0b"], access: "read" }, /cannot contain NUL/],
	] as const) assert.throws(() => parseCommandParams(value), pattern, JSON.stringify(value));
});

test("the runner saves the exit code, a start failure, and the runtime limit outside the terminal", async (t) => {
	const exited = await job(t, process.execPath, ["-e", "process.exit(3)"]);
	await runRunner(exited.directory);
	assert.deepEqual(await jobStatus(exited), { state: "ended", code: 3, signal: null, timedOut: false });

	const missing = await job(t, join(exited.directory, "no-such-command"), []);
	await runRunner(missing.directory);
	const failed = await jobStatus(missing);
	assert.equal(failed.state === "ended" && /ENOENT/.test(failed.error ?? ""), true);

	const slow = await job(t, process.execPath, ["-e", "setTimeout(() => {}, 60000)"], 200);
	await runRunner(slow.directory);
	assert.deepEqual(await jobStatus(slow), { state: "ended", code: null, signal: "SIGTERM", timedOut: true });
	assert.rejects(jobStatus({ directory: slow.directory, token: "other" }), /another job token/);
});

test("the runner and its command hold the job lease until they end", { skip: !hasLsof && "lsof is not installed" }, async (t) => {
	const running = await job(t, process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
	const child = spawn(process.execPath, [RUNNER, running.directory], { stdio: "ignore" });
	t.after(() => { child.kill("SIGKILL"); });
	for (let attempt = 0; attempt < 100 && (await jobStatus(running)).state !== "running"; attempt++) await delay(20);
	const status = await jobStatus(running);
	assert.equal(status.state, "running");
	const holders = () => {
		const result = spawnSync("lsof", ["-w", "-nP", "-a", "-F", "p", "--", join(running.directory, "process.lease")], { encoding: "utf8" });
		return result.stdout.split("\n").filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1)));
	};
	assert.ok(holders().includes(status.state === "running" ? status.pid : -1));
	assert.ok(holders().includes(child.pid!));
	process.kill(status.state === "running" ? status.pid : 0, "SIGTERM");
	for (let attempt = 0; attempt < 100 && (await jobStatus(running)).state !== "ended"; attempt++) await delay(20);
	assert.deepEqual(await jobStatus(running), { state: "ended", code: null, signal: "SIGTERM", timedOut: false });
	for (let attempt = 0; attempt < 100 && holders().length; attempt++) await delay(20);
	assert.deepEqual(holders(), []);
});

type Harness = Awaited<ReturnType<typeof commandHarness>>;

/** A fake Herdr that runs the typed runner line without a shell, and a real runner and lsof. */
async function commandHarness(t: { after: (callback: () => Promise<void>) => void }, overrides: { processInfo?: (args: string[]) => ExecResult | undefined } = {}) {
	const agentDir = await tempDir(t, "pi-herdr-command-agent-");
	const repoParent = await tempDir(t, "pi-herdr-command-parent-");
	const repo = join(repoParent, "team", "service");
	await mkdir(join(repo, "src"), { recursive: true });
	execFileSync("git", ["init", "-q", repo]);
	const events: Array<[string, unknown]> = [];
	const calls: string[][] = [];
	const panes = new Map<string, string>();
	const handlers = new Map<string, (...args: any[]) => any>();
	let submitted = false;
	let next = 1;
	let execute: ((...args: any[]) => Promise<any>) | undefined;
	let prepare: ((value: unknown) => unknown) | undefined;
	const api = {
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
		events: { emit: (channel: string, data: unknown) => events.push([channel, data]), on: () => () => {} },
		registerTool(tool: { name: string; execute: typeof execute; prepareArguments: typeof prepare }) {
			if (tool.name === "herdr_command") { execute = tool.execute; prepare = tool.prepareArguments; }
		},
		exec: async (command: string, args: string[], options: { cwd: string }): Promise<ExecResult> => {
			if (command !== "herdr") return await new Promise((resolve) => {
				const child = spawn(command, args, { cwd: options.cwd });
				let stdout = ""; let stderr = "";
				child.stdout.on("data", (chunk) => { stdout += chunk; });
				child.stderr.on("data", (chunk) => { stderr += chunk; });
				child.once("exit", (code) => resolve({ stdout, stderr, code: code ?? 1, killed: false }));
			});
			calls.push(args);
			if (args[0] === "pane" && args[1] === "split") {
				const pane = `w1:p${++next}`;
				panes.set(pane, `term-${next}`);
				submitted = false;
				return success({ result: { pane: { pane_id: pane, workspace_id: "w1", terminal_id: `term-${next}`, focused: false, cwd: args[args.indexOf("--cwd") + 1] } } });
			}
			if (args[0] === "pane" && args[1] === "process-info") { const result = overrides.processInfo?.(args); if (result) return result; }
			if (args[0] === "pane" && args[1] === "run" && args[3]!.includes("command-runner.mjs")) {
				// The fake shell runs the quoted runner line without a shell, as the leader of a new job group.
				const words = [...args[3]!.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
				spawn(words[0]!, words.slice(1), { stdio: "ignore", detached: true }).unref();
				submitted = true;
				return success();
			}
			if (submitted && args[0] === "pane" && args[1] === "read") return success("make: all tests passed\n");
			if (args[0] === "pane" && args[1] === "get") {
				return panes.has(args[2]!) ? success({ result: { pane: { pane_id: args[2], terminal_id: panes.get(args[2]!) } } })
					: { stdout: JSON.stringify({ error: { code: "pane_not_found" } }), stderr: "", code: 1, killed: false };
			}
			if (args[0] === "pane" && args[1] === "close") { panes.delete(args[2]!); return success(); }
			return shellProbe(args) ?? success();
		},
	} as unknown as ExtensionAPI;
	herdrCommandExtension(api, { agentDir });
	assert.ok(execute && prepare);
	const ctx = { cwd: repoParent, hasUI: false };
	const run = async (params: unknown) => await execute!("call", prepare!(params), undefined, undefined, ctx);
	const waitFor = async (id: string, state: string) => {
		for (let attempt = 0; attempt < 200; attempt++) {
			const read = await run({ action: "read", id });
			if ((read.details as { status: { state: string } }).status.state === state) return read;
			await delay(20);
		}
		throw new Error(`Job ${id} did not reach ${state}.`);
	};
	return { agentDir, repo, events, calls, panes, handlers, run, waitFor, api, ctx };
}

test("start runs the runner in a verified pane, read reports saved status, and stop proves the end", { skip: !hasLsof && "lsof is not installed" }, async (t) => {
	await withPane("w1:p1", async () => {
		const app: Harness = await commandHarness(t);
		const started = await app.run({ action: "start", repo: "team/service", cwd: "src", command: process.execPath, args: ["-e", "process.exit(0)"], access: "write" });
		const { id, cwd } = started.details as { id: string; cwd: string };
		assert.equal(cwd, join(app.repo, "src"));
		assert.deepEqual(app.events, [[CHECKOUT_ACTIVITY_START, { jobId: id, cwd }]]);
		assert.deepEqual(app.calls.find((args) => args[1] === "split"), ["pane", "split", "w1:p1", "--direction", "right", "--no-focus", "--cwd", cwd]);
		const launch = JSON.parse(await readFile(join(app.agentDir, "config", "pi-herdr-tools", "commands", id, "launch.json"), "utf8"));
		assert.deepEqual([launch.command, launch.args, launch.cwd], [process.execPath, ["-e", "process.exit(0)"], cwd]);

		const read = await app.waitFor(id, "ended");
		assert.match(read.content[0].text, new RegExp(`^Job ${id} · exited with code 0 · pane w1:p2`));
		assert.match(read.content[0].text, /untrusted terminal text[\s\S]*make: all tests passed/);

		const stopped = await app.run({ action: "stop", id });
		assert.match(stopped.content[0].text, /pane w1:p2 is closed and no process holds the job lease/);
		assert.deepEqual(app.events.at(-1), [CHECKOUT_ACTIVITY_END, { jobId: id }]);
		await assert.rejects(app.run({ action: "start", repo: "team/service", cwd: "../..", command: "true", access: "read" }), /relative path without \.\. components/);
	});
});

test("stop ends a background child that outlived the command, also after it dropped the lease", { skip: !hasLsof && "lsof is not installed" }, async (t) => {
	await withPane("w1:p1", async () => {
		const app = await commandHarness(t);
		// The subshell closes the lease descriptor, like a Python subprocess with close_fds, then outlives the command.
		const started = await app.run({ action: "start", command: "bash", args: ["-c", "(exec 3>&-; sleep 300) & exit 0"], access: "write" });
		const { id } = started.details as { id: string };
		await app.waitFor(id, "ended");
		const record = JSON.parse(await readFile(join(app.agentDir, "config", "pi-herdr-tools", "commands", id, "started.json"), "utf8"));
		assert.equal(typeof record.group, "number");
		const members = () => spawnSync("pgrep", ["-g", String(record.group)], { encoding: "utf8" }).stdout.trim();
		assert.notEqual(members(), "", "the background sleep remains in the job group");
		const stopped = await app.run({ action: "stop", id });
		assert.match(stopped.content[0].text, /no process holds the job lease/);
		assert.equal(members(), "");
		assert.deepEqual(app.events.at(-1), [CHECKOUT_ACTIVITY_END, { jobId: id }]);
	});
});

test("read and stop never act on a later pane that reuses the job pane ID", { skip: !hasLsof && "lsof is not installed" }, async (t) => {
	await withPane("w1:p1", async () => {
		const app = await commandHarness(t);
		const { id } = (await app.run({ action: "start", command: process.execPath, args: ["-e", "0"], access: "read" })).details as { id: string };
		await app.waitFor(id, "ended");
		app.panes.set("w1:p2", "term-other");
		assert.match((await app.run({ action: "read", id })).content[0].text, /the job pane is gone/);
		await app.run({ action: "stop", id });
		assert.equal(app.panes.get("w1:p2"), "term-other");
		assert.equal(app.calls.some((args) => args[1] === "close"), false);
	});
});

test("start types nothing into a pane where another program owns the foreground", async (t) => {
	await withPane("w1:p1", async () => {
		const app = await commandHarness(t, { processInfo: (args) => success({ result: { process_info: { pane_id: args[3], shell_pid: 501, foreground_process_group_id: 777 } } }) });
		await assert.rejects(app.run({ action: "start", command: "true", access: "write" }), /runs a foreground program, not its shell[\s\S]*no command was started/);
		assert.equal(app.calls.some((args) => args[1] === "run" && args[3]!.includes("command-runner")), false);
		assert.deepEqual(app.calls.at(-1), ["pane", "close", "w1:p2"]);
		assert.deepEqual(app.events.map(([channel]) => channel), [CHECKOUT_ACTIVITY_START, CHECKOUT_ACTIVITY_END]);
	});
});

test("a new session runtime restores a running write job and its activity, and stop still proves the end", { skip: !hasLsof && "lsof is not installed" }, async (t) => {
	await withPane("w1:p1", async () => {
		const first = await commandHarness(t);
		const { id, cwd } = (await first.run({ action: "start", command: "sleep", args: ["300"], access: "write" })).details as { id: string; cwd: string };
		await first.waitFor(id, "running");
		// A replaced runtime: a new registration with the same agent directory and Herdr state.
		const events: Array<[string, unknown]> = [];
		let execute: ((...args: any[]) => Promise<any>) | undefined;
		let prepare: ((value: unknown) => unknown) | undefined;
		const handlers = new Map<string, (...args: any[]) => any>();
		herdrCommandExtension({ ...(first.api as object),
			on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
			events: { emit: (channel: string, data: unknown) => events.push([channel, data]), on: () => () => {} },
			registerTool(tool: { execute: typeof execute; prepareArguments: typeof prepare }) { execute = tool.execute; prepare = tool.prepareArguments; },
		} as unknown as ExtensionAPI, { agentDir: first.agentDir });
		await handlers.get("session_start")!({}, first.ctx);
		assert.deepEqual(events, [[CHECKOUT_ACTIVITY_START, { jobId: id, cwd }]]);
		const stopped = await execute!("call", prepare!({ action: "stop", id }), undefined, undefined, first.ctx);
		assert.match(stopped.content[0].text, /stopped by SIGTERM/);
		assert.deepEqual(events.at(-1), [CHECKOUT_ACTIVITY_END, { jobId: id }]);
	});
});
