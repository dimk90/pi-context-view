/** The payload guard's message channel: unit comparison and Pi's adjustments, without a runtime. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { SystemMessage, Tool } from "@earendil-works/pi-ai";

import { type ConvertibleCapture, convertCapturedRequest, renderExpectedUnits } from "../src/capture/adjustments.ts";
import type { GuardModel } from "../src/capture/guard.ts";
import { compareMessageUnits, diffLines, type MessageUnit } from "../src/capture/messages.ts";
import { copyRequest } from "../src/capture/request.ts";
import type { RequestMessage } from "../src/snapshot.ts";

const VISION: GuardModel = { provider: "mock", api: "openai-completions", id: "vision", input: ["text", "image"] };
const TEXT: GuardModel = { ...VISION, id: "text", input: ["text"] };
const EXACT = { ignoreNameCase: false };
const IMAGE = { type: "image" as const, data: "PRIVATE_IMAGE_BYTES", mimeType: "image/png" };
const LEADING: SystemMessage = {
	role: "system", content: "", sections: { preamble: "Base.", cwd: "<cwd>/a</cwd>" }, timestamp: 0,
};

/** A unit of `part` with `text`. */
function unit(part: MessageUnit["part"], text: string, name?: string): MessageUnit {
	return name === undefined ? { part, text } : { part, text, name };
}

/** A capture of `messages` with no request-only change, as the monitor would copy it. */
function capture(messages: readonly RequestMessage[], forcedPrompt?: string): ConvertibleCapture {
	const baseline = messages.map((message, index) => ({ entryId: `e${index}`, message }));
	return {
		baseline: { messages: baseline }, ...copyRequest(baseline, messages),
		...(forcedPrompt === undefined ? {} : { forcedPrompt }),
	};
}

/** Expected units of `messages` for `model`. */
function expected(messages: readonly RequestMessage[], model: GuardModel, blockImages = false): MessageUnit[] {
	return renderExpectedUnits(convertCapturedRequest(capture(messages), { blockImages }), model);
}

/** A user message with text and image blocks. */
function user(...content: Array<string | typeof IMAGE>): RequestMessage {
	return {
		role: "user", timestamp: 1,
		content: content.map((block) => typeof block === "string" ? { type: "text" as const, text: block } : block),
	};
}

// ============================================================================
// Comparison
// ============================================================================

test("whitespace and unpaired surrogates do not make units differ", () => {
	assert.deepEqual(compareMessageUnits([unit("user", "a b\nc")], [unit("user", "ab  c")], EXACT), []);
	assert.deepEqual(compareMessageUnits([unit("user", "x\uD800y")], [unit("user", "xy")], EXACT), []);
});

test("empty text units are skipped as Pi skips them, but an empty tool result counts", () => {
	const before = [unit("assistant", "  \n"), unit("tool-result", "")];
	assert.deepEqual(compareMessageUnits(before, [unit("tool-result", "")], EXACT), []);
	assert.deepEqual(compareMessageUnits(before, [], EXACT),
		[{ type: "payload-change", change: "deleted", part: "tool-result", lines: [] }]);
});

test("findings report deleted, modified, and added units with only the differing lines", () => {
	const before = [unit("system", "a\nb\nc"), unit("user", "first"), unit("user", "second")];
	const after = [unit("system", "a\nB\n\nc"), unit("user", "second"), unit("user", "new — 新")];
	assert.deepEqual(compareMessageUnits(before, after, EXACT), [
		{ type: "payload-change", change: "deleted", part: "user", lines: [{ type: "removed", text: "first" }] },
		{ type: "payload-change", change: "modified", part: "system", lines: [
			{ type: "removed", text: "b" }, { type: "added", text: "B" },
		] },
		{ type: "payload-change", change: "added", part: "user", lines: [{ type: "added", text: "new — 新" }] },
	]);
});

test("a moved unit is a deletion plus an addition, never a modification", () => {
	const [first, reply, second] = [unit("user", "one"), unit("assistant", "ok"), unit("user", "two")];
	assert.deepEqual(compareMessageUnits([first, reply, second], [second, first, reply], EXACT), [
		{ type: "payload-change", change: "added", part: "user", lines: [{ type: "added", text: "two" }] },
		{ type: "payload-change", change: "deleted", part: "user", lines: [{ type: "removed", text: "two" }] },
	]);
});

test("tool-call names match without case only when asked, as for Anthropic OAuth names", () => {
	const before = [unit("tool-call", "{}", "read")];
	const after = [unit("tool-call", "{}", "Read")];
	assert.deepEqual(compareMessageUnits(before, after, { ignoreNameCase: true }), []);
	assert.deepEqual(compareMessageUnits(before, after, EXACT), [{
		type: "payload-change", change: "modified", part: "tool-call",
		lines: [{ type: "removed", text: "read {}" }, { type: "added", text: "Read {}" }],
	}]);
});

test("line diffs ignore whitespace and blank lines, and report regrouped lines", () => {
	assert.deepEqual(diffLines("a b\n\nc", "ab\n  c"), []);
	assert.deepEqual(diffLines("a\n\nb\nc", "a\n  b\nc\nd"), [{ type: "added", text: "d" }]);
	assert.deepEqual(diffLines("ab\ncd", "a\nbcd"), [
		{ type: "removed", text: "ab" }, { type: "removed", text: "cd" },
		{ type: "added", text: "a" }, { type: "added", text: "bcd" },
	]);
});

// ============================================================================
// Pi's adjustments
// ============================================================================

