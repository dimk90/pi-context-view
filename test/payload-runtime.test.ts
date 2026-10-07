/** Payload pairing, tool declarations, and message text on Pi's real adapters, with loopback-only endpoints. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { type AssistantMessage, type ImageContent, type Message, type TextContent, Type } from "@earendil-works/pi-ai";
import {
	type AgentSession, createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
	DefaultResourceLoader, type ExtensionContext, type ExtensionFactory, ModelRuntime, SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import registerExtension from "../src/index.ts";
import { type GuardFinding, type RequestSnapshot, SnapshotStore } from "../src/snapshot.ts";
import cacheWarm from "./fixtures/cache-warm.ts";
import forcedPrompt from "./fixtures/forced-prompt.ts";
import { type MockApi, type MockProvider, startMockProvider } from "./harness/mock-provider.ts";

const APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
const MCP_SERVER = fileURLToPath(new URL("./fixtures/mcp-server.ts", import.meta.url));
/** A 1×1 PNG for image-input checks. */
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** Text that payload editors add, so findings are easy to match. */
const LATE_LINE = "XYZZY_LATE: appended in the provider payload — 末尾.";
const LATE_MESSAGE = "XYZZY_LATE: a user message added to the provider payload.";

/** Physical model supplied by the runtime. */
type Model = NonNullable<ExtensionContext["model"]>;
type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

/** Isolated session options; extension order is explicit. */
interface RuntimeOptions {
	readonly api?: MockApi;
	readonly before?: readonly ExtensionFactory[];
	readonly after?: readonly ExtensionFactory[];
	readonly settings?: Partial<Settings>;
	readonly compat?: Record<string, unknown>;
	readonly oauth?: boolean;
	readonly warming?: boolean;
	/** Selected model; `text` has no image input. */
	readonly modelId?: "vision" | "text";
}

/** Session, mock endpoint, and capture publications, all process-local. */
interface Runtime {
	readonly session: AgentSession;
	readonly provider: MockProvider;
	readonly store: SnapshotStore;
	readonly published: RequestSnapshot[];
	model(api: MockApi, id?: string): Model;
	snapshots(): Promise<RequestSnapshot[]>;
}

for (const api of APIS) {
	test(`${api}: ordinary prompts and tool follow-ups compare without findings`, async (t) => {
		const runtime = await createRuntime(t, { api });
		await runtime.session.prompt("first");
		runtime.provider.enqueue({ type: "tool-call", name: "read", arguments: { path: "missing.txt" } });
		await runtime.session.prompt("second");
		const snapshots = await runtime.snapshots();
		assert.equal(snapshots.length, 3);
		for (const snapshot of snapshots) {
			assert.deepEqual(findings(snapshot), []);
			assert.deepEqual(snapshot.declaredTools, { declared: ["read", "write"], baseline: ["read", "write"] });
		}
	});

	for (const order of ["before", "after"] as const) {
		test(`${api}: in-place payload tool edits ${order} monitor respect load order`, async (t) => {
			const editor: ExtensionFactory = (pi) => {
				pi.on("before_provider_request", (event) => {
					const payload = event.payload as { tools: Array<Record<string, unknown>> };
					const read = payload.tools[0];
					const definition = api === "openai-completions" ? read.function as Record<string, unknown> : read;
					definition.description = "Changed late — 工具";
					const extra = { ...structuredClone(read), ...(api === "openai-completions"
						? { function: { ...definition, name: "extra" } } : { name: "extra" }) };
					payload.tools.splice(1, 1, extra);
				});
			};
			const runtime = await createRuntime(t, { api, [order]: [editor] });
			await runtime.session.prompt("tool edits");
			const [snapshot] = await runtime.snapshots();
			const changed = [{ type: "added", text: "Changed late — 工具" }];
			// The modification also lists every line of read's built-in description as removed
			const added = findings(snapshot).map((finding) => finding.type === "late-tool-edit"
				? { ...finding, lines: finding.lines.filter((line) => line.type === "added") }
				: finding);
			assert.deepEqual(added, order === "after" ? [] : [
				{ type: "hidden-declaration", name: "write", candidates: [] },
				{ type: "late-tool-edit", change: "modified", name: "read", lines: changed },
				{ type: "late-tool-edit", change: "added", name: "extra", lines: changed },
			]);
			if (order === "before") {
				const modified = findings(snapshot).find((finding) => finding.type === "late-tool-edit");
				assert.ok(modified?.type === "late-tool-edit");
				assert.ok(modified.lines.some((line) => line.type === "removed"));
			}
			assert.deepEqual(snapshot.declaredTools?.declared, order === "after" ? ["read", "write"] : ["read", "extra"]);
		});
	}
}

