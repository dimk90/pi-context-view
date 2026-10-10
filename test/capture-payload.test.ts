/** Lifecycle wiring on a host where event timing can be controlled exactly. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type BeforeAgentStartEvent, type ExtensionAPI, type ExtensionContext, type ExtensionEvent, SessionManager,
} from "@earendil-works/pi-coding-agent";

import { SnapshotBuilder } from "../src/capture/builder.ts";
import { registerCapture } from "../src/capture/register.ts";
import { NO_PAYLOAD_REASON } from "../src/capture/tracker.ts";
import { type RequestSnapshot, SnapshotStore } from "../src/snapshot.ts";

const MODEL = { provider: "mock", api: "openai-completions", id: "vision", input: ["text", "image"] };
const TOOL = { name: "read", description: "Read.", parameters: { type: "object" } };
const SYSTEM = { role: "system", content: "prompt", toolsAdded: [TOOL], timestamp: 1 } as const;

/** Fake only the host ports; use actual capture, builder, store, and session projection. */
function harness(probe = false) {
	const handlers = new Map<string, Array<(event: ExtensionEvent, ctx: ExtensionContext) => unknown>>();
	const snapshots = new SnapshotStore();
	const published: RequestSnapshot[] = [];
	snapshots.subscribe((snapshot) => published.push(snapshot));
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({ ...SYSTEM, toolsAdded: [TOOL] });
	const context = {
		sessionManager, model: { ...MODEL }, getSystemPrompt: () => "prompt",
		modelRegistry: { find: () => MODEL },
	} as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...handlers.get(event) ?? [], handler]);
		},
	} as unknown as ExtensionAPI;
	registerCapture(pi, { isCurrentRun: probe, filterMessages: (messages) => messages }, new SnapshotBuilder(snapshots));
	return {
		snapshots, published, context,
		emit(event: ExtensionEvent) {
			for (const handler of handlers.get(event.type) ?? []) {
				assert.equal(handler(event, context), undefined, "capture handlers observe only");
			}
		},
	};
}

/** Provider identity that SilentProbe's blanking keeps on an assistant result. */
function assistant(): AssistantMessage {
	return {
		role: "assistant", provider: MODEL.provider, api: MODEL.api, model: MODEL.id,
		content: [], stopReason: "stop", timestamp: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

/** Let deferred comparisons and publications run. */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

for (const first of ["message_start", "provider_stream_event", "message_end"] as const) {
	test(`${first} can supply the first identity, without reading stream data or changing requests`, async () => {
		const h = harness(true);
		const messages = [{ ...SYSTEM, toolsAdded: [structuredClone(TOOL)] }];
		const payload = { messages: [{ role: "system", content: "prompt" }], tools: [] };
		const beforeMessages = structuredClone(messages);
		const beforePayload = structuredClone(payload);
		// Capture reads only the hidden tools of Pi's normalized options
		const options = { hiddenTools: ["read"] } as unknown as BeforeAgentStartEvent["systemPromptOptions"];
		h.emit({ type: "before_agent_start", prompt: "", systemPrompt: "prompt", systemPromptOptions: options });
		h.emit({ type: "context_with_system", messages });
		h.emit({ type: "before_provider_request", payload });
		assert.deepEqual(messages, beforeMessages);
		assert.deepEqual(payload, beforePayload);
		const identity = { provider: MODEL.provider, api: MODEL.api, model: MODEL.id };
		if (first === "provider_stream_event") h.emit({
			type: first, ...identity, get data() { throw new Error("stream data must not be read"); },
		});
		else h.emit({ type: first, message: assistant() });
		await flush();
		const snapshot = h.snapshots.latest();
		assert.equal(snapshot?.origin, "synthetic-probe");
		assert.ok(snapshot?.guard.status === "complete");
		assert.deepEqual(snapshot.guard.findings, [], "the tool Pi hid is not a payload removal");
		assert.deepEqual(snapshot.hiddenTools, ["read"]);
		const count = h.published.length;
		h.emit({ type: "message_start", message: assistant() });
		h.emit({ type: "message_end", message: assistant() });
		await flush();
		assert.equal(h.published.length, count);
	});
}

test("hidden names are copied at the event boundary and reset by an empty list on the next run", async () => {
	const h = harness(true);
	const options = { hiddenTools: ["read"] } as unknown as BeforeAgentStartEvent["systemPromptOptions"];
	h.emit({ type: "before_agent_start", prompt: "", systemPrompt: "prompt", systemPromptOptions: options });
	options.hiddenTools.length = 0;
	h.emit({ type: "context_with_system", messages: [{ ...SYSTEM, toolsAdded: [TOOL] }] });
	await flush();
	const first = h.snapshots.latest();
	assert.equal(first?.guard.status, "pending");
	assert.deepEqual(first?.hiddenTools, ["read"], "owned even before any payload");

	h.emit({ type: "before_agent_start", prompt: "", systemPrompt: "prompt", systemPromptOptions: options });
	h.emit({ type: "context_with_system", messages: [{ ...SYSTEM, toolsAdded: [TOOL] }] });
	await flush();
	assert.deepEqual(first?.hiddenTools, ["read"], "an earlier snapshot does not share the next run's list");
	assert.notEqual(h.snapshots.latest()?.id, first?.id);
	assert.equal(h.snapshots.latest()?.hiddenTools, undefined);
});

test("a new capture settles an earlier unpaired one and cannot inherit its request model", async () => {
	const h = harness();
	h.emit({ type: "context_with_system", messages: [] });
	// A later handler mutates the model object: capture owns its original identity
	if (h.context.model) h.context.model.id = "changed";
	h.emit({ type: "context_with_system", messages: [] });
	await flush();
	const earlier = h.published.findLast((snapshot) => snapshot.id === 1);
	assert.deepEqual(earlier?.guard, { status: "incomplete", reason: NO_PAYLOAD_REASON });
	assert.equal(h.snapshots.latest()?.id, 2);
	assert.equal(h.snapshots.latest()?.guard.status, "pending");
	h.emit({ type: "session_shutdown", reason: "quit" });
	const count = h.published.length;
	await flush();
	assert.equal(h.published.length, count);
});
