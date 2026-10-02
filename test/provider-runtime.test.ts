import assert from "node:assert/strict";
import { test } from "node:test";

import type {
	BeforeAgentStartEvent,
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

// Deep import bypasses the package barrel, which does not re-export the option normalizer.
import {
	normalizeBuildSystemPromptOptions,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { measureInjectedMessages } from "../src/capture.ts";
import {
	providerMessagesToAgentMessages,
	providerToAgentMessage,
} from "../src/provider-payload.ts";
import registerExtension from "../src/index.ts";

/**
 * Runtime simulation: pcv's `before_provider_request` handler sees pi-ide's
 * editor-context injection as a converted provider-format user message (the
 * customType is gone, but the text payload is intact). The point of this test
 * is to lock in the order-independent contract: any injection that reaches the
 * provider payload will be visible to `/context injections`, regardless of where
 * pcv sits in any chain.
 */
test("runtime simulation: before_provider_request freeze sees pi-ide's editor-context injection", () => {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, handler);
		},
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
			timestamp: "2026-09-26T17:00:00Z",
			message: { role: "user", content: "我选择中的文本是什么", timestamp: 1 },
		},
	];
	let sessionReads = 0;
	const ctx = {
		getSystemPrompt: () => "you are pi",
		sessionManager: {
			getEntries: () => {
				sessionReads += 1;
				return entries;
			},
			getLeafId: () => "1",
		},
	} as unknown as ExtensionContext;

	registerExtension(pi);
	const start = handlers.get("session_start") as (event: unknown, ctx: unknown) => unknown;
	const agentStart = handlers.get("before_agent_start") as (
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
	) => unknown;
	const beforeProviderRequest = handlers.get("before_provider_request") as (
		event: BeforeProviderRequestEvent,
		ctx: ExtensionContext,
	) => unknown;

	start({ type: "session_start", reason: "new" }, ctx);
	agentStart(
		{
			type: "before_agent_start",
			prompt: "我选择中的文本是什么",
			systemPrompt: "you are pi",
			systemPromptOptions: normalizeBuildSystemPromptOptions({ cwd: "/tmp" }),
		},
		ctx,
	);
	assert.equal(sessionReads, 1, "session_start + before_agent_start build the baseline once");

	// Provider payload mirrors what convertToLlm emits after every chain step:
	// pi-ide's `custom` is folded into a `user` message with text-block content.
	const providerPayload = {
		system: "you are pi",
		messages: [
			{ role: "user", content: "我选择中的文本是什么" },
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "<editor>todo.md</editor>\n<selection>提示词和acp</selection>",
					},
				],
			},
		],
	};

	const result = beforeProviderRequest(
		{ type: "before_provider_request", payload: providerPayload },
		ctx,
	);
	assert.equal(result, undefined, "before_provider_request must not mutate the payload");
	assert.equal(sessionReads, 2, "before_provider_request builds the session baseline");

	// Now verify the snapshot's measureInjectedMessages classifies the IDE
	// injection as request-only — i.e. it shows up in `/context injections`.
	const snapshotMessages = providerMessagesToAgentMessages(providerPayload.messages);
	const baselineMessages = entries
		.map((e) => (e.type === "message" ? e.message : null))
		.filter((m): m is NonNullable<typeof m> => m !== null);
	const injections = measureInjectedMessages(snapshotMessages, baselineMessages);

	const ideInjection = injections.find(
		(item) => item.text.includes("提示词和acp"),
	);
	assert.ok(
		ideInjection,
		`measureInjectedMessages must classify pi-ide's editor-context as an injection; got: ${JSON.stringify(
			injections.map((i) => ({ id: i.id, label: i.label, chars: i.chars })),
		)}`,
	);
	assert.equal(ideInjection.requestOnly, true, "IDE injection is not in baseline → requestOnly");
	assert.ok(
		ideInjection.text.includes("提示词和acp"),
		"Injection text must contain the original selection",
	);
});

/**
 * Unit tests for the provider→AgentMessage converter.
 */
test("providerToAgentMessage: user message with text-block content flattens to a string", () => {
	const result = providerToAgentMessage({
		role: "user",
		content: [{ type: "text", text: "hello world" }],
	});
	assert.equal(result.role, "user");
	assert.equal(result.content, "hello world");
});

test("providerToAgentMessage: user message with mixed content preserves non-text blocks", () => {
	const result = providerToAgentMessage({
		role: "user",
		content: [
			{ type: "text", text: "look at this image" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
		],
	});
	assert.equal(result.role, "user");
	if (typeof result.content === "string") {
		assert.fail("mixed content should not collapse to a string");
	} else {
		assert.equal(result.content.length, 2);
	}
});

test("providerToAgentMessage: assistant content blocks round-trip with timestamp", () => {
	const result = providerToAgentMessage({
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		stop_reason: "stop",
		timestamp: 42,
	});
	assert.equal(result.role, "assistant");
	assert.equal(result.timestamp, 42);
	assert.equal(result.stopReason, "stop");
});

test("providerToAgentMessage: system content as text blocks flattens to string", () => {
	const result = providerToAgentMessage({
		role: "system",
		content: [{ type: "text", text: "you are pi" }],
	});
	assert.equal(result.role, "system");
	assert.equal(result.content, "you are pi");
});

test("providerToAgentMessage: unknown role passes through with timestamp", () => {
	const toolResult = {
		role: "toolResult",
		toolCallId: "call-1",
		content: [{ type: "text", text: "result" }],
		timestamp: 99,
	};
	const result = providerToAgentMessage(toolResult);
	assert.equal(result.role, "toolResult");
	assert.equal(result.timestamp, 99);
});