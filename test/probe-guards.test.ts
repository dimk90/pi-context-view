import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import { type ExtensionAPI, type ExtensionCommandContext, SettingsManager } from "@earendil-works/pi-coding-agent";

import { CompactionState, InitialCaptureState, SilentProbeState } from "../src/capture.ts";
import { resolveInitialCapture } from "../src/command.ts";

/** Settings accepted by Pi's in-memory manager. */
type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

beforeEach(() => {
	// Never read the developer's global settings during unit tests
	mock.method(SettingsManager, "create", () => SettingsManager.inMemory());
});
afterEach(() => mock.restoreAll());

/** A safe idle command context; a send ends immediately instead of running an agent. */
function createHarness(settings: Settings = {}) {
	const capture = new InitialCaptureState();
	const probe = new SilentProbeState();
	const compaction = new CompactionState();
	const sent: string[] = [];
	const visibility: boolean[] = [];
	const pi = {
		getSettings: () => settings,
		getAllTools: () => [],
		getActiveTools: () => [],
		sendUserMessage: (content: string) => {
			sent.push(content);
			probe.fail("Test run ended.");
		},
	} as unknown as ExtensionAPI;
	const context = {
		cwd: "/tmp",
		model: { provider: "test", id: "model", api: "openai-completions", contextWindow: 100_000 },
		modelRegistry: { hasConfiguredAuth: () => true },
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 0, contextWindow: 100_000, percent: 0 }),
		getSystemPrompt: () => "base",
		getSystemPromptOptions: () => ({ cwd: "/tmp" }),
		waitForIdle: async () => undefined,
		ui: { setWorkingVisible: (visible: boolean) => visibility.push(visible) },
	} as unknown as ExtensionCommandContext;
	return { pi, context, capture, probe, compaction, sent, visibility };
}

/** Run the command resolution without opening an overlay. */
async function resolve(harness: ReturnType<typeof createHarness>) {
	return resolveInitialCapture(harness.pi, harness.capture, harness.probe, harness.compaction, harness.context);
}

/** A skipped probe neither freezes Initial nor consumes the runtime's attempt. */
async function assertSkipped(harness: ReturnType<typeof createHarness>, reason: string): Promise<void> {
	const result = await resolve(harness);
	assert.equal(result.degradedReason, `Silent probe unavailable: ${reason} Extension additions were not observed.`);
	assert.deepEqual(harness.sent, []);
	assert.deepEqual(harness.visibility, []);
	assert.equal(harness.capture.snapshot, undefined);
	const attempt = harness.probe.start();
	assert.equal(attempt.started, true);
	harness.probe.fail("cleanup");
	await attempt.completion;
}

test("probe guards recheck pending messages after waiting for idle", async () => {
	const harness = createHarness();
	harness.context.waitForIdle = async () => {
		harness.context.hasPendingMessages = () => true;
	};
	await assertSkipped(harness, "messages are waiting to be delivered.");
});

test("probe guards reject a virtual selection before checking its authentication", async () => {
	const harness = createHarness();
	assert.ok(harness.context.model);
	harness.context.model.api = "pi-virtual";
	harness.context.modelRegistry.hasConfiguredAuth = () => { throw new Error("Must not check auth"); };
	await assertSkipped(harness, "a virtual model is selected.");
});

test("probe guards reject idle warming from the live settings snapshot", async () => {
	await assertSkipped(createHarness({ cacheWarming: "idle" }), "idle cache warming is enabled.");
});

test("a project warming override cannot hide the global idle setting", async (t) => {
	t.mock.method(SettingsManager, "create", (...args: Parameters<typeof SettingsManager.create>) => {
		assert.equal(args[2]?.projectTrusted, false);
		return SettingsManager.inMemory({ cacheWarming: "idle" });
	});
	await assertSkipped(createHarness({ cacheWarming: "off" }), "idle cache warming is enabled.");
});

test("probe guards use Pi's default auto-compaction reserve", async () => {
	const harness = createHarness();
	harness.context.getContextUsage = () => ({ tokens: 83_617, contextWindow: 100_000, percent: 83.617 });
	await assertSkipped(harness, "context exceeds the auto-compaction threshold.");
});

test("probe guards honor per-model compaction overrides", async () => {
	const harness = createHarness({ compaction: {
		reserveTokens: 1_000,
		modelOverrides: { "test/model": { reserveTokens: 50_000 } },
	} });
	harness.context.getContextUsage = () => ({ tokens: 50_001, contextWindow: 100_000, percent: 50.001 });
	await assertSkipped(harness, "context exceeds the auto-compaction threshold.");
});

test("probe guards fail closed on invalid compaction settings", async () => {
	await assertSkipped(createHarness({ compaction: { reserveTokens: -1 } }), "Pi settings could not be checked.");
});

test("probe guards fail closed on unreadable global warming settings without exposing the error", async (t) => {
	t.mock.method(SettingsManager, "create", () => { throw new Error("sensitive file contents"); });
	await assertSkipped(createHarness(), "Pi settings could not be checked.");
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

test("clearing a guard allows the still-unused probe attempt", async () => {
	const settings: Settings = { cacheWarming: "idle" };
	const harness = createHarness(settings);
	await resolve(harness);
	assert.deepEqual(harness.sent, []);
	settings.cacheWarming = "off";
	await resolve(harness);
	assert.deepEqual(harness.sent, [""]);
});