for (const mode of ["on", "only"] as const) {
	for (const api of APIS) {
		test(`${api}: built-in codemode ${mode} and tool-search separate recorded descriptions from hidden tools`, async (t) => {
			const runtime = await createRuntime(t, {
				api, before: [createCodemodeExtension(), createToolSearchExtension()],
				settings: { codemode: { mode }, defaultTools: ["read", "write", "codemode", "tool_search"] },
			});
			await runtime.session.prompt("built-in loadout");
			const [snapshot] = await runtime.snapshots();
			assert.deepEqual(snapshot.changes, { conversation: [], system: [] });
			assert.deepEqual(findings(snapshot), mode === "on" ? [] : ["read", "write"].map((name) => ({
				type: "hidden-declaration", name, candidates: ["codemode", "tool_search"],
			})));
			assert.deepEqual(snapshot.declaredTools?.declared, mode === "on"
				? ["read", "write", "codemode", "tool_search"] : ["codemode", "tool_search"]);
		});
	}
}

test("MCP direct tools are recorded declarations, not late edits", async (t) => {
	const directory = await temporaryDirectory(t);
	const runtime = await createRuntime(t, {
		before: [
			(pi) => pi.registerMcpServer("fixture", { command: process.execPath, args: [MCP_SERVER], exposure: "direct" }),
			createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }), logPath: join(directory, "mcp.log") }),
		],
	});
	await runtime.session.prompt("MCP declaration");
	const [snapshot] = await runtime.snapshots();
	assert.deepEqual(findings(snapshot), []);
	assert.deepEqual(snapshot.changes, { conversation: [], system: [] });
	assert.ok(snapshot.declaredTools?.declared.includes("mcp__fixture__echo"));
});

for (const compat of [{ supportsAdditionalTools: true }, { supportsToolSearch: true }]) {
	test(`Responses ${Object.keys(compat)[0]} inline additions, then removals and redefinitions`, async (t) => {
		const runtime = await createRuntime(t, { api: "openai-responses", compat: { supportsMidConvoSystemMessages: true, ...compat } });
		await exerciseToolChanges(runtime);
	});
}

test("Completions system-message tool additions, then removals and redefinitions", async (t) => {
	const runtime = await createRuntime(t, {
		compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true },
	});
	await exerciseToolChanges(runtime);
	const sent = runtime.provider.requests.map((request) => request.body.messages as Array<Record<string, unknown>>);
	assert.ok(sent.some((messages) => messages.some((message) => message.role === "system" && message.tools !== undefined)),
		"a system message declared a later tool inline");
});

for (const oauth of [false, true]) {
	test(`Anthropic native inline additions/removals/redefinitions${oauth ? " with OAuth casing" : ""}`, async (t) => {
		const runtime = await createRuntime(t, {
			api: "anthropic-messages", oauth,
			compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
		});
		await exerciseToolChanges(runtime);
	});
}

test("virtual routing selects each parser and image capability from the dispatched catalog model", async (t) => {
	let api: MockApi = "openai-completions";
	const router: ExtensionFactory = (pi) => pi.registerVirtualModel({
		provider: "router", id: "auto", name: "Auto",
		route(_request, ctx) {
			const model = ctx.modelRegistry.find(`mock-${api}`, "text");
			assert.ok(model);
			return { model, thinkingLevel: "off" };
		},
	});
	const runtime = await createRuntime(t, { before: [router] });
	const virtual = runtime.session.modelRuntime.getModel("router", "auto");
	assert.ok(virtual);
	await runtime.session.setModel(virtual);
	for (const target of APIS) {
		api = target;
		await runtime.session.prompt(`route ${target}`, {
			images: [{ type: "image", data: PIXEL_PNG, mimeType: "image/png" }],
		});
		const sent = JSON.stringify(runtime.provider.requests.at(-1)?.body);
		assert.ok(sent.includes("(image omitted: model does not support images)"));
		assert.ok(!sent.includes(PIXEL_PNG));
	}
	const snapshots = await runtime.snapshots();
	assert.equal(snapshots.length, 3);
	for (const [index, snapshot] of snapshots.entries()) {
		assert.deepEqual(findings(snapshot), []);
		assert.ok(snapshot.guard.status === "complete");
		assert.equal(snapshot.guard.dispatch.api, APIS[index]);
	}
});

