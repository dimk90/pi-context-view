/** Demo-only fixtures loaded through Pi's resource loader, without importing them into regular tests. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
	type AgentSession,
	type BuildSystemPromptOptions,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { startDemoMockProvider } from "../scripts/demo-injections/demo-mock-provider.ts";
import registerExtension from "../src/index.ts";
import { buildInjectionsSnapshot } from "../src/injections.ts";
import type { InjectionSnapshot } from "../src/model.ts";
import { collectPromptSources } from "../src/prompt-additions.ts";
import { type RequestSnapshot, SnapshotStore } from "../src/snapshot.ts";
import { type MockApi, startMockProvider } from "./harness/mock-provider.ts";
import { createIsolatedConfigStore } from "./harness/settings.ts";

const FIXTURES = [
	"context-modify", "context-delete", "context-add", "review-checklist",
	"section-patch", "section-modify", "section-delete", "payload-changes", "payload-remove-tool", "agent-start-message",
];
const OBSOLETE_MESSAGE_TYPE = "Custom Demo Message: Obsolete Scope";
const OBSOLETE_MESSAGE_TEXT = "Limit the review to formatting; skip error handling and test coverage.";
const PAYLOAD_ORIGINAL = "Keep the review brief.";
const PAYLOAD_MODIFIED = "Keep the review brief. Include a short explanation for each finding.";
const REVIEW_SUFFIX = "Give recommendations only; do not edit files.";

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
	for (const after of [false, true]) {
		test(`combined demo keeps examples distinct: ${api}, after=${after}`, async (t) => {
			const runtime = await createDemoRuntime(t, api, after);
			const prompt = "Suggest improvements to this code review workflow.";
			await runtime.session.prompt(prompt);
			const snapshot = await runtime.latest();
			assert.deepEqual(runtime.errors, []);
			assert.deepEqual(snapshot.changes.conversation.map((change) => change.type).sort(),
				["added", "added", "deleted", "modified"]);
			const modified = snapshot.changes.conversation.find((change) => change.type === "modified");
			assert.ok(modified?.type === "modified" && modified.message.role === "user");
			assert.equal(modified.message.content, `${prompt}\n${REVIEW_SUFFIX}`);
			const original = runtime.session.sessionManager.getEntry(modified.entryId);
			assert.ok(original?.type === "message" && original.message.role === "user");
			assert.deepEqual(original.message.content, [{ type: "text", text: prompt }]);
			const deleted = snapshot.changes.conversation.find((change) => change.type === "deleted");
			assert.ok(deleted?.type === "deleted");
			const obsolete = runtime.session.sessionManager.getEntry(deleted.entryId);
			assert.ok(obsolete?.type === "custom_message" && obsolete.customType === OBSOLETE_MESSAGE_TYPE);
			assert.equal(obsolete.content, OBSOLETE_MESSAGE_TEXT);

			assert.deepEqual(snapshot.changes.system.map((change) => change.type === "section" ? change.name : change.type)
				.sort(), after ? [] : [
					"demo_checklist", "demo_legacy_migration", "demo_review",
				]);
			assert.ok(snapshot.guard.status === "complete");
			assert.deepEqual(snapshot.guard.findings.map((finding) => finding.type === "payload-tool-change"
				? `${finding.change} tool:${finding.name}` : `${finding.change} ${finding.part}`).sort(),
				after ? ["modified system"] : ["deleted tool:write", "modified user"]);
			if (!after) {
				const finding = snapshot.guard.findings.find((finding) => finding.type === "payload-change");
				assert.ok(finding?.type === "payload-change");
				assert.deepEqual(finding.lines, [
					{ type: "removed", text: PAYLOAD_ORIGINAL }, { type: "added", text: PAYLOAD_MODIFIED },
				]);
			}

			const composition = runtime.compose(snapshot);
			assertAttributedTool(composition);
			const items = composition.groups.flatMap((group) => group.items);
			const messages = items.find((item) => item.kind === "message");
			assert.equal(messages?.label, "messages (4)");
			assert.equal(messages?.sections?.filter((part) => part.change === "deleted").length, 1);
			const removed = messages?.sections?.find((part) => part.change === "deleted");
			assert.equal(removed?.tokens, 0);
			assert.equal(removed?.text, OBSOLETE_MESSAGE_TEXT);
			const saved = messages?.sections?.find((part) => part.label === "Custom Demo Message: Findings Format");
			assert.ok(saved);
			assert.equal(saved.requestOnly, undefined);
			assert.ok(!JSON.stringify(composition).includes("XYZZY"));
			if (!after) {
				const promptParts = items.find((item) => item.kind === "base-prompt")?.children ?? [];
				const removedSection = promptParts.find((part) => part.label === "demo_legacy_migration");
				assert.equal(removedSection?.tokens, 0);
				assert.equal(removedSection?.requestOnly, true);
			}

			await runtime.session.prompt("Explain the most important finding.");
			const second = await runtime.latest();
			assert.equal(second.changes.conversation.filter((change) => change.type === "deleted").length, 1);
			assert.equal(runtime.session.sessionManager.getEntries().filter((entry) =>
				entry.type === "custom_message" && entry.customType === OBSOLETE_MESSAGE_TYPE).length, 1,
			"the obsolete note is saved once, not once per run");
		});
	}
}

test("combined demo also works with reversed group order", async (t) => {
	const fixtures = [
		"agent-start-message", "payload-changes", "payload-remove-tool", "review-checklist",
		"section-patch", "section-modify", "section-delete", "context-modify", "context-delete", "context-add",
	];
	const runtime = await createDemoRuntime(t, "openai-completions", false, { fixtures });
	const prompt = "Suggest improvements to the review workflow.";
	await runtime.session.prompt(prompt);
	const snapshot = await runtime.latest();
	assert.deepEqual(runtime.errors, []);
	assert.deepEqual(snapshot.changes.conversation.map((change) => change.type).sort(),
		["added", "added", "deleted", "modified"]);
	const modified = snapshot.changes.conversation.find((change) => change.type === "modified");
	assert.ok(modified?.type === "modified" && modified.message.role === "user");
	assert.equal(modified.message.content, `${prompt}\n${REVIEW_SUFFIX}`);
	assertAttributedTool(runtime.compose(snapshot));
});

test("context demo stays distinct without saved-message or payload anchors", async (t) => {
	const runtime = await createDemoRuntime(t, "openai-completions", false,
		{ fixtures: ["context-modify", "context-delete", "context-add"] });
	await runtime.session.prompt("Suggest improvements to the review workflow.");
	const snapshot = await runtime.latest();
	assert.deepEqual(runtime.errors, []);
	assert.deepEqual(snapshot.changes.conversation.map((change) => change.type).sort(), ["added", "deleted", "modified"]);
	assert.ok(snapshot.guard.status === "complete");
	assert.deepEqual(snapshot.guard.findings, []);
	assert.equal(runtime.compose(snapshot).groups.flatMap((group) => group.items)
		.find((item) => item.kind === "message")?.label, "messages (2)");
});

test("combined demo captures both payload findings with the launcher's body-discarding mock", async (t) => {
	const provider = await startDemoMockProvider();
	t.after(() => provider.close());
	const runtime = await createDemoRuntime(t, "openai-completions", false, { baseUrl: provider.baseUrl });
	await runtime.session.prompt("Suggest improvements to a code review workflow.");
	const snapshot = await runtime.latest();
	assert.deepEqual(runtime.errors, []);
	assert.equal(snapshot.guard.status, "complete");
	assert.deepEqual(snapshot.guard.findings.map((finding) => finding.type === "payload-tool-change"
		? `${finding.change} tool:${finding.name}` : `${finding.change} ${finding.part}`).sort(),
	["deleted tool:write", "modified user"]);
	assertAttributedTool(runtime.compose(snapshot));
	const assistant = runtime.session.agent.state.messages.findLast((message) => message.role === "assistant");
	assert.ok(assistant?.role === "assistant");
	assert.equal(assistant.stopReason, "stop");
	assert.deepEqual(assistant.content, [{ type: "text", text: "ok" }]);
});

/** A demo runtime exposing captures and composition without opening a TUI. */
interface DemoRuntime {
	readonly session: AgentSession;
	readonly errors: string[];
	latest(): Promise<RequestSnapshot>;
	compose(snapshot: RequestSnapshot): InjectionSnapshot;
}

