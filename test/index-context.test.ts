import assert from "node:assert/strict";
import { test } from "node:test";

import {
	type BeforeAgentStartEvent,
	type BeforeProviderRequestEvent,
	buildSessionProjection,
	type ContextEvent,
	type ContextWithSystemEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import registerExtension from "../src/index.ts";
import { PROBE_IDENTITIES_CUSTOM_TYPE } from "../src/probe/filter.ts";
import { SnapshotStore } from "../src/snapshot.ts";

/** Events these tests deliver to the extension's handlers. */
type TestEvent = SessionStartEvent | BeforeAgentStartEvent | ContextWithSystemEvent | BeforeProviderRequestEvent;

/** User message fixture for context events. */
function userMessage(content: string, timestamp: number): ContextEvent["messages"][number] {
	return { role: "user", content, timestamp } satisfies ContextEvent["messages"][number];
}

/**
 * Register the extension on a fake Pi that only records handlers. The returned
 * function runs every handler registered for one event in registration order,
 * with `ctx`, and returns their results in that order.
 */
function registerOnFakePi(ctx: ExtensionContext, snapshots?: SnapshotStore) {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, [...handlers.get(event) ?? [], handler]);
		},
		// Not triggered by the events these tests deliver
		appendEntry: () => undefined,
		registerCommand: () => undefined,
		getAllTools: () => [],
		getActiveTools: () => [],
		getCommands: () => [],
		getSettings: () => ({}),
	} as unknown as ExtensionAPI;
	registerExtension(pi, snapshots);
	return {
		emit: (event: TestEvent): unknown[] => (handlers.get(event.type) ?? []).map((handler) => handler(event, ctx)),
		handles: (eventType: string): boolean => handlers.has(eventType),
	};
}

/** Deferred diffs and guard jobs queued before this call. */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

test("only context_with_system observes requests: the filter returns a result, capture reads the baseline once", () => {
	// A resumed session with one real user message and the probe identities
	// persisted by a prior runtime.
	const probeUser = { role: "user", content: [], timestamp: 10 } satisfies ContextEvent["messages"][number];
	const entries: SessionEntry[] = [
		{
			type: "message",
			id: "1",
			parentId: null,
			timestamp: "2026-08-22T10:00:00Z",
			message: userMessage("hello", 1),
		},
		{
			type: "custom",
			id: "2",
			parentId: "1",
			timestamp: "2026-08-22T10:01:00Z",
			customType: PROBE_IDENTITIES_CUSTOM_TYPE,
			data: { messages: [{ role: "user", timestamp: 10 }] },
		},
	];
	let sessionReads = 0;
	const ctx = {
		getSystemPrompt: () => "system prompt",
		sessionManager: {
			getEntries: () => {
				sessionReads += 1;
				return entries;
			},
			buildSessionProjection: () => {
				sessionReads += 1;
				return buildSessionProjection(entries, "2");
			},
			getLeafId: () => "2",
		},
	} as unknown as ExtensionContext;
	const { emit, handles } = registerOnFakePi(ctx);

	// Rehydrate the persisted probe identity.
	emit({ type: "session_start", reason: "resume" });
	assert.equal(sessionReads, 1);
	assert.equal(handles("context"), false, "no handler observes the conversation-only context event");

	const system = { role: "system", content: "base", timestamp: 20 } satisfies ContextEvent["messages"][number];
	const patch = { role: "system", content: "patch", timestamp: 21 } satisfies ContextEvent["messages"][number];
	const realUser = userMessage("hello", 1);
	const full = [system, probeUser, realUser, patch];
	assert.deepEqual(emit({ type: "context_with_system", messages: full }), [
		{ messages: [system, realUser, patch] },
		undefined,
	], "only the filter returns a result; capture returns nothing");
	assert.deepEqual(full, [system, probeUser, realUser, patch], "filter never mutates the input");
	assert.equal(sessionReads, 2, "structured capture reads the baseline of each request");
	assert.deepEqual(emit({ type: "context_with_system", messages: [system, realUser, patch] }), [undefined, undefined]);
	assert.equal(sessionReads, 3);
});

test("#9: capture handlers return nothing and leave event.messages and the payload unchanged", async () => {
	const system = { role: "system", content: "system prompt", timestamp: 1 } satisfies ContextEvent["messages"][number];
	const entries: SessionEntry[] = [
		{ type: "message", id: "s", parentId: null, timestamp: "2026-08-22T10:00:00Z", message: system },
		{ type: "message", id: "1", parentId: "s", timestamp: "2026-08-22T10:00:01Z", message: userMessage("hello", 2) },
	];
	const model = { provider: "mock", api: "openai-completions", id: "text", input: ["text"] };
	const ctx = {
		getSystemPrompt: () => "system prompt",
		model,
		modelRegistry: { find: () => model },
		sessionManager: {
			getEntries: () => entries,
			buildSessionProjection: () => buildSessionProjection(entries, "1"),
			getLeafId: () => "1",
		},
	} as unknown as ExtensionContext;
	const snapshots = new SnapshotStore();
	const { emit } = registerOnFakePi(ctx, snapshots);
	emit({ type: "session_start", reason: "new" });
	emit({
		type: "before_agent_start", prompt: "hello", systemPrompt: "system prompt",
		systemPromptOptions: { cwd: "/tmp", hiddenTools: [] } as unknown as BeforeAgentStartEvent["systemPromptOptions"],
	});

	// An earlier handler added a request-only message, so capture copies it
	const added = userMessage("request-only note", 3);
	const messages = [system, userMessage("hello", 2), added];
	const originals = [...messages];
	const messagesBefore = structuredClone(messages);
	assert.deepEqual(emit({ type: "context_with_system", messages }), [undefined, undefined]);

	// An earlier handler added a payload message, so the guard reports it
	const payload = {
		model: "text",
		messages: [
			{ role: "system", content: "system prompt" },
			{ role: "user", content: "hello" },
			{ role: "user", content: "request-only note" },
			{ role: "user", content: [{ type: "text", text: "late note" }] },
		],
	};
	const payloadMessages = [...payload.messages];
	const payloadBefore = structuredClone(payload);
	assert.deepEqual(emit({ type: "before_provider_request", payload }), [undefined]);

	await flush();
	assert.deepEqual(messages, messagesBefore);
	assert.ok(messages.every((message, index) => message === originals[index]), "no message is replaced");
	assert.deepEqual(payload, payloadBefore);
	assert.ok(payload.messages.every((message, index) => message === payloadMessages[index]),
		"no payload message is replaced");
	// The deferred comparison ran on copies
	const latest = snapshots.latest();
	assert.equal(latest?.changes.conversation[0]?.type, "added");
	assert.deepEqual(latest?.guard, {
		status: "complete", dispatch: { provider: "mock", api: "openai-completions", model: "text" },
		findings: [{ type: "late-edit", change: "added", part: "user", lines: [{ type: "added", text: "late note" }] }],
	});
});