test("physical guard publishes before HTTP response, then detects setModel during preparation", async (t) => {
	let switchTo: Model | undefined;
	let runtime: Runtime;
	const before: ExtensionFactory = (pi) => {
		pi.on("context", async () => {
			if (switchTo) { await pi.setModel(switchTo); switchTo = undefined; }
		});
	};
	const after: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", async () => {
			// Wait for deferred comparison while still blocking the actual HTTP send
			await flush();
			assert.notEqual(runtime.store.latest()?.guard.status, "pending");
		});
	};
	runtime = await createRuntime(t, { before: [before], after: [after] });
	await runtime.session.prompt("ordinary");
	for (const target of [runtime.model("openai-completions", "text"), runtime.model("anthropic-messages")]) {
		switchTo = target;
		await runtime.session.prompt("switch during preparation");
	}
	const snapshots = await runtime.snapshots();
	assert.deepEqual(findings(snapshots[0]), []);
	for (const snapshot of snapshots.slice(1)) {
		assert.ok(snapshot.guard.status === "incomplete");
		assert.match(snapshot.guard.reason, /differs/);
		assert.equal(snapshot.declaredTools, undefined);
	}
});

for (const level of ["agent", "provider"] as const) {
	test(`${level} retries pair each capture only once`, async (t) => {
		const runtime = await createRuntime(t, { settings: {
			retry: { enabled: level === "agent", maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: level === "provider" ? 1 : 0 } },
		} });
		runtime.provider.enqueue({ type: "error", status: 500, message: "Internal server error" }, { type: "text", text: "retry ok" });
		await runtime.session.prompt("retry once");
		const snapshots = await runtime.snapshots();
		assert.equal(runtime.provider.requests.length, 2);
		assert.equal(snapshots.length, level === "agent" ? 2 : 1);
		for (const snapshot of snapshots) assert.deepEqual(findings(snapshot), []);
	});
}

for (const api of ["openai-completions", "openai-responses"] as const) {
	test(`${api}: successful and failed idle warm refreshes publish nothing`, { timeout: 30_000 }, async (t) => {
		const runtime = await createRuntime(t, { api, warming: true, before: [cacheWarm], settings: { cacheWarming: "idle" } });
		await runtime.session.prompt("warm this request");
		await runtime.snapshots();
		const count = runtime.published.length;
		runtime.provider.enqueue({ type: "text", text: "warm" }, { type: "error", status: 500, message: "warm failure" });
		await runtime.provider.waitForRequests(3, 20_000);
		for (const request of runtime.provider.requests.slice(1)) {
			assert.equal(api === "openai-responses" ? request.body.max_output_tokens : request.body.max_completion_tokens,
				api === "openai-responses" ? 16 : 1);
		}
		await flush();
		assert.equal(runtime.published.length, count);
		assert.deepEqual(findings(runtime.store.latest()), []);
		await runtime.session.prompt("real request after warming");
		assert.equal((await runtime.snapshots()).length, 2);
	});
}

// ============================================================================
// Message channel
// ============================================================================

for (const api of APIS) {
	for (const order of ["before", "after"] as const) {
		test(`${api}: payload message edits ${order} the monitor are late edits only before it`, async (t) => {
			const runtime = await createRuntime(t, { api, [order]: [payloadMessageEditor(api)] });
			await runtime.session.prompt("first prompt");
			await runtime.session.prompt("second prompt");
			const snapshots = await runtime.snapshots();
			const sent = JSON.stringify(runtime.provider.requests.at(-1)?.body);
			assert.ok(sent.includes(LATE_MESSAGE) && !sent.includes("first prompt"), "the editor changed the sent payload");
			assert.deepEqual(findings(snapshots[1]), order === "after" ? [] : [
				{ type: "late-edit", change: "deleted", part: "user", lines: [{ type: "removed", text: "first prompt" }] },
				{ type: "late-edit", change: "modified", part: "user", lines: [{ type: "added", text: LATE_LINE }] },
				{ type: "late-edit", change: "added", part: "user", lines: [{ type: "added", text: LATE_MESSAGE }] },
			]);
		});
	}

	test(`${api}: an unknown payload part leaves only the message channel uncompared`, async (t) => {
		const unknownPart: ExtensionFactory = (pi) => {
			pi.on("before_provider_request", (event) => {
				const messages = payloadMessages(api, event.payload);
				messages.push({ role: "user", content: [{ type: "input_audio", input_audio: { data: "", format: "wav" } }] });
			});
		};
		const runtime = await createRuntime(t, { api, before: [unknownPart] });
		await runtime.session.prompt("prompt");
		const [snapshot] = await runtime.snapshots();
		assert.ok(snapshot.guard.status === "incomplete");
		assert.match(snapshot.guard.reason, /shape the .* parser does not know/);
		assert.deepEqual(snapshot.guard.findings, [], "the compared tool channel keeps its findings");
		assert.deepEqual(snapshot.declaredTools, { declared: ["read", "write"], baseline: ["read", "write"] });
	});
}

