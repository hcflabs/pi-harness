import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverRepos, gitTopLevel, resolveRepoTarget } from "@hcflabs/pi-repo";

const hookSourcePath = fileURLToPath(new URL("../hooks/post-checkout.mjs", import.meta.url));
const managedHookMarker = "pi-deps-managed-hook";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function toggleDependencyHook(
	commonGitDir: string,
	moveAside = rename, // test seam for races between the marker check and the move
): Promise<{ enabled: boolean; path: string }> {
	const source = await readFile(hookSourcePath, "utf8");
	const path = join(commonGitDir, "hooks", "post-checkout");
	let existing: string | undefined;
	try {
		existing = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	if (existing !== undefined) {
		if (!existing.includes(managedHookMarker)) {
			throw new Error(`Refusing to modify unmanaged Git hook: ${path}`);
		}
		// Rename first so the content check happens on the exact inode being removed.
		const staging = `${path}.pi-deps-${process.pid}-${randomUUID()}`;
		await moveAside(path, staging);
		let managed = false;
		try {
			managed = (await readFile(staging, "utf8")).includes(managedHookMarker);
		} finally {
			if (!managed) {
				// Restore unverified content without clobbering a hook created meanwhile.
				try {
					await link(staging, path);
				} catch (error) {
					throw new Error(`Cannot restore Git hook ${path}; its content remains at ${staging}`, { cause: error });
				}
				await rm(staging);
			}
		}
		if (!managed) throw new Error(`Refusing to modify unmanaged Git hook: ${path}`);
		await rm(staging);
		return { enabled: false, path };
	}

	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.pi-deps-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(temporary, source, { encoding: "utf8", flag: "wx" });
		await chmod(temporary, 0o755);
		await link(temporary, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`Refusing to modify Git hook created concurrently: ${path}`, { cause: error });
		}
		throw error;
	} finally {
		await rm(temporary, { force: true });
	}
	return { enabled: true, path };
}

const statusKey = "pi-deps";
const pollMs = 500;
const waitTimeoutMs = 10 * 60_000;
// The watcher accepts this many consecutive parse errors before it stops.
const maxParseFailures = 3;
const spinnerIntervalMs = 100;
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatElapsed(startedAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
	const minutes = Math.floor(seconds / 60);
	return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

interface InstallStatus {
	state?: string;
	message?: string;
}

// The absolute Git directory of `cwd`, or undefined when Git cannot find one.
async function gitDirectory(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const git = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd });
	return git.code !== 0 || git.killed ? undefined : git.stdout.trim();
}

