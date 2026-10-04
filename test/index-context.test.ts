import assert from "node:assert/strict";
import { test } from "node:test";

import {
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

/** User message fixture for context events. */
function userMessage(content: string, timestamp: number): ContextEvent["messages"][number] {
	return { role: "user", content, timestamp } satisfies ContextEvent["messages"][number];
}

test("only context_with_system observes requests: the filter returns a result, capture reads the baseline once", () => {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, [...handlers.get(event) ?? [], handler]);
		},
		// Not triggered by the events exercised below.
		appendEntry: () => undefined,
		registerCommand: () => undefined,
		getAllTools: () => [],
		getActiveTools: () => [],
		getCommands: () => [],
	} as unknown as ExtensionAPI;

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

	registerExtension(pi);
	/** Run every handler the extension registered for one event, in order; return the last defined result. */
	function emit(event: SessionStartEvent | ContextWithSystemEvent): unknown {
		let result: unknown;
		for (const handler of handlers.get(event.type) ?? []) result = handler(event, ctx) ?? result;
		return result;
	}

	// Rehydrate the persisted probe identity.
	emit({ type: "session_start", reason: "resume" });
	assert.equal(sessionReads, 1);
	assert.equal(handlers.has("context"), false, "no handler observes the conversation-only context event");

	const system = { role: "system", content: "base", timestamp: 20 } satisfies ContextEvent["messages"][number];
	const patch = { role: "system", content: "patch", timestamp: 21 } satisfies ContextEvent["messages"][number];
	const realUser = userMessage("hello", 1);
	const full = [system, probeUser, realUser, patch];
	assert.deepEqual(emit({ type: "context_with_system", messages: full }), {
		messages: [system, realUser, patch],
	});
	assert.deepEqual(full, [system, probeUser, realUser, patch], "filter never mutates the input");
	assert.equal(sessionReads, 2, "structured capture reads the baseline of each request");
	assert.equal(emit({ type: "context_with_system", messages: [system, realUser, patch] }), undefined);
	assert.equal(sessionReads, 3);
});