/**
 * Injections composition from a request snapshot: the rebuilt baseline at the
 * snapshot's leaf with its request-only changes applied and marked.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Tool } from "@earendil-works/pi-ai";
import { SessionManager, type ToolInfo } from "@earendil-works/pi-coding-agent";

import { buildInjectionsSnapshot, type InjectionsInput } from "../src/injections.ts";
import type { InitialSnapshot, InjectionItem } from "../src/model.ts";
import type {
	ConversationChange,
	GuardFinding,
	GuardResult,
	RequestMessage,
	RequestSnapshot,
	SystemChange,
} from "../src/snapshot.ts";

const READ: Tool = { name: "read", description: "Read files", parameters: { type: "object", properties: {} } } as Tool;
const BASH: Tool = { name: "bash", description: "Run commands", parameters: { type: "object", properties: {} } } as Tool;
const SECTIONS = {
	preamble: "You are a test assistant.",
	tools: "<tools>\n- read: Read files\n- bash: Run commands\n</tools>",
	docs: "<docs>\nPi documentation lives here.\n</docs>",
	cwd: "<cwd>\n/tmp/project\n</cwd>",
};
const BUILTIN_TOOLS = [READ, BASH].map((tool) => ({
	...tool,
	sourceInfo: { source: "builtin", path: `<builtin:${tool.name}>` },
})) as unknown as ToolInfo[];

/** A session with a recorded system state, a custom message, and two user prompts. */
function createSession(): { session: SessionManager; entries: Record<"custom" | "first" | "second", string> } {
	const session = SessionManager.inMemory("/tmp/project");
	session.appendMessage({ role: "system", content: "", sections: SECTIONS, toolsAdded: [READ, BASH], timestamp: 1 });
	const custom = session.appendCustomMessageEntry("fixture-notes", "stored note", false);
	const first = session.appendMessage({ role: "user", content: "first prompt", timestamp: 3 });
	const second = session.appendMessage({ role: "user", content: "second prompt", timestamp: 4 });
	return { session, entries: { custom, first, second } };
}

/** Composition input for a snapshot taken at the session's current leaf. */
function input(
	session: SessionManager,
	changes: { conversation?: ConversationChange[]; system?: SystemChange[] } = {},
	extra: Partial<RequestSnapshot> = {},
): InjectionsInput {
	const snapshot: RequestSnapshot = {
		id: 1,
		origin: "real-turn",
		capturedAt: Date.UTC(2026, 6, 10),
		leafId: session.getLeafId(),
		changes: { conversation: changes.conversation ?? [], system: changes.system ?? [] },
		guard: { status: "incomplete", reason: "No payload." },
		...extra,
	};
	return {
		snapshot,
		entries: session.getEntries(),
		filterMessages: (messages) => messages,
		options: { cwd: "/tmp/project" },
		allTools: BUILTIN_TOOLS,
		systemPrompt: "live prompt",
		activeToolNames: ["read"],
	};
}

/** Every item and child, keyed by id. */
function itemsById(snapshot: InitialSnapshot): Map<string, InjectionItem> {
	const items = new Map<string, InjectionItem>();
	for (const item of snapshot.groups.flatMap((group) => group.items)) {
		items.set(item.id, item);
		for (const child of item.children ?? []) items.set(child.id, child);
	}
	return items;
}

/** `group / label · tokens · change` lines for message items. */
function describeMessages(snapshot: InitialSnapshot): string[] {
	return snapshot.groups.flatMap((group) => group.items.filter((item) => item.kind === "message")
		.map((item) => `${group.source.label} / ${item.label} · ${item.tokens}${item.change ? ` · ${item.change}` : ""}`));
}

/** A user message as a request carries it. */
function user(content: string): Extract<RequestMessage, { role: "user" }> {
	return { role: "user", content, timestamp: 5 };
}