/** One configuration of the adjustment matrix; each runs on a fresh runtime. */
interface AdjustmentCase {
	readonly api: MockApi;
	readonly modelId?: "vision" | "text";
	readonly compat?: Record<string, unknown>;
	readonly blockImages?: boolean;
	readonly forced?: boolean;
	readonly oauth?: boolean;
	readonly codemode?: boolean;
}

const ADJUSTMENT_CASES: readonly AdjustmentCase[] = [
	...APIS.flatMap((api): AdjustmentCase[] => [
		{ api },
		{ api, modelId: "text" },
		{ api, compat: { supportsMidConvoSystemMessages: true } },
		{ api, modelId: "text", compat: { supportsMidConvoSystemMessages: true } },
		{ api, blockImages: true },
		{ api, forced: true, compat: { supportsMidConvoSystemMessages: true } },
	]),
	{ api: "openai-completions", compat: { requiresAssistantAfterToolResult: true, requiresThinkingAsText: true } },
	{ api: "openai-completions", modelId: "text", compat: { requiresAssistantAfterToolResult: true } },
	{ api: "openai-completions", codemode: true, compat: { supportsOpenAIGrammarTools: true } },
	{ api: "openai-completions", codemode: true, compat: {
		supportsOpenAIGrammarTools: true, supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true,
	} },
	{ api: "openai-responses", codemode: true, compat: { supportsOpenAIGrammarTools: true } },
	{ api: "openai-responses", compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true } },
	{ api: "anthropic-messages", oauth: true },
	{ api: "anthropic-messages", compat: { allowEmptySignature: true } },
	{ api: "anthropic-messages", compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } },
];

for (const adjustment of ADJUSTMENT_CASES) {
	const { api, ...variant } = adjustment;
	test(`${api}: Pi's adjustments are not late edits ${JSON.stringify(variant)}`, async (t) => {
		const runtime = await createRuntime(t, {
			api, modelId: adjustment.modelId, compat: adjustment.compat, oauth: adjustment.oauth,
			before: [...(adjustment.forced ? [forcedPrompt] : []), ...(adjustment.codemode ? [createCodemodeExtension()] : [])],
			settings: {
				...(adjustment.blockImages ? { images: { blockImages: true } } : {}),
				...(adjustment.codemode ? { codemode: { mode: "on" }, defaultTools: ["read", "write", "codemode"] } : {}),
			},
		});
		await runtime.session.prompt("first prompt");
		seedHistory(runtime.session, runtime.session.model);
		await runtime.session.prompt("second prompt");
		const snapshots = await runtime.snapshots();
		assert.equal(snapshots.length, 2);
		assert.deepEqual(snapshots[1].changes, { conversation: [], system: [] });
		assert.deepEqual(findings(snapshots[1]), []);
		const sent = JSON.stringify(runtime.provider.requests.at(-1)?.body);
		for (const text of ["Foreign answer.", "Custom block note.", "Ran `ls`", "No result provided"]) {
			assert.ok(sent.includes(text), `the payload carries the seeded ${text}`);
		}
		assert.ok(!sent.includes("Failed partial.") && !sent.includes("hidden output"));
		if (adjustment.modelId === "text") assert.ok(sent.includes("(image omitted: model does not support images)"));
		if (adjustment.blockImages) assert.ok(sent.includes("Image reading is disabled."));
		if (adjustment.codemode) assert.ok(sent.includes("\"input\":\"return 1;\""), "the codemode call is a grammar call");
	});
}

/**
 * Persist history that exercises Pi's adjustments: images, another model's
 * thinking and tool calls, signed and unsigned thinking of the selected model,
 * empty and image-only tool results, an unanswered call, failed and aborted
 * replies, custom, bash, and summary messages, and later system messages,
 * one between a tool call and its result.
 */