test("image placeholders are Pi's only for a model without image input", () => {
	const messages = [LEADING, user("look", IMAGE, IMAGE)];
	const sent = [
		unit("system", "Base.\n\n<cwd>/a</cwd>"), unit("user", "look\n(image omitted: model does not support images)"),
	];
	assert.deepEqual(compareMessageUnits(expected(messages, TEXT), sent, EXACT), []);
	assert.deepEqual(compareMessageUnits(expected(messages, VISION), sent, EXACT), [{
		type: "payload-change", change: "modified", part: "user",
		lines: [{ type: "added", text: "(image omitted: model does not support images)" }],
	}]);
	const converted = convertCapturedRequest(capture(messages), { blockImages: false });
	assert.doesNotMatch(JSON.stringify(converted), /PRIVATE_IMAGE/);
});

test("blocked-image text is Pi's only while the setting is on", () => {
	const messages = [LEADING, user("look", IMAGE, IMAGE)];
	const sent = [unit("system", "Base.\n\n<cwd>/a</cwd>"), unit("user", "look\nImage reading is disabled.")];
	assert.deepEqual(compareMessageUnits(expected(messages, VISION, true), sent, EXACT), []);
	assert.equal(compareMessageUnits(expected(messages, VISION, false), sent, EXACT).length, 1);
});

test("system messages render at their positions, collapse without support, and yield to a forced prompt", () => {
	const later: SystemMessage = { role: "system", content: "", sections: { cwd: "<cwd>/b</cwd>" }, timestamp: 2 };
	const messages = [LEADING, user("one"), later, user("two")];
	const keeps = { ...VISION, compat: { supportsMidConvoSystemMessages: true } };
	assert.deepEqual(expected(messages, keeps), [
		unit("system", "Base.\n\n<cwd>/a</cwd>"),
		unit("user", "one"),
		unit("system", "Updated system prompt section \"cwd\":\n\n<cwd>/b</cwd>"),
		unit("user", "two"),
	]);
	assert.deepEqual(expected(messages, VISION), [
		unit("system", "Base.\n\n<cwd>/b</cwd>"), unit("user", "one"), unit("user", "two"),
	]);
	const converted = convertCapturedRequest(capture(messages, "Forced."), { blockImages: false });
	const forced = renderExpectedUnits(converted, keeps);
	assert.deepEqual(forced, [unit("system", "Forced."), unit("user", "one"), unit("user", "two")]);
});

test("another model's thinking becomes text; the same model's thinking stays out of the message channel", () => {
	const reply = (model: string): RequestMessage => ({
		role: "assistant", provider: "mock", api: "openai-completions", model, stopReason: "stop", timestamp: 3,
		content: [
			{ type: "thinking", thinking: "Reasoning.", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "Answer." },
		],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	assert.deepEqual(expected([user("q"), reply("vision")], VISION).at(-1), unit("assistant", "Answer."));
	assert.deepEqual(expected([user("q"), reply("other")], VISION).at(-1), unit("assistant", "Reasoning.Answer."));
});

test("Pi's own conversion runs on the rebuilt request: custom, bash, and summary messages become user text", () => {
	const messages: RequestMessage[] = [
		{ role: "custom", customType: "note", content: "Note.", display: true, timestamp: 1 },
		{ role: "bashExecution", command: "ls", output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: 2 },
		{
			role: "bashExecution", command: "env", output: "SECRET", exitCode: 0, cancelled: false, truncated: false,
			excludeFromContext: true, timestamp: 3,
		},
		{ role: "compactionSummary", summary: "Summary.", tokensBefore: 10, timestamp: 4 },
	];
	const texts = expected(messages, VISION).map((item) => item.text);
	assert.equal(texts.length, 3);
	assert.equal(texts[0], "Note.");
	assert.equal(texts[1], "Ran `ls`\n(no output)");
	assert.match(texts[2], /<summary>\nSummary\.\n<\/summary>/);
});

test("grammar calls use declarations from the captured request, not removed baseline history", () => {
	const grammarTool: Tool = {
		name: "script", description: "Run code.",
		parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
		constrainedSampling: { type: "grammar", variants: { openai_regex: ".*" } },
	};
	const declared: SystemMessage = { ...LEADING, toolsAdded: [grammarTool] };
	const removed: SystemMessage = { role: "system", content: "", toolsRemoved: [{ name: "script" }], timestamp: 1 };
	const baseline = [declared, removed].map((message, index) => ({ entryId: `e${index}`, message }));
	// A context handler collapsed the system history; the old grammar no longer reaches the adapter
	const copied: ConvertibleCapture = { baseline: { messages: baseline }, ...copyRequest(baseline, [LEADING]) };
	assert.deepEqual([...convertCapturedRequest(copied, { blockImages: false }).grammarInputs.declared], []);

	// A request-only grammar declaration can also be removed later, but its history still counts
	const added = { baseline: { messages: [] }, ...copyRequest([], [declared, removed]) };
	const converted = convertCapturedRequest(added, { blockImages: false });
	assert.deepEqual([...converted.grammarInputs.declared], [["script", "code"]]);
});

test("a capture with copied middle messages rebuilds the request between the baseline ends", () => {
	const baseline = [LEADING, user("one"), user("two"), user("three")]
		.map((message, index) => ({ entryId: `e${index}`, message }));
	const request = [LEADING, user("one"), user("TWO"), user("extra"), user("three")];
	const copied: ConvertibleCapture = { baseline: { messages: baseline }, ...copyRequest(baseline, request) };
	const converted = convertCapturedRequest(copied, { blockImages: false });
	const content = converted.messages.map((message) => message.role === "user" ? message.content : message.role);
	assert.deepEqual(content, [
		"system", ...["one", "TWO", "extra", "three"].map((text) => [{ type: "text", text }]),
	]);
});
