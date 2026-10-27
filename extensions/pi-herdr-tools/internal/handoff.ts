import { realpath } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrClient, herdrCommandFailure } from "@hcflabs/pi-herdr";
import { discoverRepos, gitTopLevel, resolveRepoTarget, type RepoOptions } from "@hcflabs/pi-repo";
import { Type } from "typebox";
import {
	createWorktree,
	errorMessage,
	launchPiAgent,
	prepareWorktreeLaunch,
	requiredString,
	resolveWorkspace,
	worktreeParentWorkspace,
} from "./worktree.ts";

const PROMPT_TIMEOUT_MS = 30_000;
// An error message lists at most this many repo selectors, and searches for them for at most this long.
const MAX_SELECTORS = 20;
const SELECTOR_SEARCH_MS = 5_000;
const TEXT_LIMIT = 300;

const bounded = (text: string) => text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}...` : text;

const nonEmpty = (description: string) => Type.String({ description, minLength: 1, pattern: "\\S" });

const HandoffParams = Type.Object({
	branch: nonEmpty("New Git branch for the worktree, created from local main"),
	label: nonEmpty("Short Herdr workspace label"),
	// Herdr agent names must match this pattern; checking it here fails before any mutation.
	agentName: Type.String({
		description: "Unique Herdr agent name for the new Pi agent: lowercase letter, then up to 31 of a-z, 0-9, _ or -",
		pattern: "^[a-z][a-z0-9_-]{0,31}$",
	}),
	prompt: nonEmpty("Self-contained task prompt for the new agent"),
	repo: Type.Optional(nonEmpty(
		"Git repository for the worktree, as a path relative to the Pi working directory. Use . for the working directory itself when it is a Git top-level directory. Omit it to use the repository of the current Herdr workspace, or the working directory when the workspace has no Git checkout and the working directory is a Git top-level directory.",
	)),
});

/** Register `herdr_handoff` only inside Herdr, where it can run. */
export default function herdrHandoffExtension(pi: ExtensionAPI): void {
	if (process.env.HERDR_ENV !== "1") return;
	const herdr = createHerdrClient<{ cwd: string }>(pi.exec.bind(pi));

	pi.registerTool({
		name: "herdr_handoff",
		label: "Herdr Handoff",
		description: "Create a Herdr worktree from local main, start Pi in it, and submit a self-contained task prompt. Focus does not change.",
		promptSnippet: "Hand off a separate task to a new Pi agent in a new Herdr worktree from local main",
		promptGuidelines: [
			"Use herdr_handoff for a separate task that the user authorized, for example through /handoff-worktree. A handoff has no checked integration: the new agent works unsupervised.",
			"When the Pi working directory is not a Git repository, or holds several repositories, set repo to the child repository of the task. herdr_handoff never selects a child repository automatically.",
		],
		parameters: HandoffParams,
		executionMode: "sequential",

		async execute(_toolCallId, { branch, label, agentName, prompt, repo }, signal, _onUpdate, ctx) {
			const paneId = requiredString(process.env.HERDR_PANE_ID, "HERDR_PANE_ID");
			const git = (cwd: string, args: string[]) => pi.exec("git", args, { cwd });
			const repoOptions: RepoOptions = {
				signal,
				runProcess: (command, args, options) => pi.exec(command, args, { cwd: options.cwd, signal: options.signal, timeout: options.timeoutMs ?? undefined }),
			};
			/** List the repo values below the Pi working directory. A failed search adds no text. */
			const selectorHint = async (): Promise<string> => {
				try {
					const found = await discoverRepos(ctx.cwd, { ...repoOptions, limit: MAX_SELECTORS, budgetMs: SELECTOR_SEARCH_MS });
					if (found.repos.length === 0) return `Discovery found no Git repository below ${found.base}.`;
					return `Repositories below ${found.base}: ${found.repos.map((item) => bounded(item.repo)).join(", ")}.${found.truncated ? " The list may be incomplete." : ""}`;
				} catch {
					return "";
				}
			};
			const needRepo = async (reason: string) =>
				new Error(`herdr_handoff: ${reason} Set the repo parameter to a Git repository, as a path relative to ${ctx.cwd}. ${await selectorHint()} Nothing was created.`);
			const repository = async (cwd: string): Promise<string> => {
				const result = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
				if (result.code === 0 && !result.killed) return result.stdout.trim();
				// Only a second check that finds no Git directory means "not a repository". Any other failure keeps its exit code.
				const top = result.killed ? "failed" : await gitTopLevel(cwd, repoOptions).catch(() => "failed");
				if (top === undefined) {
					if (cwd === ctx.cwd) throw await needRepo(`${cwd} is not in a Git repository.`);
					throw new Error(`herdr_handoff: ${cwd} is not in a Git repository; nothing was created.`);
				}
				const stderr = result.stderr.trim();
				const outcome = result.killed ? `did not finish in ${cwd}` : `failed in ${cwd} with exit ${result.code}`;
				throw new Error(`herdr_handoff: git rev-parse --git-common-dir ${outcome}${stderr ? `: ${bounded(stderr)}` : ""}. Nothing was created.`);
			};
			let gitCwd: string;
			let location: string[];
			if (repo === undefined) {
				const workspace = await resolveWorkspace(herdr, ctx.cwd, paneId);
				if (!workspace.checkout) {
					// A plain workspace has no checkout to branch from. A working directory that is a Git top-level directory is the repository.
					const top = await gitTopLevel(ctx.cwd, repoOptions).catch((error: unknown) => {
						throw new Error(`herdr_handoff: ${errorMessage(error)} Nothing was created.`, { cause: error });
					});
					if (top === undefined || top !== await realpath(ctx.cwd)) {
						throw await needRepo(`Herdr workspace ${workspace.workspaceId} has no Git checkout, and ${ctx.cwd} is not a Git top-level directory${top === undefined ? "" : ` (Git reports ${top})`}.`);
					}
					gitCwd = top;
					location = ["--cwd", top];
				} else {
					// The worktree comes from the pane's workspace, so it must be the repository checked here.
					if (await repository(ctx.cwd) !== await repository(workspace.checkout)) {
						throw new Error(`herdr_handoff: ${ctx.cwd} and Herdr workspace ${workspace.workspaceId} (${workspace.checkout}) are different Git repositories; nothing was created.`);
					}
					gitCwd = ctx.cwd;
					location = ["--workspace", await worktreeParentWorkspace(herdr, ctx.cwd, workspace)];
				}
			} else {
				// Herdr opens or creates the repository's primary workspace when it gets --cwd.
				const target = await resolveRepoTarget(ctx.cwd, repo, repoOptions).catch((error: unknown) => {
					throw new Error(`herdr_handoff: ${errorMessage(error)} Nothing was created.`, { cause: error });
				});
				gitCwd = target.root;
				location = ["--cwd", target.root];
			}
			const main = await git(gitCwd, ["rev-parse", "--verify", "--quiet", "refs/heads/main"]);
			if (main.code !== 0 || main.killed) {
				throw new Error(`herdr_handoff requires a local main branch in ${gitCwd}; nothing was created.`);
			}
			// Herdr checks out an existing branch instead of creating it from --base.
			const existing = await git(gitCwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
			if (existing.code !== 1 || existing.killed) {
				throw new Error(`herdr_handoff: branch ${branch} already exists or could not be checked; choose a new branch. Nothing was created.`);
			}

			signal?.throwIfAborted();
			const worktree = await createWorktree(herdr, ctx.cwd, [
				"worktree", "create", ...location,
				"--branch", branch, "--base", "main", "--label", label, "--no-focus",
			], "Handoff");
			const { workspaceId, checkoutPath } = worktree;
			const { target, onPaneBusy } = await prepareWorktreeLaunch(herdr, ctx.cwd, worktree).catch((error: unknown) => {
				throw new Error(
					`Handoff launch preparation failed; retained Herdr workspace ${workspaceId}, tab ${worktree.tabId}, root pane ${worktree.rootPaneId}, branch ${branch}, checkout ${checkoutPath}: ${errorMessage(error)}`,
					{ cause: error },
				);
			});
			const retained = () =>
				`Herdr workspace ${workspaceId}, tab ${target.tabId}, pane ${target.paneId}, branch ${branch}, checkout ${checkoutPath}`;
			if (signal?.aborted) throw new Error(`Handoff was cancelled before agent start; retained ${retained()}.`);
			await launchPiAgent(herdr, ctx.cwd, { action: "Handoff", name: agentName, pane: target.paneId, args: [], retained, onPaneBusy });

			const promptArgs = [
				"agent", "prompt", agentName, prompt, "--wait", "--until", "working", "--timeout", String(PROMPT_TIMEOUT_MS),
			];
			if (signal?.aborted) throw new Error(`Handoff was cancelled before prompt delivery; retained ${retained()}, and agent ${agentName}.`);
			const delivered = await herdr.exec(promptArgs, { cwd: ctx.cwd });
			if (delivered.code !== 0 || delivered.killed) {
				throw new Error(
					`Handoff prompt was not confirmed for agent ${agentName}; retained ${retained()}, and agent ${agentName}: ${herdrCommandFailure(promptArgs, delivered)}`,
				);
			}

			const details = { workspaceId, tabId: target.tabId, paneId: target.paneId, branch, checkoutPath, agentName, ...(repo === undefined ? {} : { repo }) };
			return {
				content: [{
					type: "text" as const,
					text: `Handed off to agent ${agentName}, which is working in Herdr workspace ${workspaceId} (tab ${target.tabId}, pane ${target.paneId}, branch ${branch}, checkout ${checkoutPath}). Focus did not change.`,
				}],
				details,
			};
		},
	});
}
