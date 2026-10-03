import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	type ExtensionFactory,
	type ExtensionUIContext,
	ModelRuntime,
	type SessionBoundaryDraft,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import registerExtension from "../src/index.ts";
import { PROBE_IDENTITIES_CUSTOM_TYPE } from "../src/capture.ts";
import forcedPrompt from "./fixtures/forced-prompt.ts";
import inputTransform from "./fixtures/input-transform.ts";
import marker from "./fixtures/marker.ts";

/** Loopback-only provider that records requests and returns a deterministic assistant response. */
async function startProvider(t: TestContext) {
	let requests = 0;
	const server = createServer((_request, response) => {
		requests++;
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.end([
			'data: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
			'data: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}',
			"data: [DONE]",
			"",
		].join("\n\n"));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
		server.closeAllConnections();
	}));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests: () => requests };
}

/** Build an isolated Pi runtime with no real credentials, resources, or provider endpoints. */
async function createRuntime(t: TestContext, baseUrl: string, factories: ExtensionFactory[]) {
	const directory = await mkdtemp(join(tmpdir(), "context-probe-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } });
	t.mock.method(SettingsManager, "create", () => settingsManager);
	const runtime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const model = {
		provider: "probe-test", id: "test", name: "Test", api: "openai-completions", baseUrl,
		reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 128,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsMidConvoSystemMessages: true },
	} satisfies NonNullable<ExtensionContext["model"]>;
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [
			(pi) => pi.registerProvider("probe-test", {
				api: model.api, baseUrl, apiKey: "local-test-key", models: [model],
			}),
			...factories,
		],
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd: directory, agentDir: directory, settingsManager, resourceLoader, model,
		modelRuntime: runtime, sessionManager: SessionManager.inMemory(directory), tools: [], thinkingLevel: "off",
	});
	t.after(() => session.dispose());
	assert.deepEqual(extensionsResult.errors, []);
	return session;
}

for (const position of ["before", "after"] as const) {
	test(`Pi 1.0 probe aborts, blanks and omits its entries with fixtures ${position}`, async (t) => {
		const provider = await startProvider(t);
		const observed = { headers: 0, payloads: 0, responses: 0, contexts: 0, beforeSettle: 0, overlays: 0 };
		const errors: string[] = [];
		const stopReasons: string[] = [];
		const visibility: boolean[] = [];
		let draftedEarlierOmission = false;
		const sentinel: ExtensionFactory = (pi) => {
			pi.on("before_provider_headers", () => { observed.headers++; });
			pi.on("before_provider_request", () => { observed.payloads++; });
			pi.on("after_provider_response", () => { observed.responses++; });
			pi.on("context_with_system", () => { observed.contexts++; });
			pi.on("agent_before_settle", () => { observed.beforeSettle++; });
			pi.on("message_end", (event) => {
				if (event.message.role === "assistant") stopReasons.push(event.message.stopReason);
			});
			pi.on("turn_end", (event) => {
				const entries: SessionBoundaryDraft[] = [
					...event.entries,
					{ type: "custom", customType: "other-boundary", data: { retained: true } },
				];
				// On the probe turn only, omit its prompt first; the extension must not repeat that omission
				const prompt = event.context.contextEntries.find(({ sourceEntry }) =>
					sourceEntry.type === "message" && sourceEntry.message.role === "user");
				if (!draftedEarlierOmission && prompt !== undefined) {
					draftedEarlierOmission = true;
					entries.push({ type: "context_edit", targetId: prompt.sourceEntry.id, replacement: null });
				}
				return { entries };
			});
		};
		const fixtures = [marker, forcedPrompt, inputTransform];
		const ordered = position === "before" ? [...fixtures, registerExtension] : [registerExtension, ...fixtures];
		const session = await createRuntime(t, provider.baseUrl, [sentinel, ...ordered]);
		await session.bindExtensions({
			mode: "tui",
			onError: (error) => { errors.push(`${error.event}: ${error.error}`); },
			uiContext: {
				setWorkingVisible: (visible: boolean) => { visibility.push(visible); },
				custom: async () => { observed.overlays++; },
			} as unknown as ExtensionUIContext,
		});
		await session.prompt("/context injections");
		assert.deepEqual(errors, []);
		assert.equal(observed.overlays, 1);
		assert.equal(observed.contexts, 1, "structured capture still runs after turn_start abort");
		assert.deepEqual(stopReasons, ["error"], "auth rejects the aborted signal before streaming");
		assert.equal(observed.headers, 0);
		assert.equal(observed.payloads, 0);
		assert.equal(observed.responses, 0, "after_provider_response sentinel stays silent");
		assert.equal(provider.requests(), 0, "no HTTP request, even one failing before a response");
		assert.equal(observed.beforeSettle, 0, "abort skips agent_before_settle, not turn_end");
		assert.equal(visibility[0], false);
		assert.equal(visibility.at(-1), true);
		const branch = session.sessionManager.getBranch();
		const messages = branch.filter((entry) => entry.type === "message"
			&& (entry.message.role === "user" || entry.message.role === "assistant"));
		assert.equal(messages.length, 2);
		for (const entry of messages) {
			assert.equal(entry.type, "message");
			assert.ok(entry.type === "message"
				&& (entry.message.role === "user" || entry.message.role === "assistant"));
			assert.deepEqual(entry.message.content, []);
			if (entry.message.role === "assistant") assert.equal(entry.message.stopReason, "stop");
		}
		const edits = branch.filter((entry) => entry.type === "context_edit");
		assert.ok(draftedEarlierOmission);
		assert.deepEqual(edits.map((entry) => entry.targetId), messages.map((entry) => entry.id),
			"one omission per probe entry, including one drafted by an earlier handler");
		assert.ok(edits.every((entry) => entry.replacement === null));
		assert.ok(branch.some((entry) => entry.type === "custom" && entry.customType === "other-boundary"));
		assert.ok(branch.some((entry) => entry.type === "custom" && entry.customType === PROBE_IDENTITIES_CUSTOM_TYPE));
		assert.ok(session.sessionManager.buildSessionProjection().messages.every((message) =>
			message.role !== "user" && message.role !== "assistant"));

		// No matching identity means the filter preserves the full system-message layout
		const head = { role: "system", content: "base", timestamp: 1 } as const;
		const real = { role: "user", content: "real", timestamp: 2 } as const;
		const patch = { role: "system", content: "later", timestamp: 3 } as const;
		assert.deepEqual(await session.extensionRunner.emitContext([head, real, patch]), [head, real, patch]);
		const probeUser = messages.find((entry) => entry.type === "message" && entry.message.role === "user");
		assert.ok(probeUser?.type === "message");
		assert.deepEqual(await session.extensionRunner.emitContext([head, real, probeUser.message, patch]),
			[head, real, patch], "filtering an old probe does not collapse mid-conversation system messages");
		await session.prompt("/context injections");
		assert.equal(provider.requests(), 0, "reopening the view never repeats the probe");

		// A real request still reaches the local provider and stays in the projection
		await session.prompt("real request");
		assert.equal(provider.requests(), 1);
		assert.equal(observed.responses, 1);
		assert.equal(session.getLastAssistantText(), "ok");
		assert.equal(session.sessionManager.getBranch().filter((entry) => entry.type === "context_edit").length, 2);
		assert.equal(session.sessionManager.buildSessionProjection().messages.filter((message) =>
			message.role === "user" || message.role === "assistant").length, 2);
		assert.deepEqual(errors, []);
	});
}