function seedHistory(session: AgentSession, model: Model | undefined): void {
	assert.ok(model);
	const manager = session.sessionManager;
	const image: ImageContent = { type: "image", data: PIXEL_PNG, mimeType: "image/png" };
	const text = (value: string): TextContent => ({ type: "text", text: value });
	const other = { provider: "elsewhere", api: model.api === "anthropic-messages" ? "openai-responses" : "anthropic-messages", model: "x" };
	const same = { provider: model.provider, api: model.api, model: model.id };
	const signature = model.api === "openai-responses"
		? JSON.stringify({ type: "reasoning", id: "rs_seed", summary: [] })
		: model.api === "openai-completions" ? "reasoning_content" : "anthropic-signature";
	const append = (message: unknown) => manager.appendMessage(message as Message);

	append({ role: "user", content: [text("Look at these."), image, image], timestamp: 1 });
	append(assistant(other, "toolUse", [
		{ type: "thinking", thinking: "Foreign reasoning.", thinkingSignature: "foreign" },
		{ type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
		text("Foreign answer."),
		{ type: "toolCall", id: "call|foreign+id", name: "read", arguments: { path: "a.txt" } },
	]));
	// Pi persists section patches only; it removes these unknown sections again on the next prompt
	append({ role: "system", content: "", sections: { held: "<held>Held section.</held>" }, timestamp: 2 });
	append({ role: "toolResult", toolCallId: "call|foreign+id", toolName: "read", content: [image], isError: false, timestamp: 3 });
	append(assistant(same, "toolUse", [
		{ type: "thinking", thinking: "Signed reasoning.", thinkingSignature: signature },
		{ type: "thinking", thinking: "Unsigned reasoning." },
		text("Same-model answer."),
		{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "b.txt", limit: 2 } },
		{ type: "toolCall", id: "call_code", name: "codemode", arguments: { code: "return 1;" } },
		{ type: "toolCall", id: "call_orphan", name: "write", arguments: { path: "c.txt", content: "x" } },
	]));
	append({ role: "toolResult", toolCallId: "call_read", toolName: "read", content: [], isError: false, timestamp: 4 });
	append({
		role: "toolResult", toolCallId: "call_code", toolName: "codemode", content: [text("1"), image], isError: false, timestamp: 5,
	});
	append(assistant(same, "error", [text("Failed partial.")]));
	append(assistant(same, "aborted", [text("Aborted partial.")]));
	manager.appendCustomMessageEntry("note", "Custom string note.", true);
	manager.appendCustomMessageEntry("note", [text("Custom block note."), image], false);
	append({ role: "bashExecution", command: "ls", output: "file.txt", exitCode: 1, cancelled: false, truncated: false, timestamp: 6 });
	append({
		role: "bashExecution", command: "cat secret", output: "hidden output", exitCode: 0, cancelled: false, truncated: false,
		excludeFromContext: true, timestamp: 7,
	});
	append({ role: "branchSummary", summary: "Branch summary.", fromId: null, timestamp: 8 });
	append({ role: "user", content: "   ", timestamp: 9 });
	append(assistant(same, "stop", [text("   "), text("Spaced answer.")]));
	append({ role: "system", content: "", sections: { extra: "<extra>Later section.</extra>" }, timestamp: 10 });
	// The agent prepares the next prompt's system patch from its own copy of the transcript
	session.refreshContext();
}

