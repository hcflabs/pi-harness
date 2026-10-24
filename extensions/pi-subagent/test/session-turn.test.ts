import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { appendFile, chmod, mkdtemp, open, rename, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createSessionActivityReader, readSessionTurn, SESSION_LIMIT, type PromptMatch } from "../src/session-turn.ts";

const prompt = "inspect\n\nTurn identity: unique";
const lines = (entries: unknown[]) => [
	{ type: "session", id: "session" },
	{ type: "message", id: "user", parentId: "session", message: { role: "user", content: [{ type: "text", text: prompt }] } },
	...entries,
].map((line) => JSON.stringify(line)).join("\n") + "\n";
const assistant = (id: string, parentId: string, stopReason: string, text = "", extra: Record<string, unknown> = {}) => ({
	type: "message", id, parentId, message: { role: "assistant", stopReason, content: text ? [{ type: "text", text }] : [], ...extra },
});
const omit = (id: string, parentId: string, targetId: string, replacement: unknown = null) => ({ type: "context_edit", id, parentId, targetId, replacement });

async function privateDirectory(t: TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-session-turn-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

async function privateSession(t: TestContext, text: string, mode = 0o600): Promise<string> {
	const path = join(await privateDirectory(t), "session.jsonl");
	await writeFile(path, text, { mode });
	await chmod(path, mode);
	return path;
}

// A short settle delay keeps tests fast. One test below uses the module constant.
const read = (path: string, match: PromptMatch = prompt) => readSessionTurn(path, match, { settleMs: 10 });

test("the Final turn gives the exact answer, not interim output", async (t) => {
	const path = await privateSession(t, lines([
		assistant("tool", "user", "toolUse", "interim"),
		{ type: "message", id: "result", parentId: "tool", message: { role: "toolResult", toolCallId: "a" } },
		assistant("final", "result", "stop", "exact answer"),
	]));
	assert.deepEqual(await read(path), { state: "succeeded", stopReason: "stop", answer: "exact answer" });
	assert.deepEqual(await read(path, "other prompt"), { state: "absent" });
	assert.deepEqual(await read(path, (text) => text.endsWith("Turn identity: unique")), { state: "succeeded", stopReason: "stop", answer: "exact answer" });
	assert.deepEqual(await read(join(await privateDirectory(t), "missing.jsonl")), { state: "absent" });
});

test("the branch follows non-message entries to the exact prompt", async (t) => {
	const entries = [
		{ type: "model_change", id: "model", parentId: "user", provider: "test", modelId: "test" },
		{ type: "thinking_level_change", id: "thinking", parentId: "model", thinkingLevel: "high" },
		{ type: "custom", id: "custom", parentId: "thinking", customType: "test", data: {} },
	];
	const final = assistant("final", "custom", "stop", "Done.");
	assert.equal((await read(await privateSession(t, lines([...entries, final])))).state, "succeeded");
	assert.deepEqual(await read(await privateSession(t, lines([...entries, final])), `${prompt}\n`), { state: "absent" });
	for (const parentId of ["missing", "session"]) {
		const unrelated = lines([...entries.slice(0, -1), { ...entries[2], parentId }, final]);
		assert.deepEqual(await read(await privateSession(t, unrelated)), { state: "running" });
	}
});

test("only a stop Final turn succeeds, and toolUse keeps the turn running", async (t) => {
	for (const stopReason of ["error", "aborted", "length"]) {
		const turn = await read(await privateSession(t, lines([assistant("final", "user", stopReason)])));
		assert.equal(turn.state, "failed");
		assert.equal(turn.state === "failed" && turn.stopReason, stopReason);
		assert.match(turn.state === "failed" ? turn.failure : "", new RegExp(`stop reason "${stopReason}"`));
	}
	assert.deepEqual(await read(await privateSession(t, lines([assistant("tool", "user", "toolUse")]))), { state: "running" });
	assert.deepEqual(await read(await privateSession(t, lines([]))), { state: "running" });
	await assert.rejects(read(await privateSession(t, lines([assistant("final", "user", "unknown")]))), /unknown stop reason/);
});

test("a retried HTTP 429 turn runs until the retried answer, then succeeds", async (t) => {
	const failed = assistant("first", "user", "error", "", { errorMessage: "429 rate_limit_error" });
	const path = await privateSession(t, lines([failed, omit("omit", "first", "first")]));
	assert.deepEqual(await read(path), { state: "running" });
	await appendFile(path, JSON.stringify(assistant("retry", "omit", "stop", "answer after retry")) + "\n");
	assert.deepEqual(await read(path), { state: "succeeded", stopReason: "stop", answer: "answer after retry" });
});

test("an error turn that Pi does not omit fails after the confirm read and names the error", async (t) => {
	const path = await privateSession(t, lines([
		assistant("first", "user", "error", "", { errorMessage: "429 rate_limit_error" }),
		omit("omit", "first", "first"),
		assistant("last", "omit", "error", "", { errorMessage: `429 ${"x".repeat(1000)}` }),
	]));
	const turn = await read(path);
	assert.equal(turn.state, "failed");
	if (turn.state !== "failed") return;
	assert.equal(turn.stopReason, "error");
	assert.equal(Array.from(turn.errorMessage!).length, 500);
	assert.match(turn.failure, /^Pi ended the worker turn with stop reason "error": 429 x+$/);
});

test("an omission written during the settle delay keeps the turn running", async (t) => {
	const path = await privateSession(t, lines([assistant("first", "user", "error", "", { errorMessage: "429" })]));
	// The module constant applies here. Pi writes the omission after the first read.
	const reading = readSessionTurn(path, prompt);
	await sleep(100);
	await appendFile(path, JSON.stringify(omit("omit", "first", "first")) + "\n");
	assert.deepEqual(await reading, { state: "running" });
	// A second error turn restarts the settle rule. The read ends with the answer of the last retry.
	const second = await privateSession(t, lines([assistant("first", "user", "error")]));
	const retried = readSessionTurn(second, prompt, { settleMs: 300 });
	await sleep(50);
	await appendFile(second, JSON.stringify(omit("omit", "first", "first")) + "\n" + JSON.stringify(assistant("other", "omit", "error")) + "\n");
	await sleep(400);
	await appendFile(second, JSON.stringify(omit("omit-other", "other", "other")) + "\n" + JSON.stringify(assistant("retry", "omit-other", "stop", "late answer")) + "\n");
	assert.deepEqual(await retried, { state: "succeeded", stopReason: "stop", answer: "late answer" });
});

test("a recovered length turn keeps running, and an unrecovered one fails with its reason", async (t) => {
	const length = assistant("long", "user", "length", "cut");
	assert.deepEqual(await read(await privateSession(t, lines([length, omit("omit", "long", "long")]))), { state: "running" });
	const turn = await read(await privateSession(t, lines([length])));
	assert.equal(turn.state === "failed" && turn.stopReason, "length");
	assert.match(turn.state === "failed" ? turn.failure : "", /"length"/);
});

test("the latest edit on the branch decides omission", async (t) => {
	const answer = assistant("answer", "user", "stop", "kept answer");
	const omitted = lines([answer, omit("omit", "answer", "answer")]);
	assert.deepEqual(await read(await privateSession(t, omitted)), { state: "running" });
	const restored = lines([answer, omit("omit", "answer", "answer"), omit("replace", "omit", "answer", [{ type: "text", text: "replacement" }])]);
	assert.deepEqual(await read(await privateSession(t, restored)), { state: "succeeded", stopReason: "stop", answer: "kept answer" });
	// An omission on another branch does not apply to the active branch.
	const elsewhere = lines([
		assistant("first", "user", "aborted"),
		omit("omit", "user", "first"),
		{ type: "label", id: "leaf", parentId: "first", targetId: "first", label: "x" },
	]);
	assert.equal((await read(await privateSession(t, elsewhere))).state, "failed");
});

test("entries on another branch are not the Final turn", async (t) => {
	const session = lines([
		assistant("old", "user", "aborted"),
		assistant("new", "user", "stop", "new branch answer"),
	]);
	assert.deepEqual(await read(await privateSession(t, session)), { state: "succeeded", stopReason: "stop", answer: "new branch answer" });
	const orphan = lines([assistant("orphan", "session", "stop", "unrelated")]);
	assert.deepEqual(await read(await privateSession(t, orphan)), { state: "running" });
});

test("a later user turn after the prompt is an error", async (t) => {
	const session = lines([
		{ type: "message", id: "second-user", parentId: "user", message: { role: "user", content: [{ type: "text", text: "hijack" }] } },
		assistant("final", "second-user", "stop", "wrong turn"),
	]);
	await assert.rejects(read(await privateSession(t, session)), /unexpected user turn/);
});

test("only an unterminated last line can be incomplete", async (t) => {
	const complete = lines([assistant("final", "user", "stop", "answer")]);
	assert.equal((await read(await privateSession(t, complete + '{"type":"message","id":"next"'))).state, "succeeded");
	const partialAnswer = lines([]) + JSON.stringify(assistant("final", "user", "stop", "answer"));
	assert.deepEqual(await read(await privateSession(t, partialAnswer)), { state: "running" });
	const malformed = lines([]) + "not json\n" + JSON.stringify(assistant("final", "user", "stop", "answer")) + "\n";
	await assert.rejects(read(await privateSession(t, malformed)), /malformed entry on line 3/);
	await assert.rejects(read(await privateSession(t, lines([]) + "\n")), /malformed entry on line 3/);
	await assert.rejects(read(await privateSession(t, lines([{ type: "message", parentId: "user", message: { role: "assistant" } }]))), /without an ID/);
});

test("the private read rejects a wider mode, a symbolic link, and a file above the size limit", async (t) => {
	const session = lines([assistant("final", "user", "stop", "answer")]);
	for (const mode of [0o644, 0o640, 0o604]) {
		const path = await privateSession(t, session, mode);
		await assert.rejects(read(path), (error: Error) => error.message.includes(path) && /mode 0600/.test(error.message));
		await assert.rejects(createSessionActivityReader(path, prompt).usage(), /mode 0600/);
	}
	const target = await privateSession(t, session);
	const link = join(await privateDirectory(t), "session.jsonl");
	await symlink(target, link);
	await assert.rejects(read(link), /symbolic link/);
	await assert.rejects(createSessionActivityReader(link, prompt).usage(), /symbolic link/);
	const large = await privateSession(t, session);
	await truncate(large, SESSION_LIMIT + 1);
	await assert.rejects(read(large), /exceeds the 16 MiB limit/);
});

async function sampleSession(t: TestContext, session: string, turnPrompt = prompt) {
	const reader = createSessionActivityReader(await privateSession(t, session), turnPrompt);
	return { ...await reader.usage(), activity: reader.activity };
}

test("usage sums input and output without cache, and total cost, for the exact prompt", async (t) => {
	const usage = (input: number, cost?: unknown) => ({ input, output: 2, cacheRead: 300_000, cacheWrite: 40_000, ...(cost === undefined ? {} : { cost: { total: cost } }) });
	const session = lines([
		{ type: "message", id: "one", message: { role: "assistant", usage: usage(10, 0.25) } },
		{ type: "message", id: "two", message: { role: "assistant", usage: usage(20, 0.125) } },
		{ type: "message", id: "bad", message: { role: "assistant", usage: usage(0, "1") } },
	]) + '{"type":"message"';
	const sampled = await sampleSession(t, session);
	assert.deepEqual([sampled.tokens, sampled.cost], [36, 0.375]);
	assert.equal((await sampleSession(t, lines([{ type: "message", id: "one", message: { role: "assistant", usage: usage(10) } }]))).cost, undefined);
	assert.equal((await sampleSession(t, session, "another prompt")).tokens, undefined);
	assert.equal((await sampleSession(t, lines([]))).tokens, undefined);
	const missing = createSessionActivityReader(join(await privateDirectory(t), "missing.jsonl"), prompt);
	assert.deepEqual(await missing.usage(), { tokens: undefined, cost: undefined });
});

test("activity matches parallel results by ID and uses only the latest recorded result duration", async (t) => {
	const calls = { type: "message", id: "calls", message: { role: "assistant", timestamp: 1, durationMs: 999,
		content: [{ type: "toolCall", id: "a", name: "read" }, { type: "toolCall", id: "b", name: "bash" }] } };
	const result = (toolCallId: string, durationMs?: number) => ({ type: "message", id: toolCallId, message: {
		role: "toolResult", toolCallId, toolName: "ignored result name", timestamp: 10_000, durationMs,
	} });
	assert.deepEqual((await sampleSession(t, lines([calls]))).activity, { pending: ["read", "bash"], latest: undefined });
	assert.deepEqual((await sampleSession(t, lines([calls, result("b", 2400)]))).activity,
		{ pending: ["read"], latest: { name: "bash", durationMs: 2400 } });
	assert.deepEqual((await sampleSession(t, lines([calls, result("b", 2400), result("a", 125), result("unknown", 9999)]))).activity,
		{ pending: [], latest: { name: "read", durationMs: 125 } });
});

test("activity waits for a full trailing result and omits absent or invalid timing", async (t) => {
	const call = { type: "message", id: "call", message: { role: "assistant", timestamp: 1,
		content: [{ type: "toolCall", id: "a", name: "read" }, { type: "toolCall", id: "b", name: "bash" }] } };
	const result = (toolCallId: string, durationMs: unknown) => ({ type: "message", id: "result", message: {
		role: "toolResult", toolCallId, durationMs, timestamp: 9999,
	} });
	const prefix = lines([call, result("a", 250)]);
	const final = JSON.stringify(result("b", 800));
	assert.deepEqual((await sampleSession(t, prefix + final.slice(0, -2))).activity,
		{ pending: ["bash"], latest: { name: "read", durationMs: 250 } });
	assert.deepEqual((await sampleSession(t, prefix + final + "\n")).activity,
		{ pending: [], latest: { name: "bash", durationMs: 800 } });
	for (const durationMs of [undefined, -1, "800"]) {
		assert.deepEqual((await sampleSession(t, prefix + JSON.stringify(result("b", durationMs)) + "\n")).activity,
			{ pending: [], latest: { name: "bash" } });
	}
});

test("activity stays inside the exact prompt boundary and resets on a new exact prompt", async (t) => {
	const call = (id: string, name: string) => ({ type: "message", id, message: { role: "assistant",
		content: [{ type: "toolCall", id, name }] } });
	const result = (toolCallId: string) => ({ type: "message", id: "result", message: { role: "toolResult", toolCallId, durationMs: 900 } });
	const user = (text: string) => ({ type: "message", id: "next", message: { role: "user", content: [{ type: "text", text }] } });
	const session = JSON.stringify(call("old", "old tool")) + "\n" + lines([
		result("old"), call("task", "task tool"), user(`${prompt} extra`), result("task"), call("other", "other tool"),
	]);
	assert.deepEqual((await sampleSession(t, session)).activity, { pending: ["task tool"], latest: undefined });
	assert.equal((await sampleSession(t, session, "different prompt")).activity, undefined);
	const next = session + [user(prompt), result("task"), call("new", "new tool")].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	assert.deepEqual((await sampleSession(t, next)).activity, { pending: ["new tool"], latest: undefined });
});

test("activity samples read and parse only appended complete lines for usage and text", async (t) => {
	const path = join(await privateDirectory(t), "session.jsonl");
	const assistantUsage = (input: number, text: string) => ({ type: "message", message: { role: "assistant",
		usage: { input, output: 2 }, content: [{ type: "text", text }, { type: "toolCall", id: "a", name: "read" },
			{ type: "toolCall", id: "b", name: "bash" }] } });
	const entry = (message: unknown) => JSON.stringify({ type: "message", message }) + "\n";
	let complete = lines([assistantUsage(10, "  first 😀 \t")]);
	await writeFile(path, complete, { mode: 0o600 });
	const reader = createSessionActivityReader(path, prompt);
	const file = await open(path, "r");
	const reads = t.mock.method(Object.getPrototypeOf(file) as Pick<typeof file, "read">, "read");
	await file.close();
	const parses = t.mock.method(JSON, "parse");
	// The reader passes the file position as the fourth read() argument.
	const positions = (from: number) => reads.mock.calls.slice(from).map((call) => (call.arguments as unknown[])[3]);
	const check = async (newLines: number, position?: number) => {
		const fullReader = createSessionActivityReader(path, prompt);
		const expected = await fullReader.usage();
		const expectedText = await fullReader.partialText(8);
		const readCount = reads.mock.callCount();
		const parseCount = parses.mock.callCount();
		const [text, tokens] = await Promise.all([reader.partialText(8), reader.usage().then(({ tokens }) => tokens)]);
		assert.equal(tokens, expected.tokens);
		assert.deepEqual(reader.activity, fullReader.activity);
		assert.equal(text, expectedText);
		assert.equal(parses.mock.callCount() - parseCount, newLines);
		assert.deepEqual(positions(readCount), position === undefined ? [] : [position]);
	};
	await check(3, 0);
	assert.equal(await reader.partialText(100), "first 😀");
	await check(0);

	const result = entry({ role: "toolResult", toolCallId: "b", durationMs: 250 });
	const tail = Buffer.from(JSON.stringify(assistantUsage(20, " second 🚀  ")) + "\n");
	const split = tail.indexOf(Buffer.from("🚀")) + 1;
	let position = Buffer.byteLength(complete);
	await appendFile(path, Buffer.concat([Buffer.from(result), tail.subarray(0, split)]));
	complete += result;
	await check(1, position);
	position = Buffer.byteLength(complete);
	await appendFile(path, tail.subarray(split, -1));
	// Even valid JSON must wait for its newline before it advances the offset.
	await check(0, position);
	await appendFile(path, "\n");
	complete += tail.toString();
	await check(1, position);
	assert.equal(await reader.partialText(100), "first 😀 \t\n second 🚀");
	await check(0);

	const outside = entry({ role: "user", content: [{ type: "text", text: `${prompt} extra` }] })
		+ JSON.stringify(assistantUsage(999, "unrelated")) + "\n";
	position = Buffer.byteLength(complete);
	await appendFile(path, outside);
	complete += outside;
	await check(2, position);
	const reset = entry({ role: "user", content: [{ type: "text", text: prompt }] })
		+ entry({ role: "toolResult", toolCallId: "b", durationMs: 999 })
		+ JSON.stringify(assistantUsage(0, "new")) + "\n";
	position = Buffer.byteLength(complete);
	await appendFile(path, reset);
	complete += reset;
	await check(3, position);
	assert.equal((await reader.usage()).tokens, 2);
	assert.equal(await reader.partialText(100), "new");
	assert.deepEqual(reader.activity, { pending: ["read", "bash"], latest: undefined });

	// A malformed complete line is an error. The offset stays before it, so each sample parses it again.
	position = Buffer.byteLength(complete);
	await appendFile(path, "malformed\n" + JSON.stringify(assistantUsage(999, "ignored")) + "\n");
	for (let attempt = 0; attempt < 2; attempt++) {
		const readCount = reads.mock.callCount();
		const parseCount = parses.mock.callCount();
		await assert.rejects(reader.usage(), /malformed entry on line/);
		assert.equal(parses.mock.callCount() - parseCount, 1);
		assert.deepEqual(positions(readCount), [position]);
		assert.equal(reader.activity, undefined);
	}
});

test("activity samples reset after shrink, rewrite, replacement, and the size limit", async (t) => {
	const directory = await privateDirectory(t);
	const path = join(directory, "session.jsonl");
	const session = (input: number, text: string) => lines([{ type: "message", message: { role: "assistant",
		usage: { input, output: 1 }, content: [{ type: "text", text }, { type: "toolCall", id: "a", name: text }] } }]);
	await writeFile(path, session(10, "original long text"), { mode: 0o600 });
	const reader = createSessionActivityReader(path, prompt);
	const check = async (input: number, text: string) => {
		assert.equal((await reader.usage()).tokens, input + 1);
		assert.equal(await reader.partialText(100), text);
		assert.deepEqual(reader.activity, { pending: [text], latest: undefined });
	};
	await check(10, "original long text");
	await writeFile(path, session(2, "short"));
	await check(2, "short");
	await writeFile(path, session(3, "equal"));
	const time = new Date(Date.now() + 1000);
	await utimes(path, time, time);
	await check(3, "equal");
	const replacement = join(directory, "replacement.jsonl");
	await writeFile(replacement, session(4, "other"), { mode: 0o600 });
	await utimes(replacement, time, time);
	await rename(replacement, path);
	await check(4, "other");
	await truncate(path, SESSION_LIMIT + 1);
	await assert.rejects(reader.usage(), /exceeds the 16 MiB limit/);
	assert.equal(reader.activity, undefined);
	await assert.rejects(reader.partialText(100), /exceeds the 16 MiB limit/);
	await writeFile(path, session(5, "after"));
	await check(5, "after");
});
