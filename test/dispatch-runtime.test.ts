/**
 * Pi behavior the payload guard relies on (D4 in doc/REQUEST-ONLY-INJECTIONS.md),
 * checked in a real in-process runtime against the mock provider: which model
 * `ctx.model` names while a request is prepared, which events carry the
 * dispatch identity, what `ctx.modelRegistry.find()` returns for a routed
 * model, and how each API serializes a request. Only Pi and test extensions
 * load; the monitor itself is not involved.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite, test, type TestContext } from "node:test";

import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { type MockApi, type MockProvider, startMockProvider } from "./harness/mock-provider.ts";

const APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const satisfies readonly MockApi[];

/** A 1×1 PNG for image-input checks. */
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Selection of the test router; `router/pi-virtual/auto` in identities. */
const VIRTUAL = { provider: "router", id: "auto" } as const;

/** Message roles each API's serializer emits. */
const COMPLETIONS_ROLES = ["system", "developer", "user", "assistant", "tool"];
const ANTHROPIC_ROLES = ["system", "user", "assistant"];

/**
 * Models of every mock provider `mock-<api>`:
 *   vision   accepts text and images
 *   text     text only, with mid-conversation system messages
 */
type ModelId = "vision" | "text";

type Model = NonNullable<ExtensionContext["model"]>;
type Item = Record<string, unknown>;

/** What one agent request showed the extensions; models and identities read `provider/api/model`. */
interface ObservedRequest {
	/** `ctx.model` at the request's `turn_start`, before Pi resolves the request model. */
	readonly turnStartModel: string;
	/** `ctx.model` at `context_with_system`: the request model the capture records. */
	readonly requestModel: string;
	readonly requestCapabilities: Capabilities;
	/** `ctx.model` at `before_provider_request`, when a payload was built. */
	payloadModel?: string;
	payload?: Item;
	/**
	 * Events in arrival order. Identity-bearing events carry their identity:
	 * `message_start <identity>`, the first `provider_stream_event <identity>`,
	 * and `message_end <identity>`, all from the assistant message.
	 */
	readonly events: string[];
	/** `ctx.modelRegistry.find()` for the identity at assistant `message_end`. */
	found?: Capabilities;
}

/** Model fields that payload normalization reads. */
interface Capabilities {
	readonly identity: string;
	readonly input: readonly string[];
	readonly compat: unknown;
}

/** Options of one runtime. */
interface RuntimeOptions {
	/** Initially selected model; defaults to OpenAI Completions `vision`. */
	readonly model?: readonly [MockApi, ModelId];
	/** Extensions loaded before the observer. */
	readonly extensions?: readonly ExtensionFactory[];
	/** Fields merged into the `text` models' `compat`. */
	readonly compat?: Record<string, unknown>;
	readonly tools?: readonly string[];
}

/** A Pi runtime with its observations. */
interface Runtime {
	readonly session: AgentSession;
	readonly provider: MockProvider;
	readonly requests: ObservedRequest[];
	readonly errors: string[];
	/** A registered model; throws when it is missing. */
	model(provider: string, id: string): Model;
}

