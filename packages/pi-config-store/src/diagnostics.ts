import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type DiagnosticLevel = "info" | "warning" | "error";

export interface DiagnosticEvent {
	time: string;
	source: string;
	level: DiagnosticLevel;
	message: string;
}

interface DiagnosticState {
	schema: 1;
	events: DiagnosticEvent[];
	commandOwner?: object;
}

const DIAGNOSTICS = Symbol.for("@hcflabs/pi-config-store/diagnostics");

function state(): DiagnosticState {
	const shared = globalThis as { [DIAGNOSTICS]?: DiagnosticState };
	return shared[DIAGNOSTICS] ??= { schema: 1, events: [] };
}

function sanitize(text: string): string {
	const plain = stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
	return Array.from(plain).slice(0, 500).join("");
}

/** Record one event. Without UI, an explicit context also writes its message to stderr. */
export function recordDiagnostic(source: string, level: DiagnosticLevel, message: string, ctx?: { hasUI: boolean }): void {
	const event: DiagnosticEvent = {
		time: new Date().toISOString(),
		source: sanitize(source),
		level,
		message: sanitize(message),
	};
	const events = state().events;
	events.push(event);
	if (events.length > 200) events.splice(0, events.length - 200);
	if (ctx && !ctx.hasUI) process.stderr.write(`${event.message}\n`);
}

/** Return copies of the events, oldest first. */
export function readDiagnostics(): readonly DiagnosticEvent[] {
	return state().events.map((event) => ({ ...event }));
}

/** Register the shared command. The first caller owns it until session shutdown. */
export function registerDiagnosticsCommand(pi: Pick<ExtensionAPI, "registerCommand" | "on">): boolean {
	const shared = state();
	if (shared.commandOwner) return false;
	const owner = {};
	shared.commandOwner = owner;
	try {
		pi.registerCommand("diagnostics", {
			description: "Show recent diagnostics. Use /diagnostics all to show all events.",
			handler: async (args, ctx) => {
				const events = readDiagnostics();
				const selected = args.trim() === "all" ? events : events.slice(-20);
				const text = selected.length
					? selected.map(({ time, source, level, message }) => `${time} [${source}] ${level}: ${message}`).join("\n")
					: "No diagnostics.";
				if (ctx.hasUI) ctx.ui.notify(text, "info");
				else process.stdout.write(`${text}\n`);
			},
		});
		pi.on("session_shutdown", () => {
			if (state().commandOwner === owner) delete state().commandOwner;
		});
	} catch (error) {
		if (shared.commandOwner === owner) delete shared.commandOwner;
		throw error;
	}
	return true;
}
