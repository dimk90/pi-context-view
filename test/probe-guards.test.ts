import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { CACHE_WARMING_MAX_IDLE_AGE_MS } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI, type ExtensionCommandContext, type SessionEntry, SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { CompactionState } from "../src/compaction.ts";
import type { ProbeFailureCause } from "../src/probe/failure.ts";
import { ProbeFilter } from "../src/probe/filter.ts";
import { SilentProbe } from "../src/probe/silent-probe.ts";
import { ProbeTrigger } from "../src/probe/trigger.ts";
import { SnapshotStore } from "../src/snapshot.ts";
import { useSettings } from "./harness/settings.ts";

/** Settings accepted by Pi's in-memory manager. */
type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

/**
 * A safe idle command context; a send ends immediately instead of running an
 * agent. Its model has no prompt-cache lifetimes and its branch is empty, so
 * Pi's default idle warming cannot have a live warm run.
 */
function createHarness(settings: Settings = {}) {
	const probe = new SilentProbe(new ProbeFilter());
	const sent: string[] = [];
	const visibility: boolean[] = [];
	const pi = {
		getSettings: () => settings,
		sendUserMessage: (content: string) => {
			sent.push(content);
			probe.fail("startup", "Test run ended.");
		},
	} as unknown as ExtensionAPI;
	const context = {
		// Never created; global settings are registered per directory
		cwd: `/probe-guards/${randomUUID()}`,
		model: { provider: "test", id: "model", api: "openai-completions", contextWindow: 100_000 },
		modelRegistry: { hasConfiguredAuth: () => true },
		sessionManager: { getBranch: () => [] },
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 0, contextWindow: 100_000, percent: 0 }),
		waitForIdle: async () => undefined,
		ui: { setWorkingVisible: (visible: boolean) => visibility.push(visible) },
	} as unknown as ExtensionCommandContext;
	const trigger = new ProbeTrigger({ pi, probe, snapshots: new SnapshotStore(), compaction: new CompactionState() });
	return { context, probe, trigger, sent, visibility };
}

/**
 * Let Pi's idle warming have a live warm run: the model gets prompt-cache
 * lifetimes, and the branch ends with an assistant message `ageMs` old.
 */
function allowLiveWarmRun(harness: ReturnType<typeof createHarness>, ageMs = 0): void {
	assert.ok(harness.context.model);
	harness.context.model.promptCache = { short: 300 };
	const branch = [{ type: "message", message: { role: "assistant", timestamp: Date.now() - ageMs } }];
	harness.context.sessionManager.getBranch = () => branch as unknown as SessionEntry[];
}

/** Ask the trigger for a probe as a consumer would. */
async function resolve(harness: ReturnType<typeof createHarness>) {
	return harness.trigger.request(harness.context);
}

/** A skipped probe sends nothing and does not consume the runtime's attempt. */
async function assertSkipped(harness: ReturnType<typeof createHarness>, cause: ProbeFailureCause): Promise<void> {
	const result = await resolve(harness);
	assert.equal(result.status, "failed");
	assert.equal(result.status === "failed" ? result.cause : undefined, cause);
	assert.deepEqual(harness.sent, []);
	assert.deepEqual(harness.visibility, []);
	const attempt = harness.probe.start();
	assert.equal(attempt.started, true);
	harness.probe.fail("shutdown");
	await attempt.completion;
}

test("probe guards recheck pending messages after waiting for idle", async () => {
	const harness = createHarness();
	harness.context.waitForIdle = async () => {
		harness.context.hasPendingMessages = () => true;
	};
	await assertSkipped(harness, "pending-messages");
});

test("probe guards reject a virtual selection before checking its authentication", async () => {
	const harness = createHarness();
	assert.ok(harness.context.model);
	harness.context.model.api = "pi-virtual";
	harness.context.modelRegistry.hasConfiguredAuth = () => { throw new Error("Must not check auth"); };
	await assertSkipped(harness, "virtual-model");
});

test("probe guards distinguish a missing model from missing authentication", async () => {
	const missing = createHarness();
	await assertSkipped({ ...missing, context: { ...missing.context, model: undefined } }, "missing-model");
	const unauthenticated = createHarness();
	unauthenticated.context.modelRegistry.hasConfiguredAuth = () => false;
	await assertSkipped(unauthenticated, "missing-auth");
});

