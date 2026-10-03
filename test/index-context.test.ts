import assert from "node:assert/strict";
import { test } from "node:test";

import type {
	BeforeAgentStartEvent,
	ContextEvent,
	ContextWithSystemEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

// Deep import bypasses the package barrel, which does not re-export the option normalizer.
import {
	normalizeBuildSystemPromptOptions,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { PROBE_IDENTITIES_CUSTOM_TYPE } from "../src/capture.ts";
import registerExtension from "../src/index.ts";

/** User message fixture for context events. */
function userMessage(content: string, timestamp: number): ContextEvent["messages"][number] {
	return { role: "user", content, timestamp } satisfies ContextEvent["messages"][number];
}

test("context handler skips the session baseline rebuild after the Initial snapshot freezes", () => {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, handler);
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
			getLeafId: () => "2",
		},
	} as unknown as ExtensionContext;

	registerExtension(pi);
	const start = handlers.get("session_start") as (event: SessionStartEvent, ctx: ExtensionContext) => unknown;
	const agentStart = handlers.get("before_agent_start") as (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown;
	const context = handlers.get("context") as (event: ContextEvent, ctx: ExtensionContext) => void;
	const filter = handlers.get("context_with_system") as (
		event: ContextWithSystemEvent,
		ctx: ExtensionContext,
	) => { messages?: ContextEvent["messages"] } | undefined;

	// Rehydrate the persisted probe identity, then prepare the first real run.
	start({ type: "session_start", reason: "resume" }, ctx);
	agentStart(
		{ type: "before_agent_start", prompt: "hello", systemPrompt: "system prompt",
			systemPromptOptions: normalizeBuildSystemPromptOptions({ cwd: "/tmp" }) },
		ctx,
	);
	assert.equal(sessionReads, 1);

	const messages = [probeUser, userMessage("hello", 1)];
	assert.equal(context({ type: "context", messages }, ctx), undefined);
	assert.equal(sessionReads, 2, "the first context event builds the session baseline");
	assert.deepEqual(messages, [probeUser, userMessage("hello", 1)], "capture does not filter the request");

	assert.equal(context({ type: "context", messages: [probeUser, userMessage("again", 2)] }, ctx), undefined);
	assert.equal(sessionReads, 2, "a frozen snapshot must not rebuild the session baseline");

	const system = { role: "system", content: "base", timestamp: 20 } satisfies ContextEvent["messages"][number];
	const patch = { role: "system", content: "patch", timestamp: 21 } satisfies ContextEvent["messages"][number];
	const realUser = userMessage("hello", 1);
	const full = [system, probeUser, realUser, patch];
	assert.deepEqual(filter({ type: "context_with_system", messages: full }, ctx), {
		messages: [system, realUser, patch],
	});
	assert.deepEqual(full, [system, probeUser, realUser, patch], "filter never mutates the input");
	assert.equal(filter({ type: "context_with_system", messages: [system, realUser, patch] }, ctx), undefined);
	assert.equal(sessionReads, 2, "filtering does not rebuild the baseline");
});