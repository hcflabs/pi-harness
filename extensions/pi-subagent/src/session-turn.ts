import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

/** The largest worker session file that a reader accepts. */
export const SESSION_LIMIT = 16 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
/** Pi writes the omission of a retried error turn before its retry delay. A second read after this delay finds that omission. */
const ERROR_SETTLE_MS = 500;
const ERROR_MESSAGE_CHARS = 500;
const STOP_REASONS = ["stop", "length", "toolUse", "error", "aborted"] as const;
type StopReason = typeof STOP_REASONS[number];
export type FailedStopReason = Exclude<StopReason, "stop" | "toolUse">;

/** The prompt text, or a test that selects the prompt text of a user entry. */
export type PromptMatch = string | ((text: string) => boolean);

/**
 * The evidence of one worker prompt in its Pi session.
 * - `absent`: the file or the prompt entry does not exist.
 * - `running`: the prompt exists, but its branch has no Final turn.
 * - `succeeded`: the Final turn has the `stop` reason.
 * - `failed`: the Final turn has a `length`, `error`, or `aborted` reason.
 */
export type SessionTurn =
	| { state: "absent" }
	| { state: "running" }
	| { state: "succeeded"; stopReason: "stop"; answer: string }
	| { state: "failed"; stopReason: FailedStopReason; errorMessage?: string; failure: string };

export interface SessionTurnOptions {
	signal?: AbortSignal;
	/** Test only. Replaces the delay before the confirm read of an `error` Final turn. */
	settleMs?: number;
}

/** Each field is absent when no turn record carried it. */
export interface SessionUsage {
	tokens?: number;
	/** Sum of assistant `usage.cost.total`. */
	cost?: number;
}

export interface SessionToolActivity {
	pending: string[];
	latest?: { name: string; durationMs?: number };
}

export interface SessionActivityReader {
	usage(): Promise<SessionUsage>;
	/** Bounded assistant text of this prompt so far. This text is failure evidence only, never completion. */
	partialText(maxChars: number): Promise<string | undefined>;
	/** Display-only activity from the last usage() sample. */
	readonly activity?: SessionToolActivity;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const notPrivate = (path: string) => `Pi session file ${path} is not private, regular, or bounded`;
const tooLarge = (path: string) => new Error(`Pi session file ${path} exceeds the 16 MiB limit.`);

/** Opens a session file only when it is a regular file of the current user with mode 0600 or stricter. Returns undefined for a missing file. */
async function openPrivateSession(path: string): Promise<{ file: FileHandle; info: Stats } | undefined> {
	let file: FileHandle;
	try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		if (code === "ELOOP" || code === "EMLINK") throw new Error(`${notPrivate(path)}: it is a symbolic link.`, { cause: error });
		throw error;
	}
	try {
		const info = await file.stat();
		const uid = process.getuid?.();
		if (!info.isFile()) throw new Error(`${notPrivate(path)}: it is not a regular file.`);
		if ((info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid)) {
			throw new Error(`${notPrivate(path)}: it must belong to the current user and have mode 0600, with no group or other access.`);
		}
		if (info.size > SESSION_LIMIT) throw tooLarge(path);
		return { file, info };
	} catch (error) {
		await file.close();
		throw error;
	}
}

/** Reads a private session file in bounded chunks. Returns undefined for a missing file. */
export async function readPrivateSession(path: string): Promise<Buffer | undefined> {
	const opened = await openPrivateSession(path);
	if (!opened) return undefined;
	try {
		const chunks: Buffer[] = [];
		let bytes = 0;
		for (;;) {
			// The file can grow after the size check. Read one byte more than the limit to find that growth.
			const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, SESSION_LIMIT + 1 - bytes));
			const { bytesRead } = await opened.file.read(chunk, 0, chunk.length, null);
			if (!bytesRead) break;
			chunks.push(chunk.subarray(0, bytesRead));
			bytes += bytesRead;
			if (bytes > SESSION_LIMIT) throw tooLarge(path);
		}
		return Buffer.concat(chunks, bytes);
	} finally { await opened.file.close(); }
}

function parseLine(line: string, path: string, lineNumber: number): Json {
	let entry: unknown;
	try { entry = JSON.parse(line); } catch (error) {
		throw new Error(`Pi session file ${path} has a malformed entry on line ${lineNumber}.`, { cause: error });
	}
	if (!isObject(entry) || typeof entry.type !== "string") {
		throw new Error(`Pi session file ${path} has a malformed entry on line ${lineNumber}.`);
	}
	return entry;
}

const messageOf = (entry: Json): Json | undefined => entry.type === "message" && isObject(entry.message) ? entry.message : undefined;