suite("request model on a physical selection", { concurrency: true }, () => {
	for (const api of APIS) {
		test(`${api}: ctx.model during preparation names the dispatched model`, async (t) => {
			const other = APIS[(APIS.indexOf(api) + 1) % APIS.length];
			const runtime = await createRuntime(t, { model: [api, "vision"] });
			await runtime.session.prompt("first prompt");
			runtime.provider.enqueue({ type: "tool-call", name: "read", arguments: { path: "missing.txt" } },
				{ type: "text", text: "after tool" });
			await runtime.session.prompt("tool prompt");
			await runtime.session.setModel(runtime.model(`mock-${other}`, "text"));
			await runtime.session.prompt("after a model change");

			assert.deepEqual(runtime.errors, []);
			assert.deepEqual(runtime.requests.map((request) => request.requestModel), [
				...Array<string>(3).fill(identity(api, "vision")), identity(other, "text"),
			], "the tool follow-up is a separate request");
			for (const request of runtime.requests) {
				assertDispatched(request, request.requestModel);
				assert.equal(request.payloadModel, request.requestModel);
				assert.deepEqual(request.found, request.requestCapabilities, "ctx.model has the dispatched model's capabilities");
			}
		});

		test(`${api}: assistant and provider stream events carry the dispatch identity`, async (t) => {
			const runtime = await createRuntime(t, { model: [api, "vision"] });
			runtime.provider.enqueue({ type: "text", text: "late", delayMs: 50 });
			await runtime.session.prompt("delayed stream");
			runtime.provider.enqueue({ type: "error", status: 500, message: "mock failure" });
			await runtime.session.prompt("failing request");

			assert.deepEqual(runtime.errors, []);
			const [delayed, failed] = runtime.requests;
			const dispatched = identity(api, "vision");
			assert.equal(delayed.events[0], "after_provider_response");
			assert.equal(delayed.events.at(-1), `message_end ${dispatched}`);
			// The adapter pushes its start before reading the stream, but the agent loop delivers it in more
			// async steps. Data buffered by the time the response resolves, even 50 ms late under load, often
			// reaches provider_stream_event handlers first, so the guard accepts either
			assert.deepEqual(delayed.events.slice(1, -1).sort(),
				[`message_start ${dispatched}`, `provider_stream_event ${dispatched}`]);
			assert.deepEqual(failed.events, [`message_start ${dispatched}`, `message_end ${dispatched}`],
				"a failure before streaming has only the assistant events, and no after_provider_response");
		});
	}

	test("pi.setModel() in a context handler changes ctx.model but not the prepared request", async (t) => {
		let switchTo: Model | undefined;
		const switcher: ExtensionFactory = (pi) => {
			pi.on("context", async () => {
				const model = switchTo;
				switchTo = undefined;
				if (model && !(await pi.setModel(model))) throw new Error("setModel failed");
			});
		};
		const runtime = await createRuntime(t, { model: ["openai-completions", "vision"], extensions: [switcher] });
		switchTo = runtime.model("mock-anthropic-messages", "vision");
		await runtime.session.prompt("switch during preparation");
		await runtime.session.prompt("next prompt");

		assert.deepEqual(runtime.errors, []);
		const [switched, next] = runtime.requests;
		const prepared = identity("openai-completions", "vision");
		const selected = identity("anthropic-messages", "vision");
		assert.equal(switched.turnStartModel, prepared, "turn_start still sees the model Pi prepares the request for");
		assert.equal(switched.requestModel, selected);
		assert.equal(switched.payloadModel, selected);
		assertDispatched(switched, prepared);
		assert.deepEqual(matchingApis(switched.payload), ["openai-completions"], "the payload keeps the prepared API");
		assert.equal(next.requestModel, selected);
		assertDispatched(next, selected);
	});
});

test("virtual selection: ctx.model stays virtual and find() returns the model Pi dispatched", async (t) => {
	let target: MockApi = "openai-completions";
	const router: ExtensionFactory = (pi) => {
		pi.registerVirtualModel({
			...VIRTUAL,
			name: "Auto",
			route(_request, ctx) {
				const model = ctx.modelRegistry.find(`mock-${target}`, "text");
				if (!model) throw new Error(`mock-${target}/text is not registered`);
				// Claim image input: Pi dispatches the catalog model, which has none
				return { model: { ...model, input: ["text", "image"] }, thinkingLevel: "off" };
			},
		});
	};
	const runtime = await createRuntime(t, { extensions: [router] });
	await runtime.session.setModel(runtime.model(VIRTUAL.provider, VIRTUAL.id));
	for (const api of APIS) {
		target = api;
		await runtime.session.prompt(`routed to ${api}`, { images: [{ type: "image", data: PIXEL_PNG, mimeType: "image/png" }] });
	}

	assert.deepEqual(runtime.errors, []);
	assert.equal(runtime.requests.length, APIS.length);
	for (const [index, request] of runtime.requests.entries()) {
		const routed = identity(APIS[index], "text");
		assert.equal(request.requestModel, `${VIRTUAL.provider}/pi-virtual/${VIRTUAL.id}`);
		assert.equal(request.payloadModel, request.requestModel, "before_provider_request has no routed model either");
		assertDispatched(request, routed);
		assert.deepEqual(request.found, {
			identity: routed, input: ["text"], compat: { supportsMidConvoSystemMessages: true },
		});
		assert.deepEqual(matchingApis(request.payload), [APIS[index]]);
		assert.match(JSON.stringify(request.payload), /image omitted/, "the dispatched model is the catalog model");
	}
});

