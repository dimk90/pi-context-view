/**
 * Every request-only change kind in one request, on Pi's real adapters against
 * the mock provider. Fixtures load by path through Pi's resource loader, so
 * extension tools keep a real file source for exact attribution.
 */
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

import registerExtension from "../src/index.ts";
import { buildInjectionsSnapshot } from "../src/injections.ts";
import type { InjectionSnapshot } from "../src/model.ts";
import { collectPromptSources } from "../src/prompt-additions.ts";
import { type ConversationChange, type GuardFinding, type RequestSnapshot, SnapshotStore } from "../src/snapshot.ts";
import { AGENT_START_MESSAGE_TYPE } from "./fixtures/agent-start-message.ts";
import { ATTRIBUTED_TOOL_NAME } from "./fixtures/attributed-tool.ts";
import { CONTEXT_ADD_TYPE } from "./fixtures/context-add.ts";
import { CONTEXT_DELETE_SAVED_TEXT, CONTEXT_DELETE_SAVED_TYPE } from "./fixtures/context-delete-saved.ts";
import { CONTEXT_MODIFY_PREFIX } from "./fixtures/context-modify.ts";
import {
	PAYLOAD_CHANGE_ADDED, PAYLOAD_CHANGE_ANCHOR, PAYLOAD_CHANGE_DELETED, PAYLOAD_CHANGE_MODIFIED, PAYLOAD_CHANGE_ORIGINAL,
} from "./fixtures/payload-changes.ts";
import { PAYLOAD_REMOVED_TOOL } from "./fixtures/payload-remove-tool.ts";
import { SECTION_DELETE_NAME, SECTION_DELETE_SECTIONS } from "./fixtures/section-delete.ts";
import { SECTION_MODIFY_SECTIONS } from "./fixtures/section-modify.ts";
import { SECTION_PATCH_SECTIONS } from "./fixtures/section-patch.ts";
import { type MockApi, startMockProvider } from "./harness/mock-provider.ts";
import { createIsolatedConfigStore } from "./harness/settings.ts";

const APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
/** One fixture per change kind, plus a saved message and an attributed tool. */
const FIXTURES = [
	"context-add", "context-modify", "context-delete-saved", "section-patch", "section-modify", "section-delete",
	"payload-changes", "payload-remove-tool", "agent-start-message", "attributed-tool",
];
const FIRST_PROMPT = "first prompt";
const LATEST_PROMPT = "latest prompt";

/** Where the monitor loads relative to the fixtures. */
type Position = "before" | "after";

/** A runtime exposing captures and Injections composition without opening a TUI. */
interface Runtime {
	readonly session: AgentSession;
	readonly errors: string[];
	/** The latest capture after its deferred diff and guard settle. */
	latest(): Promise<RequestSnapshot>;
	compose(snapshot: RequestSnapshot): InjectionSnapshot;
}

for (const api of APIS) {
	for (const position of ["before", "after"] as const) {
		test(`${api}: every change kind stays distinct in one request (fixtures ${position})`, async (t) => {
			const runtime = await createRuntime(t, api, position);
			await runtime.session.prompt(FIRST_PROMPT);
			await runtime.session.prompt(LATEST_PROMPT);
			const snapshot = await runtime.latest();
			assert.deepEqual(runtime.errors, []);
			const before = position === "before";

			assert.deepEqual(snapshot.changes.conversation.map(describeChange).sort(), [
				`added ${CONTEXT_ADD_TYPE}`,
				// payload-changes seeds its request-only originals through `context` in both orders
				...[PAYLOAD_CHANGE_ORIGINAL, PAYLOAD_CHANGE_ANCHOR, PAYLOAD_CHANGE_DELETED].map((text) => `added user: ${text}`),
				"deleted",
				`modified user: ${CONTEXT_MODIFY_PREFIX} ${LATEST_PROMPT}`,
			].sort());
			const deleted = snapshot.changes.conversation.find((change) => change.type === "deleted");
			assert.ok(deleted?.type === "deleted");
			const entry = runtime.session.sessionManager.getEntry(deleted.entryId);
			assert.ok(entry?.type === "custom_message" && entry.customType === CONTEXT_DELETE_SAVED_TYPE);
			assert.equal(runtime.session.sessionManager.getEntries().filter((saved) =>
				saved.type === "custom_message" && saved.customType === CONTEXT_DELETE_SAVED_TYPE).length, 1,
			"the deleted note is saved once, not once per prompt");

			// After the monitor, section edits reach only the payload
			assert.deepEqual(snapshot.changes.system.map((change) => change.type === "section" ? change.name : change.type)
				.sort(), before ? [
				"cwd", SECTION_DELETE_NAME, ...Object.keys(SECTION_DELETE_SECTIONS),
				...SECTION_MODIFY_SECTIONS.map(({ name }) => name), ...Object.keys(SECTION_PATCH_SECTIONS),
			].sort() : []);
			assert.ok(snapshot.guard.status === "complete");
			assert.deepEqual(snapshot.guard.findings.map(describeFinding).sort(), before
				? ["added user", `deleted tool:${PAYLOAD_REMOVED_TOOL}`, "deleted user", "modified user"].sort()
				: ["modified system"]);
			if (before) {
				const modified = snapshot.guard.findings.find((finding) =>
					finding.type === "payload-change" && finding.change === "modified");
				assert.deepEqual(modified?.lines, [
					{ type: "removed", text: PAYLOAD_CHANGE_ORIGINAL }, { type: "added", text: PAYLOAD_CHANGE_MODIFIED },
				]);
				const added = snapshot.guard.findings.find((finding) =>
					finding.type === "payload-change" && finding.change === "added");
				assert.deepEqual(added?.lines, [{ type: "added", text: PAYLOAD_CHANGE_ADDED }]);
			}

			const composition = runtime.compose(snapshot);
			assertAttributedTool(composition);
			assertDeletedPreviews(composition, before);
		});
	}
}