function userText(entry: Json): string | undefined {
	const message = messageOf(entry);
	if (message?.role !== "user" || !Array.isArray(message.content) || message.content.length !== 1) return undefined;
	const part = message.content[0];
	return isObject(part) && part.type === "text" && typeof part.text === "string" ? part.text : undefined;
}

function entryId(entry: Json, path: string): string {
	if (typeof entry.id !== "string" || !entry.id) throw new Error(`Pi session file ${path} has an entry without an ID.`);
	return entry.id;
}

/** One read of the session text. `finalId` identifies the Final turn entry. */
function evaluateTurn(text: string, path: string, prompt: PromptMatch): { turn: SessionTurn; finalId?: string } {
	const matches = typeof prompt === "string" ? (value: string) => value === prompt : prompt;
	// Pi can still write the last line. Only a line that ends with a newline is complete.
	const lines = text.split("\n").slice(0, -1);
	const entries = lines.map((line, index) => parseLine(line, path, index + 1)).filter((entry) => entry.type !== "session");
	let promptIndex = -1;
	entries.forEach((entry, index) => {
		const value = userText(entry);
		if (value !== undefined && matches(value)) promptIndex = index;
	});
	if (promptIndex < 0) return { turn: { state: "absent" } };
	if (entries.slice(promptIndex + 1).some((entry) => messageOf(entry)?.role === "user")) {
		throw new Error(`Pi session file ${path} contains an unexpected user turn after the worker prompt.`);
	}
	const byId = new Map<string, Json>();
	for (const entry of entries) byId.set(entryId(entry, path), entry);
	// All entry types link the branch. The latest entry is the leaf of the active branch.
	const promptEntry = entries[promptIndex]!;
	const branch: Json[] = [];
	const seen = new Set<Json>();
	let current: Json | undefined = entries.at(-1);
	while (current && current !== promptEntry && !seen.has(current)) {
		seen.add(current);
		branch.push(current);
		current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
	}
	if (current !== promptEntry) return { turn: { state: "running" } };
	branch.reverse();
	// The latest edit for a target on the branch wins. A null replacement omits the target.
	const edits = new Map<string, unknown>();
	for (const entry of branch) {
		if (entry.type !== "context_edit") continue;
		if (typeof entry.targetId !== "string" || !("replacement" in entry)) {
			throw new Error(`Pi session file ${path} has a malformed context_edit entry.`);
		}
		edits.set(entry.targetId, entry.replacement);
	}
	let final: Json | undefined;
	for (const entry of branch) {
		if (messageOf(entry)?.role === "assistant" && edits.get(entryId(entry, path)) !== null) final = entry;
	}
	if (!final) return { turn: { state: "running" } };
	const message = messageOf(final)!;
	const reason = message.stopReason;
	if (!STOP_REASONS.some((known) => known === reason)) {
		throw new Error(`Pi session file ${path} has an assistant entry with an unknown stop reason.`);
	}
	const finalId = entryId(final, path);
	if (reason === "toolUse") return { turn: { state: "running" }, finalId };
	if (reason === "stop") {
		if (!Array.isArray(message.content)) throw new Error(`Pi session file ${path} has an assistant entry without content.`);
		const answer = message.content.flatMap((part) => isObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
		return { turn: { state: "succeeded", stopReason: "stop", answer }, finalId };
	}
	const stopReason = reason as FailedStopReason;
	const detail = typeof message.errorMessage === "string" && message.errorMessage.trim()
		? Array.from(message.errorMessage.trim()).slice(0, ERROR_MESSAGE_CHARS).join("") : undefined;
	return {
		turn: { state: "failed", stopReason, ...(detail === undefined ? {} : { errorMessage: detail }),
			failure: `Pi ended the worker turn with stop reason "${stopReason}"${detail === undefined ? "" : `: ${detail}`}` },
		finalId,
	};
}

async function readTurnOnce(path: string, prompt: PromptMatch): Promise<{ turn: SessionTurn; finalId?: string }> {
	const data = await readPrivateSession(path);
	return data === undefined ? { turn: { state: "absent" } } : evaluateTurn(data.toString("utf8"), path, prompt);
}

/**
 * Reads the Final turn of the exact worker prompt from its private Pi session file.
 * An `error` Final turn is a failure only when a second read after about 500 ms shows the same unomitted entry.
 * Throws for a file that is not private, larger than 16 MiB, or malformed, or that has a later user turn.
 */
export async function readSessionTurn(path: string, prompt: PromptMatch, options: SessionTurnOptions = {}): Promise<SessionTurn> {
	let read = await readTurnOnce(path, prompt);
	for (;;) {
		if (read.turn.state !== "failed" || read.turn.stopReason !== "error") return read.turn;
		// Pi can omit the error turn and retry it after Herdr reports the agent done.
		await sleep(options.settleMs ?? ERROR_SETTLE_MS, undefined, options.signal ? { signal: options.signal } : undefined);
		const next = await readTurnOnce(path, prompt);
		if (next.turn.state === "failed" && next.turn.stopReason === "error" && next.finalId === read.finalId) return next.turn;
		read = next;
	}
}

class ActivityState {
	private active = false;
	private total = 0;
	private observed = false;
	private cost: number | undefined;
	private pending = new Map<string, string>();
	private latest: SessionToolActivity["latest"];
	private texts: string[] = [];
	private prompt: string;

	constructor(prompt: string) { this.prompt = prompt; }

	consume(entry: Json): void {
		const message = messageOf(entry);
		if (!message) return;
		if (message.role === "user") {
			this.active = userText(entry) === this.prompt;
			if (this.active) {
				this.total = 0; this.observed = false; this.cost = undefined; this.pending.clear(); this.latest = undefined;
				this.texts = [];
			}
		} else if (this.active && message.role === "assistant") {
			if (isObject(message.usage)) {
				const usage = message.usage;
				const values = [usage.input, usage.output];
				if (values.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
					this.total += (values as number[]).reduce((sum, value) => sum + value, 0);
					this.observed = true;
				}
				const cost = isObject(usage.cost) ? usage.cost.total : undefined;
				if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) this.cost = (this.cost ?? 0) + cost;
			}
			if (Array.isArray(message.content)) for (const part of message.content) {
				if (!isObject(part)) continue;
				if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
					this.pending.set(part.id, part.name);
				} else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
					this.texts.push(part.text);
				}
			}
		} else if (this.active && message.role === "toolResult" && typeof message.toolCallId === "string") {
			const name = this.pending.get(message.toolCallId);
			if (name !== undefined) {
				this.pending.delete(message.toolCallId);
				this.latest = { name };
				if (typeof message.durationMs === "number" && Number.isFinite(message.durationMs) && message.durationMs >= 0) {
					this.latest.durationMs = message.durationMs;
				}
			}
		}
	}

	usage(): SessionUsage & { activity?: SessionToolActivity } {
		return { tokens: this.observed ? this.total : undefined, cost: this.cost,
			activity: this.pending.size || this.latest ? { pending: [...this.pending.values()], latest: this.latest } : undefined };
	}

	partialText(maxChars: number): string | undefined {
		const chars = Array.from(this.texts.join("\n").trim());
		if (!chars.length) return undefined;
		return chars.length <= maxChars ? chars.join("") : `…${chars.slice(-maxChars).join("")}`;
	}
}

