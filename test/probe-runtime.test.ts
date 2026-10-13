import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
	type AgentSession,
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
import { PROBE_IDENTITIES_CUSTOM_TYPE } from "../src/probe/filter.ts";
import forcedPrompt from "./fixtures/forced-prompt.ts";
import inputTransform from "./fixtures/input-transform.ts";
import marker from "./fixtures/marker.ts";
import { useSettings } from "./harness/settings.ts";

/** The parts of an OpenAI chat-completions request body the tests read. */
interface RequestBody {
	messages: Array<{ role: string; content: string | Array<{ text?: string }> }>;
}

/** Loopback-only provider that records requests and returns a deterministic assistant response. */
async function startProvider(t: TestContext) {
	let requests = 0;
	const bodies: RequestBody[] = [];
	const server = createServer((request, response) => {
		// Count on arrival, so even a request that never completes is seen
		requests++;
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end([
				'data: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
				'data: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}',
				"data: [DONE]",
				"",
			].join("\n\n"));
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
		server.closeAllConnections();
	}));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests: () => requests, bodies };
}

/** Build an isolated Pi runtime with no real credentials, resources, or provider endpoints. */
async function createRuntime(t: TestContext, baseUrl: string, factories: ExtensionFactory[]) {
	const directory = await mkdtemp(join(tmpdir(), "context-probe-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } });
	useSettings(t, directory, () => settingsManager);
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
	test(`the probe aborts, blanks and omits its entries with fixtures ${position}`, async (t) => {
		const provider = await startProvider(t);
		const observed = { headers: 0, payloads: 0, responses: 0, contexts: 0, beforeSettle: 0, overlays: 0 };
		const errors: string[] = [];
		const stopReasons: Array<[string, string | undefined]> = [];
		const visibility: boolean[] = [];
		let draftedEarlierOmission = false;
		let contextMessages: string[] = [];
		const sentinel: ExtensionFactory = (pi) => {
			pi.on("context", (event) => { contextMessages = conversationRoles(event.messages); });
			pi.on("before_provider_headers", () => { observed.headers++; });
			pi.on("before_provider_request", () => { observed.payloads++; });
			pi.on("after_provider_response", () => { observed.responses++; });
			pi.on("context_with_system", () => { observed.contexts++; });
			pi.on("agent_before_settle", () => { observed.beforeSettle++; });
			pi.on("message_end", (event) => {
				if (event.message.role === "assistant") {
					stopReasons.push([event.message.stopReason, event.message.errorMessage]);
				}
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
		// The only abort form the probe blanks: Node.js AbortError text, before streaming
		assert.deepEqual(stopReasons, [["error", "This operation was aborted"]],
			"auth rejects the aborted signal before streaming");
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
		assert.deepEqual(contextMessages, ["user"], "omitted probe entries never reach a context handler");
		assert.equal(session.sessionManager.getBranch().filter((entry) => entry.type === "context_edit").length, 2);
		assert.equal(session.sessionManager.buildSessionProjection().messages.filter((message) =>
			message.role === "user" || message.role === "assistant").length, 2);
		assert.deepEqual(errors, []);
	});
}

test("filtering unomitted probe entries keeps mid-conversation system messages in place", async (t) => {
	const provider = await startProvider(t);
	const seen = { context: [] as string[], beforeFilter: [] as string[], afterFilter: [] as string[] };
	let addSection = false;
	const earlier: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", (event) => {
			// A prompt change between runs records a system message mid-conversation
			if (addSection) event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, later: "later" };
		});
		pi.on("context", (event) => { seen.context = event.messages.map((message) => message.role); });
		pi.on("context_with_system", (event) => { seen.beforeFilter = event.messages.map((message) => message.role); });
	};
	const later: ExtensionFactory = (pi) => {
		pi.on("context_with_system", (event) => { seen.afterFilter = event.messages.map((message) => message.role); });
	};
	const session = await createRuntime(t, provider.baseUrl, [earlier, registerExtension, later]);
	const errors = await bindTui(session);
	await session.prompt("/context injections");

	// Return to the probe's last entry, before its omissions, as in an old session or after an interrupted probe
	const probeEntries = session.sessionManager.getBranch().filter((entry) => entry.type === "message"
		&& (entry.message.role === "user" || entry.message.role === "assistant"));
	const probeAssistant = probeEntries.at(-1);
	assert.ok(probeAssistant);
	await session.navigateTree(probeAssistant.id);
	await session.prompt("first");
	addSection = true;
	await session.prompt("second");

	assert.deepEqual(errors, []);
	assert.equal(provider.requests(), 2);
	assert.deepEqual(seen.context, ["user", "assistant", "user", "assistant", "user"],
		"unomitted blank probe entries stay visible to context handlers");
	assert.deepEqual(seen.beforeFilter, ["system", "user", "assistant", "user", "assistant", "system", "user"],
		"and to earlier context_with_system handlers");
	assert.deepEqual(seen.afterFilter, ["system", "user", "assistant", "system", "user"],
		"later handlers see the probe entries removed and the later system message in place");
	// Pi's conversion drops blank messages anyway; this checks the system message reaches the provider in place
	assert.deepEqual(provider.bodies[1].messages.map((message) => message.role), seen.afterFilter);
});

test("a nested custom-message run fails the attempt and the probe still claims its own prompt", { timeout: 30_000 }, async (t) => {
	const provider = await startProvider(t);
	const events: string[] = [];
	const stopReasons: Array<[string, string | undefined]> = [];
	let settledRuns = 0;
	let resolveBothSettled: () => void = () => undefined;
	const bothSettled = new Promise<void>((resolve) => { resolveBothSettled = resolve; });
	const sentinel: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", (event) => { events.push(`before_agent_start: ${event.messageType}`); });
		pi.on("after_provider_response", () => { events.push("after_provider_response"); });
		pi.on("message_end", (event) => {
			if (event.message.role === "assistant") {
				stopReasons.push([event.message.stopReason, event.message.errorMessage]);
			}
		});
		pi.on("agent_settled", () => {
			events.push("agent_settled");
			if (++settledRuns === 2) resolveBothSettled();
		});
	};
	// Another extension starts its own run from the probe's input, inheriting the token, and waits for it
	let nestedSent = false;
	let resolveNestedSettled: (() => void) | undefined;
	const nestedSender: ExtensionFactory = (pi) => {
		pi.on("input", async (event) => {
			if (nestedSent || event.source !== "extension") return;
			nestedSent = true;
			const nestedSettled = new Promise<void>((resolve) => { resolveNestedSettled = resolve; });
			pi.sendMessage({ customType: "nested-run", content: "nested", display: true }, { triggerTurn: true });
			await nestedSettled;
		});
		pi.on("agent_settled", () => {
			// Pi is idle only once every agent_settled handler has returned
			if (resolveNestedSettled !== undefined) setImmediate(resolveNestedSettled);
			resolveNestedSettled = undefined;
		});
	};
	const session = await createRuntime(t, provider.baseUrl, [sentinel, nestedSender, registerExtension]);
	const errors: string[] = [];
	await session.bindExtensions({
		mode: "tui",
		onError: (error) => { errors.push(`${error.event}: ${error.error}`); },
		uiContext: {
			setWorkingVisible: () => undefined,
			custom: async () => { events.push("view"); },
		} as unknown as ExtensionUIContext,
	});

	await session.prompt("/context injections");
	await bothSettled;

	assert.deepEqual(errors, []);
	assert.deepEqual(events, [
		"before_agent_start: custom",
		// The failed attempt opens the view while the nested run still waits for its response
		"view",
		"after_provider_response",
		"agent_settled",
		"before_agent_start: user",
		"agent_settled",
	]);
	assert.equal(provider.requests(), 1, "only the nested run reaches the provider");
	assert.deepEqual(stopReasons, [["stop", undefined], ["error", "This operation was aborted"]]);
	const branch = session.sessionManager.getBranch();
	const [reply, ...probeEntries] = branch.flatMap((entry) => entry.type === "message"
		&& (entry.message.role === "user" || entry.message.role === "assistant")
		? [{ id: entry.id, message: entry.message }]
		: []);
	assert.ok(reply?.message.role === "assistant");
	assert.equal(reply.message.stopReason, "stop");
	assert.deepEqual(probeEntries.map(({ message }) => message.content), [[], []],
		"the probe prompt and its abort are blanked");
	assert.deepEqual(branch.filter((entry) => entry.type === "context_edit").map((entry) => entry.targetId),
		probeEntries.map(({ id }) => id), "and omitted");
	const projected = session.sessionManager.buildSessionProjection().messages;
	assert.deepEqual(projected.flatMap((message) => message.role === "custom" ? [message.customType] : []),
		["nested-run"]);
	assert.deepEqual(conversationRoles(projected), ["assistant"], "the nested run's reply stays visible");
});

