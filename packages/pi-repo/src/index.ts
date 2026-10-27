import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { spawnBounded, type Exec } from "@hcflabs/pi-process";

const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_DEPTH = 3;
const MAX_DEPTH_LIMIT = 8;
const DEFAULT_LIMIT = 200;
const LIMIT_CAP = 1_000;
const DEFAULT_MAX_DIRECTORIES = 5_000;
const DEFAULT_BUDGET_MS = 30_000;
const DETAIL_LIMIT = 500;
const GIT_FILE_READ_BYTES = 4_096;
const EXCLUDED_NAMES = new Set([".git", ".worktrees", "node_modules", ".terraform", "venv", ".venv"]);
const EXCLUDED_PREFIXES = [".scratch-"];

/** Options for each Git call. */
export interface RepoOptions {
	/** Runs Git. The default is `spawnBounded` from `@hcflabs/pi-process`. */
	runProcess?: Exec;
	/** Stops the operation. */
	signal?: AbortSignal;
	/** Time limit for one Git call, in milliseconds. The default is 10 000. */
	timeoutMs?: number;
}

/** A validated Git top-level directory inside a base directory. */
export interface RepoTarget {
	/** The selector relative to `base`, with `/` separators. `.` means `base` itself. */
	repo: string;
	/** The real path of the Git top-level directory. */
	root: string;
	/** The real path of the base directory. */
	base: string;
}

/** A Repository target that discovery found. */
export interface DiscoveredRepo {
	repo: string;
	root: string;
	/** True when `.git` is a file that points into `worktrees/` of another Git directory. */
	linkedWorktree: boolean;
	/** True when `.git` is a file that points into `modules/` of another Git directory. */
	submodule: boolean;
}

/** A directory that discovery could not examine or verify. */
export interface DiscoveryIssue {
	/** The path relative to the base directory. */
	path: string;
	reason: string;
}

export interface DiscoveryOptions extends RepoOptions {
	/** The directory to search, relative to the base directory. The default is `.`. */
	path?: string;
	/** The number of directory levels below `path` to examine. The default is 3. The maximum is 8. */
	maxDepth?: number;
	/** The maximum number of repositories to return. The default is 200. The maximum is 1 000. */
	limit?: number;
	/** The maximum number of directories to examine. The default is 5 000. */
	maxDirectories?: number;
	/** The total time limit, in milliseconds. The default is 30 000. */
	budgetMs?: number;
	/** More directory names to skip. */
	exclude?: readonly string[];
	/** Returns the current time in milliseconds. Tests use it. */
	now?: () => number;
}

export interface RepoDiscovery {
	base: string;
	repos: DiscoveredRepo[];
	issues: DiscoveryIssue[];
	/**
	 * True when a limit stopped the search before it examined all directories.
	 * The limits are `maxDepth`, `maxDirectories`, `limit`, and `budgetMs`.
	 * A directory at `maxDepth` that has child directories sets it, because discovery does not open those children.
	 * A directory at `maxDepth` inside a found repository does not set it.
	 */
	truncated: boolean;
}

/** An invalid Repository target selector. Git inspection failures use a plain `Error`. */
export class RepoTargetError extends Error {
	override name = "RepoTargetError";
}

/** Return true when `candidate` is `root` or a path below it. Both paths must be absolute and normalized. */
export function isWithin(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function selector(base: string, path: string): string {
	return relative(base, path).split(sep).join("/") || ".";
}

function detail(result: { stdout: string; stderr: string }): string {
	return (result.stderr || result.stdout).trim().slice(0, DETAIL_LIMIT);
}

function exactRootLine(stdout: string): string {
	const match = /^([^\r\n\0]+)(?:\r?\n)?$/.exec(stdout);
	if (!match || !isAbsolute(match[1]!)) throw new Error("Git returned a malformed repository root.");
	// Git for Windows reports `C:/repo`. Normalize the spelling, then compare real paths.
	return normalize(match[1]!);
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
		throw error;
	}
}

async function hasRepositoryMarker(start: string): Promise<boolean> {
	for (let directory = start; ; directory = dirname(directory)) {
		if (await exists(join(directory, ".git"))) return true;
		if (dirname(directory) === directory) return false;
	}
}

function positiveInteger(value: number | undefined, fallback: number, cap: number, label: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > cap) {
		throw new RangeError(`${label} must be an integer from 1 to ${cap}.`);
	}
	return value;
}

/**
 * Return the real path of the Git top-level directory that contains `cwd`.
 * Return `undefined` only when Git fails, `cwd` and its parents have no `.git` entry,
 * and a second Git check that ignores ownership finds no Git directory.
 * Other Git failures throw, for example a timeout, an ownership error, a bare repository, or malformed output.
 * The check does not read Git messages, so it does not depend on the Git locale.
 */