/**
 * Samples live usage, tool activity, and partial text of the exact prompt.
 * Each sample parses only the complete lines after the last byte offset.
 * A replaced, shrunk, or rewritten file starts a new parse from byte 0.
 */
export function createSessionActivityReader(path: string, prompt: string): SessionActivityReader {
	let offset = 0;
	let lineNumber = 0;
	let previous: Stats | undefined;
	let state = new ActivityState(prompt);
	let lastUsage: SessionUsage & { activity?: SessionToolActivity } = {};
	let reading: Promise<void> | undefined;
	const reset = () => { offset = 0; lineNumber = 0; previous = undefined; state = new ActivityState(prompt); };
	const read = async () => {
		let opened;
		try { opened = await openPrivateSession(path); }
		catch (error) { reset(); throw error; }
		if (!opened) { reset(); return; }
		const { file, info } = opened;
		try {
			if (previous && (info.dev !== previous.dev || info.ino !== previous.ino || info.size < previous.size
				|| (info.size === previous.size && (info.mtimeMs !== previous.mtimeMs || info.ctimeMs !== previous.ctimeMs)))) reset();
			previous = info;
			const buffer = Buffer.alloc(info.size - offset);
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await file.read(buffer, length, Math.min(CHUNK_BYTES, buffer.length - length), offset + length);
				if (!bytesRead) break;
				length += bytesRead;
			}
			// Only complete lines advance the offset. A malformed complete line stops the parse and throws.
			let start = 0;
			for (let end = buffer.indexOf(10); end >= 0 && end < length; end = buffer.indexOf(10, start)) {
				state.consume(parseLine(buffer.toString("utf8", start, end), path, lineNumber + 1));
				lineNumber += 1;
				offset += end + 1 - start;
				start = end + 1;
			}
		} finally { await file.close(); }
	};
	// Timer samples and failure evidence can request the same file at the same time.
	const sample = async () => {
		try { await (reading ??= read().finally(() => { reading = undefined; })); }
		catch (error) { lastUsage = {}; throw error; }
	};
	return {
		get activity() { return lastUsage.activity; },
		async usage() {
			await sample();
			lastUsage = state.usage();
			return { tokens: lastUsage.tokens, cost: lastUsage.cost };
		},
		async partialText(maxChars) {
			await sample();
			return state.partialText(maxChars);
		},
	};
}
