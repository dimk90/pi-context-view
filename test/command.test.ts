import assert from "node:assert/strict";
import { test } from "node:test";

import { type ExtensionAPI, type ExtensionCommandContext, SettingsManager } from "@earendil-works/pi-coding-agent";

import {
	CONTEXT_COMMAND_DESCRIPTION,
	getContextArgumentCompletions,
	parseContextCommand,
	reportCommandMessage,
	reportCompactionInProgress,
	reportConfigCreation,
	reportTuiOnly,
	reportUnsupportedPi,
	resolveRequestSnapshot,
} from "../src/command.ts";
import { CompactionState } from "../src/compaction.ts";
import { ProbeFilter } from "../src/probe/filter.ts";
import { SilentProbe } from "../src/probe/silent-probe.ts";
import { ProbeTrigger } from "../src/probe/trigger.ts";
import { type RequestSnapshot, SnapshotStore } from "../src/snapshot.ts";
import { readProbeToken } from "../src/probe/token.ts";

/** Collect what a command reports through the TUI notification path. */
function createNotifyingContext(): {
	context: ExtensionCommandContext;
	notified: Array<{ message: string; type: string }>;
} {
	const notified: Array<{ message: string; type: string }> = [];
	const context = {
		hasUI: true,
		ui: { notify: (message: string, type: string) => notified.push({ message, type }) },
	} as unknown as ExtensionCommandContext;
	return { context, notified };
}

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
		"[usage|injections|config] - Inspect context usage, injections",
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
	const { context, notified } = createNotifyingContext();

	reportCommandMessage(context, 'Ignoring unknown key "\u001b[31mred\u0007"', "warning");
	reportCommandMessage(context, "x".repeat(600), "error");

	assert.deepEqual(notified[0], { message: 'Ignoring unknown key "red"', type: "warning" });
	assert.equal(notified[1]?.message.length, 500);
	assert.ok(notified[1]?.message.endsWith("\u2026"));
});

test("reportTuiOnly names the refused view instead of the whole command", () => {
	const { context, notified } = createNotifyingContext();

	reportTuiOnly(context, "usage");
	reportTuiOnly(context, "injections");

	// Only views are refused; /context config needs no UI and runs in every mode.
	assert.deepEqual(notified, [
		{ message: "/context usage is available in TUI mode only.", type: "warning" },
		{ message: "/context injections is available in TUI mode only.", type: "warning" },
	]);
});

test("reportCompactionInProgress names the refused view", () => {
	const { context, notified } = createNotifyingContext();

	reportCompactionInProgress(context, "usage");
	reportCompactionInProgress(context, "injections");

	assert.deepEqual(notified, [
		{ message: "/context usage is unavailable while compaction is in progress.", type: "warning" },
		{ message: "/context injections is unavailable while compaction is in progress.", type: "warning" },
	]);
});

test("reportUnsupportedPi names the required and the running Pi version", () => {
	const { context, notified } = createNotifyingContext();

	reportUnsupportedPi(context, "0.86.1");

	assert.deepEqual(notified, [{
		message: "/context requires Pi 1.0.0 or newer; this is Pi 0.86.1. Nothing was captured.",
		type: "error",
	}]);
});

test("reportConfigCreation reports every create outcome with its own severity", () => {
	const { context, notified } = createNotifyingContext();
	const filePath = "/agent/extensions/pi-context-view.json";

	reportConfigCreation(context, { type: "created", filePath });
	reportConfigCreation(context, { type: "exists", filePath });
	// OS error text is untrusted, so it must reach the terminal sanitized.
	reportConfigCreation(context, { type: "failed", filePath, reason: "EACCES: \u001b[31mdenied\u0007" });

	assert.deepEqual(notified, [
		{ message: `Created default configuration: ${filePath}`, type: "info" },
		{ message: `Configuration already exists; left unchanged: ${filePath}`, type: "warning" },
		{ message: `Cannot create configuration at ${filePath}: EACCES: denied`, type: "error" },
	]);
});

test("resolveRequestSnapshot sends the synthetic prompt inside the probe token scope", async (t) => {
	t.mock.method(SettingsManager, "create", () => SettingsManager.inMemory());
	const probe = new SilentProbe(new ProbeFilter());
	const compaction = new CompactionState();
	let sentContent: string | undefined;
	let tokenDuringSend: string | undefined;
	const pi = {
		getSettings: () => ({}),
		sendUserMessage: (content: string) => {
			sentContent = content;
			tokenDuringSend = readProbeToken();
			// No agent lifecycle follows in this harness; end the attempt at once.
			probe.fail("No agent run in this harness.");
		},
	} as unknown as ExtensionAPI;
	const context = {
		model: { provider: "anthropic", id: "test-model" },
		hasPendingMessages: () => false,
		getContextUsage: () => undefined,
		modelRegistry: { hasConfiguredAuth: () => true },
		ui: { setWorkingVisible: () => undefined },
		waitForIdle: async () => undefined,
	} as unknown as ExtensionCommandContext;

	const store = new SnapshotStore();
	const trigger = new ProbeTrigger({ pi, probe, snapshots: store, compaction });
	const result = await resolveRequestSnapshot(store, trigger, context, "latest");

	assert.equal(sentContent, "", "the probe prompt carries no instructions of its own");
	assert.equal(probe.isProbeInput("extension", tokenDuringSend), true, "the send must carry this attempt's token");
	assert.equal(readProbeToken(), undefined, "the token must not outlive the send");
	assert.deepEqual(result, {
		type: "missing",
		degradedReason: "No agent run in this harness. Extension additions were not observed.",
	});
});

