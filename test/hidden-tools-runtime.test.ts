/** Issue #11 on Pi's real codemode loadout, adapters, and probe, without external provider calls. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
	type AgentSession, createAgentSession, createCodemodeExtension, DefaultResourceLoader, type ExtensionContext,
	type ExtensionFactory, type ExtensionUIContext, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

import registerExtension from "../src/index.ts";
import { buildInjectionsSnapshot } from "../src/injections.ts";
import type { InjectionItem } from "../src/model.ts";
import { applyRequestSnapshot } from "../src/projection.ts";
import { buildUsageSnapshot } from "../src/replay.ts";
import { SnapshotStore } from "../src/snapshot.ts";
import { computeUsage } from "../src/usage.ts";
import { type MockApi, startMockProvider } from "./harness/mock-provider.ts";

const ACTIVE = ["read", "bash", "edit", "write", "codemode"];
const HIDDEN = ["read", "bash", "edit", "write"];
/** Initial lists only codemode and keeps the names of the tools codemode `only` hides. */
const INITIAL_TOOLS = { listed: ["codemode"], hidden: HIDDEN };

for (const api of ["openai-completions", "anthropic-messages"] as const) {
	test(`#11 ${api}: a first probe already leaves out the tools codemode-only hides`, async (t) => {
		const { session, store, provider, errors, observed } = await createRuntime(t, api);
		await session.prompt("/context");
		const probe = store.latest();
		assert.equal(probe?.origin, "synthetic-probe");
		assert.deepEqual(probe?.hiddenTools, HIDDEN);
		assert.equal(provider.requests.length, 0);
		assert.equal(observed.responses, 0, "after_provider_response sentinel stays silent for the probe");
		assert.deepEqual(usageToolNames(session, store), ["codemode"]);
		assert.deepEqual(initialTools(session, store), INITIAL_TOOLS);

		await session.prompt("hi");
		await flush();
		const real = store.latest();
		assert.equal(real?.origin, "real-turn");
		assert.deepEqual(real?.hiddenTools, HIDDEN);
		assert.equal(real?.guard.status, "complete");
		assert.deepEqual(real?.guard.status === "complete" ? real.guard.findings : undefined, [],
			"tools Pi hid are not late removals");
		assert.deepEqual(usageToolNames(session, store), ["codemode"]);
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

test("#11: Usage follows Pi's hidden tools as soon as the active tools change", async (t) => {
	const { session, store } = await createRuntime(t, "openai-completions");
	await session.prompt("hi");
	await flush();
	assert.deepEqual(usageToolNames(session, store), ["codemode"]);
	session.setActiveToolsByName(["read", "bash", "edit", "write"]);
	assert.deepEqual(session.getActiveToolNames(), ["read", "bash", "edit", "write"]);
	assert.deepEqual(initialTools(session, store), INITIAL_TOOLS, "Initial keeps its captured hidden set");
	assert.deepEqual(usageToolNames(session, store), [...ACTIVE].sort(),
		"Pi hides nothing now and records the change at the next request, so every replayed tool counts until then");
	await session.prompt("after active-tool change");
	await flush();
	assert.equal(store.latest()?.hiddenTools, undefined);
	assert.deepEqual(usageToolNames(session, store), ["bash", "edit", "read", "write"]);
	assert.deepEqual(initialTools(session, store), INITIAL_TOOLS, "a later request does not change Initial");
});

/** Pi's current prompt options, as a command handler reads them. */
function liveOptions(session: AgentSession) {
	return session.extensionRunner.createCommandContext().getSystemPromptOptions();
}

/** Tool names Usage lists, through its production application and measurement. */
function usageToolNames(session: AgentSession, store: SnapshotStore): string[] {
	const manager = session.sessionManager;
	const applied = applyRequestSnapshot({
		snapshot: store.latest(), entries: manager.getEntries(), leafId: manager.getLeafId(),
		filterMessages: (messages) => messages,
	});
	const snapshot = buildUsageSnapshot({
		...applied, systemPrompt: session.systemPrompt, options: liveOptions(session),
		allTools: session.getAllTools(), activeToolNames: session.getActiveToolNames(),
	});
	return computeUsage({ snapshot, messages: applied.messages }).categories
		.filter((category) => category.id === "built-in-tools" || category.id === "custom-tools")
		.flatMap((category) => category.children ?? []).map((child) => child.label).sort();
}

/** Tool names Injections lists for the first snapshot, and names of the tools Pi hid it leaves out. */
function initialTools(
	session: AgentSession,
	store: SnapshotStore,
): { listed: string[]; hidden: readonly string[] | undefined } {
	const first = store.first();
	assert.ok(first !== undefined);
	const snapshot = buildInjectionsSnapshot({
		snapshot: first, entries: session.sessionManager.getEntries(), filterMessages: (messages) => messages,
		options: liveOptions(session), allTools: session.getAllTools(), systemPrompt: session.systemPrompt,
		activeToolNames: session.getActiveToolNames(),
	});
	const flatten = (item: InjectionItem): InjectionItem[] => [item, ...(item.children ?? []).flatMap(flatten)];
	const listed = snapshot.groups.flatMap((group) => group.items).flatMap(flatten)
		.filter((item) => item.kind === "tool" && item.children === undefined).map((item) => item.label).sort();
	return { listed, hidden: snapshot.hiddenTools };
}

/**
 * Real SDK runtime with codemode `only`, the monitor, and a last-loaded
 * payload logger and `after_provider_response` sentinel.
 */
async function createRuntime(t: TestContext, api: MockApi) {
	const provider = await startMockProvider();
	t.after(() => provider.close());
	const directory = await mkdtemp(join(tmpdir(), "context-hidden-tools-"));
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
			createCodemodeExtension(), (pi) => registerExtension(pi, store), logger,
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
