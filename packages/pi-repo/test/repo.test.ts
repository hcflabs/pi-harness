import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Exec } from "@hcflabs/pi-process";
import { discoverRepos, gitTopLevel, isWithin, RepoTargetError, resolveRepoTarget } from "../src/index.ts";

async function scratch(t: test.TestContext): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), "pi-repo-")));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function repository(path: string): Promise<string> {
	await mkdir(path, { recursive: true });
	git(path, "init", "-q", "-b", "main");
	git(path, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
	return path;
}

function fakeGit(result: { code: number; killed?: boolean; stdout?: string; stderr?: string }): Exec {
	return async () => ({ code: result.code, killed: result.killed ?? false, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
}

test("isWithin accepts the root and its children only", () => {
	assert.equal(isWithin("/a/b", "/a/b"), true);
	assert.equal(isWithin("/a/b", "/a/b/c"), true);
	assert.equal(isWithin("/a/b", "/a/bc"), false);
	assert.equal(isWithin("/a/b", "/a"), false);
});

test("gitTopLevel returns the real top-level from a subdirectory", async (t) => {
	const root = await repository(join(await scratch(t), "repo"));
	await mkdir(join(root, "src", "deep"), { recursive: true });
	assert.equal(await gitTopLevel(join(root, "src", "deep")), root);
});

test("gitTopLevel returns undefined outside Git", async (t) => {
	assert.equal(await gitTopLevel(await scratch(t)), undefined);
});

test("gitTopLevel throws when Git fails beside a .git entry", async (t) => {
	const root = await scratch(t);
	await mkdir(join(root, ".git"));
	await assert.rejects(gitTopLevel(root, { runProcess: fakeGit({ code: 128, stderr: "detected dubious ownership" }) }), /dubious ownership/);
});

test("gitTopLevel classifies a non-repository without reading the Git message", async (t) => {
	const root = await scratch(t);
	const calls: string[][] = [];
	const runner: Exec = async (_command, args) => {
		calls.push(args);
		return { code: 128, killed: false, stdout: "", stderr: "fatal: kein Git-Repository" };
	};
	assert.equal(await gitTopLevel(root, { runProcess: runner }), undefined);
	assert.deepEqual(calls[1], ["-c", "safe.directory=*", "rev-parse", "--git-dir"]);
});

test("gitTopLevel throws when the second check finds a Git directory without a .git entry", async (t) => {
	const root = await scratch(t);
	let call = 0;
	const runner: Exec = async () => (call++ === 0
		? { code: 128, killed: false, stdout: "", stderr: "detected dubious ownership" }
		: { code: 0, killed: false, stdout: ".\n", stderr: "" });
	await assert.rejects(gitTopLevel(root, { runProcess: runner }), /dubious ownership/);
});

test("gitTopLevel and resolveRepoTarget treat a bare repository as a Git failure", async (t) => {
	const base = await scratch(t);
	await mkdir(join(base, "bare"));
	git(join(base, "bare"), "init", "-q", "--bare");
	await assert.rejects(gitTopLevel(join(base, "bare")), /git rev-parse --show-toplevel failed/);
	await assert.rejects(resolveRepoTarget(base, "bare"), (error: Error) => !(error instanceof RepoTargetError));
});

test("gitTopLevel accepts an unnormalized root spelling", async (t) => {
	const root = await scratch(t);
	assert.equal(await gitTopLevel(root, { runProcess: fakeGit({ code: 0, stdout: `${root}/./\n` }) }), root);
});

test("gitTopLevel throws on a stopped process and on malformed output", async (t) => {
	const root = await scratch(t);
	await assert.rejects(gitTopLevel(root, { runProcess: fakeGit({ code: 0, killed: true }) }), /did not finish/);
	await assert.rejects(gitTopLevel(root, { runProcess: fakeGit({ code: 0, stdout: "relative/path\n" }) }), /malformed/);
	await assert.rejects(gitTopLevel(root, { runProcess: fakeGit({ code: 0, stdout: "/a\n/b\n" }) }), /malformed/);
});

test("gitTopLevel rejects a root that does not contain the directory", async (t) => {
	const root = await scratch(t);
	const other = await scratch(t);
	await assert.rejects(gitTopLevel(root, { runProcess: fakeGit({ code: 0, stdout: `${other}\n` }) }), /does not contain/);
});

test("gitTopLevel honors an aborted signal", async (t) => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(gitTopLevel(await scratch(t), { signal: controller.signal }), { name: "AbortError" });
});

test("resolveRepoTarget accepts child and nested child repositories in a non-Git base", async (t) => {
	const base = await scratch(t);
	const child = await repository(join(base, "service-a"));
	const nested = await repository(join(base, "team", "service-b"));
	assert.deepEqual(await resolveRepoTarget(base, "service-a"), { repo: "service-a", root: child, base });
	assert.deepEqual(await resolveRepoTarget(base, "team/service-b/"), { repo: "team/service-b", root: nested, base });
});

test("resolveRepoTarget accepts . only when the base is a top-level", async (t) => {
	const base = await scratch(t);
	await assert.rejects(resolveRepoTarget(base, "."), (error: Error) => error instanceof RepoTargetError && /not in a Git repository/.test(error.message));
	const root = await repository(join(base, "repo"));
	assert.deepEqual(await resolveRepoTarget(root, "."), { repo: ".", root, base: root });
});

test("resolveRepoTarget rejects unsafe or wrong selectors", async (t) => {
	const base = await scratch(t);
	const root = await repository(join(base, "repo"));
	await mkdir(join(root, "src"));
	await writeFile(join(base, "file"), "x");
	const cases: Array<[string, RegExp]> = [
		["", /non-empty relative path/],
		["repo\n", /control characters/],
		[root, /relative path, not/],
		["../repo", /\.\. component/],
		["repo/../repo", /\.\. component/],
		["missing", /does not exist/],
		["file", /not a directory/],
		["repo/src", /not a Git top-level directory\. Git reports/],
	];
	for (const [repo, message] of cases) {
		await assert.rejects(resolveRepoTarget(base, repo), (error: Error) => error instanceof RepoTargetError && message.test(error.message), repo);
	}
});

test("resolveRepoTarget follows symlinks inside the base and rejects symlinks outside it", async (t) => {
	const base = await scratch(t);
	const outside = await repository(join(await scratch(t), "outside"));
	const inside = await repository(join(base, "real"));
	await symlink(inside, join(base, "alias"));
	await symlink(outside, join(base, "escape"));
	assert.deepEqual(await resolveRepoTarget(base, "alias"), { repo: "real", root: inside, base });
	await assert.rejects(resolveRepoTarget(base, "escape"), (error: Error) => error instanceof RepoTargetError && /outside/.test(error.message));
});

test("resolveRepoTarget reports Git inspection failures as plain errors", async (t) => {
	const base = await scratch(t);
	await mkdir(join(base, "broken", ".git"), { recursive: true });
	await assert.rejects(
		resolveRepoTarget(base, "broken", { runProcess: fakeGit({ code: 128, stderr: "fatal: unsafe repository" }) }),
		(error: Error) => !(error instanceof RepoTargetError) && /unsafe repository/.test(error.message),
	);
});

test("discoverRepos finds repositories to depth 3 and nested repositories inside them", async (t) => {
	const base = await scratch(t);
	await repository(join(base, "one"));
	await repository(join(base, "group", "two"));
	await repository(join(base, "group", "team", "three"));
	await repository(join(base, "group", "team", "deeper", "four"));
	await repository(join(base, "one", "inner"));
	const result = await discoverRepos(base);
	assert.equal(result.base, base);
	assert.deepEqual(result.repos.map((repo) => repo.repo), ["group/team/three", "group/two", "one", "one/inner"]);
	assert.deepEqual(result.issues, []);
	// `group/team/deeper` is at the depth limit and has the child directory `four`. Discovery did not examine it.
	assert.equal(result.truncated, true);
	const deeper = await discoverRepos(base, { maxDepth: 4 });
	assert.deepEqual(deeper.repos.map((repo) => repo.repo), ["group/team/deeper/four", "group/team/three", "group/two", "one", "one/inner"]);
	assert.equal(deeper.truncated, false);
});

test("discoverRepos reports truncation when a directory at the depth limit has child directories", async (t) => {
	const base = await scratch(t);
	await repository(join(base, "a", "b", "c", "d", "deep"));
	const result = await discoverRepos(base);
	assert.deepEqual(result.repos, []);
	assert.equal(result.truncated, true);
	assert.deepEqual((await discoverRepos(base, { maxDepth: 5 })).repos.map((repo) => repo.repo), ["a/b/c/d/deep"]);
	assert.equal((await discoverRepos(base, { maxDepth: 5 })).truncated, false);
	// Excluded directories and files at the depth limit are not unexamined directories.
	const flat = await scratch(t);
	await mkdir(join(flat, "a", "b", "c", "node_modules"), { recursive: true });
	await mkdir(join(flat, "a", "b", "c", ".worktrees"));
	await writeFile(join(flat, "a", "b", "c", "file"), "x");
	const complete = await discoverRepos(flat);
	assert.equal(complete.truncated, false);
	assert.deepEqual(complete.issues, []);
	await mkdir(join(flat, "a", "b", "c", "child"));
	assert.equal((await discoverRepos(flat)).truncated, true);
	assert.equal((await discoverRepos(flat, { exclude: ["child"] })).truncated, false);
});

test("discoverRepos reports a repository at the depth limit that has child directories", async (t) => {
	const base = await scratch(t);
	const repo = await repository(join(base, "a", "b", "c"));
	assert.equal((await discoverRepos(base)).truncated, false);
	await mkdir(join(repo, "src"));
	const result = await discoverRepos(base);
	assert.deepEqual(result.repos.map((item) => item.repo), ["a/b/c"]);
	assert.equal(result.truncated, true);
});

test("discoverRepos lists repositories inside repositories and respects the depth and exclude rules there", async (t) => {
	const base = await scratch(t);
	const outer = await repository(join(base, "outer"));
	await repository(join(outer, "packages", "inner"));
	await repository(join(outer, "node_modules", "pkg"));
	await repository(join(outer, ".worktrees", "wt"));
	await repository(join(outer, "vendor", "lib"));
	await repository(join(outer, "a", "b", "c", "far"));
	const result = await discoverRepos(base, { exclude: ["vendor"] });
	assert.deepEqual(result.repos.map((repo) => repo.repo), ["outer", "outer/packages/inner"]);
	assert.equal(result.truncated, true);
	assert.deepEqual((await discoverRepos(base, { exclude: ["vendor"], maxDepth: 5 })).repos.map((repo) => repo.repo), [
		"outer", "outer/a/b/c/far", "outer/packages/inner",
	]);
	// Repositories inside repositories count against the repository limit.
	const limited = await discoverRepos(base, { limit: 1 });
	assert.deepEqual(limited.repos.map((repo) => repo.repo), ["outer"]);
	assert.equal(limited.truncated, true);
});

test("discoverRepos descends into a directory whose .git entry is not a repository", async (t) => {
	const base = await scratch(t);
	await mkdir(join(base, "broken"));
	await writeFile(join(base, "broken", ".git"), "gitdir: /nonexistent\n");
	const child = await repository(join(base, "broken", "child"));
	const result = await discoverRepos(base);
	assert.deepEqual(result.repos.map((repo) => repo.root), [child]);
	assert.deepEqual(result.issues.map((issue) => issue.path), ["broken"]);
});

test("discoverRepos skips excluded names and symlinked directories", async (t) => {
	const base = await scratch(t);
	const real = await repository(join(base, "real"));
	await repository(join(base, "node_modules", "pkg"));
	await repository(join(base, ".scratch-x", "pkg"));
	await repository(join(base, "vendor", "pkg"));
	await symlink(real, join(base, "alias"));
	const result = await discoverRepos(base, { exclude: ["vendor"] });
	assert.deepEqual(result.repos, [{ repo: "real", root: real, linkedWorktree: false, submodule: false }]);
});

test("discoverRepos marks linked worktrees and reports invalid .git entries", async (t) => {
	const base = await scratch(t);
	const main = await repository(join(base, "main"));
	git(main, "worktree", "add", "-q", "-b", "feature", join(base, "linked"));
	await mkdir(join(base, "fake"));
	await writeFile(join(base, "fake", ".git"), "gitdir: /nonexistent\n");
	const result = await discoverRepos(base);
	assert.deepEqual(result.repos.map(({ repo, linkedWorktree, submodule }) => ({ repo, linkedWorktree, submodule })), [
		{ repo: "linked", linkedWorktree: true, submodule: false },
		{ repo: "main", linkedWorktree: false, submodule: false },
	]);
	assert.deepEqual(result.issues.map((issue) => issue.path), ["fake"]);
});

test("discoverRepos tells a submodule from a linked worktree and from a separate Git directory", async (t) => {
	const base = await scratch(t);
	const library = await repository(join(await scratch(t), "library"));
	const main = await repository(join(base, "main"));
	git(main, "-c", "protocol.file.allow=always", "-c", "user.name=t", "-c", "user.email=t@example.com", "submodule", "add", "-q", library, "vendor/lib");
	git(main, "worktree", "add", "-q", "-b", "feature", join(base, "linked"));
	await mkdir(join(base, "separate"));
	git(base, "init", "-q", `--separate-git-dir=${join(await scratch(t), "gitdir")}`, join(base, "separate"));
	const result = await discoverRepos(base);
	assert.deepEqual(result.repos.map(({ repo, linkedWorktree, submodule }) => ({ repo, linkedWorktree, submodule })), [
		{ repo: "linked", linkedWorktree: true, submodule: false },
		{ repo: "main", linkedWorktree: false, submodule: false },
		{ repo: "main/vendor/lib", linkedWorktree: false, submodule: true },
		{ repo: "separate", linkedWorktree: false, submodule: false },
	]);
	assert.deepEqual(result.issues, []);
});

test("discoverRepos returns the base itself and the repositories inside it", async (t) => {
	const root = await repository(join(await scratch(t), "repo"));
	const nested = await repository(join(root, "nested"));
	assert.deepEqual((await discoverRepos(root)).repos, [
		{ repo: ".", root, linkedWorktree: false, submodule: false },
		{ repo: "nested", root: nested, linkedWorktree: false, submodule: false },
	]);
});

test("discoverRepos searches a selected path and reports truncation", async (t) => {
	const base = await scratch(t);
	await repository(join(base, "a", "one"));
	await repository(join(base, "a", "two"));
	await repository(join(base, "b", "three"));
	assert.deepEqual((await discoverRepos(base, { path: "a" })).repos.map((repo) => repo.repo), ["a/one", "a/two"]);
	const limited = await discoverRepos(base, { limit: 1 });
	assert.equal(limited.repos.length, 1);
	assert.equal(limited.truncated, true);
	const narrow = await discoverRepos(base, { maxDirectories: 2 });
	assert.equal(narrow.truncated, true);
	let clock = 0;
	const slow = await discoverRepos(base, { budgetMs: 1, now: () => (clock += 5) });
	assert.equal(slow.truncated, true);
	await assert.rejects(discoverRepos(base, { path: "../x" }), RepoTargetError);
	await assert.rejects(discoverRepos(base, { maxDepth: 0 }), RangeError);
});

test("discoverRepos rejects a discovery path that contains a symlink", async (t) => {
	const base = await scratch(t);
	await repository(join(base, "real", "sub", "repo"));
	await symlink(join(base, "real"), join(base, "alias"));
	assert.deepEqual((await discoverRepos(base, { path: "real/sub" })).repos.map((repo) => repo.repo), ["real/sub/repo"]);
	for (const path of ["alias", "alias/sub"]) {
		await assert.rejects(discoverRepos(base, { path }), (error: Error) => error instanceof RepoTargetError && /symlink alias/.test(error.message), path);
	}
});

test("discoverRepos caps each Git call at the remaining budget", async (t) => {
	const base = await scratch(t);
	await mkdir(join(base, "a", ".git"), { recursive: true });
	await mkdir(join(base, "b", ".git"), { recursive: true });
	let clock = 0;
	const timeouts: Array<number | null | undefined> = [];
	const runner: Exec = async (_command, _args, options) => {
		timeouts.push(options.timeoutMs);
		clock += 150;
		return { code: 0, killed: false, stdout: `${options.cwd}\n`, stderr: "" };
	};
	const result = await discoverRepos(base, { budgetMs: 100, now: () => clock, runProcess: runner });
	assert.deepEqual(timeouts, [100]);
	assert.deepEqual(result.repos.map((repo) => repo.repo), ["a"]);
	assert.equal(result.truncated, true);
});

test("discoverRepos changes no Git state", async (t) => {
	const base = await scratch(t);
	const root = await repository(join(base, "repo"));
	await writeFile(join(root, "untracked"), "x");
	const before = git(root, "status", "--porcelain=v2", "--branch");
	await discoverRepos(base);
	assert.equal(git(root, "status", "--porcelain=v2", "--branch"), before);
});