export async function gitTopLevel(cwd: string, options: RepoOptions = {}): Promise<string | undefined> {
	const runProcess = options.runProcess ?? spawnBounded;
	const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
	options.signal?.throwIfAborted();
	const canonicalCwd = await realpath(cwd);
	const result = await runProcess("git", ["rev-parse", "--show-toplevel"], {
		cwd: canonicalCwd,
		signal: options.signal,
		timeoutMs,
	});
	options.signal?.throwIfAborted();
	if (result.killed) throw new Error(`git rev-parse --show-toplevel did not finish in ${canonicalCwd}.`);
	if (result.code !== 0) {
		const environment = process.env.GIT_DIR !== undefined || process.env.GIT_WORK_TREE !== undefined;
		if (!environment && !(await hasRepositoryMarker(canonicalCwd))) {
			// A bare repository or an ownership block has no `.git` entry. Ask Git for a Git directory without the ownership check.
			const probe = await runProcess("git", ["-c", "safe.directory=*", "rev-parse", "--git-dir"], {
				cwd: canonicalCwd,
				signal: options.signal,
				timeoutMs,
			});
			options.signal?.throwIfAborted();
			if (probe.killed) throw new Error(`git rev-parse --git-dir did not finish in ${canonicalCwd}.`);
			if (probe.code !== 0) return undefined;
		}
		const text = detail(result);
		throw new Error(`git rev-parse --show-toplevel failed in ${canonicalCwd} with exit ${result.code}${text ? `: ${text}` : ""}`);
	}
	const root = await realpath(exactRootLine(result.stdout));
	options.signal?.throwIfAborted();
	if (!isWithin(root, canonicalCwd)) {
		throw new Error(`Git reported ${root}, which does not contain ${canonicalCwd}.`);
	}
	return root;
}

function relativeSelector(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
		throw new RepoTargetError(`${label} must be a non-empty relative path without control characters.`);
	}
	if (isAbsolute(value)) throw new RepoTargetError(`${label} must be a relative path, not ${value}.`);
	if (value.split(/[\\/]/).includes("..")) throw new RepoTargetError(`${label} must not contain a .. component.`);
	return value;
}

async function containedDirectory(base: string, value: string, label: string): Promise<string> {
	let path: string;
	try {
		path = await realpath(join(base, value));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") throw new RepoTargetError(`${label} ${value} does not exist in ${base}.`);
		throw error;
	}
	if (!isWithin(base, path)) throw new RepoTargetError(`${label} ${value} resolves to ${path}, which is outside ${base}.`);
	if (!(await lstat(path)).isDirectory()) throw new RepoTargetError(`${label} ${value} is not a directory.`);
	return path;
}

/**
 * Validate `repo` as a Repository target inside `base`.
 * The target must be a relative path without `..`, stay inside `base` after symlink resolution,
 * and be equal to its Git top-level directory.
 * Selector errors throw `RepoTargetError`. Git inspection errors throw a plain `Error`.
 */
export async function resolveRepoTarget(base: string, repo: string, options: RepoOptions = {}): Promise<RepoTarget> {
	const value = relativeSelector(repo, "repo");
	options.signal?.throwIfAborted();
	const canonicalBase = await realpath(base);
	const path = await containedDirectory(canonicalBase, value, "Repository target");
	const root = await gitTopLevel(path, options);
	if (root === undefined) throw new RepoTargetError(`Repository target ${value} is not in a Git repository.`);
	if (root !== path) {
		throw new RepoTargetError(`Repository target ${value} is not a Git top-level directory. Git reports ${root}.`);
	}
	return { repo: selector(canonicalBase, root), root, base: canonicalBase };
}

/** Resolve a discovery path without following any symlink in it. `base` must be a real path. */
async function discoveryStart(base: string, value: string): Promise<string> {
	let path = base;
	for (const part of value.split(/[\\/]/)) {
		if (part === "" || part === ".") continue;
		path = join(path, part);
		let info;
		try {
			info = await lstat(path);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") throw new RepoTargetError(`Discovery path ${value} does not exist in ${base}.`);
			throw error;
		}
		if (info.isSymbolicLink()) {
			throw new RepoTargetError(`Discovery path ${value} contains the symlink ${selector(base, path)}. Discovery does not follow symlinks.`);
		}
		if (!info.isDirectory()) throw new RepoTargetError(`Discovery path ${value} is not a directory.`);
	}
	return path;
}

function excluded(name: string, extra: ReadonlySet<string>): boolean {
	return EXCLUDED_NAMES.has(name) || extra.has(name) || EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function reason(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, DETAIL_LIMIT);
}

