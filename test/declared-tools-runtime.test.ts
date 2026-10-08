/** Issue #11 on Pi's real codemode loadout, adapters, and probe, without external provider calls. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
	type AgentSession, createAgentSession, createCodemodeExtension, DefaultResourceLoader, type ExtensionAPI,
	type ExtensionContext, type ExtensionFactory, type ExtensionUIContext, ModelRuntime, SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { SnapshotBuilder } from "../src/capture/builder.ts";
import { registerCapture } from "../src/capture/register.ts";
import { CompactionState, registerCompactionTracking } from "../src/compaction.ts";
import registerExtension from "../src/index.ts";
import { ProbeFilter, registerProbeFilter } from "../src/probe/filter.ts";
import { registerSilentProbe, SilentProbe } from "../src/probe/silent-probe.ts";
import { type ProbeResult, ProbeTrigger } from "../src/probe/trigger.ts";
import { createProbeView } from "../src/probe/view.ts";
import { applyRequestSnapshot, latestDeclaredTools } from "../src/projection.ts";
import { buildUsageSnapshot } from "../src/replay.ts";
import { SnapshotStore } from "../src/snapshot.ts";
import { computeUsage } from "../src/usage.ts";
import { type MockApi, startMockProvider } from "./harness/mock-provider.ts";

const ACTIVE = ["read", "bash", "edit", "write", "codemode"];

for (const api of ["openai-completions", "anthropic-messages"] as const) {
	test(`#11 ${api}: a first probe uses replay; a real codemode-only request excludes hidden definitions`, async (t) => {
		const { session, store, provider, errors, observed } = await createRuntime(t, api);
		await session.prompt("/context");
		assert.equal(store.latest()?.origin, "synthetic-probe");
		assert.equal(store.latest()?.declaredTools, undefined);
		assert.equal(provider.requests.length, 0);
		assert.equal(observed.responses, 0, "after_provider_response sentinel stays silent for the probe");
		assert.deepEqual(toolNames(session, store), [...ACTIVE].sort());
		await session.prompt("hi");
		await flush();
		assert.deepEqual(store.latest()?.declaredTools, { declared: ["codemode"], baseline: ACTIVE });
		assert.deepEqual(toolNames(session, store), ["codemode"]);
		assert.equal(provider.requests.length, 1);
		assert.equal(observed.responses, 1);
		assert.deepEqual(observed.declarations, [api === "anthropic-messages"
			? ["codemode", "__pi_deferred_placeholder__"] : ["codemode"]]);
		await session.prompt("/context");
		await session.prompt("/context injections");
		assert.equal(provider.requests.length, 1, "neither view makes another request");
		assert.deepEqual(errors, []);
	});
}

test("#11: a later probe records no names and keeps the real turn's declared names", async (t) => {
	const probes: ProbeResult[] = [];
	const { session, store, provider, errors, observed } = await createRuntime(t, "openai-completions",
		(pi, snapshots) => registerProbeCommand(pi, snapshots, probes));
	await session.prompt("hi");
	await flush();
	assert.deepEqual(toolNames(session, store), ["codemode"]);
	await session.prompt("/probe");
	assert.equal(probes[0]?.status, "captured", JSON.stringify(probes[0]));
	assert.equal(store.latest()?.origin, "synthetic-probe");
	assert.equal(store.latest()?.declaredTools, undefined);
	assert.deepEqual(latestDeclaredTools(store), { declared: ["codemode"], baseline: ACTIVE });
	assert.deepEqual(toolNames(session, store), ["codemode"]);
	assert.equal(provider.requests.length, 1, "the probe makes no provider request");
	assert.equal(observed.responses, 1, "after_provider_response sentinel stays silent for the probe");
	assert.deepEqual(errors, []);
});

test("#11: changing active tools invalidates declared names before the next request", async (t) => {
	const { session, store } = await createRuntime(t, "openai-completions");
	await session.prompt("hi");
	await flush();
	assert.deepEqual(toolNames(session, store), ["codemode"]);
	session.setActiveToolsByName(["read", "bash", "edit", "write"]);
	assert.deepEqual(session.getActiveToolNames(), ["read", "bash", "edit", "write"]);
	assert.deepEqual(toolNames(session, store), [...ACTIVE].sort(),
		"Pi records the change at the next request, so every replayed tool counts until then");
	await session.prompt("after active-tool change");
	await flush();
	assert.deepEqual(store.latest()?.declaredTools?.declared, ["read", "bash", "edit", "write"]);
	assert.deepEqual(toolNames(session, store), ["bash", "edit", "read", "write"]);
});

/** Tool names Usage lists, through its production selection, application, and measurement. */
function toolNames(session: AgentSession, store: SnapshotStore): string[] {
	const manager = session.sessionManager;
	const applied = applyRequestSnapshot({
		snapshot: store.latest(), declaredTools: latestDeclaredTools(store), activeToolNames: session.getActiveToolNames(),
		entries: manager.getEntries(), leafId: manager.getLeafId(), filterMessages: (messages) => messages,
	});
	const snapshot = buildUsageSnapshot({
		...applied, systemPrompt: session.systemPrompt, options: { cwd: "/tmp/project" },
		allTools: session.getAllTools(), activeToolNames: session.getActiveToolNames(),
	});
	return computeUsage({ snapshot, messages: applied.messages }).categories
		.filter((category) => category.id === "built-in-tools" || category.id === "custom-tools")
		.flatMap((category) => category.children ?? []).map((child) => child.label).sort();
}