test("the composition replays the recorded prompt and tools and lists session custom messages", () => {
	const { session } = createSession();
	const filtered: number[] = [];
	const snapshot = buildInjectionsSnapshot({
		...input(session),
		filterMessages: (messages) => {
			filtered.push(messages.length);
			return messages;
		},
	});
	const items = itemsById(snapshot);

	assert.ok(filtered.length > 0, "baseline messages pass through the probe filter");
	assert.deepEqual(items.get("base-prompt")?.children?.map((child) => child.label),
		["Preamble", "Available Tools", "Documentation", "Current Dir"]);
	assert.equal(items.get("tool:builtin")?.label, "Built-in Tools (2)");
	assert.deepEqual(describeMessages(snapshot), ["fixture-notes / message · 3"], "user prompts are not injections");
	assert.equal(snapshot.origin, "real-turn");
	assert.ok([...items.values()].every((item) => item.change === undefined));
	assert.equal(snapshot.totalTokens, snapshot.groups.reduce((sum, group) => sum + group.totalTokens, 0));
});

test("conversation changes stay in place with their markers", () => {
	const { session, entries } = createSession();
	const added: RequestMessage = {
		role: "custom", customType: "fixture-add", content: "added note", display: false, timestamp: 5,
	};
	const modifiedNote: RequestMessage = {
		role: "custom", customType: "fixture-notes", content: "rewritten stored note", display: false, timestamp: 2,
	};
	const snapshot = buildInjectionsSnapshot(input(session, {
		conversation: [
			{ type: "added", message: added, attribution: { customType: "fixture-add" } },
			{ type: "added", message: user("added user text"), attribution: {} },
			{ type: "modified", entryId: entries.custom, message: modifiedNote, attribution: { customType: "fixture-notes" } },
			{ type: "modified", entryId: entries.second, message: user("edited second prompt"), attribution: {} },
			{ type: "deleted", entryId: entries.first, attribution: {} },
		],
	}));

	assert.deepEqual(describeMessages(snapshot).sort(), [
		"fixture-add / message · 3 · added",
		"fixture-notes / message · 6 · modified",
		"unattributed / user message · 0 · deleted",
		"unattributed / user message · 4 · added",
		"unattributed / user message · 5 · modified",
	], "the modified session custom message replaces its unchanged row");

	const items = [...itemsById(snapshot).values()];
	const modified = items.find((item) => item.change === "modified" && item.label === "user message");
	assert.deepEqual(modified?.sections?.map((part) => [part.label, part.text, part.tokens]), [
		["Request", "edited second prompt", 5],
		["Session", "second prompt", 0],
	]);
	const deleted = items.find((item) => item.change === "deleted");
	assert.equal(deleted?.text, "first prompt", "a deletion previews the session original");
	assert.equal(deleted?.sections, undefined);
});

test("system changes apply to the measured prompt and tools and mark what they touched", () => {
	const { session } = createSession();
	const edit: Tool = { ...READ, description: "Read files, edited for this request" };
	const grep: Tool = { name: "grep", description: "Search files", parameters: { type: "object" } } as Tool;
	const snapshot = buildInjectionsSnapshot(input(session, {
		system: [
			{ type: "content", text: "Appended instructions." },
			{ type: "section", name: "cwd", text: "<cwd>\n/tmp/project\nwith a note\n</cwd>" },
			{ type: "section", name: "fixture_notes", text: "<fixture_notes>\nRequest-only section.\n</fixture_notes>" },
			{ type: "section", name: "docs", text: null },
			{ type: "tool", name: "read", declaration: edit },
			{ type: "tool", name: "grep", declaration: grep },
			{ type: "tool", name: "bash", declaration: null },
		],
	}));
	const items = itemsById(snapshot);
	const prompt = items.get("base-prompt");

	assert.deepEqual(prompt?.children?.map((child) => [child.label, child.change, child.tokens > 0]), [
		["Preamble", "modified", true],
		["Available Tools", undefined, true],
		["Current Dir", "modified", true],
		["fixture_notes", "added", true],
		["Documentation", "deleted", false],
	], "the deleted section follows the sent parts");
	assert.equal(items.get("base-prompt:documentation")?.text, "Pi documentation lives here.");
	assert.deepEqual(prompt?.sections?.map((part) => part.change), ["modified", undefined, "modified", "added", "deleted"]);
	assert.ok(items.get("base-prompt:preamble")?.text.startsWith("Appended instructions."));
	assert.equal(prompt?.tokens, prompt?.children?.reduce((sum, child) => sum + child.tokens, 0));

	assert.equal(items.get("tool:builtin")?.label, "Built-in Tools (1)", "the count names declared tools only");
	assert.equal(items.get("tool:builtin:read")?.change, "modified");
	const bash = items.get("tool:builtin:bash");
	assert.deepEqual([bash?.change, bash?.tokens], ["deleted", 0]);
	assert.match(bash?.sections?.[0]?.text ?? "", /^bash: Run commands/, "a deleted tool previews its session definition");
	assert.equal(items.get("tool:unattributed:grep")?.change, "added");
});

