import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { open, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_MAX_BYTES, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrClient, hasHerdrErrorCode, herdrCommandFailure, startPiAgent } from "@hcflabs/pi-herdr";
import { utf8Prefix } from "./ephemeral.ts";
import type { PreparedRoleLaunch, ResolvedRoleLaunch } from "./index.ts";
import { assertPrivateLease, PI_SUBAGENT_PROCESS_LEASE, scanProcessLease } from "./process-lease.ts";
import { createSessionActivityReader, readSessionTurn, SESSION_LIMIT, type SessionToolActivity, type SessionUsage } from "./session-turn.ts";

const OPERATION_MS = 30_000;
/** The longest Herdr wait while the agent is idle or done and the session has no Final turn. */
const SETTLED_POLL_MS = 1000;
const WAIT_STATES = ["working", "idle", "done", "blocked", "unknown"] as const;
// Leave room for boundary instructions below Linux's 128 KiB per-argument limit.
const INLINE_TASK_BYTES = 64 * 1024;
const DIRECT_OUTCOMES = ["succeeded", "failed", "blocked"] as const;

/** The Role tool that reads a file-backed task packet, or undefined for an inline packet; throws when no tool can read it in full. */
export function directTaskReader(task: string, tools: readonly string[]): "read" | "bash" | undefined {
	if (Buffer.byteLength(task, "utf8") <= INLINE_TASK_BYTES) return;
	const longLine = task.split("\n").some((line) => Buffer.byteLength(line, "utf8") > DEFAULT_MAX_BYTES);
	if (tools.includes("read") && !longLine) return "read";
	if (tools.includes("bash")) return "bash";
	throw new Error(longLine
		? `Large direct task packet has a line above Pi read's ${DEFAULT_MAX_BYTES}-byte limit. Add bash to the Role or use lines within that limit; no worker was launched.`
		: "Large direct task packets require read or bash in the Role; no worker was launched.");
}

type Json = Record<string, unknown>;
const object = (value: unknown, label: string): Json => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Malformed Herdr ${label}.`);
	return value as Json;
};
const field = (value: unknown, label: string): string => {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Malformed Herdr ${label}.`);
	return value;
};
const result = (value: unknown, type: string): Json => {
	const response = object(object(value, "response").result, "result");
	if (response.type !== type) throw new Error(`Herdr returned an unexpected ${type} response.`);
	return response;
};

/** A prompt is accepted only with the exact pane, agent, cwd and turn identity. */
export interface DirectHandle {
	name: string;
	tabId: string;
	paneId: string;
	sessionFile: string;
	prompt: string;
	/** `text` is the exact answer; `inline` is bounded for Main, linking a private full copy when truncated. */
	answer(maxBytes: number): Promise<{ text: string; inline: string; answerFile?: string }>;
	usage(): Promise<DirectUsage>;
	/** Bounded assistant text from this turn so far; failure evidence only, never completion. */
	partialText(maxChars: number): Promise<string | undefined>;
	/** Display-only activity from the last usage() sample. */
	readonly activity?: DirectToolActivity;
	/** Focus the worker pane after Herdr confirms the exact launched agent still owns it. */
	focus(): Promise<void>;
	cancel(): Promise<void>;
}

const turnSuffix = (turn: string) => `\n\nTurn identity: ${turn}`;
/** Selects the user prompt text that carries the exact turn identity. */
export const directTurnPrompt = (turn: string) => (text: string) => text.endsWith(turnSuffix(turn));

/** Returns the answer of a successful Final turn. A write-access answer must be a succeeded JSON completion object. */
export function directCompletionAnswer(text: string, requireSuccess: boolean): string {
	if (!text.trim()) throw new Error("Pi persisted an empty final answer.");
	if (!requireSuccess) return text;
	let completion: Json;
	try { completion = JSON.parse(text) as Json; }
	catch (error) { throw new Error("Pi write-access final answer must be a JSON completion object.", { cause: error }); }
	if (!completion || typeof completion !== "object" || Array.isArray(completion)
		|| !DIRECT_OUTCOMES.some((outcome) => outcome === completion.outcome)
		|| typeof completion.answer !== "string" || !completion.answer.trim()) {
		throw new Error("Pi write-access completion must have a valid outcome and a non-empty answer.");
	}
	if (completion.outcome !== "succeeded") throw new Error(`Direct task reported ${completion.outcome}: ${completion.answer}`);
	return completion.answer;
}

