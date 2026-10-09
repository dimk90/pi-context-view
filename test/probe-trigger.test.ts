import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import { type ExtensionAPI, type ExtensionCommandContext, SettingsManager } from "@earendil-works/pi-coding-agent";

import { CompactionState } from "../src/compaction.ts";
import { ProbeFilter } from "../src/probe/filter.ts";
import { SilentProbe } from "../src/probe/silent-probe.ts";
import { readProbeToken } from "../src/probe/token.ts";
import { ProbeTrigger } from "../src/probe/trigger.ts";
import { type CaptureOrigin, type GuardResult, type RequestSnapshot, SnapshotStore } from "../src/snapshot.ts";

const INCOMPLETE: GuardResult = { status: "incomplete", reason: "No provider payload was observed for this request." };

beforeEach(() => {
	// Never read the developer's global settings during unit tests
	mock.method(SettingsManager, "create", () => SettingsManager.inMemory());
});
afterEach(() => mock.restoreAll());

/** A minimal snapshot with no changes. */
function snapshot(id: number, origin: CaptureOrigin, guard: GuardResult): RequestSnapshot {
	return { id, origin, leafId: null, changes: { conversation: [], system: [] }, guard };
}

/**
 * An idle context whose probe send runs `simulateRun` with the claimed probe,
 * the store, and the token, as Pi's lifecycle would after `sendUserMessage("")`.
 */
function createHarness(simulateRun: (probe: SilentProbe, store: SnapshotStore) => Promise<void>) {
	const probe = new SilentProbe(new ProbeFilter());
	const store = new SnapshotStore();
	const visibility: boolean[] = [];
	let sent = 0;
	let run: Promise<void> | undefined;
	const pi = {
		getSettings: () => ({}),
		sendUserMessage: () => {
			sent++;
			probe.beginRun(readProbeToken());
			run = simulateRun(probe, store);
		},
	} as unknown as ExtensionAPI;
	const context = {
		cwd: "/tmp",
		model: { provider: "test", id: "model", api: "openai-completions", contextWindow: 100_000 },
		modelRegistry: { hasConfiguredAuth: () => true },
		hasPendingMessages: () => false,
		getContextUsage: () => undefined,
		waitForIdle: async () => undefined,
		ui: { setWorkingVisible: (visible: boolean) => visibility.push(visible) },
	} as unknown as ExtensionCommandContext;
	const trigger = new ProbeTrigger({
		pi, probe, snapshots: store, compaction: new CompactionState(), snapshotGraceMs: 1,
	});
	return { context, trigger, store, visibility, sent: () => sent, run: () => run };
}

test("ProbeTrigger resolves once the probe snapshot's guard settles after the probe", async () => {
	const probeSnapshot = snapshot(2, "synthetic-probe", INCOMPLETE);
	let resolved = false;
	let resolvedWhilePending = false;
	const harness = createHarness(async (probe, store) => {
		await Promise.resolve();
		store.publish(snapshot(2, "synthetic-probe", { status: "pending" }));
		store.publish(snapshot(1, "real-turn", INCOMPLETE));
		// A whole macrotask gives an early resolution time to show
		await new Promise((resolve) => setImmediate(resolve));
		resolvedWhilePending = resolved;
		// Pi runs SilentProbe's agent_settled handler before capture settles the guard
		probe.settle();
		await Promise.resolve();
		store.publish(probeSnapshot);
	});

	const result = await harness.trigger.request(harness.context).finally(() => {
		resolved = true;
	});

	assert.equal(resolvedWhilePending, false, "neither a pending guard nor a real turn resolves the attempt");
	assert.deepEqual(result, { status: "captured" }, "the result keeps no snapshot");
	assert.equal(harness.store.latest(), probeSnapshot);
	assert.equal(harness.sent(), 1);
	assert.deepEqual(harness.visibility, [false, true]);
});

test("ProbeTrigger shares one attempt between concurrent and later callers", async () => {
	const probeSnapshot = snapshot(1, "synthetic-probe", INCOMPLETE);
	const harness = createHarness(async (probe, store) => {
		await new Promise((resolve) => setImmediate(resolve));
		probe.settle();
		store.publish(probeSnapshot);
	});

	const [first, concurrent] = await Promise.all([
		harness.trigger.request(harness.context),
		harness.trigger.request(harness.context),
	]);
	const later = await harness.trigger.request(harness.context);

	assert.deepEqual(first, { status: "captured" });
	assert.equal(harness.store.latest(), probeSnapshot);
	assert.strictEqual(concurrent, first);
	assert.strictEqual(later, first);
	assert.equal(harness.sent(), 1, "one probe per runtime");
	assert.deepEqual(harness.visibility, [false, true]);
});

test("ProbeTrigger fails when the probe settles without a snapshot", async () => {
	const harness = createHarness(async (probe) => {
		await Promise.resolve();
		probe.settle();
	});

	const result = await harness.trigger.request(harness.context);

	assert.deepEqual(result, { status: "failed", reason: "Silent probe settled without a request snapshot." });
	assert.deepEqual(harness.visibility, [false, true]);
	await harness.run();
});

test("ProbeTrigger reports the probe's own failure", async () => {
	const harness = createHarness(async (probe) => {
		probe.fail("Session ended before the silent probe completed.");
	});

	const result = await harness.trigger.request(harness.context);

	assert.deepEqual(result, { status: "failed", reason: "Session ended before the silent probe completed." });
	assert.deepEqual(harness.visibility, [false, true]);
});