test("a forced prompt is measured whole and ignores section changes", () => {
	const { session } = createSession();
	const snapshot = buildInjectionsSnapshot(input(session, {
		system: [{ type: "section", name: "docs", text: null }, { type: "tool", name: "bash", declaration: null }],
	}, { forcedPrompt: "Forced prompt text." }));
	const items = itemsById(snapshot);

	assert.equal(items.get("base-prompt")?.text, "Forced prompt text.");
	assert.equal(items.get("base-prompt")?.children, undefined);
	assert.equal(items.get("tool:builtin:bash")?.change, "deleted", "tool changes still reach a forced prompt");
});

test("a branch with no recorded system state uses the live prompt", () => {
	const session = SessionManager.inMemory("/tmp/project");
	session.appendMessage({ role: "user", content: "first prompt", timestamp: 1 });
	const snapshot = buildInjectionsSnapshot(input(session));

	assert.equal(itemsById(snapshot).get("base-prompt")?.text, "live prompt");
	assert.equal(itemsById(snapshot).get("tool:builtin")?.label, "Built-in Tools (1)");

	const live = input(session, {}, { hiddenTools: ["read"] });
	const hidden = itemsById(buildInjectionsSnapshot({ ...live, options: { ...live.options, hiddenTools: ["bash"] } }));
	assert.equal(hidden.get("tool:builtin")?.label, "Built-in Tools (0)");
	assert.deepEqual([hidden.get("tool:builtin:read")?.change, hidden.get("tool:builtin:read")?.tokens], ["hidden", 0],
		"the snapshot's hidden tools apply, not the live ones");
});

test("Initial uses its leaf after later edits, branching, and tool changes", () => {
	const { session, entries } = createSession();
	const initial = input(session);
	session.appendContextEdit(entries.custom, { content: "newer content" });
	session.appendMessage({ role: "system", content: "", sections: { cwd: "<cwd>\n/new\n</cwd>" },
		toolsRemoved: [{ name: "read" }], timestamp: 8 });
	session.branch(entries.first);
	session.appendMessage(user("another branch"));
	const snapshot = buildInjectionsSnapshot({ ...initial, entries: session.getEntries() });
	const items = itemsById(snapshot);
	assert.equal(items.get("message:fixture-notes:0")?.text, "stored note");
	assert.equal(items.get("base-prompt:current-dir")?.text, "/tmp/project");
	assert.equal(items.get("tool:builtin")?.label, "Built-in Tools (2)");
});