export type DirectUsage = SessionUsage;
export type DirectToolActivity = SessionToolActivity;

/** `turn` is the prompt's random turn identity; it proves which session turn a record owns.
 * `workspaceId` and `cwd` bind the record to its launching Herdr workspace and checkout. */
export type DirectTab = Pick<DirectHandle, "name" | "tabId" | "paneId" | "sessionFile"> & { leasePath: string; turn: string; workspaceId: string; cwd: string };

/** Allocation evidence is not ownership and must never authorize pane mutation. */
export type DirectAllocation = Omit<DirectTab, "tabId" | "paneId"> & { label: string; tabId?: string; paneId?: string };
export class DirectAllocationError extends Error {
	readonly allocation: DirectAllocation;
	constructor(allocation: DirectAllocation, cause: unknown) {
		super(`Direct tab allocation is unverified: ${cause instanceof Error ? cause.message : String(cause)}. No agent start was dispatched. Inspect /subagent allocation evidence: workspace ${allocation.workspaceId}, cwd ${allocation.cwd}, label ${JSON.stringify(allocation.label)}, tab ${allocation.tabId ?? "unknown"}, pane ${allocation.paneId ?? "unknown"}, agent ${allocation.name}, session ${allocation.sessionFile}, lease ${allocation.leasePath}. Manual allocation reconciliation is required; do not replay creation or unlock admission.`, { cause });
		this.allocation = allocation;
	}
}

