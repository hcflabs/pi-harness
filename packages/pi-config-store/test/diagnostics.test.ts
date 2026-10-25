import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readDiagnostics, recordDiagnostic, registerConfigReporting, registerDiagnosticsCommand } from "../src/index.ts";

const key = Symbol.for("@hcflabs/pi-config-store/diagnostics");
const shared = globalThis as Record<symbol, unknown>;
beforeEach(() => { delete shared[key]; });

function harness() {
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const handlers = new Map<string, () => void>();
	const pi = {
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command),
		on: (name: string, handler: () => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const notices: string[] = [];
	const ctx = { hasUI: true, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
	return { pi, commands, handlers, notices, ctx };
}

test("the log keeps the newest 200 events, oldest first", () => {
	for (let i = 0; i < 205; i++) recordDiagnostic("test", "info", String(i));
	const events = readDiagnostics();
	assert.equal(events.length, 200);
	assert.equal(events[0]!.message, "5");
	assert.equal(events.at(-1)!.message, "204");
	assert.equal(new Date(events[0]!.time).toISOString(), events[0]!.time);
});

test("the log removes ANSI sequences and controls and limits messages to 500 characters", () => {
	recordDiagnostic("\x1b[31msource\x1b[0m\n", "warning", "\x1b[31mred\x1b[0m\x1b]0;title\x07\n\r\t\x00\x7f\x85\u2028\u2029\u200b");
	assert.deepEqual(readDiagnostics().map(({ source, message }) => ({ source, message })), [{ source: "source", message: "red" }]);
	recordDiagnostic("test", "error", "😀".repeat(501));
	assert.equal(Array.from(readDiagnostics()[1]!.message).length, 500);
});

test("readers cannot change stored events or the event array", () => {
	recordDiagnostic("test", "info", "original");
	const copy = readDiagnostics();
	copy[0]!.message = "changed";
	(copy as unknown[]).pop();
	assert.equal(readDiagnostics()[0]!.message, "original");
});

test("only an explicit context without UI writes one sanitized line to stderr", (t) => {
	const stderr = t.mock.method(process.stderr, "write", () => true);
	const stdout = t.mock.method(process.stdout, "write", () => true);
	const log = t.mock.method(console, "log", () => {});
	const warn = t.mock.method(console, "warn", () => {});
	const error = t.mock.method(console, "error", () => {});
	recordDiagnostic("test", "info", "no context");
	recordDiagnostic("test", "warning", "with UI", { hasUI: true });
	assert.equal(stderr.mock.callCount(), 0);
	recordDiagnostic("test", "error", "\x1b[31mheadless\x1b[0m\nmessage", { hasUI: false });
	assert.deepEqual(stderr.mock.calls.map(({ arguments: args }) => args), [["headlessmessage\n"]]);
	assert.equal(stdout.mock.callCount() + log.mock.callCount() + warn.mock.callCount() + error.mock.callCount(), 0);
	assert.equal(readDiagnostics().length, 3);
});

test("module copies share events and the command owner", async () => {
	const copy = await import("../dist/diagnostics.js");
	recordDiagnostic("first", "info", "one");
	copy.recordDiagnostic("second", "warning", "two");
	assert.deepEqual(copy.readDiagnostics(), readDiagnostics());
	assert.equal((shared[key] as { schema: number }).schema, 1);
	const first = harness();
	const second = harness();
	assert.equal(registerDiagnosticsCommand(first.pi), true);
	assert.equal(copy.registerDiagnosticsCommand(second.pi), false);
	assert.equal(second.commands.size, 0);
	assert.equal(second.handlers.size, 0);
	first.handlers.get("session_shutdown")!();
	assert.equal(copy.registerDiagnosticsCommand(second.pi), true);
	first.handlers.get("session_shutdown")!();
	assert.equal(registerDiagnosticsCommand(harness().pi), false);
	second.handlers.get("session_shutdown")!();
	assert.equal(registerDiagnosticsCommand(harness().pi), true);
	assert.equal(readDiagnostics().length, 2);
});

test("the command shows empty, recent, and all events in one notification or stdout", async (t) => {
	const app = harness();
	registerDiagnosticsCommand(app.pi);
	const command = app.commands.get("diagnostics")!;
	const stdout = t.mock.method(process.stdout, "write", () => true);
	const stderr = t.mock.method(process.stderr, "write", () => true);
	await command.handler("", app.ctx);
	assert.deepEqual(app.notices, ["No diagnostics."]);
	assert.equal(stdout.mock.callCount(), 0);
	await command.handler("", { hasUI: false } as ExtensionCommandContext);
	assert.deepEqual(stdout.mock.calls[0]!.arguments, ["No diagnostics.\n"]);
	for (let i = 0; i < 25; i++) recordDiagnostic("test", "warning", `event ${i}`);
	const lines = readDiagnostics().map(({ time, source, level, message }) => `${time} [${source}] ${level}: ${message}`);
	await command.handler("", app.ctx);
	assert.equal(app.notices[1], lines.slice(-20).join("\n"));
	await command.handler(" all ", app.ctx);
	assert.equal(app.notices[2], lines.join("\n"));
	await command.handler("all", { hasUI: false } as ExtensionCommandContext);
	assert.deepEqual(stdout.mock.calls[1]!.arguments, [`${lines.join("\n")}\n`]);
	assert.equal(stderr.mock.callCount(), 0);
});

test("a failed command registration releases its claim", () => {
	const app = harness();
	app.pi.registerCommand = () => { throw new Error("Registration failed."); };
	assert.throws(() => registerDiagnosticsCommand(app.pi), /Registration failed/);
	assert.equal(registerDiagnosticsCommand(harness().pi), true);
});

test("config reporting records each new report once and does not duplicate stderr", (t) => {
	const stderr = t.mock.method(process.stderr, "write", () => true);
	const app = harness();
	const reporter = registerConfigReporting(app.pi, []);
	const store = { extensionId: "test", path: `/diagnostics-test-${Date.now()}` };
	const issues = [{ kind: "invalid-value" as const, key: "count", message: "must be positive" }];
	reporter.report(app.ctx, store, { status: "ok", source: "file", value: {}, issues });
	reporter.report(app.ctx, store, { status: "ok", source: "file", value: {}, issues });
	assert.equal(readDiagnostics().length, 1);
	assert.equal(readDiagnostics()[0]!.level, "warning");
	assert.equal(readDiagnostics()[0]!.message, app.notices[0]);
	assert.equal(stderr.mock.callCount(), 0);
	reporter.report({ hasUI: false, ui: app.ctx.ui }, { ...store, path: `${store.path}-disabled` }, { status: "disabled", source: "file", issues });
	assert.equal(readDiagnostics().length, 2);
	assert.equal(readDiagnostics()[1]!.level, "error");
	assert.deepEqual(stderr.mock.calls[0]!.arguments, [`${readDiagnostics()[1]!.message}\n`]);
	assert.equal(app.notices.length, 1);
});