/**
 * Test-only wiring of the production probe and capture layers, in the order
 * `src/index.ts` registers them, with a `/probe` command that asks
 * ProbeTrigger for a probe even when the store already holds a snapshot.
 */
function registerProbeCommand(pi: ExtensionAPI, snapshots: SnapshotStore, results: ProbeResult[]): void {
	const probeFilter = new ProbeFilter();
	const probe = new SilentProbe(probeFilter);
	const compaction = new CompactionState();
	const trigger = new ProbeTrigger({ pi, probe, snapshots, compaction });
	registerProbeFilter(pi, probeFilter);
	registerSilentProbe(pi, probe);
	registerCapture(pi, createProbeView(probeFilter, probe), new SnapshotBuilder(snapshots));
	registerCompactionTracking(pi, compaction);
	pi.registerCommand("probe", {
		description: "Test only",
		handler: async (_args, ctx) => { results.push(await trigger.request(ctx)); },
	});
}

/**
 * Real SDK runtime with codemode `only`, the monitor, and a last-loaded
 * payload logger and `after_provider_response` sentinel. The monitor defaults
 * to the production extension.
 */
async function createRuntime(
	t: TestContext,
	api: MockApi,
	monitor: (pi: ExtensionAPI, snapshots: SnapshotStore) => void = (pi, snapshots) => registerExtension(pi, snapshots),
) {
	const provider = await startMockProvider();
	t.after(() => provider.close());
	const directory = await mkdtemp(join(tmpdir(), "context-declared-tools-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({
		cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
		defaultTools: ACTIVE, codemode: { mode: "only" },
	});
	t.mock.method(SettingsManager, "create", () => settingsManager);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
	});
	const model = {
		provider: "mock", id: "text", name: "Mock", api, baseUrl: provider.baseUrls[api],
		reasoning: false, input: ["text"], maxTokens: 128, contextWindow: 100_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
	} satisfies NonNullable<ExtensionContext["model"]>;
	const store = new SnapshotStore();
	const observed = { responses: 0, declarations: [] as string[][] };
	const logger: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", (event) => {
			const body = event.payload as { tools: Array<{ name?: string; function?: { name: string } }> };
			observed.declarations.push(body.tools.map((tool) => tool.function?.name ?? tool.name ?? "unknown"));
		});
		pi.on("after_provider_response", () => { observed.responses++; });
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [
			(pi) => pi.registerProvider("mock", { api, baseUrl: model.baseUrl, apiKey: "mock-key", models: [model] }),
			createCodemodeExtension(), (pi) => monitor(pi, store), logger,
		],
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd: directory, agentDir: directory, settingsManager, resourceLoader, modelRuntime, model,
		sessionManager: SessionManager.inMemory(directory), thinkingLevel: "off",
	});
	t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
	assert.deepEqual(extensionsResult.errors, []);
	assert.deepEqual(session.getActiveToolNames(), ACTIVE);
	const errors: string[] = [];
	await session.bindExtensions({
		mode: "tui", onError: (error) => { errors.push(`${error.event}: ${error.error}`); },
		uiContext: { setWorkingVisible: () => undefined, custom: async () => undefined } as unknown as ExtensionUIContext,
	});
	return { session, store, provider, errors, observed };
}

/** Wait for the capture and guard jobs queued before this call. */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}
