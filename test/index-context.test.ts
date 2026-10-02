import assert from "node:assert/strict";
import { test } from "node:test";

import type {
	BeforeAgentStartEvent,
	BeforeProviderRequestEvent,
	ContextEvent,
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

/** Custom message fixture for context events (Phase 2 injection, e.g. pi-ide). */
function customMessage(
	customType: string,
	content: string,
	timestamp: number,
): ContextEvent["messages"][number] {
	return { role: "custom", customType, content, display: false, timestamp } satisfies
		ContextEvent["messages"][number];
}

test("Phase 1 context handler filters probe identities and freezes the snapshot", () => {
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
	const context = handlers.get("context") as (
		event: ContextEvent,
		ctx: ExtensionContext,
	) => { messages?: ContextEvent["messages"] } | undefined;

	// Rehydrate the persisted probe identity, then prepare the first real run.
	start({ type: "session_start", reason: "resume" }, ctx);
	agentStart(
		{
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "system prompt",
			systemPromptOptions: normalizeBuildSystemPromptOptions({ cwd: "/tmp" }),
		},
		ctx,
	);
	assert.equal(sessionReads, 1, "session_start + before_agent_start build the baseline once");

	// Phase 1 (`context`) filters probe identities AND freezes the snapshot so
	// silent-probe turns (which are aborted before before_provider_request) still
	// capture a usable snapshot.
	const first = context({ type: "context", messages: [probeUser, userMessage("hello", 1)] }, ctx);
	assert.deepEqual(first, { messages: [userMessage("hello", 1)] }, "Phase 1 returns filtered messages");
	assert.equal(sessionReads, 2, "Phase 1 freezes and rebuilds the session baseline");

	const second = context({ type: "context", messages: [probeUser, userMessage("again", 2)] }, ctx);
	assert.deepEqual(second, { messages: [userMessage("again", 2)] });
	assert.equal(sessionReads, 3, "Phase 1 rebuilds the baseline on every freeze");
	assert.ok(handlers.has("before_provider_request"), "before_provider_request handler must be registered");
});

test("before_provider_request freezes the snapshot from the final provider payload", () => {
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

	const entries: SessionEntry[] = [
		{
			type: "message",
			id: "1",
			parentId: null,
			timestamp: "2026-08-22T10:00:00Z",
			message: userMessage("hello", 1),
		},
	];
	let sessionReads = 0;
	const ctx = {
		getSystemPrompt: () => "system prompt fallback",
		sessionManager: {
			getEntries: () => {
				sessionReads += 1;
				return entries;
			},
			getLeafId: () => "1",
		},
	} as unknown as ExtensionContext;

	registerExtension(pi);
	const start = handlers.get("session_start") as (event: SessionStartEvent, ctx: ExtensionContext) => unknown;
	const agentStart = handlers.get("before_agent_start") as (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown;
	const beforeProviderRequest = handlers.get("before_provider_request") as (
		event: BeforeProviderRequestEvent,
		ctx: ExtensionContext,
	) => unknown;

	start({ type: "session_start", reason: "new" }, ctx);
	agentStart(
		{
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "system prompt",
			systemPromptOptions: normalizeBuildSystemPromptOptions({ cwd: "/tmp" }),
		},
		ctx,
	);
	assert.equal(sessionReads, 1, "session_start + before_agent_start build the baseline once");

	// Provider-payload messages mirror what `convertToLlm` produces after every
	// chain step: pi-ide's editor-context has already been folded into a `user`
	// message with text-block content (customType is gone — that is the trade-off
	// for the order-independent freeze).
	const providerPayload = {
		system: "you are pi",
		messages: [
			{ role: "user", content: "hello" },
			{
				role: "user",
				content: [{ type: "text", text: "<editor>todo.md</editor><selection>foo</selection>" }],
			},
		],
	};

	const result = beforeProviderRequest(
		{ type: "before_provider_request", payload: providerPayload },
		ctx,
	);
	assert.equal(sessionReads, 2, "before_provider_request builds the session baseline");
	// Order-independent freeze must NOT mutate the payload — the runner passes
	// the same payload to the next handler.
	assert.equal(result, undefined, "before_provider_request does not mutate the payload");
});