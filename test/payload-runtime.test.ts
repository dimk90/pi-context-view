/** Payload pairing and tool declarations on Pi's real adapters, with loopback-only endpoints. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { Type } from "@earendil-works/pi-ai";
import {
	type AgentSession, createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
	DefaultResourceLoader, type ExtensionContext, type ExtensionFactory, ModelRuntime, SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { MESSAGES_NOT_COMPARED_REASON } from "../src/capture/guard.ts";
import registerExtension from "../src/index.ts";
import { type GuardFinding, type RequestSnapshot, SnapshotStore } from "../src/snapshot.ts";
import cacheWarm from "./fixtures/cache-warm.ts";
import { type MockApi, type MockProvider, startMockProvider } from "./harness/mock-provider.ts";

const APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
const MCP_SERVER = fileURLToPath(new URL("./fixtures/mcp-server.ts", import.meta.url));

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
	test(`${api}: ordinary prompts and tool follow-ups compare without tool findings`, async (t) => {
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
			assert.deepEqual(findings(snapshot), order === "after" ? [] : [
				{ type: "hidden-declaration", name: "write", candidates: [] },
				{ type: "late-tool-edit", change: "modified", name: "read", description: "Changed late — 工具" },
				{ type: "late-tool-edit", change: "added", name: "extra", description: "Changed late — 工具" },
			]);
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

for (const oauth of [false, true]) {
	test(`Anthropic native inline additions/removals/redefinitions${oauth ? " with OAuth casing" : ""}`, async (t) => {
		const runtime = await createRuntime(t, {
			api: "anthropic-messages", oauth,
			compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
		});
		await exerciseToolChanges(runtime);
	});
}

test("virtual routing selects each parser from the dispatched catalog model", async (t) => {
	let api: MockApi = "openai-completions";
	const router: ExtensionFactory = (pi) => pi.registerVirtualModel({
		provider: "router", id: "auto", name: "Auto",
		route(_request, ctx) {
			const model = ctx.modelRegistry.find(`mock-${api}`, "vision");
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
		await runtime.session.prompt(`route ${target}`);
	}
	const snapshots = await runtime.snapshots();
	assert.equal(snapshots.length, 3);
	for (const [index, snapshot] of snapshots.entries()) {
		assert.deepEqual(findings(snapshot), []);
		assert.ok(snapshot.guard.status === "incomplete");
		assert.equal(snapshot.guard.dispatch?.api, APIS[index]);
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
			assert.equal(runtime.store.latest()?.guard.status, "incomplete");
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
		model: models.find((model) => model.api === (options.api ?? "openai-completions") && model.id === "vision"), thinkingLevel: "off",
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

/** Tool findings of a successful partial comparison. */
function findings(snapshot: RequestSnapshot | undefined): readonly GuardFinding[] {
	assert.ok(snapshot?.guard.status === "incomplete");
	assert.equal(snapshot.guard.reason, MESSAGES_NOT_COMPARED_REASON);
	assert.ok(snapshot.guard.findings);
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