/** Classify a `.git` file by the Git directory that it names: `worktrees/` is a linked worktree and `modules/` is a submodule. */
async function gitFileKind(gitFile: string): Promise<Pick<DiscoveredRepo, "linkedWorktree" | "submodule">> {
	let text = "";
	try {
		const handle = await open(gitFile, "r");
		try {
			const { buffer, bytesRead } = await handle.read(Buffer.alloc(GIT_FILE_READ_BYTES), 0, GIT_FILE_READ_BYTES, 0);
			text = buffer.toString("utf8", 0, bytesRead);
		} finally {
			await handle.close();
		}
	} catch {
		// Git already accepted this repository. An unreadable pointer only means that its kind is unknown.
	}
	const gitDir = /^gitdir:[ \t]*([^\r\n]+)/.exec(text)?.[1]?.trim().replaceAll("\\", "/") ?? "";
	// A worktree of a submodule names both directories. The `worktrees/` entry is the last one, so it wins.
	if (/(?:^|\/)worktrees\/[^/]+\/?$/.test(gitDir)) return { linkedWorktree: true, submodule: false };
	return { linkedWorktree: false, submodule: /(?:^|\/)modules\//.test(gitDir) };
}

/**
 * Find Git top-level directories below `base`.
 * The search does not follow symlinks. It also searches inside a repository that it found, for example for submodules.
 * A repository inside a repository counts toward `limit` and obeys `maxDepth` and `exclude`.
 * It changes no files and no Git state.
 */
export async function discoverRepos(base: string, options: DiscoveryOptions = {}): Promise<RepoDiscovery> {
	const maxDepth = positiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH, MAX_DEPTH_LIMIT, "maxDepth");
	const limit = positiveInteger(options.limit, DEFAULT_LIMIT, LIMIT_CAP, "limit");
	const maxDirectories = positiveInteger(options.maxDirectories, DEFAULT_MAX_DIRECTORIES, 100_000, "maxDirectories");
	const budgetMs = positiveInteger(options.budgetMs, DEFAULT_BUDGET_MS, 600_000, "budgetMs");
	const now = options.now ?? Date.now;
	const deadline = now() + budgetMs;
	const extra = new Set(options.exclude ?? []);
	options.signal?.throwIfAborted();
	const canonicalBase = await realpath(base);
	const start = options.path === undefined || options.path === "."
		? canonicalBase
		: await discoveryStart(canonicalBase, relativeSelector(options.path, "path"));

	const repos: DiscoveredRepo[] = [];
	const issues: DiscoveryIssue[] = [];
	// `inRepo` is true below a found repository. Its deep directories are normal repository content.
	const queue: Array<{ path: string; depth: number; inRepo: boolean }> = [{ path: start, depth: 0, inRepo: false }];
	let examined = 0;
	let truncated = false;
	// A directory at `maxDepth` that has child directories. Discovery does not open those children.
	let depthLimited = false;

	while (queue.length > 0) {
		options.signal?.throwIfAborted();
		if (examined >= maxDirectories || repos.length >= limit || now() > deadline) {
			truncated = true;
			break;
		}
		const { path, depth, inRepo } = queue.shift()!;
		examined += 1;
		const name = selector(canonicalBase, path);

		let marker: Awaited<ReturnType<typeof lstat>> | undefined;
		try {
			marker = await lstat(join(path, ".git"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				issues.push({ path: name, reason: reason(error) });
				continue;
			}
		}
		if (marker) {
			const remaining = deadline - now();
			if (remaining < 1) {
				truncated = true;
				break;
			}
			try {
				const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, remaining);
				const root = await gitTopLevel(path, { ...options, timeoutMs });
				if (root !== path) {
					issues.push({ path: name, reason: `has a .git entry, but Git reports ${root ?? "no repository"}` });
				} else {
					const kind = marker.isFile() ? await gitFileKind(join(path, ".git")) : { linkedWorktree: false, submodule: false };
					repos.push({ repo: name, root, ...kind });
				}
			} catch (error) {
				options.signal?.throwIfAborted();
				if (now() >= deadline) {
					truncated = true;
					break;
				}
				issues.push({ path: name, reason: reason(error) });
			}
		}
		// A repository can hold more repositories. Read its directories like those of any other directory.
		const atLimit = depth >= maxDepth;
		// Inside a repository, a directory at the limit does not set `truncated`, so it is not read.
		const below = inRepo || marker !== undefined;
		if (atLimit && (depthLimited || below)) continue;

		let entries;
		try {
			entries = await readdir(path, { withFileTypes: true });
		} catch (error) {
			issues.push({ path: name, reason: reason(error) });
			continue;
		}
		const children = entries
			.filter((entry) => entry.isDirectory() && !excluded(entry.name, extra))
			.map((entry) => entry.name)
			.sort(compare);
		if (atLimit) {
			if (children.length > 0) depthLimited = true;
			continue;
		}
		children.forEach((child) => queue.push({ path: join(path, child), depth: depth + 1, inRepo: below }));
	}

	repos.sort((left, right) => compare(left.repo, right.repo));
	issues.sort((left, right) => compare(left.path, right.path));
	return { base: canonicalBase, repos, issues, truncated: truncated || depthLimited };
}
