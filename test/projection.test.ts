/**
 * The latest request snapshot applied to the current projection for Usage:
 * conversation changes by baseline entry, system changes, the forced prompt,
 * and declared tool names only while fresh.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { getCurrentTools, type Tool } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { type AppliedRequest, applyRequestSnapshot, latestDeclaredTools } from "../src/projection.ts";
import {
	type ConversationChange,
	type DeclaredTools,
	type RequestMessage,
	type RequestSnapshot,
	SnapshotStore,
	type SystemChange,
} from "../src/snapshot.ts";

const READ: Tool = { name: "read", description: "Read files", parameters: { type: "object", properties: {} } } as Tool;
const BASH: Tool = { name: "bash", description: "Run commands", parameters: { type: "object", properties: {} } } as Tool;

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

/**
 * Apply `snapshot` to the session's current projection without probe messages
 * to filter. Live active tools default to the replayed ones, as when no change
 * is pending.
 */
function apply(
	session: SessionManager,
	snapshot: RequestSnapshot | undefined,
	declaredTools?: DeclaredTools,
	activeToolNames = getCurrentTools(session.buildSessionProjection().messages).map((tool) => tool.name),
): AppliedRequest {
	return applyRequestSnapshot({
		snapshot,
		entries: session.getEntries(),
		leafId: session.getLeafId(),
		filterMessages: (messages) => messages,
		declaredTools,
		activeToolNames,
	});
}

/** A snapshot with only an ID, an origin, and optionally declared tool names. */
function recorded(id: number, origin: RequestSnapshot["origin"], declaredTools?: DeclaredTools): RequestSnapshot {
	return {
		id, origin, capturedAt: 0, leafId: null, changes: { conversation: [], system: [] },
		guard: { status: "incomplete", reason: "No payload." },
		...(declaredTools === undefined ? {} : { declaredTools }),
	};
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

test("declared tool names come from the latest snapshot of either origin that records them", () => {
	const names = (declared: string[]): DeclaredTools => ({ declared, baseline: ["read", "bash"] });
	const store = new SnapshotStore();
	assert.equal(latestDeclaredTools(store), undefined);

	store.publish(recorded(1, "real-turn", names(["read"])));
	store.publish(recorded(2, "synthetic-probe"));
	assert.deepEqual(latestDeclaredTools(store), names(["read"]), "a standard probe records none and replaces nothing");

	store.publish(recorded(3, "synthetic-probe", names(["bash"])));
	assert.deepEqual(latestDeclaredTools(store), names(["bash"]), "a probe payload that was compared records names");

	store.publish(recorded(4, "real-turn", names(["read", "bash"])));
	assert.deepEqual(latestDeclaredTools(store), names(["read", "bash"]));

	store.publish(recorded(5, "real-turn"));
	store.publish(recorded(6, "synthetic-probe"));
	assert.equal(latestDeclaredTools(store), undefined, "a later turn with an incomplete tool channel leaves none");
});

test("declared tool names wait for a pending active-tool change and need live names", () => {
	const { session } = createSession();
	const declaredTools: DeclaredTools = { declared: ["extra"], baseline: ["read"] };
	assert.deepEqual(apply(session, undefined, declaredTools, ["read", "read"]).declaredToolNames, new Set(["extra"]));
	assert.equal(apply(session, undefined, declaredTools, ["read", "bash"]).declaredToolNames, undefined,
		"Pi records the change only when the next request starts");
	assert.equal(apply(session, undefined, declaredTools, []).declaredToolNames, undefined);
	const withoutLiveNames = applyRequestSnapshot({
		snapshot: undefined, entries: session.getEntries(), leafId: session.getLeafId(),
		filterMessages: (messages) => messages, declaredTools,
	});
	assert.equal(withoutLiveNames.declaredToolNames, undefined);
});

test("declared tool names apply only while the replayed tool names equal the baseline names", () => {
	const { session } = createSession();
	const declaredTools: DeclaredTools = { declared: ["read", "extra"], baseline: ["read"] };
	assert.deepEqual(apply(session, undefined, declaredTools).declaredToolNames, new Set(["read", "extra"]));
	assert.deepEqual(apply(session, snapshotAt(session), declaredTools).declaredToolNames, new Set(["read", "extra"]));
	assert.equal(apply(session, snapshotAt(session)).declaredToolNames, undefined);

	session.appendMessage(user("later prompt", 5));
	session.appendMessage({ role: "system", content: "", sections: { cwd: "<cwd>\n/new\n</cwd>" }, timestamp: 6 });
	assert.deepEqual(apply(session, snapshotAt(session), declaredTools).declaredToolNames, new Set(["read", "extra"]),
		"a recorded prompt change keeps the same tools");

	session.appendMessage({ role: "system", content: "", toolsAdded: [BASH], timestamp: 7 });
	assert.equal(apply(session, snapshotAt(session), declaredTools).declaredToolNames, undefined,
		"an active-tool change makes them stale until a newer snapshot");
	assert.deepEqual(
		apply(session, snapshotAt(session), { declared: ["bash"], baseline: ["bash", "read"] }).declaredToolNames,
		new Set(["bash"]),
		"names compare as sets",
	);
});
