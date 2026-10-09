/**
 * The latest request snapshot applied to the current projection for Usage:
 * conversation changes by baseline entry, and system changes and the forced
 * prompt only while fresh.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Tool } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { type AppliedRequest, applyRequestSnapshot } from "../src/projection.ts";
import type { ConversationChange, RequestMessage, RequestSnapshot, SystemChange } from "../src/snapshot.ts";

const READ: Tool = { name: "read", description: "Read files", parameters: { type: "object", properties: {} } } as Tool;

/** A session with a recorded system state and three user prompts. */
function createSession(): { session: SessionManager; entries: Record<"first" | "second" | "third", string> } {
	const session = SessionManager.inMemory("/tmp/project");
	session.appendMessage({ role: "system", content: "", sections: { cwd: "<cwd>\n/tmp\n</cwd>" },
		toolsAdded: [READ], timestamp: 1 });
	const first = session.appendMessage(user("first", 2));
	const second = session.appendMessage(user("second", 3));
	const third = session.appendMessage(user("third", 4));
	return { session, entries: { first, second, third } };
}

/** A user message as the session or a request carries it. */
function user(content: string, timestamp: number): Extract<RequestMessage, { role: "user" }> {
	return { role: "user", content, timestamp };
}

/** A snapshot taken at the session's current leaf. */
function snapshotAt(
	session: SessionManager,
	conversation: ConversationChange[] = [],
	system: SystemChange[] = [],
): RequestSnapshot {
	return {
		id: 1, origin: "real-turn", capturedAt: 0, leafId: session.getLeafId(),
		changes: { conversation, system },
		guard: { status: "incomplete", reason: "No payload." },
	};
}

/** Apply `snapshot` to the session's current projection without probe messages to filter. */
function apply(session: SessionManager, snapshot: RequestSnapshot | undefined): AppliedRequest {
	return applyRequestSnapshot({
		snapshot,
		entries: session.getEntries(),
		leafId: session.getLeafId(),
		filterMessages: (messages) => messages,
	});
}

/** Contents of the non-system messages, in order. */
function contents(applied: AppliedRequest): unknown[] {
	return applied.messages.filter((message) => message.role !== "system")
		.map((message) => "content" in message ? message.content : message.role);
}

test("without a snapshot, the current projection is used unchanged", () => {
	const { session } = createSession();
	const applied = apply(session, undefined);
	assert.equal(applied.messages[0]?.role, "system");
	assert.deepEqual(contents(applied), ["first", "second", "third"]);
	assert.deepEqual(applied.systemChanges, []);
});

test("conversation changes apply by entry: replace, remove, and append", () => {
	const { session, entries } = createSession();
	const applied = apply(session, snapshotAt(session, [
		{ type: "modified", entryId: entries.first, message: user("bbbb", 2), attribution: {} },
		{ type: "deleted", entryId: entries.second, attribution: {} },
		{ type: "added", message: user("added", 5), attribution: {} },
	]));
	assert.deepEqual(contents(applied), ["bbbb", "third", "added"]);
});

test("a reorder, captured as a deletion plus an addition, counts the message once", () => {
	const { session, entries } = createSession();
	const applied = apply(session, snapshotAt(session, [
		{ type: "deleted", entryId: entries.first, attribution: {} },
		{ type: "added", message: user("first", 2), attribution: {} },
	]));
	assert.deepEqual(contents(applied), ["second", "third", "first"]);
});

test("a change whose entry left the projection is dropped, keeping the current messages", () => {
	const { session, entries } = createSession();
	const snapshot = snapshotAt(session, [
		{ type: "modified", entryId: entries.third, message: user("stale edit", 4), attribution: {} },
		{ type: "deleted", entryId: entries.second, attribution: {} },
	]);
	session.branch(entries.first);
	session.appendMessage(user("other branch", 6));
	assert.deepEqual(contents(apply(session, snapshot)), ["first", "other branch"]);

	const compacted = createSession();
	const beforeCompaction = snapshotAt(compacted.session, [
		{ type: "deleted", entryId: compacted.entries.first, attribution: {} },
	]);
	compacted.session.appendCompaction("Summary", compacted.entries.third, 1_000);
	assert.deepEqual(contents(apply(compacted.session, beforeCompaction)), ["compactionSummary", "third"]);
});

test("probe messages are filtered before the changes apply", () => {
	const { session } = createSession();
	const applied = applyRequestSnapshot({
		snapshot: snapshotAt(session),
		entries: session.getEntries(),
		leafId: session.getLeafId(),
		filterMessages: (messages) =>
			messages.filter((message) => !("content" in message) || message.content !== "second"),
	});
	assert.deepEqual(contents(applied), ["first", "third"]);
});

test("system changes apply only while the replayed system state is unchanged since capture", () => {
	const { session } = createSession();
	const system: SystemChange[] = [{ type: "section", name: "extra", text: "<extra>\nRequest only\n</extra>" }];
	const snapshot = snapshotAt(session, [], system);
	session.appendMessage(user("later prompt", 5));
	assert.deepEqual(apply(session, snapshot).systemChanges, system, "conversation growth keeps them fresh");

	session.appendMessage({ role: "system", content: "", sections: { cwd: "<cwd>\n/new\n</cwd>" }, timestamp: 6 });
	assert.deepEqual(apply(session, snapshot).systemChanges, [], "a recorded system change makes them stale");
});

test("a forced prompt applies under the same freshness rule as system changes", () => {
	const { session } = createSession();
	const snapshot = { ...snapshotAt(session), forcedPrompt: "Forced prompt" };
	assert.equal(apply(session, snapshot).forcedPrompt, "Forced prompt");

	session.appendMessage({ role: "system", content: "", sections: { cwd: "<cwd>\n/new\n</cwd>" }, timestamp: 6 });
	assert.equal(apply(session, snapshot).forcedPrompt, undefined);
});
