/** Regression coverage for #6 through capture, diff, projection application, and Usage. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { buildRequestSnapshot } from "../src/capture/builder.ts";
import { captureRequest } from "../src/capture/request.ts";
import { applyRequestSnapshot } from "../src/projection.ts";
import { buildUsageSnapshot } from "../src/replay.ts";
import type { RequestMessage, RequestSnapshot } from "../src/snapshot.ts";
import { collectPreviewEntries, computeUsage } from "../src/usage.ts";

/** A plain user message, as in the issue's reproduction. */
function user(content: string, timestamp = 7) {
	return { role: "user" as const, content, timestamp };
}

/** Capture a transformed request against the session, using the production differ and builder. */
function capture(session: SessionManager, messages: RequestMessage[]): RequestSnapshot {
	return buildRequestSnapshot(captureRequest({
		id: 1, origin: "real-turn", sessionManager: session, messages,
		effectivePrompt: getCurrentSystemPrompt(session.buildSessionProjection().messages),
		probe: { filterMessages: (projected) => projected },
	}), { status: "incomplete", reason: "No provider payload in this unit test." });
}

/** Apply the snapshot and estimate Usage, with no fallback prompt or tool contributions. */
function usage(session: SessionManager, snapshot?: RequestSnapshot): ReturnType<typeof computeUsage> {
	const applied = applyRequestSnapshot({
		snapshot, entries: session.getEntries(), leafId: session.getLeafId(),
		filterMessages: (messages) => messages,
	});
	return computeUsage({
		messages: applied.messages,
		snapshot: buildUsageSnapshot({
			...applied, systemPrompt: "", options: { cwd: "/tmp/project" }, allTools: [], activeToolNames: [],
		}),
	});
}

test("#6: replacing a 40,000-character user message with bbbb counts 1 token, not 10,001", () => {
	const session = SessionManager.inMemory("/tmp/project");
	const original = user("a".repeat(40_000));
	const entryId = session.appendMessage(original);
	const replacement = { ...original, content: "bbbb" };
	const snapshot = capture(session, [replacement]);
	assert.deepEqual(snapshot.changes.conversation, [
		{ type: "modified", entryId, message: replacement, attribution: {} },
	]);
	assert.equal(usage(session).estimatedTokens, 10_000, "the session still holds the original");
	const observed = usage(session, snapshot);
	assert.equal(observed.estimatedTokens, 1);
	assert.deepEqual(observed.categories.flatMap(collectPreviewEntries).map((entry) => entry.text), ["bbbb"]);
});

test("#6: a removed user message contributes neither tokens nor a preview", () => {
	const session = SessionManager.inMemory("/tmp/project");
	const entryId = session.appendMessage(user("a".repeat(40_000)));
	const kept = user("keep", 8);
	session.appendMessage(kept);
	const snapshot = capture(session, [kept]);
	assert.deepEqual(snapshot.changes.conversation, [{ type: "deleted", entryId, attribution: {} }]);
	const observed = usage(session, snapshot);
	assert.equal(observed.estimatedTokens, 1);
	assert.deepEqual(observed.categories.flatMap(collectPreviewEntries).map((entry) => entry.text), ["keep"]);
});

test("#6: a reorder is a deletion plus an addition and each message counts once", () => {
	const session = SessionManager.inMemory("/tmp/project");
	const messages = [user("a".repeat(40_000)), user("keep", 8), user("last", 9)];
	for (const message of messages) session.appendMessage(message);
	const snapshot = capture(session, [messages[1], messages[2], messages[0]]);
	assert.deepEqual(snapshot.changes.conversation.map((change) => change.type).sort(), ["added", "deleted"]);
	const observed = usage(session, snapshot);
	assert.equal(observed.estimatedTokens, 10_002);
	assert.deepEqual(observed.categories.flatMap(collectPreviewEntries).map((entry) => entry.text),
		messages.map((message) => message.content), "previews contain each message once, ordered by timestamp");
});

for (const navigation of ["branch", "compaction"] as const) {
	test(`#6: a stale modification after ${navigation} is dropped and current messages count`, () => {
		const session = SessionManager.inMemory("/tmp/project");
		const root = session.appendMessage(user("root", 1));
		const original = user("a".repeat(40_000));
		const entryId = session.appendMessage(original);
		const current = user("current message", 8);
		const currentId = session.appendMessage(current);
		const snapshot = capture(session, [user("root", 1), { ...original, content: "bbbb" }, current]);
		assert.deepEqual(snapshot.changes.conversation.map((change) => [change.type, "entryId" in change && change.entryId]),
			[["modified", entryId]]);
		if (navigation === "branch") {
			session.branch(root);
			// Identical text at a different entry must not inherit the old entry's replacement
			session.appendMessage(original);
		} else {
			session.appendCompaction("Summary", currentId, 10_005);
		}
		const observed = usage(session, snapshot);
		assert.deepEqual(observed.categories, usage(session).categories);
		const texts = observed.categories.flatMap(collectPreviewEntries).map((entry) => entry.text);
		assert.ok(!texts.includes("bbbb"));
		assert.ok(texts.includes(navigation === "branch" ? original.content : current.content));
		if (navigation === "branch") assert.equal(observed.estimatedTokens, 10_001);
	});
}