export function createDirectHerdr(pi: Pick<ExtensionAPI, "exec">, cwd: string, idleMs: number) {
	if (process.env.HERDR_ENV !== "1") throw new Error("Direct delegation requires a Herdr-managed Pi pane (HERDR_ENV=1).");
	const workspaceId = field(process.env.HERDR_WORKSPACE_ID, "HERDR_WORKSPACE_ID");
	const callerPane = field(process.env.HERDR_PANE_ID, "HERDR_PANE_ID");
	const workingDir = realpathSync(cwd);
	const herdr = createHerdrClient(pi.exec.bind(pi));
	const options = (signal?: AbortSignal) => ({ cwd: workingDir, timeout: OPERATION_MS, ...(signal ? { signal } : {}) });
	const inspect = (value: unknown, type: string, name: string, paneId: string, tabId: string) => {
		const agent = object(result(value, type).agent, "agent");
		if (agent.name !== name || agent.pane_id !== paneId || agent.tab_id !== tabId || agent.workspace_id !== workspaceId
			|| agent.cwd !== workingDir || agent.interactive_ready !== true) {
			throw new Error("Herdr agent identity or readiness did not match its verified launch.");
		}
		return field(agent.agent_status, "agent state");
	};
	return {
		workspaceId,
		cwd: workingDir,
		/** Close only an exact owned pane, then prove it and its leased children stopped.
		 * A task result or Ctrl-C acknowledgement is not termination evidence.
		 * `settledOnly` refuses to close a listed agent that is not idle or done. */
		async stop(tab: Pick<DirectTab, "name" | "tabId" | "paneId" | "leasePath">, current: () => boolean = () => true, settledOnly = false): Promise<void> {
			const requireCurrent = () => { if (!current()) throw new Error("Direct task scope changed; reopen /subagent."); };
			requireCurrent();
			await assertPrivateLease(tab.leasePath, false);
			const listed = result(await herdr.json(["agent", "list"], options()), "agent_list");
			if (!Array.isArray(listed.agents)) throw new Error("Malformed Herdr agent list.");
			const related = listed.agents.map((value) => {
				const agent = object(value, "listed agent");
				for (const key of ["pane_id", "tab_id"]) field(agent[key], `listed agent ${key}`);
				return agent;
			}).filter((agent) => agent.name === tab.name || agent.pane_id === tab.paneId || agent.tab_id === tab.tabId);
			const panes = async () => {
				const list = result(await herdr.json(["pane", "list", "--workspace", workspaceId], options()), "pane_list");
				if (!Array.isArray(list.panes)) throw new Error("Malformed Herdr pane list.");
				return list.panes.map((value) => {
					const pane = object(value, "listed pane");
					for (const key of ["pane_id", "tab_id"]) field(pane[key], `listed pane ${key}`);
					if (pane.workspace_id !== workspaceId) throw new Error("Herdr pane list escaped the owned workspace.");
					return pane;
				});
			};
			if (related.length) {
				const agent = related[0]!;
				if (related.length !== 1 || agent.name !== tab.name || agent.pane_id !== tab.paneId
					|| agent.tab_id !== tab.tabId || agent.workspace_id !== workspaceId || agent.cwd !== workingDir
					|| tab.paneId === callerPane) throw new Error("Worker termination requires one exact owned agent, workspace, checkout, tab and pane match.");
				if (settledOnly && agent.agent_status !== "idle" && agent.agent_status !== "done") {
					throw new Error(`Herdr agent ${tab.name} is ${String(agent.agent_status)}, not idle or done; it was not closed`);
				}
				requireCurrent();
				result(await herdr.json(["pane", "close", tab.paneId], options()), "ok");
			}
			if ((await panes()).some((pane) => pane.pane_id === tab.paneId || pane.tab_id === tab.tabId)) {
				throw new Error(`Owned pane ${tab.paneId} is still present; termination is unproved.`);
			}
			for (let scan = 0; scan < 2; scan++) {
				const holders = await scanProcessLease(tab.leasePath, (args) => pi.exec("lsof", args, { cwd: workingDir, timeout: 3_000 }));
				if (holders.length) throw new Error(`Owned process lease ${tab.leasePath} still has holders: ${holders.join(", ")}. Stop those owned processes, then retry Close/cancel-and-release.`);
				if (scan === 0) await sleep(50);
			}
			requireCurrent();
		},
		/** `resume` reuses a stopped worker's saved session and private lease instead of a new temp directory. */
		async start(launch: ResolvedRoleLaunch & Pick<PreparedRoleLaunch, "tools">, name: string, label: string, task: string, signal: AbortSignal, onTab: (tab: DirectTab) => void, requireSuccess = false, resume?: Pick<DirectTab, "sessionFile" | "leasePath">): Promise<DirectHandle> {
			const reader = directTaskReader(task, launch.tools);
			const caller = result(await herdr.json(["pane", "current", "--current"], options(signal)), "pane_current");
			const pane = object(caller.pane, "calling pane");
			if (pane.pane_id !== callerPane || pane.workspace_id !== workspaceId) throw new Error("Herdr caller pane no longer matches the launching workspace.");
			if (Object.keys(launch.env).length) throw new Error("Direct Herdr launch cannot transfer Role environment overrides.");
			let sessionFile: string;
			let leasePath: string;
			if (resume) {
				({ sessionFile, leasePath } = resume);
				await assertPrivateLease(leasePath, false);
			} else {
				const sessionDir = await mkdtemp(join(tmpdir(), "pi-subagent-direct-"));
				sessionFile = join(sessionDir, "session.jsonl");
				leasePath = join(sessionDir, "process.lease");
				await writeFile(leasePath, "", { flag: "wx", mode: 0o600 });
				// Pi initializes an existing empty session in place and keeps its private mode.
				await (await open(sessionFile, "wx", 0o600)).close();
			}
			const turn = randomBytes(16).toString("hex");
			if (reader) {
				const taskFile = join(dirname(sessionFile), `task-${turn}.md`);
				await writeFile(taskFile, task, { flag: "wx", mode: 0o600 });
				task = `Use ${reader} to read the complete task packet at ${JSON.stringify(taskFile)}. Read all parts before you act; do not use a truncated preview. The file contains the full task and chain context. If you cannot read it in full, stop and report blocked work.`;
			}
			// Pi's native session is the exact answer channel. Herdr screen output is diagnostic only.
			const sessionArgs = launch.args.filter((arg) => arg !== "--no-session");
			if (sessionArgs.length !== launch.args.length - 1) throw new Error("Role launch must contain exactly one --no-session option.");
			signal.throwIfAborted();
			// Tab creation is bounded but not session-cancellable: Herdr may create it
			// before the CLI responds, and aborting the CLI loses the exact tab ID.
			const allocation: DirectAllocation = { name, workspaceId, cwd: workingDir, label, sessionFile, leasePath, turn };
			let tabId: string;
			let paneId: string;
			try {
				const response = await herdr.json(["tab", "create", "--workspace", workspaceId, "--cwd", workingDir, "--label", label, "--env", `${PI_SUBAGENT_PROCESS_LEASE}=${leasePath}`, "--no-focus"], options());
				const created = object(response.result, "tab allocation result");
				// Capture every returned ID before validation can fail. These are evidence,
				// not owned tabs; the caller retains this intent even without either ID.
				for (const [source, key, target] of [[created.tab, "tab_id", "tabId"], [created.root_pane, "pane_id", "paneId"]] as const) {
					if (source && typeof source === "object" && typeof (source as Json)[key] === "string") allocation[target] = (source as Json)[key] as string;
				}
				result(response, "tab_created");
				const tab = object(created.tab, "created tab");
				const workerPane = object(created.root_pane, "created pane");
				tabId = field(tab.tab_id, "tab id");
				paneId = field(workerPane.pane_id, "pane id");
				if (tab.workspace_id !== workspaceId || workerPane.workspace_id !== workspaceId || workerPane.tab_id !== tabId
					|| workerPane.cwd !== workingDir || tab.focused !== false || workerPane.focused !== false || paneId === callerPane) {
					throw new Error(`Herdr tab ${tabId} has unverified identity, cwd or focus; inspect it before retrying.`);
				}
			} catch (error) { throw new DirectAllocationError(allocation, error); }
			try {
				// Record the tab before the agent start can outlive an aborted launch.
				onTab({ name, tabId, paneId, sessionFile, leasePath, turn, workspaceId, cwd: workingDir });
				signal.throwIfAborted();
				const started = await startPiAgent(herdr, { name, pane: paneId,
					args: [...sessionArgs, "--session", sessionFile], options: options(signal), shouldRetry: () => false, freshPane: true });
				if (started.code !== 0 || started.killed) throw new Error(`Herdr agent start failed: ${started.stderr.slice(0, 1000)}`);
				if (inspect(JSON.parse(started.stdout), "agent_started", name, paneId, tabId) !== "idle") throw new Error("Herdr agent was not idle after start.");
				// A canceled start may have succeeded server-side; retain its tab but
				// never submit a new prompt after cancellation.
				signal.throwIfAborted();
				const completionInstruction = requireSuccess
					? `\n\nWrite-access completion: Return exactly one JSON object without Markdown, {"outcome":"succeeded","answer":"summary"}. outcome must be ${DIRECT_OUTCOMES.join(", ")}. Use succeeded only when the entire authorized task, including requested checks and commits, completed successfully; a failed mutation, unresolved partial work, or missing authorization must be failed or blocked, even if your Pi turn ends normally. Describe changes, checks, commit identity, remaining risks, and checkout status in answer.`
					: "";
				const prompt = `${task}\n\nDirect shared-checkout boundary: use only your Role's resources for the explicitly authorized task and scope. Writes and commits affect Main's existing checkout immediately; preserve unrelated files and staged changes. Do not create or manage worktrees, change branches, push, or perform external mutations without explicit task authorization. There is no isolated integration, automatic validation, or rollback. If instructions conflict or authorization is missing, stop and report it. Report changes, commit identity if any, checks, remaining risks, and checkout status; never claim isolated guarantees.${completionInstruction}${turnSuffix(turn)}`;
				// Native prompt without --wait acknowledges submission, not completion of the turn.
				const accepted = await herdr.json(["agent", "prompt", name, prompt], options(signal));
				const state = inspect(accepted, "agent_prompted", name, paneId, tabId);
				if (state === "blocked" || state === "unknown") throw new Error(`Herdr agent became ${state}; inspect it before retrying.`);
				const session = createSessionActivityReader(sessionFile, prompt);
				return {
				name, tabId, paneId, sessionFile, prompt,
				get activity() { return session.activity; },
				usage: session.usage,
				partialText: session.partialText,
				async answer(maxBytes) {
					// The session decides completion. Herdr idle or done only starts a read.
					const settledAnswer = async () => {
						const final = await readSessionTurn(sessionFile, prompt, { signal });
						if (final.state === "absent" || final.state === "running") return undefined;
						if (final.state === "failed") throw new Error(`${final.failure}. Inspect tab ${tabId} and ${sessionFile} before retrying.`);
						const text = directCompletionAnswer(final.answer, requireSuccess);
						const bytes = Buffer.byteLength(text, "utf8");
						if (bytes <= maxBytes) return { text, inline: text };
						// An oversized exact answer still succeeds: Main gets a bounded prefix and a private full copy.
						// Exclusive creation refuses a worker-planted file, symlink, or FIFO at this predictable path.
						const file = join(dirname(sessionFile), `answer-${turn}.md`);
						await writeFile(file, text, { flag: "wx", mode: 0o600 });
						return { text, answerFile: file, inline: `${utf8Prefix(text, maxBytes)}\n\n[Answer truncated to ${maxBytes} of ${bytes} bytes; read the full answer at ${file}]` };
					};
					let current = state;
					let deadline = Date.now() + idleMs;
					let sessionSize = 0;
					const observeProgress = async () => {
						const info = await stat(sessionFile).catch((error: NodeJS.ErrnoException) => {
							if (error.code === "ENOENT") return undefined;
							throw error;
						});
						if (info && info.size > SESSION_LIMIT) throw new Error(`Pi session in tab ${tabId} exceeds 16 MiB; inspect ${sessionFile} for recovery.`);
						if (info && info.size > sessionSize) {
							sessionSize = info.size;
							deadline = Date.now() + idleMs;
						}
					};
					for (;;) {
						if (current !== "working" && current !== "idle" && current !== "done") {
							throw new Error(`Herdr agent in tab ${tabId} became ${current}; inspect it before retrying.`);
						}
						// A turn can finish before observation starts or between waits.
						// Pi can also omit an error turn and retry it while Herdr reports done.
						if (current !== "working") {
							const answer = await settledAnswer();
							if (answer !== undefined) return answer;
						}
						await observeProgress();
						const remaining = deadline - Date.now();
						if (remaining <= 0) throw new Error(`Herdr agent in tab ${tabId} made no progress for ${idleMs}ms; inspect ${sessionFile} before retrying.`);
						const args = ["agent", "wait", name,
							...WAIT_STATES.filter((until) => until !== current).flatMap((until) => ["--until", until]),
							"--timeout", String(Math.max(1, Math.min(current === "working" ? OPERATION_MS - 1000 : SETTLED_POLL_MS, remaining)))];
						const waited = await herdr.exec(args, options(signal));
						if (waited.code !== 0 || waited.killed) {
							if (!waited.killed && hasHerdrErrorCode(waited, "timeout")) continue;
							throw new Error(herdrCommandFailure(args, waited));
						}
						const next = inspect(JSON.parse(waited.stdout), "agent_info", name, paneId, tabId);
						if (next !== current) deadline = Date.now() + idleMs;
						current = next;
					}
				},
				async focus() {
					// A reused pane ID must not receive focus: the agent identity must match the launch first.
					inspect(await herdr.json(["agent", "get", paneId], options()), "agent_info", name, paneId, tabId);
					await herdr.json(["agent", "focus", paneId], options());
				},
				async cancel() {
					await herdr.json(["agent", "send-keys", name, "ctrl+c"], options());
				},
				};
			} catch (error) {
				if (signal.aborted) await herdr.exec(["agent", "send-keys", name, "ctrl+c"], options()).catch(() => undefined);
				throw new Error(`Direct launch in Herdr tab ${tabId} is not verified; inspect the agent and ${sessionFile} before retrying: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
			}
		},
	};
}