test("resolveRequestSnapshot skips the probe when compaction starts while waiting for idle", async () => {
	const probe = new SilentProbe(new ProbeFilter());
	const compaction = new CompactionState();
	const controller = new AbortController();
	let sentUserMessages = 0;
	let waitedForIdle = false;
	const pi = {
		sendUserMessage: () => {
			sentUserMessages++;
		},
	} as unknown as ExtensionAPI;
	const context = {
		waitForIdle: async () => {
			waitedForIdle = true;
			compaction.begin(controller.signal);
		},
	} as unknown as ExtensionCommandContext;

	const store = new SnapshotStore();
	const trigger = new ProbeTrigger({ pi, probe, snapshots: store, compaction });
	const result = await resolveRequestSnapshot(store, trigger, context, "first");

	assert.equal(waitedForIdle, true);
	assert.equal(sentUserMessages, 0);
	assert.deepEqual(result, {
		type: "missing",
		degradedReason:
			"Silent probe unavailable: context compaction is in progress. Extension additions were not observed.",
	});

	const unusedAttempt = probe.start(1_000);
	assert.equal(unusedAttempt.started, true, "skipping compaction must not consume the runtime's probe attempt");
	probe.fail("test cleanup");
	assert.deepEqual(await unusedAttempt.completion, { status: "failed", reason: "test cleanup" });
});

/** A published snapshot with no changes; only its identity matters to Initial resolution. */
function requestSnapshot(id: number, origin: RequestSnapshot["origin"]): RequestSnapshot {
	return {
		id, origin, capturedAt: 0, leafId: null,
		changes: { conversation: [], system: [] },
		guard: { status: "incomplete", reason: "No payload." },
	};
}

test("resolveRequestSnapshot returns the selected snapshot without probing", async () => {
	const store = new SnapshotStore();
	store.publish(requestSnapshot(1, "real-turn"));
	store.publish(requestSnapshot(2, "synthetic-probe"));
	const trigger = { request: async () => assert.fail("no probe while a snapshot exists") } as unknown as ProbeTrigger;
	const context = { waitForIdle: async () => assert.fail("no wait while a snapshot exists") } as unknown as
		ExtensionCommandContext;

	const first = await resolveRequestSnapshot(store, trigger, context, "first");
	const latest = await resolveRequestSnapshot(store, trigger, context, "latest");

	assert.equal(first.type === "snapshot" ? first.snapshot.id : undefined, 1);
	assert.equal(latest.type === "snapshot" ? latest.snapshot.id : undefined, 2, "the latest of either origin");
});

test("resolveRequestSnapshot takes a snapshot a running turn published before idle, without probing", async () => {
	const store = new SnapshotStore();
	const trigger = { request: async () => assert.fail("the running turn supplies Initial") } as unknown as ProbeTrigger;
	const context = {
		waitForIdle: async () => store.publish(requestSnapshot(1, "real-turn")),
	} as unknown as ExtensionCommandContext;

	const result = await resolveRequestSnapshot(store, trigger, context, "first");

	assert.equal(result.type === "snapshot" ? result.snapshot.origin : undefined, "real-turn");
});

test("resolveRequestSnapshot asks ProbeTrigger once the store is empty and reports a failure", async () => {
	const store = new SnapshotStore();
	let probed = 0;
	const failing = {
		request: async () => {
			probed++;
			return { status: "failed", reason: "Silent probe unavailable: a virtual model is selected." };
		},
	} as unknown as ProbeTrigger;
	const context = { waitForIdle: async () => undefined } as unknown as ExtensionCommandContext;

	const missing = await resolveRequestSnapshot(store, failing, context, "first");
	assert.equal(probed, 1);
	assert.deepEqual(missing, {
		type: "missing",
		degradedReason: "Silent probe unavailable: a virtual model is selected. Extension additions were not observed.",
	});

	const capturing = {
		request: async () => {
			const snapshot = requestSnapshot(1, "synthetic-probe");
			store.publish(snapshot);
			return { status: "captured", snapshot };
		},
	} as unknown as ProbeTrigger;
	const probe = await resolveRequestSnapshot(store, capturing, context, "latest");
	assert.equal(probe.type === "snapshot" ? probe.snapshot.origin : undefined, "synthetic-probe");
});
