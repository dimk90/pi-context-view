/**
 * Content-only message previews: what the model receives, without envelope
 * metadata, raw image payloads, or opaque provider signatures.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import { messagePreview } from "../src/message-preview.ts";

test("assistant previews omit opaque signatures but keep same-named tool arguments", () => {
	const message = {
		role: "assistant",
		content: [
			{ type: "text", text: "visible answer", textSignature: "OPAQUE_TEXT_SENTINEL" },
			{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "OPAQUE_THINKING_SENTINEL" },
			{
				type: "toolCall", id: "call-1", name: "read",
				arguments: {
					path: "example.txt",
					textSignature: "text argument data",
					thinkingSignature: "argument data",
					thoughtSignature: "more argument data",
				},
				thoughtSignature: "OPAQUE_THOUGHT_SENTINEL",
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 8,
	} satisfies ContextEvent["messages"][number];
	const original = structuredClone(message);

	const preview = messagePreview(message);

	assert.deepEqual(preview.jsonSpan, { start: 0, end: preview.text.length });
	assert.deepEqual(JSON.parse(preview.text), [
		{ type: "text", text: "visible answer" },
		{ type: "thinking", thinking: "visible reasoning" },
		{
			type: "toolCall", id: "call-1", name: "read",
			arguments: {
				path: "example.txt",
				textSignature: "text argument data",
				thinkingSignature: "argument data",
				thoughtSignature: "more argument data",
			},
		},
	]);
	assert.doesNotMatch(preview.text, /OPAQUE_(TEXT|THINKING|THOUGHT)_SENTINEL/);
	assert.deepEqual(message, original);
});

test("session image previews report sizes; redacted request images keep their markers", () => {
	const payload = "B".repeat(2_048);
	const imageUser = {
		role: "user",
		content: [
			{ type: "text", text: "look at this" },
			{ type: "image", data: payload, mimeType: "image/png" },
		],
		timestamp: 1,
	} satisfies ContextEvent["messages"][number];
	const imageToolResult = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "screenshot",
		content: [{ type: "image", data: "tiny", mimeType: "image/jpeg" }],
		isError: false,
		timestamp: 2,
	} satisfies ContextEvent["messages"][number];
	const original = structuredClone([imageUser, imageToolResult]);

	assert.deepEqual(JSON.parse(messagePreview(imageUser).text), [
		{ type: "text", text: "look at this" },
		{ type: "image", data: "<2.0KB omitted>", mimeType: "image/png" },
	]);
	assert.deepEqual(JSON.parse(messagePreview(imageToolResult).text), [
		{ type: "image", data: "<4B omitted>", mimeType: "image/jpeg" },
	]);
	const redacted = {
		...imageToolResult,
		content: [{ type: "image", data: "<4B omitted>", mimeType: "image/jpeg" }],
	} satisfies ContextEvent["messages"][number];
	assert.deepEqual(JSON.parse(messagePreview(redacted, true).text), redacted.content);
	assert.deepEqual([imageUser, imageToolResult], original);
});

test("string content is plain text; block content is marked JSON", () => {
	assert.deepEqual(messagePreview({ role: "user", content: "injected", timestamp: 1 }), { text: "injected" });
	const blocks = messagePreview({ role: "user", content: [{ type: "text", text: "injected" }], timestamp: 2 });
	assert.equal(blocks.text, '[{"type":"text","text":"injected"}]');
	assert.deepEqual(blocks.jsonSpan, { start: 0, end: blocks.text.length });
});

test("summary previews omit envelope metadata without changing the content", () => {
	const messages = [
		{
			role: "compactionSummary", summary: "We fixed image previews.\nNext: update the tests.",
			tokensBefore: 42_000, timestamp: 1_700_000_000_000,
		},
		{
			role: "branchSummary", summary: '{"fromId":"actual summary content"}',
			fromId: "INTERNAL_BRANCH_ID", timestamp: 1_700_000_000_001,
		},
	] satisfies ContextEvent["messages"];

	for (const message of messages) {
		assert.deepEqual(messagePreview(message), { text: message.summary });
	}
});

test("bash previews use provider-facing text instead of message metadata", () => {
	const base = {
		role: "bashExecution", command: "ls", output: "example.txt", exitCode: 0,
		cancelled: false, truncated: false, fullOutputPath: "/tmp/full-output.txt", timestamp: 1,
	} satisfies ContextEvent["messages"][number];
	const messages = [
		base,
		{ ...base, output: "", timestamp: 2 },
		{ ...base, output: "failed", exitCode: 2, timestamp: 3 },
		{ ...base, output: "partial", exitCode: undefined, cancelled: true, timestamp: 4 },
		{ ...base, truncated: true, timestamp: 5 },
		{ ...base, excludeFromContext: true, timestamp: 6 },
	];

	assert.deepEqual(messages.map((message) => messagePreview(message)), [
		{ text: "Ran `ls`\n```\nexample.txt\n```" },
		{ text: "Ran `ls`\n(no output)" },
		{ text: "Ran `ls`\n```\nfailed\n```\n\nCommand exited with code 2" },
		{ text: "Ran `ls`\n```\npartial\n```\n\n(command cancelled)" },
		{ text: "Ran `ls`\n```\nexample.txt\n```\n\n[Output truncated. Full output: /tmp/full-output.txt]" },
		{ text: "" },
	]);
});

test("system previews include section content and omit opaque text signatures", () => {
	const message = {
		role: "system", content: [{ type: "text", text: "", textSignature: "OPAQUE_SYSTEM_SIGNATURE" }],
		sections: { review: "<review>\nSection-only instructions\n</review>", rules: null }, timestamp: 1,
	} satisfies ContextEvent["messages"][number];

	assert.deepEqual(messagePreview(message), { text: "<review>\nSection-only instructions\n</review>" });
});