// Watches the status file written by the background installer spawned by the post-checkout hook.
// It reads the Git directory of `cwd`. A session in a parent directory has none, so it watches nothing.
// First consumer wins: the status file is removed once reported.
async function watchDependencyInstallation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cwd: string,
	signal: AbortSignal,
): Promise<void> {
	if (ctx.mode !== "tui") return;
	const gitDir = await gitDirectory(pi, cwd);
	if (gitDir === undefined) return;
	const stateDir = join(gitDir, "pi-deps");
	const statusPath = join(stateDir, "status.json");
	let parseFailures = 0;
	// The "unreadable" state is local to the watcher. Its message holds the error code.
	const readStatus = async (): Promise<InstallStatus | undefined> => {
		let text: string;
		try {
			text = await readFile(statusPath, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return undefined;
			return { state: "unreadable", message: code ?? "unknown error" };
		}
		try {
			const status = JSON.parse(text) as InstallStatus;
			parseFailures = 0;
			return status;
		} catch {
			// A parse error can come from a partial write. Retry it for a short bound only.
			parseFailures++;
			return parseFailures < maxParseFailures ? { state: "running" } : { state: "unreadable", message: "SyntaxError" };
		}
	};

	let status = await readStatus();
	if (!status) return;
	signal.throwIfAborted();
	const startedAt = Date.now();
	const update = () => {
		const frame = spinnerFrames[Math.floor(Date.now() / spinnerIntervalMs) % spinnerFrames.length]!;
		ctx.ui.setStatus(statusKey, ctx.ui.theme.fg("dim", `${frame} deps · installing ${formatElapsed(startedAt)}`));
	};
	let timer: ReturnType<typeof setInterval> | undefined;
	try {
		if (status.state === "running") {
			update();
			timer = setInterval(update, spinnerIntervalMs);
			timer.unref();
		}
		const deadline = startedAt + waitTimeoutMs;
		while (status.state === "running" && Date.now() < deadline) {
			await delay(pollMs, undefined, { signal });
			status = await readStatus();
			if (!status) return;
		}
		signal.throwIfAborted();
		if (status.state === "unreadable") {
			// Keep the file so that the user can examine it.
			ctx.ui.setWidget(statusKey, [`pi-deps: cannot read status file ${statusPath}: ${status.message}`]);
			return;
		}
		await rm(statusPath, { force: true }); // consume so later sessions do not replay a stale outcome
		if (status.state === "error" || status.state === "running") {
			ctx.ui.setWidget(statusKey, [
				status.state === "error"
					? `pi-deps: install failed: ${status.message ?? "unknown error"}`
					: "pi-deps: stopped waiting for dependency installation after ten minutes; check the log.",
				`pi-deps: log: ${join(stateDir, "install.log")}`,
			]);
		}
	} finally {
		if (timer) clearInterval(timer);
		ctx.ui.setStatus(statusKey, undefined);
	}
}

// The repo list in the error message is bounded in count, in directories, and in time.
const maxListedRepos = 10;
const listSearch = { limit: maxListedRepos + 1, maxDirectories: 2_000, budgetMs: 5_000 };

// True only when `cwd` is not in a Git repository. Any other Git failure keeps its own message.
async function outsideGitRepository(cwd: string): Promise<boolean> {
	try {
		return (await gitTopLevel(cwd)) === undefined;
	} catch {
		return false;
	}
}

async function missingRepoError(cwd: string): Promise<Error> {
	const lead = `/deps needs a repo argument, because ${cwd} is not a Git repository. Run /deps <repo>.`;
	try {
		const found = await discoverRepos(cwd, listSearch);
		if (found.repos.length === 0) return new Error(`${lead} No repo found below it within the search limits.`);
		const more = found.repos.length > maxListedRepos || found.truncated;
		const names = found.repos.slice(0, maxListedRepos).map(({ repo }) => repo).join(", ");
		return new Error(`${lead} Repos found: ${names}${more ? ". More repos may exist. Name a repo by its path." : "."}`);
	} catch (error) {
		return new Error(`${lead} The repo search failed: ${errorMessage(error)}`, { cause: error });
	}
}

export default function depsExtension(pi: ExtensionAPI): void {
	let watcher: AbortController | undefined;
	const startWatcher = (ctx: ExtensionContext, cwd: string) => {
		watcher?.abort();
		const controller = watcher = new AbortController();
		void watchDependencyInstallation(pi, ctx, cwd, controller.signal).catch((error) => {
			if (!controller.signal.aborted) ctx.ui.notify(`pi-deps: ${errorMessage(error)}`, "error");
		});
	};
	pi.on("session_shutdown", () => watcher?.abort());
	pi.on("session_start", (_event, ctx) => startWatcher(ctx, ctx.cwd));
	pi.registerCommand("deps", {
		description: "Toggle dependency preparation for future Git worktrees. In a parent directory, name the repo: /deps <repo>",
		handler: async (args, ctx) => {
			const selector = args.trim();
			let cwd = ctx.cwd;
			if (selector) {
				// A selector is relative to the session directory and must name a Git top-level directory.
				try {
					cwd = (await resolveRepoTarget(ctx.cwd, selector)).root;
				} catch (error) {
					throw new Error(`Cannot select repo ${selector}: ${errorMessage(error)}`, { cause: error });
				}
			}
			const result = await pi.exec("git", ["rev-parse", "--git-common-dir", "--git-path", "hooks"], { cwd });
			if (result.code !== 0 || result.killed) {
				if (!selector && await outsideGitRepository(ctx.cwd)) throw await missingRepoError(ctx.cwd);
				throw new Error(`Cannot locate shared Git directory: ${result.stderr.trim() || `exit code ${result.code}`}`);
			}
			const [commonGitDir, hooksDir] = result.stdout.trim().split(/\r?\n/);

			// core.hooksPath replaces <commonGitDir>/hooks; refuse instead of writing where Git ignores or shares the hook.
			const defaultHooksDir = resolve(cwd, commonGitDir, "hooks");
			if (resolve(cwd, hooksDir) !== defaultHooksDir) {
				throw new Error(`Refusing non-default hooks directory (core.hooksPath?): ${hooksDir}; expected ${defaultHooksDir}`);
			}

			try {
				const toggled = await toggleDependencyHook(resolve(cwd, commonGitDir));
				ctx.ui.notify(
					`Dependency preparation ${toggled.enabled ? "enabled" : "disabled"}: ${toggled.path}`,
					"info",
				);
				// A session in a parent directory has no Git directory to watch. It watches the repo that /deps enabled.
				if (toggled.enabled && selector && await gitDirectory(pi, ctx.cwd) === undefined) startWatcher(ctx, cwd);
			} catch (error) {
				throw new Error(`Cannot toggle dependency preparation: ${errorMessage(error)}`, { cause: error });
			}
		},
	});
}
