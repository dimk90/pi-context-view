import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { CompactionState, InitialCaptureState, SilentProbeState } from "../src/capture.ts";
import {
	CONTEXT_COMMAND_DESCRIPTION,
	getContextArgumentCompletions,
	parseContextCommand,
	reportCommandMessage,
	resolveInitialCapture,
} from "../src/command.ts";

test("parseContextCommand defaults to Usage and accepts the explicit grammar", () => {
	assert.deepEqual(parseContextCommand(""), { type: "view", view: "usage" });
	assert.deepEqual(parseContextCommand(" Usage "), { type: "view", view: "usage" });
	assert.deepEqual(parseContextCommand("injections"), { type: "view", view: "injections" });
	assert.deepEqual(parseContextCommand(" CONFIG "), { type: "config" });
	assert.equal(parseContextCommand("runtime").type, "invalid");
	assert.equal(parseContextCommand("runtime on").type, "invalid");
	assert.equal(parseContextCommand("runtime off").type, "invalid");
	assert.deepEqual(parseContextCommand("usage extra"), {
		type: "invalid",
		message: "Usage: /context [usage|injections|config]",
	});
});

test("command registration and completions expose the supported grammar", () => {
	assert.equal(
		CONTEXT_COMMAND_DESCRIPTION,
		"[usage|injections|config] — Inspect context usage, injections, or create config",
	);
	assert.deepEqual(
		getContextArgumentCompletions("")?.map((item) => item.value),
		["usage", "injections", "config"],
	);
	assert.deepEqual(
		getContextArgumentCompletions("inj")?.map((item) => item.value),
		["injections"],
	);
	assert.deepEqual(
		getContextArgumentCompletions(" C")?.map((item) => item.value),
		["config"],
	);
	assert.equal(getContextArgumentCompletions("run"), null);
	assert.equal(getContextArgumentCompletions("unknown"), null);
});

test("reportCommandMessage sanitizes and caps untrusted message text", () => {
	const notified: Array<{ message: string; type: string }> = [];
	const context = {
		hasUI: true,
		ui: { notify: (message: string, type: string) => notified.push({ message, type }) },
	} as unknown as ExtensionCommandContext;

	reportCommandMessage(context, 'Ignoring unknown key "\u001b[31mred\u0007"', "warning");
	reportCommandMessage(context, "x".repeat(600), "error");

	assert.deepEqual(notified[0], { message: 'Ignoring unknown key "red"', type: "warning" });
	assert.equal(notified[1]?.message.length, 500);
	assert.ok(notified[1]?.message.endsWith("\u2026"));
});

test("resolveInitialCapture skips the probe when compaction starts while waiting for idle", async () => {
	const capture = new InitialCaptureState();
	const probe = new SilentProbeState();
	const compaction = new CompactionState();
	const controller = new AbortController();
	let sentUserMessages = 0;
	let waitedForIdle = false;
	const pi = {
		getActiveTools: () => [],
		getAllTools: () => [],
		sendUserMessage: () => {
			sentUserMessages++;
		},
	} as unknown as ExtensionAPI;
	const context = {
		getSystemPrompt: () => "base prompt",
		getSystemPromptOptions: () => ({ cwd: "/tmp" }),
		waitForIdle: async () => {
			waitedForIdle = true;
			compaction.begin(controller.signal);
		},
	} as unknown as ExtensionCommandContext;

	const result = await resolveInitialCapture(pi, capture, probe, compaction, context);

	assert.equal(waitedForIdle, true);
	assert.equal(sentUserMessages, 0);
	assert.equal(
		result.degradedReason,
		"Silent probe unavailable: context compaction is in progress. Extension additions were not observed.",
	);
	assert.equal(result.snapshot.origin, "synthetic-probe");

	const unusedAttempt = probe.start(1_000);
	assert.equal(unusedAttempt.started, true, "skipping compaction must not consume the runtime's probe attempt");
	probe.fail("test cleanup");
	assert.deepEqual(await unusedAttempt.completion, { status: "failed", reason: "test cleanup" });
});