/** Check exact tool ownership and prompt attribution, rather than guessed message ownership. */
function assertAttributedTool(snapshot: InjectionSnapshot): void {
	const group = snapshot.groups.find((group) => group.source.label === "review-checklist.ts");
	assert.ok(group, "the path-loaded tool has its own extension group");
	assert.ok(group.items.some((item) => item.kind === "tool" && item.label === "review_checklist"));
	const prompt = group.items.find((item) => item.diffOnly);
	assert.ok(prompt?.diff && prompt.diff.added > 0);
	assert.equal(prompt.requestOnly, undefined);
	assert.deepEqual(prompt.sections?.map((part) => part.label), ["Available Tools", "Guidelines"]);
	const piPrompt = snapshot.groups.find((group) => group.source.label === "pi")?.items
		.find((item) => item.kind === "base-prompt");
	for (const label of ["Available Tools", "Guidelines"]) {
		const part = piPrompt?.children?.find((part) => part.label === label);
		const references = part?.injectedReferences?.filter((reference) => reference.source.label === "review-checklist.ts");
		assert.equal(references?.length, 1);
		assert.equal(references?.[0].attribution, undefined);
	}
}

/** Overrides for the default fixture set or the test harness endpoint. */
interface DemoRuntimeOptions {
	readonly fixtures?: readonly string[];
	readonly baseUrl?: string;
}