for (const position of ["before", "after"] as const) {
	test(`messages sent while the probe run starts stay visible with the sender ${position}`, async (t) => {
		const provider = await startProvider(t);
		const stopReasons: Array<[string, string | undefined]> = [];
		let responses = 0;
		const sentinel: ExtensionFactory = (pi) => {
			pi.on("after_provider_response", () => { responses++; });
			pi.on("message_end", (event) => {
				if (event.message.role === "assistant") {
					stopReasons.push([event.message.stopReason, event.message.errorMessage]);
				}
			});
		};
		// Pi counts the session as busy while a run starts, so both sends are queued into the probe run.
		// The steered message inherits the probe token and usually shares the prompt's millisecond.
		let sent = false;
		const sender: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", () => {
				if (sent) return;
				sent = true;
				pi.sendUserMessage("steered", { deliverAs: "steer" });
				pi.sendMessage({ customType: "plain", content: "plain", display: true });
			});
		};
		const ordered = position === "before" ? [sender, registerExtension] : [registerExtension, sender];
		const session = await createRuntime(t, provider.baseUrl, [sentinel, ...ordered]);
		const errors = await bindTui(session);
		await session.prompt("/context injections");

		assert.deepEqual(errors, []);
		assert.equal(provider.requests(), 0, "the probe makes no provider request");
		assert.equal(responses, 0);
		// Pi delivers one queued message per turn: the custom one with the prompt, the steered one in an extra turn
		assert.deepEqual(stopReasons, [["error", "This operation was aborted"], ["error", "This operation was aborted"]]);
		const branch = session.sessionManager.getBranch();
		const conversation = branch.flatMap((entry) => entry.type === "message"
			&& (entry.message.role === "user" || entry.message.role === "assistant")
			? [{ id: entry.id, message: entry.message }]
			: []);
		assert.deepEqual(conversation.map(({ message }) => [message.role, message.content]), [
			["user", []],
			["assistant", []],
			["user", [{ type: "text", text: "steered" }]],
			["assistant", []],
		], "the probe prompt and both aborts are blanked, the steered message keeps its text");
		assert.ok(conversation.every(({ message }) => message.role === "user" || message.stopReason === "stop"));
		const steered = conversation[2];
		assert.deepEqual(branch.filter((entry) => entry.type === "context_edit").map((entry) => entry.targetId),
			conversation.filter((entry) => entry !== steered).map(({ id }) => id), "only probe entries are omitted");
		const projected = session.sessionManager.buildSessionProjection().messages;
		assert.deepEqual(projected.flatMap((message) => message.role === "custom" ? [message.customType] : []),
			["plain"]);
		assert.deepEqual(conversationRoles(projected), ["user"], "the steered message stays visible");

		await session.prompt("real request");
		assert.equal(provider.requests(), 1);
		assert.deepEqual(userTexts(provider.bodies[0]), ["plain", "steered", "real request"],
			"both messages reach the next real request");
		assert.deepEqual(errors, []);
	});
}

/**
 * Bind a session in TUI mode, where `/context` may probe; the view overlay
 * closes at once. Returns the extension errors reported from then on.
 */
async function bindTui(session: AgentSession): Promise<string[]> {
	const errors: string[] = [];
	await session.bindExtensions({
		mode: "tui",
		onError: (error) => { errors.push(`${error.event}: ${error.error}`); },
		uiContext: {
			setWorkingVisible: () => undefined,
			custom: async () => undefined,
		} as unknown as ExtensionUIContext,
	});
	return errors;
}

/** Text of each user message in a request body; Pi sends custom messages as user messages. */
function userTexts(body: RequestBody): string[] {
	return body.messages.flatMap((message) => {
		if (message.role !== "user") return [];
		return typeof message.content === "string"
			? [message.content]
			: [message.content.map((part) => part.text ?? "").join("")];
	});
}

/** Roles of the user and assistant messages, skipping custom and other session messages. */
function conversationRoles(messages: ReadonlyArray<{ role: string }>): string[] {
	return messages.map((message) => message.role).filter((role) => role === "user" || role === "assistant");
}