/** One-line description of a conversation change; additions keep their text, except custom messages. */
function describeChange(change: ConversationChange): string {
	if (change.type === "deleted") return "deleted";
	const message = change.message;
	if (message.role === "custom") return `${change.type} ${message.customType}`;
	assert.ok(message.role === "user");
	const text = typeof message.content === "string"
		? message.content
		: message.content.map((block) => block.type === "text" ? block.text : "").join("");
	return `${change.type} user: ${text}`;
}

/** `<change> <part>` of a payload finding, or `<change> tool:<name>` of a tool declaration finding. */
function describeFinding(finding: GuardFinding): string {
	return finding.type === "payload-tool-change"
		? `${finding.change} tool:${finding.name}`
		: `${finding.change} ${finding.part}`;
}

/**
 * The path-loaded tool forms its own group with exact ownership: its prompt
 * lines point to it in Pi's Tools and Rules parts without a guess, in both orders.
 */
function assertAttributedTool(snapshot: InjectionSnapshot): void {
	const group = snapshot.groups.find((group) => group.source.label === "attributed-tool.ts");
	assert.ok(group, "the path-loaded tool has its own extension group");
	assert.ok(group.items.some((item) => item.kind === "tool" && item.label === ATTRIBUTED_TOOL_NAME));
	const prompt = group.items.find((item) => item.diffOnly);
	assert.ok(prompt?.diff && prompt.diff.added > 0);
	assert.equal(prompt.requestOnly, undefined);
	assert.deepEqual(prompt.sections?.map((part) => part.label), ["Tools", "Rules"]);
	const piPrompt = snapshot.groups.find((group) => group.source.label === "pi")?.items
		.find((item) => item.kind === "base-prompt");
	for (const label of ["Tools", "Rules"]) {
		const part = piPrompt?.children?.find((part) => part.label === label);
		const references = part?.injectedReferences?.filter((reference) =>
			reference.source.label === "attributed-tool.ts");
		assert.equal(references?.length, 1, label);
		assert.equal(references?.[0]?.attribution, undefined, label);
		// Highlighted extension lines show this change; a diff body would hide their sources
		assert.equal(part?.textDiff, undefined, label);
	}
}

/**
 * Deleted parts stay listed at 0 tokens with their original text, and a saved
 * message stays unmarked next to request-only ones.
 */
function assertDeletedPreviews(snapshot: InjectionSnapshot, structuredSections: boolean): void {
	const items = snapshot.groups.flatMap((group) => group.items);
	const messages = items.find((item) => item.kind === "message");
	const removed = messages?.sections?.filter((part) => part.change === "deleted") ?? [];
	assert.equal(removed.length, 1);
	assert.equal(removed[0]?.tokens, 0);
	assert.equal(removed[0]?.text, CONTEXT_DELETE_SAVED_TEXT);
	const saved = messages?.sections?.filter((part) => part.label === AGENT_START_MESSAGE_TYPE) ?? [];
	assert.equal(saved.length, 2, "each prompt saves one copy");
	for (const part of saved) assert.deepEqual([part.change, part.requestOnly], [undefined, undefined]);
	if (!structuredSections) return;

	const promptParts = items.find((item) => item.kind === "base-prompt")?.children ?? [];
	for (const [name, text] of Object.entries(SECTION_DELETE_SECTIONS)) {
		const part = promptParts.find((part) => part.label === name);
		assert.deepEqual([part?.change, part?.tokens, part?.requestOnly], ["deleted", 0, true], name);
		// Pi wraps seeded sections once; previews show only the body
		assert.equal(part?.text, text, name);
	}
}

/**
 * Build an isolated Pi runtime with every fixture loaded by path and the
 * monitor first (`after`) or last (`before`). No real credentials or endpoints.
 */
async function createRuntime(t: TestContext, api: MockApi, position: Position): Promise<Runtime> {
	const provider = await startMockProvider();
	t.after(() => provider.close());
	// After hooks run in registration order: the session must stop before its directory is removed
	let stopSession: (() => void) | undefined;
	t.after(() => stopSession?.());
	const directory = await mkdtemp(join(tmpdir(), "context-combined-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
	});
	const model = {
		provider: `combined-${api}`, id: "combined", name: "Combined", api, baseUrl: provider.baseUrls[api],
		reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 128,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} satisfies NonNullable<ExtensionContext["model"]>;
	const store = new SnapshotStore();
	let options: BuildSystemPromptOptions = { cwd: directory };
	let monitorApi: ExtensionAPI | undefined;
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: FIXTURES.map((fixture) =>
			fileURLToPath(new URL(`./fixtures/${fixture}.ts`, import.meta.url))),
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
			return { ...result, extensions: position === "after" ? [monitor, ...others] : [...others, monitor] };
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
