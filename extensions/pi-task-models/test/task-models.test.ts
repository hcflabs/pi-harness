import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lock } from "proper-lockfile";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	availableTaskModels,
	executeTaskRoutes,
	loadTaskModelsConfig,
	registerTaskModelsConfigReporting,
	registerModelTask,
	resolveConfiguredTaskRoute,
	resolveConfiguredTaskRoutes,
	resolveTaskModelRoute,
	taskThinkingLevels,
	routeTaskProfile,
	taskProfileModelReference,
	TASK_PROFILE_MODELS_EXTENSION,
	type ModelTask,
	type TaskRouteAttempt,
} from "@hcflabs/pi-task-models";
import registerTaskModelsExtension from "../extensions/task-models.ts";
import registerTaskProfileModels from "../extensions/task-profile-models.ts";

const EXAMPLE_TASK = {
	id: "pi-example/review",
	label: "Example review",
	purpose: "Review one requested change.",
	defaultProfile: "fast",
} as const satisfies ModelTask;
const MODEL_TASK_REQUEST_EVENT = "@hcflabs/pi-task-models:model-task-request";
const MODEL_TASK_RESPONSE_EVENT = "@hcflabs/pi-task-models:model-task-response";
const EXECUTION_ROUTES = [
	{ model: { provider: "test", id: "primary" }, thinkingLevel: "off" },
	{ model: { provider: "test", id: "fallback" }, thinkingLevel: "off" },
] as any;

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-task-models-"));
}

function configFile(dir: string): string {
	return join(dir, "config", "pi-task-models", "config.json");
}

function eventBus() {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	return {
		on(channel: string, handler: (payload: unknown) => void) {
		const handlers = listeners.get(channel) ?? new Set();
		handlers.add(handler);
		listeners.set(channel, handlers);
		return () => handlers.delete(handler);
		},
		emit(channel: string, payload: unknown) {
			for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload);
		},
		listenerCount(channel: string) {
			return listeners.get(channel)?.size ?? 0;
		},
	};
}

function controlPlane(events: ReturnType<typeof eventBus>, agentDir: string) {
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const listeners: Array<(event: unknown, ctx: any) => void> = [];
	const sessionStart = (event: unknown, ctx: any) => { for (const listener of listeners) listener(event, ctx); };
	const pi = {
		events,
		on(name: string, listener: (event: unknown, ctx: any) => void) {
			assert.equal(name, "session_start");
			listeners.push(listener);
		},
		registerCommand(_name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
			handler = command.handler;
		},
		registerVirtualModel() {},
	};
	registerTaskModelsExtension(pi as never, { agentDir });
	assert.ok(handler);
	return { pi, handler: handler!, sessionStart };
}