/** A persisted assistant message of `identity`. */
function assistant(
	identity: { readonly provider: string; readonly api: string; readonly model: string },
	stopReason: AssistantMessage["stopReason"],
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant", ...identity, content, stopReason, timestamp: 0,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/**
 * A `before_provider_request` editor that removes the first user message,
 * appends a line to the last one in place, and adds a user message, in the
 * representation of `api`.
 */
function payloadMessageEditor(api: MockApi): ExtensionFactory {
	return (pi) => {
		pi.on("before_provider_request", (event) => {
			const messages = payloadMessages(api, event.payload);
			const users = messages.filter((message) => message.role === "user");
			// The first request has one user message; edit the second
			const last = users.at(-1);
			if (users.length < 2 || last === undefined) return;
			messages.splice(messages.indexOf(users[0]), 1);
			if (typeof last.content === "string") last.content = `${last.content}\n${LATE_LINE}`;
			else (last.content as unknown[]).push({ type: api === "openai-responses" ? "input_text" : "text", text: LATE_LINE });
			messages.push(api === "openai-responses"
				? { role: "user", content: [{ type: "input_text", text: LATE_MESSAGE }] }
				: { role: "user", content: LATE_MESSAGE });
		});
	};
}

/** The message list of a payload: `input` items for Responses, `messages` otherwise. */
function payloadMessages(api: MockApi, payload: unknown): Array<Record<string, unknown>> {
	const body = payload as Record<string, Array<Record<string, unknown>>>;
	return api === "openai-responses" ? body.input : body.messages;
}

/** Exercise persistent tool changes rather than request-only edits; both channels' baseline stays empty. */
async function exerciseToolChanges(runtime: Runtime): Promise<void> {
	for (const names of [["read"], ["read", "write"], ["write"]]) {
		runtime.session.setActiveToolsByName(names);
		await runtime.session.prompt(names.join(" "));
	}
	const snapshots = await runtime.snapshots();
	for (const [index, names] of [["read"], ["read", "write"], ["write"]].entries()) {
		assert.deepEqual(findings(snapshots[index]), []);
		assert.deepEqual(snapshots[index].changes, { conversation: [], system: [] });
		assert.deepEqual(snapshots[index].declaredTools, { declared: names, baseline: names });
	}
	// A same-name redefinition is recorded by Pi, not reported as a late edit
	await runtime.session.prompt("/redefine");
	await runtime.session.prompt("after redefinition");
	assert.deepEqual(findings((await runtime.snapshots()).at(-1)), []);
}

/** Isolated session using the actual monitor and all three physical adapters. */
async function createRuntime(t: TestContext, options: RuntimeOptions = {}): Promise<Runtime> {
	const provider = await startMockProvider();
	t.after(() => provider.close());
	const directory = await temporaryDirectory(t);
	const settingsManager = SettingsManager.inMemory({
		cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
		defaultTools: ["read", "write"], ...options.settings,
	});
	t.mock.method(SettingsManager, "create", () => settingsManager);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
	});
	const models: Model[] = APIS.flatMap((api) => ["vision", "text"].map((id) => ({
		provider: `mock-${api}`, id, api, name: id, baseUrl: provider.baseUrls[api], reasoning: false,
		input: id === "vision" ? ["text", "image"] : ["text"], maxTokens: 128, contextWindow: 100_000,
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
		compat: options.compat,
		...(options.warming ? { promptCache: { short: 12 } } : {}),
	})));
	const store = new SnapshotStore();
	const published: RequestSnapshot[] = [];
	store.subscribe((snapshot) => published.push(snapshot));
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [
			...APIS.map((api): ExtensionFactory => (pi) => pi.registerProvider(`mock-${api}`, {
				api, baseUrl: provider.baseUrls[api], apiKey: options.oauth ? "sk-ant-oat-test-key" : "mock-key",
				models: models.filter((model) => model.api === api),
			})),
			(pi) => pi.registerCommand("redefine", { description: "Test only", handler: async () => {
				pi.registerTool({ name: "write", label: "write", description: "Redefined write.", parameters: Type.Object({}),
					execute: async () => ({ content: [], details: undefined }) });
			} }),
			...(options.before ?? []), (pi) => registerExtension(pi, store), ...(options.after ?? []),
		],
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd: directory, agentDir: directory, settingsManager, resourceLoader, modelRuntime,
		sessionManager: SessionManager.inMemory(directory),
		model: models.find((model) => model.api === (options.api ?? "openai-completions") && model.id === (options.modelId ?? "vision")),
		thinkingLevel: "off",
	});
	t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
	assert.deepEqual(extensionsResult.errors, []);
	const errors: string[] = [];
	await session.bindExtensions({ mode: "rpc", onError: (error) => { errors.push(`${error.event}: ${error.error}`); } });
	return {
		session, provider, store, published,
		model: (api, id = "vision") => {
			const model = modelRuntime.getModel(`mock-${api}`, id);
			assert.ok(model);
			return model;
		},
		snapshots: async () => {
			await flush();
			assert.deepEqual(errors, []);
			return [...new Map(published.map((snapshot) => [snapshot.id, snapshot])).values()];
		},
	};
}

/** Findings of a complete comparison of both channels. */
function findings(snapshot: RequestSnapshot | undefined): readonly GuardFinding[] {
	assert.ok(snapshot?.guard.status === "complete", JSON.stringify(snapshot?.guard));
	return snapshot.guard.findings;
}

/** Deferred work queued before this call. */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Scratch files live outside the project and are removed after the test. */
async function temporaryDirectory(t: TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "context-payload-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}