/** Load real demo files by path, preserving their independence from regular test fixtures. */
async function createDemoRuntime(
	t: TestContext,
	api: MockApi,
	after: boolean,
	overrides: DemoRuntimeOptions = {},
): Promise<DemoRuntime> {
	const fixtures = overrides.fixtures ?? FIXTURES;
	const provider = overrides.baseUrl === undefined ? await startMockProvider() : undefined;
	if (provider) t.after(() => provider.close());
	const baseUrl = overrides.baseUrl ?? provider?.baseUrls[api];
	assert.ok(baseUrl);
	// After hooks run in registration order: the session must stop before its directory is removed
	let stopSession: (() => void) | undefined;
	t.after(() => stopSession?.());
	const directory = await mkdtemp(join(tmpdir(), "context-demo-fixtures-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
	});
	const model = {
		provider: `demo-${api}`, id: "demo", name: "Demo", api, baseUrl,
		reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 128,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} satisfies NonNullable<ExtensionContext["model"]>;
	const store = new SnapshotStore();
	let options: BuildSystemPromptOptions = { cwd: directory };
	let monitorApi: ExtensionAPI | undefined;
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: fixtures.map((fixture) =>
			fileURLToPath(new URL(`../scripts/demo-injections/${fixture}.ts`, import.meta.url))),
		extensionFactories: [
			(pi) => pi.registerProvider(model.provider, {
				api, baseUrl: model.baseUrl, apiKey: "mock-key", models: [model],
			}),
			(pi) => {
				monitorApi = pi;
				registerExtension(pi, store, createIsolatedConfigStore());
				pi.on("before_agent_start", (event) => { options = event.systemPromptOptions; });
			},
		],
		extensionsOverride: (result) => {
			const monitor = result.extensions.find((extension) => extension.commands.has("context"));
			assert.ok(monitor);
			const others = result.extensions.filter((extension) => extension !== monitor);
			return { ...result, extensions: after ? [monitor, ...others] : [...others, monitor] };
		},
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd: directory, agentDir: directory, settingsManager, resourceLoader, modelRuntime, model,
		sessionManager: SessionManager.inMemory(directory), thinkingLevel: "off",
	});
	stopSession = () => session.dispose();
	assert.deepEqual(extensionsResult.errors, []);
	const errors: string[] = [];
	await session.bindExtensions({ mode: "rpc", onError: (error) => { errors.push(`${error.event}: ${error.error}`); } });
	return {
		session, errors,
		latest: async () => {
			await new Promise((resolve) => setImmediate(resolve));
			const latest = store.latest();
			assert.ok(latest);
			return latest;
		},
		compose: (snapshot) => {
			assert.ok(monitorApi);
			const allTools = monitorApi.getAllTools();
			return buildInjectionsSnapshot({
				snapshot, entries: session.sessionManager.getEntries(), filterMessages: (messages) => messages,
				options, allTools, systemPrompt: session.systemPrompt, activeToolNames: session.getActiveToolNames(),
				promptSources: collectPromptSources(allTools, monitorApi.getCommands()),
			});
		},
	};
}