test("loads defaults without writing or legacy fallback and preserves invalid files", () => {
	const dir = tempDir();
	try {
		const file = configFile(dir);
		assert.deepEqual(loadTaskModelsConfig(dir), { source: "missing", value: { profiles: {}, tasks: {} } });
		assert.throws(() => readFileSync(file, "utf8"), { code: "ENOENT" });

		mkdirSync(join(dir, "config"), { recursive: true });
		writeFileSync(join(dir, "config", "pi-task-models.json"), JSON.stringify({ tasks: { "pi-new/customTask": "frontier" } }));
		assert.deepEqual(loadTaskModelsConfig(dir), { source: "missing", value: { profiles: {}, tasks: {} } });
		assert.throws(() => readFileSync(file, "utf8"), { code: "ENOENT" });

		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		for (const disabled of ["{ not json\n", '{"profiles":[]}']) {
			writeFileSync(file, disabled, { encoding: "utf8" });
			assert.throws(() => loadTaskModelsConfig(dir), /Task model config at .*config\.json is disabled: (invalid JSON|profiles: must be a JSON object)/);
			assert.equal(readFileSync(file, "utf8"), disabled);
		}

		const route = { model: "provider/model", thinkingLevel: "low" };
		const text = `${JSON.stringify({
			extra: true,
			profiles: {
				fast: { primary: { model: " provider/model", thinkingLevel: "low" } },
				balanced: { primary: { ...route, extra: true } },
				frontier: { primary: route },
				fav: { primary: route, fallback: route },
				unknown: { primary: route },
			},
			tasks: { "bad task": "fast", "pi-new/task": "slow", "pi-new/kept": "fav" },
		})}\n`;
		writeFileSync(file, text);
		assert.deepEqual(loadTaskModelsConfig(dir), {
			source: "file",
			value: { profiles: { frontier: { primary: route } }, tasks: { "pi-new/kept": "fav" } },
		});
		assert.equal(readFileSync(file, "utf8"), text);

		writeFileSync(file, `${JSON.stringify({ tasks: { "pi-new/customTask": "frontier" } })}\n`);
		assert.deepEqual(loadTaskModelsConfig(dir), {
			source: "file",
			value: { profiles: {}, tasks: { "pi-new/customTask": "frontier" } },
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("warns once at session start when config is missing", () => {
	const dir = tempDir();
	try {
		const { sessionStart } = controlPlane(eventBus(), dir);
		assert.ok(sessionStart);
		const notices: Array<[string, string]> = [];
		sessionStart({}, {
			ui: { notify(message: string, level: string) { notices.push([message, level]); } },
		});
		assert.deepEqual(notices, [[
			`Task model config is missing at ${configFile(dir)}; run /task-models to configure task routes.`,
			"warning",
		]]);
		assert.throws(() => readFileSync(configFile(dir), "utf8"), { code: "ENOENT" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reports config issues at launch: warnings fall back, a broken profile table disables", () => {
	const dir = tempDir();
	try {
		const { sessionStart } = controlPlane(eventBus(), dir);
		const file = configFile(dir);
		const presets = join(dir, "config", "pi-task-models", "presets.json");
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		writeFileSync(file, JSON.stringify({ extra: {}, tasks: { "pi-example/review": "slow" } }));
		writeFileSync(presets, JSON.stringify({ " bad": {} }));
		const notices: Array<[string, string]> = [];
		const ctx = { hasUI: true, ui: { notify(message: string, level: string) { notices.push([message, level]); } } };
		sessionStart({}, ctx);
		assert.deepEqual(notices, [
			[`pi-task-models config issues (${file}): extra: unknown key; tasks["pi-example/review"]: must be one of fast, balanced, frontier, fav; defaults replace invalid settings.`, "warning"],
			[`pi-task-models config issues (${presets}): [" bad"]: preset names must be non-empty text without surrounding whitespace or control characters; defaults replace invalid settings.`, "warning"],
		]);

		notices.length = 0;
		writeFileSync(file, "{ not json");
		sessionStart({}, ctx);
		assert.equal(notices[0]![1], "error");
		assert.match(notices[0]![0], /^pi-task-models disabled \(.*config\.json\): invalid JSON/);

		// A misspelled `profiles` key is an invalid profile table, so routing is disabled.
		notices.length = 0;
		writeFileSync(file, JSON.stringify({ profile: {} }));
		sessionStart({}, ctx);
		assert.deepEqual(notices[0], [`pi-task-models disabled (${file}): profiles: unknown key "profile"; did you mean "profiles"?`, "error"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("consumers report task-model config issues at launch and after a lazy read, once per session", () => {
	const dir = tempDir();
	try {
		const file = configFile(dir);
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		writeFileSync(file, JSON.stringify({ extra: 1 }));
		const handlers: Array<(event: unknown, ctx: unknown) => void> = [];
		const pi = { on: (_event: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.push(handler); } };
		const first = registerTaskModelsConfigReporting(pi as never, dir);
		const second = registerTaskModelsConfigReporting(pi as never, dir);
		const notices: Array<[string, string]> = [];
		const ctx = { hasUI: true, ui: { notify(message: string, level: string) { notices.push([message, level]); } } };
		const event = {};
		for (const handler of handlers) handler(event, ctx);
		assert.deepEqual(notices, [[`pi-task-models config issues (${file}): extra: unknown key; defaults replace invalid settings.`, "warning"]]);
		writeFileSync(file, JSON.stringify({ extra: 1, tasks: { "pi-example/review": "slow" } }));
		first(ctx as never);
		second(ctx as never);
		assert.deepEqual(notices.slice(1), [[`pi-task-models config issues (${file}): tasks["pi-example/review"]: must be one of fast, balanced, frontier, fav; defaults replace invalid settings.`, "warning"]]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/task-models status resolves each slot with the current scope and config", async () => {
	const dir = tempDir();
	try {
		const { pi, handler } = controlPlane(eventBus(), dir);
		registerModelTask(pi as never, EXAMPLE_TASK);
		registerModelTask(pi as never, { ...EXAMPLE_TASK, id: "pi-example/other", label: "Other", defaultProfile: "fav" });
		const primary = { provider: "openai-codex-2", id: "primary", input: ["text"], reasoning: true };
		const fallback = { provider: "test", id: "fallback", input: ["text"], reasoning: false };
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		const profiles = {
			fast: {
				primary: { model: "openai-codex/primary", thinkingLevel: "low" },
				fallback: { model: "test/fallback", thinkingLevel: "off" },
			},
			fav: { primary: { model: "test/fallback", thinkingLevel: "off" } },
		};
		writeFileSync(configFile(dir), JSON.stringify({ profiles }));
		const notices: Array<[string, string]> = [];
		const colors: string[] = [];
		const ctx = {
			hasUI: true,
			model: primary,
			scopedModels: [] as any[],
			modelRegistry: { getAvailable: () => [primary, fallback] },
			ui: {
				theme: { fg(color: string, text: string) { colors.push(color); return text; } },
				notify(message: string, level: string) { notices.push([message, level]); },
				select: async () => assert.fail("status must not open a menu"),
				setStatus: () => assert.fail("task models has no persistent status"),
			},
		};
		const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		Object.defineProperty(process.stdout, "columns", { configurable: true, value: 300 });
		try {
			await handler("status", ctx);
			assert.deepEqual(notices, [
				["Other (pi-example/other) · primary test/fallback (off) · fallback none", "info"],
				["Example review (pi-example/review) · primary openai-codex-2/primary (low) · fallback test/fallback (off)", "info"],
			]);
			assert.deepEqual(colors, ["accent", "accent"]);

			ctx.scopedModels = [{ model: primary, thinkingLevel: "high" }, { model: fallback, thinkingLevel: "off" }];
			notices.length = 0;
			await handler("status", ctx);
			assert.deepEqual(notices[1], [
				"Example review (pi-example/review) · primary openai-codex/primary (low) · fallback test/fallback (off) · primary slot unavailable",
				"warning",
			]);

			ctx.scopedModels = [{ model: primary, thinkingLevel: "low" }];
			notices.length = 0;
			await handler("status", ctx);
			assert.match(notices[0]![0], /fallback none.*primary slot unavailable.*no-route: Task pi-example\/other profile fav has no available route/);
			assert.deepEqual(notices[1], [
				"Example review (pi-example/review) · primary openai-codex-2/primary (low) · fallback test/fallback (off) · fallback slot unavailable",
				"warning",
			]);

			writeFileSync(configFile(dir), JSON.stringify({ profiles, tasks: { [EXAMPLE_TASK.id]: "fav" } }));
			ctx.scopedModels = [];
			notices.length = 0;
			await handler("status", ctx);
			assert.match(notices[1]![0], /primary test\/fallback \(off\).*fallback none$/);
		} finally {
			if (columns) Object.defineProperty(process.stdout, "columns", columns);
			else Reflect.deleteProperty(process.stdout, "columns");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/task-models status reports route errors and config issues on every read without UI", async () => {
	const dir = tempDir();
	try {
		const { pi, handler } = controlPlane(eventBus(), dir);
		registerModelTask(pi as never, EXAMPLE_TASK);
		const ctx = { hasUI: false, ui: new Proxy({}, { get() { assert.fail("status must not use UI without hasUI"); } }) };
		let text = "";
		const write = process.stdout.write;
		process.stdout.write = ((chunk: string) => { text += chunk; return true; }) as typeof write;
		try {
			await handler("status", ctx);
			assert.match(text, /primary none · fallback none · config-missing: Task model config is missing/);
			assert.equal(existsSync(configFile(dir)), false);

			mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
			for (const [contents, code, issue] of [
				["{ not json", "config-disabled", /Config .*config\.json: invalid JSON/],
				['{"profiles":{"fast":null}}', "profile-missing", /Config .*config\.json: profiles\.fast: must be an object/],
				["{}", "profile-missing", undefined],
			] as const) {
				writeFileSync(configFile(dir), contents);
				for (const _repeat of [1, 2]) {
					text = "";
					await handler("status", ctx);
					assert.match(text, new RegExp(` · ${code}: `));
					if (issue) assert.match(text, issue);
					assert.equal(readFileSync(configFile(dir), "utf8"), contents);
				}
			}
			writeFileSync(join(dir, "config", "pi-task-models", "presets.json"), "{ not json");
			text = "";
			await handler("status", ctx);
			assert.match(text, /Config .*presets\.json: invalid JSON/);
		} finally {
			process.stdout.write = write;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/task-models status uses one width-safe UI line and reports no active tasks", async () => {
	const dir = tempDir();
	try {
		const { pi, handler } = controlPlane(eventBus(), dir);
		const notices: string[] = [];
		const ctx = { hasUI: true, ui: {
			theme: { fg: (_color: string, text: string) => text },
			notify(message: string) { notices.push(message); },
		} };
		await handler("status", ctx);
		assert.deepEqual(notices, ["No Model Tasks are active."]);
		registerModelTask(pi as never, { ...EXAMPLE_TASK, label: "界".repeat(50) });
		const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		Object.defineProperty(process.stdout, "columns", { configurable: true, value: 40 });
		try {
			notices.length = 0;
			await handler("status", ctx);
			assert.equal(notices.length, 1);
			assert.doesNotMatch(notices[0]!, /[\r\n]/);
			assert.ok(visibleWidth(notices[0]!) <= 38);
			assert.match(notices[0]!, /\.\.\./);
		} finally {
			if (columns) Object.defineProperty(process.stdout, "columns", columns);
			else Reflect.deleteProperty(process.stdout, "columns");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/task-models repairs a disabled config only after confirmation", async () => {
	const dir = tempDir();
	try {
		const { handler } = controlPlane(eventBus(), dir);
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		writeFileSync(configFile(dir), "{ not json");
		let confirmed = false;
		const notices: string[] = [];
		const run = () => {
			const selections = ["fast · not configured", "test/model", "off", "None"];
			return handler("", {
				hasUI: true,
				ui: {
					select: async () => selections.shift(),
					confirm: async (_title: string, message: string) => {
						assert.match(message, /config\.json has issues: invalid JSON/);
						return confirmed;
					},
					notify(message: string) { notices.push(message); },
				},
				scopedModels: [],
				modelRegistry: { getAvailable: () => [{ provider: "test", id: "model", input: ["text"], reasoning: false }] },
			});
		};
		await run();
		assert.equal(readFileSync(configFile(dir), "utf8"), "{ not json");
		assert.match(notices[0]!, /^pi-task-models disabled/);
		confirmed = true;
		await run();
		assert.deepEqual(loadTaskModelsConfig(dir).value, {
			profiles: { fast: { primary: { model: "test/model", thinkingLevel: "off" } } }, tasks: {},
		});
		assert.equal(notices.at(-1), "fast profile saved.");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/task-models repair keeps the tasks that loaded and refuses a file changed after the snapshot", async () => {
	const dir = tempDir();
	try {
		const { handler } = controlPlane(eventBus(), dir);
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		writeFileSync(configFile(dir), JSON.stringify({ profiles: [], tasks: { "pi-example/review": "frontier" } }));
		let onConfirm = () => {};
		const notices: string[] = [];
		const run = () => {
			const selections = ["fast · not configured", "test/model", "off", "None"];
			return handler("", {
				hasUI: true,
				ui: {
					select: async () => selections.shift(),
					confirm: async () => { onConfirm(); return true; },
					notify(message: string) { notices.push(message); },
				},
				scopedModels: [],
				modelRegistry: { getAvailable: () => [{ provider: "test", id: "model", input: ["text"], reasoning: false }] },
			});
		};
		const repaired = JSON.stringify({ profiles: {}, tasks: {} });
		onConfirm = () => writeFileSync(configFile(dir), repaired);
		await run();
		assert.equal(readFileSync(configFile(dir), "utf8"), repaired);
		assert.match(notices.at(-1)!, /config\.json changed since it was read; nothing was written/);

		writeFileSync(configFile(dir), JSON.stringify({ profiles: [], tasks: { "pi-example/review": "frontier" } }));
		onConfirm = () => {};
		await run();
		assert.deepEqual(loadTaskModelsConfig(dir).value, {
			profiles: { fast: { primary: { model: "test/model", thinkingLevel: "off" } } },
			tasks: { "pi-example/review": "frontier" },
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("preset picker applies supplied profiles and preserves omitted profiles and current task assignments", async () => {
	const dir = tempDir();
	try {
		const { handler } = controlPlane(eventBus(), dir);
		const preset = {
			fast: { primary: { model: "provider/quick", thinkingLevel: "off" } },
			balanced: {
				primary: { model: "provider/steady", thinkingLevel: "medium" },
				fallback: { model: "provider/backup", thinkingLevel: "low" },
			},
			frontier: { primary: { model: "provider/deep", thinkingLevel: "high" } },
		};
		const fav = { primary: { model: "provider/favorite", thinkingLevel: "max" } };
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		const presetsFile = join(dir, "config", "pi-task-models", "presets.json");
		const contents = JSON.stringify({ zeta: preset, alpha: preset });
		writeFileSync(presetsFile, contents);
		writeFileSync(configFile(dir), JSON.stringify({ profiles: {
			...preset,
			frontier: { ...preset.frontier, fallback: preset.fast.primary },
		} }));
		const notices: Array<[string, string]> = [];
		await handler("preset", { ui: {
			select: async (title: string, options: string[]) => {
				assert.equal(title, "Task model preset");
				assert.deepEqual(options, ["alpha", "zeta"]);
				// Preserve unrelated changes made while the picker is open.
				writeFileSync(configFile(dir), JSON.stringify({
					profiles: { fav }, tasks: { "pi-example/review": "balanced" },
				}));
				return "alpha";
			},
			notify(message: string, level: string) { notices.push([message, level]); },
		} });
		assert.deepEqual(loadTaskModelsConfig(dir).value, {
			profiles: { ...preset, fav }, tasks: { "pi-example/review": "balanced" },
		});
		assert.equal(readFileSync(presetsFile, "utf8"), contents);
		assert.deepEqual(notices, [["Applied task model preset: alpha.", "info"]]);

		const favorite = { primary: { model: "provider/new-favorite", thinkingLevel: "low" } };
		writeFileSync(presetsFile, JSON.stringify({ "favorite-only": { fav: favorite } }));
		await handler("preset", { ui: {
			select: async (_title: string, options: string[]) => {
				assert.deepEqual(options, ["favorite-only"]);
				return "favorite-only";
			},
			notify() {},
		} });
		assert.deepEqual(loadTaskModelsConfig(dir).value, {
			profiles: { ...preset, fav: favorite }, tasks: { "pi-example/review": "balanced" },
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("preset selection can create config; cancellation never writes", async () => {
	const dir = tempDir();
	try {
		const { handler } = controlPlane(eventBus(), dir);
		const profile = { primary: { model: "provider/model", thinkingLevel: "off" } };
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		writeFileSync(join(dir, "config", "pi-task-models", "presets.json"), JSON.stringify({
			setup: { fast: profile, balanced: profile, frontier: profile },
		}));
		let selected: string | undefined;
		const ctx = { ui: { select: async () => selected, notify() {} } };
		await handler("preset", ctx);
		assert.throws(() => readFileSync(configFile(dir), "utf8"), { code: "ENOENT" });
		selected = "setup";
		await handler("preset", ctx);
		assert.deepEqual(loadTaskModelsConfig(dir).value, {
			profiles: { fast: profile, balanced: profile, frontier: profile }, tasks: {},
		});
		const contents = readFileSync(configFile(dir), "utf8");
		selected = undefined;
		await handler("preset", ctx);
		assert.equal(readFileSync(configFile(dir), "utf8"), contents);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("missing, empty, or invalid presets leave active config and preset files untouched", async () => {
	const dir = tempDir();
	try {
		const { handler } = controlPlane(eventBus(), dir);
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		const active = JSON.stringify({ tasks: { "pi-example/review": "fast" } });
		writeFileSync(configFile(dir), active);
		const path = join(dir, "config", "pi-task-models", "presets.json");
		const profile = { primary: { model: "provider/model", thinkingLevel: "off" } };
		for (const [contents, expected] of [
			[undefined, []],
			["{}", []],
			["{ not json", [/presets\.json\): invalid JSON/]],
			[JSON.stringify({ invalid: null }), [/presets\.json\): invalid: must be a JSON object/]],
		] as const) {
			if (contents !== undefined) writeFileSync(path, contents);
			const notices: string[] = [];
			await handler("preset", { hasUI: true, ui: {
				select: async () => assert.fail("empty presets must not open a picker"),
				notify(message: string) { notices.push(message); },
			} });
			assert.equal(notices.length, expected.length + 1);
			expected.forEach((pattern, index) => assert.match(notices[index]!, pattern));
			assert.match(notices.at(-1)!, /No presets found/);
			assert.equal(readFileSync(configFile(dir), "utf8"), active);
			if (contents !== undefined) assert.equal(readFileSync(path, "utf8"), contents);
		}

		// A bad preset or profile is dropped and reported; the rest still loads.
		writeFileSync(path, JSON.stringify({
			broken: null,
			partial: { fast: profile, frontier: { primary: { model: "provider/model", thinkingLevel: "wrong" } } },
		}));
		const notices: string[] = [];
		await handler("preset", { hasUI: true, ui: {
			select: async (_title: string, options: string[]) => {
				assert.deepEqual(options, ["partial"]);
				return undefined;
			},
			notify(message: string) { notices.push(message); },
		} });
		assert.match(notices[0]!, /broken: must be a JSON object; partial\.frontier: primary must contain/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("preset application preserves config corrupted while the picker is open", async () => {
	const dir = tempDir();
	try {
		const { handler } = controlPlane(eventBus(), dir);
		const profile = { primary: { model: "provider/model", thinkingLevel: "off" } };
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		writeFileSync(join(dir, "config", "pi-task-models", "presets.json"), JSON.stringify({
			setup: { fast: profile, balanced: profile, frontier: profile },
		}));
		const notices: Array<[string, string]> = [];
		await handler("preset", { ui: {
			select: async () => {
				writeFileSync(configFile(dir), "{ not json");
				return "setup";
			},
			notify(message: string, level: string) { notices.push([message, level]); },
		} });
		assert.equal(readFileSync(configFile(dir), "utf8"), "{ not json");
		assert.equal(notices.length, 1);
		assert.match(notices[0]![0], /^Couldn't save task model config: Config at .* has issues; .*invalid JSON/);
		assert.equal(notices[0]![1], "error");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Option+S saves all current profiles, merges names, confirms replacement, and round-trips", async () => {
	const dir = tempDir();
	try {
		initTheme("dark");
		const { handler } = controlPlane(eventBus(), dir);
		const profiles = {
			fast: {
				primary: { model: "provider/quick", thinkingLevel: "low" },
				fallback: { model: "provider/backup", thinkingLevel: "off" },
			},
			fav: { primary: { model: "provider/favorite", thinkingLevel: "high" } },
		};
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		const active = JSON.stringify({ profiles, tasks: { "pi-example/review": "fav" } });
		writeFileSync(configFile(dir), active);
		const path = join(dir, "config", "pi-task-models", "presets.json");
		let name: string | undefined = "my-setup";
		let replace = false;
		let confirmations = 0;
		const notices: Array<[string, string]> = [];
		const ctx = { mode: "tui", ui: {
			custom: async (factory: any) => {
				let result: unknown;
				const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, (value: unknown) => { result = value; });
				assert.match(component.render(80).join("\n"), /Option\+S/);
				component.handleInput("\x1bs");
				return result;
			},
			input: async () => name,
			confirm: async () => {
				assert.equal(existsSync(`${path}.lock`), false, "must confirm before taking the preset lock");
				confirmations++;
				return replace;
			},
			notify(message: string, level: string) { notices.push([message, level]); },
		} };
		await handler("", ctx);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "my-setup": profiles });
		assert.equal(confirmations, 0);
		assert.deepEqual(notices.pop(), ["Saved task model preset: my-setup.", "info"]);
		assert.equal(readFileSync(configFile(dir), "utf8"), active);

		name = "__proto__";
		await handler("", ctx);
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))), ["my-setup", "__proto__"]);
		const saved = readFileSync(path, "utf8");
		name = undefined;
		await handler("", ctx);
		name = "my-setup";
		await handler("", ctx);
		assert.equal(confirmations, 1);
		assert.equal(readFileSync(path, "utf8"), saved);

		const updated = { fast: { primary: { model: "provider/new", thinkingLevel: "off" } } };
		writeFileSync(configFile(dir), JSON.stringify({ profiles: updated }));
		replace = true;
		await handler("", ctx);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "my-setup": updated, ["__proto__"]: profiles });
		await handler("preset", { ui: { select: async () => "__proto__", notify() {} } });
		assert.deepEqual(loadTaskModelsConfig(dir).value.profiles, profiles);

		// Another session changes the active profiles while the name prompt is open; the preset saves the latest ones.
		name = "latest";
		const edited = { balanced: { primary: { model: "provider/edited", thinkingLevel: "low" } } };
		ctx.ui.input = async () => { writeFileSync(configFile(dir), JSON.stringify({ profiles: edited })); return name; };
		await handler("", ctx);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).latest, edited);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("preset saving refuses a name another session saved after the unlocked check", async () => {
	const dir = tempDir();
	try {
		const { handler } = controlPlane(eventBus(), dir);
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		writeFileSync(configFile(dir), JSON.stringify({ profiles: { fast: {
			primary: { model: "provider/model", thinkingLevel: "off" },
		} } }));
		const path = join(dir, "config", "pi-task-models", "presets.json");
		const other = `${JSON.stringify({ shared: { fav: { primary: { model: "provider/other", thinkingLevel: "high" } } } })}\n`;
		const notices: Array<[string, string]> = [];
		await handler("", { mode: "tui", ui: {
			custom: async (factory: any) => {
				let result: unknown;
				factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, (value: unknown) => { result = value; }).handleInput("\x1bs");
				return result;
			},
			// Another session holds the lock across the unlocked check, then saves the same name.
			input: async () => {
				const release = await lock(path, { realpath: false });
				setTimeout(async () => {
					writeFileSync(path, other);
					await release();
				}, 50);
				return "shared";
			},
			confirm: async () => assert.fail("must not confirm a name that was absent at the unlocked check"),
			notify(message: string, level: string) { notices.push([message, level]); },
		} });
		assert.equal(readFileSync(path, "utf8"), other);
		assert.equal(notices.length, 1);
		assert.match(notices[0]![0], /Another session saved preset "shared"; try again\./);
		assert.equal(notices[0]![1], "error");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("preset saving rejects invalid names, malformed existing files, and oversized output without overwriting", async () => {
	const dir = tempDir();
	try {
		const { handler } = controlPlane(eventBus(), dir);
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		writeFileSync(configFile(dir), JSON.stringify({ profiles: { fast: {
			primary: { model: "provider/model", thinkingLevel: "off" },
		} } }));
		const path = join(dir, "config", "pi-task-models", "presets.json");
		let name = "new";
		const notices: string[] = [];
		const ctx = { mode: "tui", ui: {
			custom: async (factory: any) => {
				let result: unknown;
				factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, (value: unknown) => { result = value; }).handleInput("\x1bs");
				return result;
			},
			input: async () => name,
			confirm: async () => assert.fail("must not offer to replace malformed presets"),
			notify(message: string) { notices.push(message); },
		} };
		for (const invalid of ["", " padded", "bad\nname"]) {
			name = invalid;
			await handler("", ctx);
			assert.match(notices.pop()!, /Preset names must be/);
			assert.throws(() => readFileSync(path), { code: "ENOENT" });
		}
		name = "new";
		for (const contents of ["{ not json", '{"invalid":{"unknown":{}}}']) {
			writeFileSync(path, contents);
			await handler("", ctx);
			assert.match(notices.pop()!, /Couldn't save task model presets/);
			assert.equal(readFileSync(path, "utf8"), contents);
		}
		const contents = JSON.stringify({ existing: { fast: { primary: {
			model: `provider/${"x".repeat(65_350)}`, thinkingLevel: "off",
		} } } });
		writeFileSync(path, contents);
		await handler("", ctx);
		assert.match(notices.pop()!, /Config exceeds 65536 bytes/);
		assert.equal(readFileSync(path, "utf8"), contents);
		writeFileSync(configFile(dir), "{}");
		await handler("", ctx);
		assert.match(notices.pop()!, /Configure a task model profile/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("task model TUI delegates selection and cancellation to Pi's native list", async () => {
	const dir = tempDir();
	try {
		const { handler } = controlPlane(eventBus(), dir);
		let key = "\x1b";
		const ctx = { mode: "tui", ui: {
			custom: async (factory: any) => {
				let result: unknown;
				factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, (value: unknown) => { result = value; }).handleInput(key);
				return result;
			},
			select: async (title: string) => { assert.equal(title, "Profile fast primary"); return undefined; },
			notify: () => assert.fail("unexpected notification"),
		}, scopedModels: [], modelRegistry: { getAvailable: () => [{ provider: "test", id: "model", input: ["text"] }] } };
		await handler("", ctx);
		key = "\r";
		await handler("", ctx);
		assert.throws(() => readFileSync(configFile(dir)), { code: "ENOENT" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("uses scoped models and pinned thinking for picker and route resolution", () => {
	const allowed = { provider: "provider", id: "allowed", input: ["text"], reasoning: true, thinkingLevelMap: { low: "low", high: "high" } } as any;
	const excluded = { provider: "provider", id: "excluded", input: ["text"], reasoning: false } as any;
	const ctx = {
		model: allowed,
		scopedModels: [{ model: allowed, thinkingLevel: "high" as const }],
		modelRegistry: { getAvailable: () => [allowed, excluded] },
	};

	assert.deepEqual(availableTaskModels(ctx), [allowed]);
	assert.deepEqual(taskThinkingLevels(ctx, allowed), ["high"]);
	assert.equal(resolveTaskModelRoute(ctx, { model: "provider/allowed", thinkingLevel: "high" })?.model, allowed);
	assert.equal(resolveTaskModelRoute(ctx, { model: "provider/allowed", thinkingLevel: "low" }), undefined);
	assert.equal(resolveTaskModelRoute(ctx, { model: "provider/excluded", thinkingLevel: "off" }), undefined);
});

test("resolves declaration defaults, explicit overrides, and fallbacks", () => {
	const dir = tempDir();
	try {
		const primary = { provider: "provider", id: "primary", input: ["text"], reasoning: false } as any;
		const fallback = { provider: "provider", id: "fallback", input: ["text"], reasoning: false } as any;
		const ctx = {
			model: primary,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [primary, fallback] },
		};
		const file = configFile(dir);
		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });

		assert.throws(
			() => resolveConfiguredTaskRoute(ctx, EXAMPLE_TASK, dir),
			{
				taskRouteCode: "config-missing",
				message: /Task model config is missing\. Run \/task-models to configure task routes\./,
			},
		);

		writeFileSync(file, "{}");
		assert.throws(
			() => resolveConfiguredTaskRoute(ctx, EXAMPLE_TASK, dir),
			{ taskRouteCode: "profile-missing" },
		);

		writeFileSync(file, JSON.stringify({
			profiles: {
				fast: { primary: { model: "provider/primary", thinkingLevel: "off" } },
				frontier: {
					primary: { model: "provider/primary", thinkingLevel: "off" },
					fallback: { model: "provider/fallback", thinkingLevel: "off" },
				},
			},
		}));
		assert.deepEqual(resolveConfiguredTaskRoute(ctx, EXAMPLE_TASK, dir), {
			model: primary,
			thinkingLevel: "off",
		});

		writeFileSync(file, JSON.stringify({
			profiles: {
				frontier: {
					primary: { model: "provider/unavailable", thinkingLevel: "off" },
					fallback: { model: "provider/fallback", thinkingLevel: "off" },
				},
			},
			tasks: { [EXAMPLE_TASK.id]: "frontier" },
		}));
		assert.deepEqual(resolveConfiguredTaskRoutes(ctx, EXAMPLE_TASK, dir), [
			{ model: fallback, thinkingLevel: "off" },
		]);
		assert.deepEqual(resolveConfiguredTaskRoute(ctx, EXAMPLE_TASK, dir), {
			model: fallback,
			thinkingLevel: "off",
		});

		writeFileSync(file, JSON.stringify({
			profiles: { frontier: { primary: { model: "provider/primary", thinkingLevel: "wrong" } } },
			tasks: { [EXAMPLE_TASK.id]: "frontier" },
		}));
		assert.throws(
			() => resolveConfiguredTaskRoute(ctx, EXAMPLE_TASK, dir),
			{
				taskRouteCode: "profile-missing",
				message: /profile frontier is invalid in .*config\.json: profiles\.frontier: primary must contain/,
			},
		);

		writeFileSync(file, "{ not json\n");
		assert.throws(
			() => resolveConfiguredTaskRoute(ctx, EXAMPLE_TASK, dir),
			{
				taskRouteCode: "config-disabled",
				message: /Task model config at .*config\.json is disabled: invalid JSON/,
			},
		);
		assert.throws(
			() => resolveConfiguredTaskRoute(ctx, { id: "bad task", label: "Bad", purpose: "Bad", defaultProfile: "fast" } as ModelTask, dir),
			/Model Task declaration is invalid/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("returns the first successful route", async () => {
	const attempts: string[] = [];
	const result = await executeTaskRoutes(
		EXECUTION_ROUTES,
		async (route) => {
			attempts.push(route.model.id);
			return route.model.id;
		},
		{ shouldFallback: () => true },
	);
	assert.equal(result, "primary");
	assert.deepEqual(attempts, ["primary"]);
});

test("executes approved fallback routes serially and reports each attempt", async () => {
	const primaryFailure = Object.assign(new Error("primary failed"), { taskRouteCode: "no-route", code: "unused-code" });
	const records: TaskRouteAttempt[] = [];
	const attempts: string[] = [];
	let releasePrimary = () => {};
	const primaryPending = new Promise<void>((resolve) => { releasePrimary = () => resolve(); });
	const result = executeTaskRoutes(
		EXECUTION_ROUTES,
		async (route) => {
			attempts.push(route.model.id);
			if (route.model.id === "primary") {
				await primaryPending;
				throw primaryFailure;
			}
			return route.model.id;
		},
		{ shouldFallback: (error) => error === primaryFailure, onAttempt: (record) => { records.push(record); } },
	);
	assert.deepEqual(attempts, ["primary"]);
	assert.equal(records.length, 0);
	releasePrimary();
	assert.equal(await result, "fallback");
	assert.deepEqual(attempts, ["primary", "fallback"]);
	assert.deepEqual(records.map(({ durationMs, ...record }) => record), [
		{ routeIndex: 0, model: "test/primary", outcome: "failed", errorCode: "no-route" },
		{ routeIndex: 1, model: "test/fallback", outcome: "succeeded" },
	]);
	for (const record of records) {
		assert.ok(Object.isFrozen(record));
		assert.ok(Number.isFinite(record.durationMs) && record.durationMs >= 0);
		assert.throws(() => { (record as any).outcome = "changed"; }, TypeError);
	}
});

test("rethrows the exact final route error and reports it", async () => {
	const firstFailure = new Error("first failed");
	const finalFailure = new Error("final failed");
	const records: TaskRouteAttempt[] = [];
	let attempt = 0;
	let fallbackChecks = 0;
	await assert.rejects(
		executeTaskRoutes(
			EXECUTION_ROUTES,
			async () => { throw [firstFailure, finalFailure][attempt++]; },
			{ shouldFallback: () => { fallbackChecks++; return true; }, onAttempt: (record) => { records.push(record); } },
		),
		(error) => error === finalFailure,
	);
	assert.equal(attempt, 2);
	assert.equal(fallbackChecks, 1);
	assert.deepEqual(records.map(({ errorCode, outcome, routeIndex }) => ({ errorCode, outcome, routeIndex })), [
		{ errorCode: "Error", outcome: "failed", routeIndex: 0 },
		{ errorCode: "Error", outcome: "failed", routeIndex: 1 },
	]);
});

test("reports bounded error codes without message or result text", async () => {
	for (const [error, code] of [
		[Object.assign(new Error("private message"), { taskRouteCode: "no-route", code: "E_TEST", status: 503 }), "no-route"],
		[{ code: "E_TEST", status: 503, name: "CustomError" }, "E_TEST"],
		[{ code: 503, status: 429, name: "CustomError" }, "http-429"],
		[{ status: 503, name: "CustomError" }, "http-503"],
		[{ status: Number.NaN, name: "CustomError" }, "CustomError"],
		[{ status: Number.POSITIVE_INFINITY }, "error"],
		[{ status: "503", code: 503 }, "error"],
		[{ name: "CustomError", message: "private message", output: "private output" }, "CustomError"],
		[{ name: "Custom_Error2" }, "Custom_Error2"],
		[{ name: "secret prompt" }, "error"],
		[{ name: "Error\nsecret" }, "error"],
		[{ name: "2Error" }, "error"],
		[{ name: "E".repeat(64) }, "E".repeat(64)],
		[{ name: "E".repeat(65) }, "error"],
		[{ code: `E_TEST\r\n${"x".repeat(100)}` }, `E_TEST ${"x".repeat(57)}`],
		[{ taskRouteCode: "x".repeat(100) }, "x".repeat(64)],
		[{ code: "", name: "CustomError" }, "CustomError"],
		["text failure\nnext", "error"],
	] as const) {
		const records: TaskRouteAttempt[] = [];
		await assert.rejects(executeTaskRoutes(EXECUTION_ROUTES.slice(0, 1), async () => { throw error; }, {
			shouldFallback: () => assert.fail("the last route must not check fallback"),
			onAttempt(record) { records.push(record); },
		}), (caught) => caught === error);
		assert.equal(records.length, 1);
		assert.deepEqual(Object.keys(records[0]!).sort(), ["durationMs", "errorCode", "model", "outcome", "routeIndex"]);
		assert.equal(records[0]!.errorCode, code);
		assert.ok(records[0]!.errorCode!.length <= 64);
		assert.doesNotMatch(JSON.stringify(records), /private message|private output|secret prompt|text failure/);
	}
	const records: TaskRouteAttempt[] = [];
	const result = { output: "private output" };
	assert.equal(await executeTaskRoutes(EXECUTION_ROUTES, async () => result, {
		shouldFallback: () => true, onAttempt(record) { records.push(record); },
	}), result);
	assert.deepEqual(Object.keys(records[0]!).sort(), ["durationMs", "model", "outcome", "routeIndex"]);
	assert.equal(records.length, 1);
});

test("never copies error message text or thrown strings into route records", async () => {
	const records: TaskRouteAttempt[] = [];
	const failures = [new Error("secret prompt"), "secret prompt"];
	let calls = 0;
	await assert.rejects(executeTaskRoutes(EXECUTION_ROUTES, async () => { throw failures[calls++]; }, {
		shouldFallback: () => true,
		onAttempt(record) { records.push(record); },
	}), (error) => error === failures[1]);
	assert.equal(records.length, 2);
	assert.deepEqual(records.map(({ errorCode }) => errorCode), ["Error", "error"]);
	for (const record of records) {
		assert.ok(Object.isFrozen(record));
		assert.equal(Object.hasOwn(record, "error"), false);
		assert.doesNotMatch(JSON.stringify(record), /secret prompt/);
	}
});

test("preserves route errors and fallback when an Error name getter throws, with or without an observer", async () => {
	const failure = new Error("private route failure");
	Object.defineProperty(failure, "name", { get() { throw new Error("private getter failure"); } });
	for (const observe of [false, true]) {
		for (const [routes, fallback, succeeds] of [
			[EXECUTION_ROUTES, true, true],
			[EXECUTION_ROUTES, false, false],
			[EXECUTION_ROUTES, true, false],
			[EXECUTION_ROUTES.slice(0, 1), true, false],
		] as const) {
			const records: TaskRouteAttempt[] = [];
			const attempts: string[] = [];
			let fallbackChecks = 0;
			const result = executeTaskRoutes(routes, async (route) => {
				attempts.push(route.model.id);
				if (succeeds && route.model.id === "fallback") return "fallback";
				throw failure;
			}, {
				shouldFallback(error) {
					assert.equal(error, failure);
					fallbackChecks++;
					return fallback;
				},
				onAttempt: observe ? (record) => { records.push(record); } : undefined,
			});
			if (succeeds) assert.equal(await result, "fallback");
			else await assert.rejects(result, (error) => error === failure);
			assert.deepEqual(attempts, fallback && routes.length > 1 ? ["primary", "fallback"] : ["primary"]);
			assert.equal(fallbackChecks, routes.length > 1 ? 1 : 0);
			assert.deepEqual(records.map(({ durationMs, ...record }) => record), observe ? attempts.map((model, routeIndex) => ({
				routeIndex,
				model: `test/${model}`,
				outcome: succeeds && routeIndex === 1 ? "succeeded" : "failed",
				...(succeeds && routeIndex === 1 ? {} : { errorCode: "error" }),
			})) : []);
			assert.doesNotMatch(JSON.stringify(records), /private/);
		}
	}
});

test("reports a generic error code when error metadata getters throw", async () => {
	for (const field of ["taskRouteCode", "code", "status", "name"]) {
		const failure = Object.defineProperty({}, field, { get() { throw new Error("private getter failure"); } });
		const records: TaskRouteAttempt[] = [];
		await assert.rejects(executeTaskRoutes(EXECUTION_ROUTES.slice(0, 1), async () => { throw failure; }, {
			shouldFallback: () => assert.fail("the last route must not check fallback"),
			onAttempt(record) { records.push(record); },
		}), (error) => error === failure);
		assert.equal(records.length, 1);
		assert.equal(records[0]!.outcome, "failed");
		assert.equal(records[0]!.errorCode, "error");
		assert.ok(Object.isFrozen(records[0]));
		assert.doesNotMatch(JSON.stringify(records), /private/);
	}
});

test("ignores synchronous and asynchronous observer failures without changing route results", async () => {
	for (const onAttempt of [
		() => { throw new Error("observer failed"); },
		async () => { throw new Error("observer failed"); },
	]) {
		let calls = 0;
		assert.equal(await executeTaskRoutes(EXECUTION_ROUTES, async () => {
			if (calls++ === 0) throw new Error("primary failed");
			return "fallback";
		}, { shouldFallback: () => true, onAttempt }), "fallback");
		const failure = new Error("route failed");
		for (const routes of [EXECUTION_ROUTES, EXECUTION_ROUTES.slice(0, 1)]) {
			await assert.rejects(executeTaskRoutes(routes, async () => { throw failure; }, {
				shouldFallback: () => false, onAttempt,
			}), (error) => error === failure);
		}
	}
});

test("reports aborted attempts but not routes cancelled before execution", async () => {
	const records: TaskRouteAttempt[] = [];
	const before = new AbortController();
	before.abort();
	await assert.rejects(executeTaskRoutes(EXECUTION_ROUTES, async () => assert.fail("must not execute"), {
		signal: before.signal, shouldFallback: () => true, onAttempt(record) { records.push(record); },
	}), { name: "AbortError" });
	assert.equal(records.length, 0);
	for (const routes of [EXECUTION_ROUTES, EXECUTION_ROUTES.slice(1)]) {
		const controller = new AbortController();
		const failure = new Error("attempt cancelled");
		records.length = 0;
		await assert.rejects(executeTaskRoutes(routes, async () => {
			controller.abort();
			throw failure;
		}, {
			signal: controller.signal,
			shouldFallback: () => assert.fail("cancellation must not check fallback"),
			onAttempt(record) { records.push(record); },
		}), (error) => error === failure);
		assert.equal(records.length, 1);
		assert.equal(records[0]!.outcome, "aborted");
		assert.equal(records[0]!.errorCode, "Error");
		assert.equal(records[0]!.model, `test/${routes[0].model.id}`);
	}
});

test("reports AbortError without a signal and preserves fallback policy errors", async () => {
	const records: TaskRouteAttempt[] = [];
	const abort = Object.assign(new Error("route cancelled"), { name: "AbortError" });
	await assert.rejects(executeTaskRoutes(EXECUTION_ROUTES.slice(0, 1), async () => { throw abort; }, {
		shouldFallback: () => false, onAttempt(record) { records.push(record); },
	}), (error) => error === abort);
	assert.equal(records[0]!.outcome, "aborted");
	assert.equal(records[0]!.errorCode, "AbortError");

	const policyError = new Error("fallback policy failed");
	records.length = 0;
	await assert.rejects(executeTaskRoutes(EXECUTION_ROUTES, async () => { throw new Error("primary failed"); }, {
		shouldFallback: () => { throw policyError; }, onAttempt(record) { records.push(record); },
	}), (error) => error === policyError);
	assert.equal(records.length, 1);
	assert.equal(records[0]!.errorCode, "Error");
});

test("rejects an empty route list", async () => {
	let attempted = false;
	await assert.rejects(
		executeTaskRoutes([], async () => {
			attempted = true;
			return undefined;
		}, { shouldFallback: () => true, onAttempt: () => assert.fail("an empty route list has no attempts") }),
		/Task route list must not be empty/,
	);
	assert.equal(attempted, false);
});

test("stops before or after cancellation and on non-fallback errors", async () => {
	const beforeAttempt = new AbortController();
	const beforeAttemptError = new Error("cancelled before attempt");
	beforeAttempt.abort(beforeAttemptError);
	let beforeAttemptCalls = 0;
	await assert.rejects(
		executeTaskRoutes(EXECUTION_ROUTES, async () => {
			beforeAttemptCalls++;
			return "unexpected";
		}, { shouldFallback: () => true, signal: beforeAttempt.signal }),
		(error) => error === beforeAttemptError,
	);
	assert.equal(beforeAttemptCalls, 0);

	const afterFailure = new AbortController();
	const afterFailureError = new Error("cancelled after failure");
	let afterFailureCalls = 0;
	await assert.rejects(
		executeTaskRoutes(EXECUTION_ROUTES, async () => {
			afterFailureCalls++;
			afterFailure.abort();
			throw afterFailureError;
		}, {
			shouldFallback: () => { throw new Error("should not evaluate fallback after cancellation"); },
			signal: afterFailure.signal,
		}),
		(error) => error === afterFailureError,
	);
	assert.equal(afterFailureCalls, 1);

	const nonFallbackError = new Error("do not fall back");
	let nonFallbackCalls = 0;
	await assert.rejects(
		executeTaskRoutes(EXECUTION_ROUTES, async () => {
			nonFallbackCalls++;
			throw nonFallbackError;
		}, { shouldFallback: () => false }),
		(error) => error === nonFallbackError,
	);
	assert.equal(nonFallbackCalls, 1);
});

test("registers model tasks idempotently and discovers them in either load order", async () => {
	for (const consumerFirst of [true, false]) {
		const dir = tempDir();
		try {
			const events = eventBus();
			let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
			const pi = {
				events,
				on() {},
				registerCommand(_name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
					handler = command.handler;
				},
				registerVirtualModel() {},
			};
			const register = () => registerModelTask(pi as never, EXAMPLE_TASK);
			if (consumerFirst) register();
			registerTaskModelsExtension(pi as never, { agentDir: dir });
			if (!consumerFirst) register();
			register();
			assert.equal(events.listenerCount(MODEL_TASK_REQUEST_EVENT), 1, "registration is idempotent");

			const responses: unknown[] = [];
			const offResponses = events.on(MODEL_TASK_RESPONSE_EVENT, (payload) => responses.push(payload));
			events.emit(MODEL_TASK_REQUEST_EVENT, { requestId: "ignored", extra: true });
			assert.deepEqual(responses, [], "malformed requests are ignored at the consumer boundary");
			offResponses();

			// A malformed response from another extension must not enter the control plane.
			events.on(MODEL_TASK_REQUEST_EVENT, (request) => {
				events.emit(MODEL_TASK_RESPONSE_EVENT, {
					requestId: (request as { requestId?: unknown }).requestId,
					task: { id: "bad task" },
				});
			});
			mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
			writeFileSync(configFile(dir), JSON.stringify({
				profiles: {},
				tasks: { "pi-hidden/disabled": "balanced" },
			}));
			assert.ok(handler);
			await handler!("", {
				ui: {
					select: async (_label: string, options: readonly string[]) => {
						assert.deepEqual(options, [
							"fast · not configured",
							"balanced · not configured",
							"frontier · not configured",
							"fav · not configured",
							"Example review · pi-example/review · fast",
						]);
						return undefined;
					},
					notify() {},
				},
			});
			assert.deepEqual(loadTaskModelsConfig(dir).value.tasks, { "pi-hidden/disabled": "balanced" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("task-models stores only non-default active task assignments", async () => {
	const dir = tempDir();
	try {
		const events = eventBus();
		const { pi, handler } = controlPlane(events, dir);
		registerModelTask(pi as never, EXAMPLE_TASK);
		const selections = [
			"Example review · pi-example/review · fast",
			"frontier",
			"Example review · pi-example/review · frontier",
			"fast",
		];
		await handler("", {
			ui: {
				select: async (_label: string, options: readonly string[]) => {
					const selection = selections.shift();
					assert.ok(selection);
					assert.ok(options.includes(selection));
					return selection;
				},
				notify() {},
			},
		});
		assert.deepEqual(loadTaskModelsConfig(dir).value.tasks, { [EXAMPLE_TASK.id]: "frontier" });

		await handler("", {
			ui: {
				select: async (_label: string, options: readonly string[]) => {
					const selection = selections.shift();
					assert.ok(selection);
					assert.ok(options.includes(selection));
					return selection;
				},
				notify() {},
			},
		});
		assert.deepEqual(loadTaskModelsConfig(dir).value.tasks, {});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("task assignment merges into the latest config and preserves config corrupted while the picker is open", async () => {
	const dir = tempDir();
	try {
		const events = eventBus();
		const { pi, handler } = controlPlane(events, dir);
		registerModelTask(pi as never, EXAMPLE_TASK);
		const profiles = { fast: { primary: { model: "provider/model", thinkingLevel: "off" } } };
		const notices: string[] = [];
		const run = (onAssign: () => void) => handler("", { ui: {
			select: async (_label: string, options: readonly string[]) => {
				if (options.includes("frontier")) {
					onAssign();
					return "frontier";
				}
				return options.find((option) => option.startsWith(EXAMPLE_TASK.label));
			},
			notify(message: string) { notices.push(message); },
		} });

		await run(() => {
			mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
			writeFileSync(configFile(dir), JSON.stringify({ profiles, tasks: { "pi-other/task": "fav" } }));
		});
		assert.deepEqual(loadTaskModelsConfig(dir).value, { profiles, tasks: { "pi-other/task": "fav", [EXAMPLE_TASK.id]: "frontier" } });

		await run(() => writeFileSync(configFile(dir), "{ not json"));
		assert.equal(readFileSync(configFile(dir), "utf8"), "{ not json");
		assert.match(notices.pop()!, /^Couldn't save task model config: Config at .* has issues/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("task-models configures primary and fallback atomically in one profile flow", async () => {
	const dir = tempDir();
	try {
		const events = eventBus();
		const { handler } = controlPlane(events, dir);
		const canonical = { provider: "openai-codex", id: "gpt-5", input: ["text"], reasoning: true, thinkingLevelMap: { low: "low" } };
		const alias = { ...canonical, provider: "openai-codex-2" };
		const fallback = { provider: "other", id: "fallback", input: ["text"], reasoning: false };
		const excluded = { provider: "other", id: "excluded", input: ["text"], reasoning: false };
		let selections = ["fast · not configured", "openai-codex-2/gpt-5", "low", "other/fallback", "off"];
		const ctx = {
			ui: {
				select: async (label: string, options: readonly string[]) => {
					assert.equal(options.includes("other/excluded"), false);
					if (label === "Profile fast fallback" && selections.length === 2) {
						assert.throws(() => readFileSync(configFile(dir), "utf8"), { code: "ENOENT" });
					}
					if (label === "Profile fast fallback" && selections.length === 1) {
						// Replace the home after loading so the async save fails deterministically.
						rmSync(join(dir, "config", "pi-task-models"), { recursive: true, force: true });
						writeFileSync(join(dir, "config", "pi-task-models"), "blocked");
					}
					const choice = selections.shift();
					assert.ok(choice);
					assert.ok(options.includes(choice));
					return choice;
				},
				notify(_message: string) {},
			},
			modelRegistry: { getAvailable: () => [canonical, alias, fallback, excluded] },
			model: alias,
			scopedModels: [
				{ model: alias, thinkingLevel: "low" },
				{ model: fallback, thinkingLevel: "off" },
			],
		};
		await handler("", ctx);
		assert.deepEqual(loadTaskModelsConfig(dir).value.profiles.fast, {
			primary: { model: "openai-codex/gpt-5", thinkingLevel: "low" },
			fallback: { model: "other/fallback", thinkingLevel: "off" },
		});
		assert.match(readFileSync(configFile(dir), "utf8"), /"openai-codex\/gpt-5"/);
		assert.deepEqual(selections, []);

		selections = ["fast · openai-codex/gpt-5 (low) → other/fallback (off)", "openai-codex-2/gpt-5", "low", "None"];
		const notifications: string[] = [];
		ctx.ui.notify = (message: string) => { notifications.push(message); };
		await handler("", ctx);
		assert.ok(notifications.some((message) => message.startsWith("Couldn't save task model config: ")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function routeModel(provider: string, id: string, extra: Record<string, unknown> = {}) {
	return { provider, id, api: "openai-completions", input: ["text"], reasoning: true, ...extra } as any;
}

test("a Task Profile Model uses the next route after a retryable failure and skips it during the cooldown", () => {
	const primary = routeModel("route-test", `primary-${Date.now()}`);
	const fallback = routeModel("route-test", `fallback-${Date.now()}`);
	const routes = [{ model: primary, thinkingLevel: "high" }, { model: fallback, thinkingLevel: "medium" }] as any;
	const now = 1_000_000;
	assert.equal(routeTaskProfile(routes, { reason: "user" }, now).model, primary);

	const failure = (model: unknown, errorMessage: string) =>
		({ reason: "retry", failed: { model, message: { stopReason: "error", errorMessage } } }) as any;
	assert.equal(routeTaskProfile(routes, failure(primary, "prompt is too long: context length exceeded"), now).model, primary,
		"a context overflow keeps the route");
	assert.equal(routeTaskProfile(routes, failure(primary, "503 Service Unavailable"), now).model, fallback);

	// The primary has a cooldown, so new turns and continuations stay on the fallback.
	assert.equal(routeTaskProfile(routes, { reason: "user" }, now + 1000).model, fallback);
	assert.equal(routeTaskProfile(routes, { reason: "continuation", previous: { model: fallback } } as any, now + 1000).model, fallback);
	// After the cooldown, a new turn keeps the previous route for its prompt cache.
	const later = now + 11 * 60_000;
	assert.equal(routeTaskProfile(routes, { reason: "user", previous: { model: fallback } } as any, later).model, fallback);
	assert.equal(routeTaskProfile(routes, { reason: "user" }, later).model, primary);

	// When both routes fail, the router still returns a route.
	assert.equal(routeTaskProfile(routes, failure(fallback, "overloaded"), now + 2000).model, primary);
	const single = [{ model: routeModel("route-test", `single-${Date.now()}`), thinkingLevel: "low" }] as any;
	assert.equal(routeTaskProfile(single, failure(single[0].model, "429 rate limit"), now).model, single[0].model);
	assert.throws(() => routeTaskProfile([], { reason: "user" }), /must not be empty/);
});

test("registers one Task Profile Model for each profile and routes it from the current config", () => {
	const dir = tempDir();
	try {
		const virtualModels: any[] = [];
		registerTaskProfileModels({ registerVirtualModel: (model: unknown) => virtualModels.push(model) } as never, { agentDir: dir });
		assert.deepEqual(virtualModels.map(({ provider, id }) => `${provider}/${id}`), ["fast", "balanced", "frontier", "fav"].map((profile) =>
			taskProfileModelReference(profile as never)));
		assert.ok(TASK_PROFILE_MODELS_EXTENSION.endsWith("task-profile-models.ts"));

		const frontier = virtualModels.find(({ id }) => id === "frontier");
		const primary = routeModel("route-config", "primary", { thinkingLevelMap: {} });
		const fallback = routeModel("route-config", "fallback");
		const taskModel = routeModel("task", "fast");
		const ctx = { modelRegistry: { getAvailable: () => [taskModel, primary, fallback] } };
		assert.throws(() => frontier.route({ reason: "user" }, ctx), /not configured/);

		mkdirSync(join(dir, "config", "pi-task-models"), { recursive: true });
		writeFileSync(configFile(dir), JSON.stringify({
			profiles: {
				frontier: {
					primary: { model: "route-config/primary", thinkingLevel: "high" },
					fallback: { model: "route-config/fallback", thinkingLevel: "medium" },
				},
				fast: { primary: { model: "task/fast", thinkingLevel: "low" } },
			},
		}));
		assert.deepEqual(frontier.route({ reason: "user" }, ctx), { model: primary, thinkingLevel: "high" });
		assert.deepEqual(
			frontier.route({ reason: "retry", failed: { model: primary, message: { errorMessage: "502 Bad Gateway" } } }, ctx),
			{ model: fallback, thinkingLevel: "medium" },
		);
		const fast = virtualModels.find(({ id }) => id === "fast");
		assert.throws(() => fast.route({ reason: "user" }, ctx), /no available route/, "a Task Route cannot name a Task Profile Model");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
