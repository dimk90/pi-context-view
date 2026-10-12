/** Message parts use branch-wide prompt numbers and keep redacted comparison text without double counting. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { buildInjectionsSnapshot, type InjectionsInput } from "../src/injections.ts";
import type { ConversationChange, RequestMessage } from "../src/snapshot.ts";

/** Capture the current leaf with no live tools or prompt material. */
function input(session: SessionManager, conversation: ConversationChange[] = []): InjectionsInput {
	return {
		snapshot: { id: 1, origin: "real-turn", leafId: session.getLeafId(), changes: { system: [], conversation },
			guard: { status: "pending" } },
		entries: session.getEntries(), filterMessages: (messages) => messages,
		options: { cwd: "/tmp" }, systemPrompt: "", allTools: [], activeToolNames: [],
	};
}

/** One genuine prompt or a synthetic probe, distinguished by timestamp in the test's filter. */
function user(content: string, timestamp = 1): Extract<RequestMessage, { role: "user" }> {
	return { role: "user", content, timestamp };
}

/** Find the composition's only messages row. */
function messages(input: InjectionsInput) {
	return buildInjectionsSnapshot(input).groups.flatMap((group) => group.items).find((item) => item.kind === "message");
}

test("message prompt numbers survive compaction and saved context omissions", () => {
	const session = SessionManager.inMemory("/tmp");
	session.appendCustomMessageEntry("before", "before any prompt", false);
	const first = session.appendMessage(user("first"));
	session.appendCustomMessageEntry("first-note", "first note", false);
	const second = session.appendMessage(user("second", 2));
	session.appendCustomMessageEntry("second-note", "second note", false);
	assert.deepEqual(messages(input(session))?.sections?.map((part) => [part.label, part.message?.userPrompt]), [
		["before", undefined], ["first-note", 1], ["second-note", 2],
	]);
	session.appendContextEdit(first, null);
	assert.equal(messages(input(session))?.sections?.at(-1)?.message?.userPrompt, 2,
		"omitting a genuine prompt from context does not renumber the branch");
	session.appendCompaction("summary", second, 1_000);
	const additions: ConversationChange[] = [{ type: "added", message: user("request only", 3), attribution: {} }];
	const row = messages(input(session, additions));
	assert.deepEqual(row?.sections?.map((part) => [part.label, part.message?.userPrompt]), [["second-note", 2], ["user", 2]]);
	assert.equal(row?.label, "messages (2)");
});

test("numbers follow the captured branch and leaf, excluding probe prompts", () => {
	const session = SessionManager.inMemory("/tmp");
	const first = session.appendMessage(user("first"));
	session.appendMessage(user("abandoned second", 2));
	session.appendMessage(user("abandoned third", 3));
	session.branch(first);
	session.appendMessage(user("probe", 99));
	const second = session.appendMessage(user("real second", 4));
	session.appendCustomMessageEntry("note", "after second", false);
	const captured = input(session, [
		{ type: "deleted", entryId: first, attribution: {} },
		{ type: "modified", entryId: second, message: user("edited", 4), attribution: {} },
		{ type: "added", message: user("request-only user", 5), attribution: {} },
	]);
	session.appendMessage(user("later third", 6));
	const row = messages({ ...captured, entries: session.getEntries(),
		filterMessages: (messages) => messages.filter((message) => message.timestamp !== 99) });
	assert.deepEqual(row?.sections?.map((part) => [part.label, part.message?.userPrompt]), [
		["user", 1], ["user", 2], ["note", 2], ["user", 2],
	]);
	assert.equal(row?.label, "messages (3)", "deleted messages retain their number but are not sent");
	assert.equal(row?.sections?.[1]?.message?.original?.text, "real second");
});

test("a probe before the first genuine prompt and an empty branch have no prompt number", () => {
	const session = SessionManager.inMemory("/tmp");
	const conversation: ConversationChange[] = [{ type: "added", message: user("addition"), attribution: {} }];
	assert.equal(messages(input(session, conversation))?.sections?.[0]?.message?.userPrompt, undefined);
	session.appendMessage(user("probe", 99));
	const captured = input(session, conversation);
	const row = messages({ ...captured, filterMessages: (messages) => messages.filter((message) => message.timestamp !== 99) });
	assert.equal(row?.sections?.[0]?.message?.userPrompt, undefined);
});

test("modified assistant parts retain only content on both sides, without signatures", () => {
	const session = SessionManager.inMemory("/tmp");
	session.appendMessage(user("prompt"));
	const original: RequestMessage = {
		role: "assistant", content: [
			{ type: "text", text: "old answer", textSignature: "OPAQUE_TEXT" },
			{ type: "thinking", thinking: "old thought", thinkingSignature: "OPAQUE_THINKING" },
			{ type: "toolCall", id: "call", name: "read", arguments: { thoughtSignature: "argument data" },
				thoughtSignature: "OPAQUE_TOOL" },
		], api: "anthropic-messages", provider: "anthropic", model: "test", stopReason: "stop", timestamp: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	const entryId = session.appendMessage(original);
	const request: RequestMessage = { ...original, content: [{ type: "text", text: "new answer" }] };
	const row = messages(input(session, [{ type: "modified", entryId, message: request, attribution: {} }]));
	assert.equal(row?.sections?.length, 1);
	const part = row?.sections?.[0];
	assert.equal(part?.message?.userPrompt, 1);
	assert.match(part?.message?.original?.text ?? "", /old answer/);
	assert.match(part?.message?.original?.text ?? "", /argument data/);
	assert.doesNotMatch(JSON.stringify(row), /OPAQUE|timestamp|stopReason/);
	assert.equal(row?.tokens, part?.tokens);
	assert.equal(row?.text, part?.text);
	assert.deepEqual(part?.message?.original?.jsonSpan, { start: 0, end: part?.message?.original?.text.length });
});