test("probe guards reject idle warming from the live settings snapshot", async () => {
	const harness = createHarness({ cacheWarming: "idle" });
	allowLiveWarmRun(harness, CACHE_WARMING_MAX_IDLE_AGE_MS - 60_000);
	await assertSkipped(harness, "idle-warming");
});

test("a project warming override cannot hide the global idle setting", async (t) => {
	const harness = createHarness({ cacheWarming: "off" });
	allowLiveWarmRun(harness);
	useSettings(t, harness.context.cwd, (_cwd, _agentDir, options) => {
		assert.equal(options?.projectTrusted, false);
		return SettingsManager.inMemory({ cacheWarming: "idle" });
	});
	await assertSkipped(harness, "idle-warming");
});

test("probe guards use Pi's default auto-compaction reserve", async () => {
	const harness = createHarness();
	harness.context.getContextUsage = () => ({ tokens: 83_617, contextWindow: 100_000, percent: 83.617 });
	await assertSkipped(harness, "context-limit");
});

test("probe guards honor per-model compaction overrides", async () => {
	const harness = createHarness({ compaction: {
		reserveTokens: 1_000,
		modelOverrides: { "test/model": { reserveTokens: 50_000 } },
	} });
	harness.context.getContextUsage = () => ({ tokens: 50_001, contextWindow: 100_000, percent: 50.001 });
	await assertSkipped(harness, "context-limit");
});

test("probe guards fail closed on invalid compaction settings", async () => {
	await assertSkipped(createHarness({ compaction: { reserveTokens: -1 } }), "settings");
});

test("probe guards fail closed on unreadable global warming settings without exposing the error", async (t) => {
	// A live idle value would make reading the global file unnecessary
	const harness = createHarness({ cacheWarming: "off" });
	useSettings(t, harness.context.cwd, () => { throw new Error("sensitive file contents"); });
	await assertSkipped(harness, "settings");
});

for (const scenario of [
	{ name: "exact threshold", settings: {}, tokens: 83_616 },
	{ name: "disabled auto-compaction", settings: { compaction: { enabled: false } }, tokens: 100_000 },
	{ name: "unknown post-compaction usage", settings: {}, tokens: null },
	{ name: "streaming cache warming", settings: { cacheWarming: "streaming" }, tokens: 0 },
	{ name: "disabled cache warming", settings: { cacheWarming: "off" }, tokens: 0 },
] satisfies Array<{ name: string; settings: Settings; tokens: number | null }>) {
	test(`probe guards allow ${scenario.name}`, async () => {
		const harness = createHarness(scenario.settings);
		harness.context.getContextUsage = () => ({ tokens: scenario.tokens, contextWindow: 100_000, percent: null });
		await resolve(harness);
		assert.deepEqual(harness.sent, [""]);
		assert.deepEqual(harness.visibility, [false, true]);
	});
}

for (const scenario of [
	{ name: "a model without prompt-cache lifetimes", promptCache: undefined, branch: "recent" },
	{ name: "a branch without assistant messages", promptCache: { short: 300 }, branch: "empty" },
	{ name: "a last request past Pi's idle warming limit", promptCache: { short: 300 }, branch: "expired" },
] as const) {
	test(`probe guards allow idle warming with ${scenario.name}`, async () => {
		const harness = createHarness({ cacheWarming: "idle" });
		if (scenario.branch !== "empty") {
			allowLiveWarmRun(harness, scenario.branch === "expired" ? CACHE_WARMING_MAX_IDLE_AGE_MS : 0);
		}
		assert.ok(harness.context.model);
		harness.context.model.promptCache = scenario.promptCache;
		await resolve(harness);
		assert.deepEqual(harness.sent, [""]);
	});
}

test("clearing a guard allows the still-unused probe attempt", async () => {
	const harness = createHarness({ cacheWarming: "idle" });
	allowLiveWarmRun(harness);
	await resolve(harness);
	assert.deepEqual(harness.sent, []);
	assert.ok(harness.context.model);
	harness.context.model.promptCache = undefined;
	await resolve(harness);
	assert.deepEqual(harness.sent, [""]);
});