suite("payload representation per API", { concurrency: true }, () => {
	for (const api of APIS) {
		test(`${api}: payloads match only their own API's shape check`, async (t) => {
			let addSection = false;
			const laterSection: ExtensionFactory = (pi) => {
				pi.on("before_agent_start", (event) => {
					// Recorded as a mid-conversation system message on the second prompt
					if (addSection) event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, later: "<later/>" };
				});
			};
			const runtime = await createRuntime(t, { model: [api, "text"], extensions: [laterSection] });
			await runtime.session.prompt("first prompt");
			addSection = true;
			runtime.provider.enqueue({ type: "tool-call", name: "read", arguments: { path: "missing.txt" } },
				{ type: "text", text: "after tool" });
			await runtime.session.prompt("second prompt");

			assert.deepEqual(runtime.errors, []);
			assert.equal(runtime.requests.length, 3);
			for (const request of runtime.requests) assert.deepEqual(matchingApis(request.payload), [api]);
			const last = runtime.requests[2].payload;
			assert.ok(last);
			const roles = (isItemList(last.messages) ? last.messages : []).map((message) => message.role);
			if (api === "anthropic-messages") {
				assert.ok(roles.includes("system"), "Anthropic sends mid-conversation system messages in messages");
			}
		});
	}

	for (const compat of [{ supportsAdditionalTools: true }, { supportsToolSearch: true }]) {
		test(`openai-responses with ${Object.keys(compat)[0]}: later additions are inline until the history is not additive`,
			async (t) => {
				const runtime = await createRuntime(t, { model: ["openai-responses", "text"], compat, tools: ["read", "ls"] });
				runtime.session.setActiveToolsByName(["read"]);
				await runtime.session.prompt("first prompt");
				runtime.session.setActiveToolsByName(["read", "ls"]);
				await runtime.session.prompt("tool added");
				runtime.session.setActiveToolsByName(["ls"]);
				await runtime.session.prompt("tool removed");

				assert.deepEqual(runtime.errors, []);
				const [, added, removed] = runtime.requests.map((request) => request.payload);
				assert.deepEqual(toolNames(added?.tools), ["read"], "the request-level list keeps the initial tools");
				assert.deepEqual(inlineToolNames(added), ["ls"]);
				assert.deepEqual(toolNames(removed?.tools), ["ls"], "a removal sends the current tools at request level");
				assert.deepEqual(inlineToolNames(removed), []);
			});
	}
});

/**
 * Build an isolated runtime with one mock provider per API, the given
 * extensions, and an observer loaded last. No real credentials or endpoints.
 */
async function createRuntime(t: TestContext, options: RuntimeOptions): Promise<Runtime> {
	const provider = await startMockProvider();
	t.after(() => provider.close());
	const directory = await mkdtemp(join(tmpdir(), "context-dispatch-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({
		cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
	});
	t.mock.method(SettingsManager, "create", () => settingsManager);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
	});
	const models = APIS.flatMap((api) => mockModels(provider, api, options.compat));
	const [api, modelId] = options.model ?? ["openai-completions", "vision"];
	const requests: ObservedRequest[] = [];
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [
			...APIS.map((mockApi): ExtensionFactory => (pi) => pi.registerProvider(`mock-${mockApi}`, {
				api: mockApi, baseUrl: provider.baseUrls[mockApi], apiKey: "mock-key",
				models: models.filter((model) => model.api === mockApi),
			})),
			...(options.extensions ?? []),
			createObserver(requests),
		],
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd: directory, agentDir: directory, settingsManager, resourceLoader, modelRuntime,
		model: models.find((model) => model.api === api && model.id === modelId),
		sessionManager: SessionManager.inMemory(directory), tools: [...(options.tools ?? ["read"])], thinkingLevel: "off",
	});
	t.after(() => session.dispose());
	assert.deepEqual(extensionsResult.errors, []);
	const errors: string[] = [];
	await session.bindExtensions({ mode: "rpc", onError: (error) => { errors.push(`${error.event}: ${error.error}`); } });
	return {
		session, provider, requests, errors,
		model: (providerId, id) => {
			const model = modelRuntime.getModel(providerId, id);
			assert.ok(model, `${providerId}/${id} is registered`);
			return model;
		},
	};
}

/** The `vision` and `text` models of the mock provider for `api`. */
function mockModels(provider: MockProvider, api: MockApi, compat: Record<string, unknown> | undefined): Model[] {
	return (["vision", "text"] as const).map((id) => ({
		provider: `mock-${api}`, id, name: id, api, baseUrl: provider.baseUrls[api], reasoning: false,
		input: id === "vision" ? ["text", "image"] : ["text"], contextWindow: 100_000, maxTokens: 128,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(id === "text" ? { compat: { supportsMidConvoSystemMessages: true, ...compat } } : {}),
	}));
}