test("changed section layout comes from replay even with duplicate text, inline tags, or no XML", () => {
	const { session } = createSession();
	const snapshot = buildInjectionsSnapshot(input(session, { system: [
		{ type: "content", text: "same text" },
		{ type: "section", name: "extra", text: "same text" },
		{ type: "section", name: "inline", text: "<inline>inline body</inline>" },
		{ type: "section", name: "empty", text: "" },
		...Object.keys(SECTIONS).filter((name) => name !== "preamble")
			.map((name): SystemChange => ({ type: "section", name, text: null })),
	] }));
	const items = itemsById(snapshot);
	assert.equal(items.get("base-prompt:section:extra")?.text, "same text");
	assert.equal(items.get("base-prompt:section:extra")?.change, "added");
	assert.equal(items.get("base-prompt:section:inline")?.text, "inline body");
	assert.equal(items.get("base-prompt:section:empty")?.change, "added");
	assert.equal(items.get("base-prompt:current-dir")?.change, "deleted");
	assert.equal(items.get("base-prompt:documentation")?.tokens, 0);
	assert.match(items.get("base-prompt:preamble")?.text ?? "", /^same text/);
});

test("a request deleting every prompt section keeps uncounted originals", () => {
	const { session } = createSession();
	const snapshot = buildInjectionsSnapshot(input(session, { system: Object.keys(SECTIONS)
		.map((name): SystemChange => ({ type: "section", name, text: null })) }));
	const prompt = itemsById(snapshot).get("base-prompt");
	assert.equal(prompt?.tokens, 0);
	assert.equal(prompt?.text, "");
	assert.equal(prompt?.children?.length, Object.keys(SECTIONS).length);
	assert.ok(prompt?.children?.every((child) => child.change === "deleted" && child.tokens === 0 && child.chars === 0));
});

test("current customPrompt keeps Dropped markers, distinct from request deletions", () => {
	const session = SessionManager.inMemory("/tmp");
	session.appendMessage({ role: "system", content: "", sections: { preamble: "custom", cwd: SECTIONS.cwd },
		toolsAdded: [READ], timestamp: 1 });
	const snapshot = buildInjectionsSnapshot({ ...input(session), options: { cwd: "/tmp", customPrompt: "custom" } });
	const items = itemsById(snapshot);
	assert.equal(items.get("base-prompt:documentation")?.dropped, true);
	assert.equal(items.get("base-prompt:documentation")?.change, undefined);
});

test("raw session and redacted request images keep their original size markers in previews", () => {
	const { session } = createSession();
	const raw: RequestMessage = { role: "user", timestamp: 9,
		content: [{ type: "image", data: "x".repeat(1_000), mimeType: "image/png" }] };
	const id = session.appendMessage(raw);
	const request: RequestMessage = { ...raw, content: [{ type: "image", data: "<2.0KB omitted>", mimeType: "image/png" }] };
	const snapshot = buildInjectionsSnapshot(input(session, { conversation: [
		{ type: "modified", entryId: id, message: request, attribution: {} },
	] }));
	const changed = itemsById(snapshot).get("change:0");
	assert.match(changed?.sections?.[0]?.text ?? "", /<2.0KB omitted>/);
	assert.match(changed?.sections?.[1]?.text ?? "", /<1000B omitted>/);
	assert.ok(!JSON.stringify(snapshot).includes("x".repeat(1_000)));
	assert.ok(Array.isArray(raw.content));
	assert.ok(raw.content[0]?.type === "image");
	assert.equal(raw.content[0].data.length, 1_000, "the source message is unchanged");
});

/** A complete guard with the given findings. */
function complete(findings: GuardFinding[]): { guard: GuardResult } {
	const dispatch = { provider: "mock", api: "openai-completions", model: "m" };
	return { guard: { status: "complete", dispatch, findings } };
}

