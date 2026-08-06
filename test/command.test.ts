import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { CompactionState, InitialCaptureState, SilentProbeState } from "../src/capture.ts";
import {
	getContextArgumentCompletions,
	parseContextCommand,
	resolveInitialCapture,
} from "../src/command.ts";

test("parseContextCommand defaults to Usage and accepts the explicit grammar", () => {
	assert.deepEqual(parseContextCommand(""), { type: "view", view: "usage" });
	assert.deepEqual(parseContextCommand(" Usage "), { type: "view", view: "usage" });
	assert.deepEqual(parseContextCommand("injections"), { type: "view", view: "injections" });
	assert.equal(parseContextCommand("runtime").type, "invalid");
	assert.equal(parseContextCommand("runtime on").type, "invalid");
	assert.equal(parseContextCommand("runtime off").type, "invalid");
	assert.deepEqual(parseContextCommand("usage extra"), {
		type: "invalid",
		message: "Usage: /context [usage|injections]",
	});
});

test("getContextArgumentCompletions exposes only v0.2.0 views", () => {
	assert.deepEqual(
		getContextArgumentCompletions("")?.map((item) => item.value),
		["usage", "injections"],
	);
	assert.deepEqual(
		getContextArgumentCompletions("inj")?.map((item) => item.value),
		["injections"],
	);
	assert.equal(getContextArgumentCompletions("run"), null);
	assert.equal(getContextArgumentCompletions("unknown"), null);
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