/** Record each request's models, payload, and dispatch-identity events; change nothing. */
function createObserver(requests: ObservedRequest[]): ExtensionFactory {
	return (pi) => {
		let turnStartModel = "none";
		let current: ObservedRequest | undefined;
		let streamed = false;
		pi.on("turn_start", (_event, ctx) => { turnStartModel = describeModel(ctx.model); });
		pi.on("context_with_system", (_event, ctx) => {
			current = {
				turnStartModel,
				requestModel: describeModel(ctx.model),
				requestCapabilities: capabilities(ctx.model),
				events: [],
			};
			streamed = false;
			requests.push(current);
		});
		pi.on("before_provider_request", (event, ctx) => {
			if (!current) return;
			current.payloadModel = describeModel(ctx.model);
			current.payload = structuredClone(event.payload) as Item;
		});
		pi.on("after_provider_response", () => { current?.events.push("after_provider_response"); });
		pi.on("provider_stream_event", (event) => {
			if (!current || streamed) return;
			streamed = true;
			current.events.push(`provider_stream_event ${event.provider}/${event.api}/${event.model}`);
		});
		pi.on("message_start", (event) => {
			const message = event.message;
			if (message.role === "assistant") current?.events.push(`message_start ${message.provider}/${message.api}/${message.model}`);
		});
		pi.on("message_end", (event, ctx) => {
			const message = event.message;
			if (message.role !== "assistant" || !current) return;
			current.events.push(`message_end ${message.provider}/${message.api}/${message.model}`);
			current.found = capabilities(ctx.modelRegistry.find(message.provider, message.model));
		});
	};
}

/** Assert every identity-bearing event names `dispatched`, with one assistant start and end. */
function assertDispatched(request: ObservedRequest, dispatched: string): void {
	const identities = request.events.filter((event) => event !== "after_provider_response");
	assert.ok(identities.length >= 2, `assistant events were observed: ${request.events}`);
	assert.deepEqual(identities.map((event) => event.split(" ")[1]), identities.map(() => dispatched));
}

/** `provider/api/model` of a mock model. */
function identity(api: MockApi, id: ModelId): string {
	return `mock-${api}/${api}/${id}`;
}

/** `provider/api/model` of a model, or `none`. */
function describeModel(model: Model | undefined): string {
	return model ? `${model.provider}/${model.api}/${model.id}` : "none";
}

/** The capabilities of a model; an unknown model has none. */
function capabilities(model: Model | undefined): Capabilities {
	return { identity: describeModel(model), input: model?.input ?? [], compat: model?.compat };
}

// ============================================================================
// Spike shape checks
// ============================================================================

/**
 * APIs whose representation `payload` matches. These checks only reject a
 * payload that cannot be the selected API's; they never select a parser.
 */
function matchingApis(payload: Item | undefined): MockApi[] {
	if (!payload) return [];
	return APIS.filter((api) => SHAPE_CHECKS[api](payload));
}

const SHAPE_CHECKS: Record<MockApi, (payload: Item) => boolean> = {
	/** System prompt in `messages`, `tool` results, nested `function` declarations. */
	"openai-completions": (payload) => isItemList(payload.messages) && !("input" in payload) && !("system" in payload)
		&& payload.messages.every((message) => COMPLETIONS_ROLES.includes(String(message.role)))
		&& optionalItems(payload.tools)?.every((tool) => tool.type === "function" && isItem(tool.function)
			&& typeof tool.function.name === "string") === true,
	/** `input` items instead of messages, flat declarations. */
	"openai-responses": (payload) => isItemList(payload.input) && !("messages" in payload)
		&& payload.input.every((item) => typeof item.role === "string" || typeof item.type === "string")
		&& optionalItems(payload.tools)?.every((tool) => typeof tool.type === "string"
			&& (tool.type !== "function" || typeof tool.name === "string")) === true,
	/** Top-level `system`, declarations with a name and no `function`. */
	"anthropic-messages": (payload) => isItemList(payload.messages) && !("input" in payload)
		&& (payload.system === undefined || typeof payload.system === "string" || isItemList(payload.system))
		&& payload.messages.every((message) => ANTHROPIC_ROLES.includes(String(message.role)))
		&& optionalItems(payload.tools)?.every((tool) => typeof tool.name === "string" && !("function" in tool)) === true,
};

/** Whether `value` is a plain object. */
function isItem(value: unknown): value is Item {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is an array of plain objects. */
function isItemList(value: unknown): value is Item[] {
	return Array.isArray(value) && value.every(isItem);
}

/** The items of an optional list: empty when absent, undefined when not a list of objects. */
function optionalItems(value: unknown): Item[] | undefined {
	if (value === undefined) return [];
	return isItemList(value) ? value : undefined;
}

/** Names of OpenAI Responses tool declarations. */
function toolNames(tools: unknown): unknown[] {
	return (optionalItems(tools) ?? []).map((tool) => tool.name);
}

/** Tool names an OpenAI Responses payload declares inline: `additional_tools` and `tool_search_output` items. */
function inlineToolNames(payload: Item | undefined): unknown[] {
	const items = optionalItems(payload?.input) ?? [];
	return items.filter((item) => item.type === "additional_tools" || item.type === "tool_search_output")
		.flatMap((item) => toolNames(item.tools));
}