test("late edits form the last group and count only the lines the payload added", () => {
	const { session } = createSession();
	const snapshot = buildInjectionsSnapshot(input(session, {
		conversation: [{ type: "added", message: user("added user text"), attribution: {} }],
	}, complete([
		{ type: "late-edit", change: "added", part: "user", lines: [
			{ type: "added", text: "XYZZY late line" }, { type: "added", text: "second" },
		] },
		{ type: "late-edit", change: "modified", part: "system", lines: [
			{ type: "removed", text: "old rule" }, { type: "added", text: "new rule!" },
		] },
		{ type: "late-edit", change: "deleted", part: "tool-result", lines: [{ type: "removed", text: "gone" }] },
		{ type: "late-tool-edit", change: "added", name: "late_tool", lines: [{ type: "added", text: "Late tool." }] },
		{ type: "late-tool-edit", change: "deleted", name: "bash", lines: [{ type: "removed", text: "Run commands" }] },
	])));

	assert.deepEqual(snapshot.groups.map((group) => group.source.label),
		["pi", "fixture-notes", "unattributed", "late edits"]);
	assert.equal(itemsById(snapshot).get("tool:builtin:bash")?.change, undefined, "a late removal does not stay in place");
	const late = snapshot.groups.at(-1);
	assert.deepEqual(late?.items.map((item) => [item.label, item.kind, item.tokens, item.change]), [
		["late_tool", "tool", 3, "added"],
		["bash", "tool", 0, "deleted"],
		["user message", "message", 6, "added"],
		["system message", "message", 3, "modified"],
		["tool result", "message", 0, "deleted"],
	], "tools come first, then messages by size");
	assert.equal(late?.totalTokens, 12);
	const modified = late?.items.find((item) => item.change === "modified");
	assert.equal(modified?.text, "new rule!", "the counted text holds only the added lines");
	assert.deepEqual(modified?.changedLines, [
		{ type: "removed", text: "old rule" }, { type: "added", text: "new rule!" },
	]);
	assert.equal(snapshot.totalTokens, snapshot.groups.reduce((sum, group) => sum + group.totalTokens, 0));
});

test("tools Pi hid stay in place at 0 tokens", () => {
	const { session } = createSession();
	const grep: Tool = { name: "grep", description: "Search files", parameters: { type: "object" } } as Tool;
	const snapshot = buildInjectionsSnapshot(input(session, {
		system: [{ type: "tool", name: "grep", declaration: grep }, { type: "tool", name: "read", declaration: null }],
	}, { ...complete([]), hiddenTools: ["bash", "grep"] }));
	const items = itemsById(snapshot);

	assert.equal(items.get("tool:builtin")?.label, "Built-in Tools (0)", "the count names declared tools only");
	const bash = items.get("tool:builtin:bash");
	assert.deepEqual([bash?.change, bash?.tokens], ["hidden", 0]);
	assert.match(bash?.sections?.[0]?.text ?? "", /^bash: Run commands/, "a hidden tool previews its definition");
	assert.equal(bash?.sections?.[0]?.change, "hidden");
	assert.equal(items.get("tool:builtin:read")?.change, "deleted");
	const builtin = items.get("tool:builtin");
	assert.deepEqual(builtin?.sections?.map((part) => [part.label, part.change, part.tokens]), [
		["bash", "hidden", 0], ["read", "deleted", 0],
	]);
	const hiddenGrep = items.get("tool:unattributed:grep");
	assert.deepEqual([hiddenGrep?.change, hiddenGrep?.tokens], ["hidden", 0], "hidden wins over the structured addition");
	assert.ok(snapshot.groups.every((group) => group.source.label !== "late edits"));
});

test("only compared channels contribute findings; a pending guard has none", () => {
	const { session } = createSession();
	const finding: GuardFinding = {
		type: "late-edit", change: "added", part: "user", lines: [{ type: "added", text: "x" }],
	};
	const partial = buildInjectionsSnapshot(input(session, {}, {
		guard: { status: "incomplete", reason: "Message channel failed.", findings: [finding] },
	}));
	assert.equal(partial.groups.at(-1)?.source.label, "late edits");
	const pending = buildInjectionsSnapshot(input(session, {}, { guard: { status: "pending" } }));
	assert.ok(pending.groups.every((group) => group.source.label !== "late edits"));
});
