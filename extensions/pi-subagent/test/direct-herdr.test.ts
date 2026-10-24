import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDirectHerdr, directCompletionAnswer, directTurnPrompt } from "../src/direct-herdr.ts";

test("write-access final turns require an explicit successful completion", () => {
	assert.equal(directCompletionAnswer("plain answer", false), "plain answer");
	assert.throws(() => directCompletionAnswer(" \n", false), /empty final answer/);
	assert.equal(directCompletionAnswer(JSON.stringify({ outcome: "succeeded", answer: "Scoped commit completed." }), true), "Scoped commit completed.");
	for (const outcome of ["failed", "blocked"]) {
		assert.throws(() => directCompletionAnswer(JSON.stringify({ outcome, answer: "Partial changes remain." }), true), /Direct task reported .*Partial changes remain/);
	}
	for (const text of ["Commit failed; partial changes remain.", "null", JSON.stringify({ answer: "Turn finished." }), JSON.stringify({ outcome: "succeeded", answer: "" })]) {
		assert.throws(() => directCompletionAnswer(text, true), /Pi write-access/);
	}
});

test("a direct turn prompt matches only the exact turn identity suffix", () => {
	const matches = directTurnPrompt("unique");
	assert.equal(matches("inspect\n\nTurn identity: unique"), true);
	assert.equal(matches("inspect\n\nTurn identity: unique\n"), false);
	assert.equal(matches("inspect\n\nTurn identity: other-unique"), false);
});

test("stop accepts native unnamed unrelated agents without authorizing mutations", async (t) => {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-direct-native-list-")));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const leasePath = join(cwd, "process.lease");
	await writeFile(leasePath, "", { mode: 0o600 });
	const previous = { ...process.env };
	Object.assign(process.env, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "owned-workspace", HERDR_PANE_ID: "caller" });
	t.after(() => { for (const key of ["HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_PANE_ID"]) {
		if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
	} });
	const tab = { name: "owned", tabId: "owned-tab", paneId: "owned-pane", leasePath, sessionFile: join(cwd, "session.jsonl") };
	for (const paneId of ["unrelated-pane", "owned-pane"]) {
		const exec: ExtensionAPI["exec"] = async (command, args) => {
			if (command === "lsof") return { code: 1, stdout: "", stderr: "", killed: false };
			assert.equal(args[1], "list", "the native-shape probe forbids all mutation calls");
			const result = args[0] === "agent" ? { type: "agent_list", agents: [{ agent: "pi", pane_id: paneId, tab_id: "unrelated-tab" }] }
				: { type: "pane_list", panes: [] };
			return { code: 0, stdout: JSON.stringify({ result }), stderr: "", killed: false };
		};
		const stopping = createDirectHerdr({ exec }, cwd, 1000).stop(tab);
		if (paneId === "owned-pane") await assert.rejects(stopping, /one exact owned agent/);
		else await stopping;
	}
});
