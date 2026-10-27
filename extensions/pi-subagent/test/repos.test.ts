import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRepoDiscovery } from "../extensions/repos.ts";

type Tool = { execute(id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: { cwd: string }): Promise<{ content: Array<{ text: string }> }> };

async function run(cwd: string): Promise<string> {
	let tool: Tool | undefined;
	registerRepoDiscovery({ registerTool(registered: Tool) { tool = registered; } } as unknown as ExtensionAPI);
	return (await tool!.execute("call", {}, undefined, undefined, { cwd })).content[0]!.text;
}

async function scratch(t: test.TestContext): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-repos-")));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

function init(path: string): void {
	execFileSync("git", ["init", "-q", path], { stdio: "pipe" });
}

test("subagent_repos labels a submodule and a linked worktree", async (t) => {
	const base = await scratch(t);
	const library = join(await scratch(t), "library");
	const main = join(base, "main");
	for (const path of [library, main]) {
		await mkdir(path, { recursive: true });
		init(path);
		execFileSync("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"], { stdio: "pipe" });
	}
	execFileSync("git", ["-C", main, "-c", "protocol.file.allow=always", "-c", "user.name=t", "-c", "user.email=t@t", "submodule", "add", "-q", library, "vendor/lib"], { stdio: "pipe" });
	execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "feature", join(base, "linked")], { stdio: "pipe" });
	const lines = (await run(base)).split("\n");
	assert.deepEqual(lines, [
		`3 repositories below ${base}.`,
		"linked (linked worktree)",
		"main",
		"main/vendor/lib (submodule)",
	]);
});

test("subagent_repos reports the directories that the depth limit left unexamined", async (t) => {
	const base = await scratch(t);
	await mkdir(join(base, "a", "b", "c", "d"), { recursive: true });
	init(join(base, "a", "b", "c", "d", "deep"));
	const text = await run(base);
	assert.match(text, /^0 repositories below .* \(truncated: .*depth.*\)\./);
});
