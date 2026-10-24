/**
 * Injections composition from a request snapshot: the rebuilt baseline at the
 * snapshot's leaf with its request-only changes applied and marked.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Tool } from "@earendil-works/pi-ai";
import { SessionManager, type ToolInfo } from "@earendil-works/pi-coding-agent";

import { buildFallbackInjectionsSnapshot, buildInjectionsSnapshot, type InjectionsInput } from "../src/injections.ts";
import { AGGREGATE_SOURCE_ID, type InjectionItem, type InjectionSnapshot } from "../src/model.ts";
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
function itemsById(snapshot: InjectionSnapshot): Map<string, InjectionItem> {
	const items = new Map<string, InjectionItem>();
	for (const item of snapshot.groups.flatMap((group) => group.items)) {
		items.set(item.id, item);
		for (const child of item.children ?? []) items.set(child.id, child);
	}
	return items;
}

/** The one row that holds every message, if any. */
function messagesRow(snapshot: InjectionSnapshot): InjectionItem | undefined {
	return snapshot.groups.flatMap((group) => group.items).find((item) => item.kind === "message");
}

/** The one row that holds every payload change, if any. */
function payloadRow(snapshot: InjectionSnapshot): InjectionItem | undefined {
	return snapshot.groups.flatMap((group) => group.items).find((item) => item.kind === "payload-change");
}

/** `group / part · tokens · change` lines for the parts of every message row. */
function describeMessages(snapshot: InjectionSnapshot): string[] {
	return snapshot.groups.flatMap((group) => group.items.filter((item) => item.kind === "message")
		.flatMap((item) => (item.sections ?? []).map((part) =>
			`${group.source.label} / ${part.label} · ${part.tokens}${part.change ? ` · ${part.change}` : ""}`)));
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
	assert.deepEqual(items.get("base-prompt")?.children?.map((child) => child.id),
		["preamble", "available-tools", "documentation", "current-dir"].map((id) => `base-prompt:${id}`));
	assert.equal(items.get("tool:builtin")?.children?.length, 2);
	assert.deepEqual(describeMessages(snapshot), ["unattributed / fixture-notes · 3"], "user prompts are not injections");
	assert.deepEqual([messagesRow(snapshot)?.id, messagesRow(snapshot)?.tokens], ["messages", 3]);
	assert.equal(messagesRow(snapshot)?.sections?.length, 1);
	assert.deepEqual(snapshot.groups.map((group) => group.source.label), ["pi", "unattributed"],
		"a customType forms no group of its own");
	assert.ok([...items.values()].every((item) => item.change === undefined));
	assert.equal(snapshot.totalTokens, snapshot.groups.reduce((sum, group) => sum + group.totalTokens, 0));
});

test("conversation changes form one unattributed messages row, in session order, then additions", () => {
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

	assert.deepEqual(describeMessages(snapshot), [
		"unattributed / fixture-notes · 6 · modified",
		"unattributed / user · 0 · deleted",
		"unattributed / user · 5 · modified",
		"unattributed / fixture-add · 3 · added",
		"unattributed / user · 4 · added",
	], "a modified or deleted message takes its session original's place; additions follow");

	const row = messagesRow(snapshot);
	assert.deepEqual([row?.id, row?.tokens, row?.requestOnly], ["messages", 18, true]);
	assert.equal(row?.sections?.filter((part) => part.change !== "deleted").length, 4,
		"the sent messages leave the deletion out");
	assert.equal(row?.text, ["rewritten stored note", "edited second prompt", "added note", "added user text"]
		.join("\n\n"));
	const parts = row?.sections ?? [];
	assert.ok(parts.every((part) => (part.requestOnly === true) === (part.change !== undefined)),
		"every changed message is request-only; a session part is not");
	assert.deepEqual([parts[2]?.label, parts[2]?.text, parts[2]?.tokens], ["user", "edited second prompt", 5]);
	assert.equal(parts[2]?.message?.original?.text, "second prompt", "a modification keeps its base in the same part");
	assert.equal(parts[1]?.text, "first prompt", "a deletion previews the session original");
	assert.deepEqual(parts.map((part) => part.message?.userPrompt), [undefined, 1, 2, 2, 2],
		"messages before the first prompt have no number; additions use the request's number");
});

test("custom entries are not messages, and message provenance never creates an extension group", () => {
	const session = SessionManager.inMemory("/tmp/project");
	session.appendMessage(user("ordinary prompt"));
	session.appendCustomEntry("pi.share", { url: "https://example.test/session" });
	const unchanged = buildInjectionsSnapshot(input(session));
	assert.equal(messagesRow(unchanged), undefined, "ordinary history and non-context entries add no messages row");
	assert.deepEqual(unchanged.groups.map((group) => group.source.label), ["pi"], "empty sources have no group");

	const message: RequestMessage = {
		role: "custom", customType: "fixture-web", content: "added note", display: false, timestamp: 6,
		details: { source: "npm:web", reason: "search context" },
	};
	const added = buildInjectionsSnapshot(input(session, { conversation: [{
		type: "added", message, attribution: { customType: "fixture-web", provenance: { source: "npm:web" } },
	}] }));
	assert.deepEqual(added.groups.map((group) => group.source.label), ["pi", "unattributed"]);
	assert.deepEqual(messagesRow(added)?.sections?.map((part) => [part.label, part.text]),
		[["fixture-web", "added note"]]);
});

test("deletion-only messages and payload findings retain their rows and parts at zero tokens", () => {
	const session = SessionManager.inMemory("/tmp/project");
	const entryId = session.appendCustomMessageEntry("fixture-notes", "stored note", false);
	const snapshot = buildInjectionsSnapshot(input(session, { conversation: [{
		type: "deleted", entryId, attribution: { customType: "fixture-notes" },
	}] }, complete([{
		type: "payload-tool-change", change: "deleted", name: "write", lines: [{ type: "removed", text: "Write files" }],
	}])));
	const messages = messagesRow(snapshot);
	const payload = payloadRow(snapshot);
	assert.deepEqual([messages?.id, messages?.tokens, messages?.text, messages?.diff],
		["messages", 0, "", { added: 0, removed: 3 }], "a deletion is not a sent message");
	assert.deepEqual(messages?.sections?.map((part) => [part.label, part.text, part.tokens]),
		[["fixture-notes", "stored note", 0]], "the original stays available after Enter");
	assert.deepEqual([payload?.id, payload?.tokens, payload?.text, payload?.diff],
		["payload-changes", 0, "", { added: 0, removed: 3 }], "a deletion is still a finding");
	assert.deepEqual(payload?.sections?.[0]?.changedLines, [{ type: "removed", text: "Write files" }]);
	assert.deepEqual(snapshot.groups.at(-1)?.diff, { added: 0, removed: 6 });
	assert.equal(snapshot.groups.at(-1)?.totalTokens, 0);
	assert.equal(messages?.children, undefined);
	assert.equal(payload?.children, undefined);
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

	assert.deepEqual(prompt?.children?.map((child) => [child.id, child.change, child.tokens > 0]), [
		["base-prompt:preamble", "modified", true],
		["base-prompt:available-tools", undefined, true],
		["base-prompt:current-dir", "modified", true],
		["base-prompt:section:fixture_notes", "added", true],
		["base-prompt:documentation", "deleted", false],
	], "the deleted section follows the sent parts");
	assert.equal(items.get("base-prompt:documentation")?.text, "Pi documentation lives here.");
	assert.deepEqual(prompt?.sections?.map((part) => part.change), ["modified", undefined, "modified", "added", "deleted"]);
	const requestOnlyParts = [true, false, true, true, true];
	assert.deepEqual(prompt?.children?.map((child) => child.requestOnly === true), requestOnlyParts);
	assert.deepEqual(prompt?.sections?.map((part) => part.requestOnly === true), requestOnlyParts,
		"preview subheaders mark the same parts as the rows");
	assert.equal(prompt?.requestOnly, undefined, "a parent row is never request-only");
	assert.ok(items.get("base-prompt:preamble")?.text.startsWith("Appended instructions."));
	assert.equal(prompt?.tokens, prompt?.children?.reduce((sum, child) => sum + child.tokens, 0));

	assert.equal(items.get("tool:builtin")?.children?.filter((child) => child.change !== "deleted").length, 1,
		"only one built-in declaration remains");
	assert.equal(items.get("tool:builtin:read")?.change, "modified");
	const bash = items.get("tool:builtin:bash");
	assert.deepEqual([bash?.change, bash?.tokens], ["deleted", 0]);
	assert.match(bash?.sections?.[0]?.text ?? "", /^bash: Run commands/, "a deleted tool previews its session definition");
	assert.equal(items.get("tool:unattributed:grep")?.change, "added");
	for (const id of ["tool:builtin:read", "tool:builtin:bash", "tool:unattributed:grep"]) {
		assert.equal(items.get(id)?.requestOnly, true, id);
	}
	assert.equal(items.get("tool:builtin")?.requestOnly, undefined);
});

test("changed prompt parts carry the texts their diff compares, in both previews", () => {
	const { session } = createSession();
	const snapshot = buildInjectionsSnapshot(input(session, {
		system: [
			{ type: "section", name: "cwd", text: "<cwd>\n/tmp/project\nwith a note\n</cwd>" },
			{ type: "section", name: "fixture_notes", text: "<fixture_notes>\nRequest-only section.\n</fixture_notes>" },
			{ type: "section", name: "docs", text: null },
		],
	}));
	const items = itemsById(snapshot);
	const currentDir = items.get("base-prompt:current-dir");
	assert.deepEqual(currentDir?.textDiff, { base: "/tmp/project", request: "/tmp/project\nwith a note" });
	assert.deepEqual(items.get("base-prompt:section:fixture_notes")?.textDiff,
		{ base: "", request: "Request-only section." }, "a custom section has no pi default, as its +N says");
	assert.deepEqual(items.get("base-prompt:documentation")?.textDiff,
		{ base: "Pi documentation lives here.", request: "" }, "a deletion removes the session text, as its -N says");
	assert.equal(items.get("base-prompt:available-tools")?.textDiff, undefined, "an unchanged part has none");
	const prompt = items.get("base-prompt");
	assert.deepEqual(prompt?.sections?.map((part) => part.textDiff), prompt?.children?.map((child) => child.textDiff));
	const row = snapshot.groups.find((group) => group.source.label === "unattributed")?.items
		.find((item) => item.diffOnly === true);
	assert.deepEqual(new Map(row?.sections?.map((part) => [part.label, part.textDiff])), new Map(prompt?.children
		?.filter((child) => child.diff !== undefined).map((child) => [child.label, child.textDiff])),
	"the unattributed row previews the same diff bodies");
});

test("a forced prompt is measured whole and ignores section changes", () => {
	const { session } = createSession();
	const snapshot = buildInjectionsSnapshot(input(session, {
		system: [{ type: "section", name: "docs", text: null }, { type: "tool", name: "bash", declaration: null }],
	}, { forcedPrompt: "Forced prompt text." }));
	const items = itemsById(snapshot);

	assert.equal(items.get("base-prompt")?.text, "Forced prompt text.");
	assert.equal(items.get("base-prompt")?.children, undefined);
	assert.equal(items.get("base-prompt")?.requestOnly, undefined, "System Prompt carries only its Forced marker");
	assert.equal(items.get("tool:builtin:bash")?.change, "deleted", "tool changes still reach a forced prompt");
});

test("forced prompt parts that differ from the session are request-only", () => {
	const { session } = createSession();
	const saved = [SECTIONS.preamble, SECTIONS.tools, SECTIONS.docs, SECTIONS.cwd].join("\n\n");
	const forced = `${saved.replace("/tmp/project", "/tmp/forced")}\n\nForced addition.`;
	const snapshot = buildInjectionsSnapshot(input(session, {}, { forcedPrompt: forced }));
	const prompt = itemsById(snapshot).get("base-prompt");

	assert.equal(prompt?.change, "forced");
	assert.equal(prompt?.requestOnly, undefined);
	assert.deepEqual(prompt?.children?.map((child) => [child.id, child.change, child.requestOnly === true]), [
		["base-prompt:preamble", undefined, false],
		["base-prompt:available-tools", undefined, false],
		["base-prompt:documentation", undefined, false],
		["base-prompt:current-dir", undefined, true],
		["base-prompt:additions", undefined, true],
	], "only the parts whose forced text differs from the session are marked; none carries a change");
	assert.deepEqual(prompt?.sections?.map((part) => part.requestOnly === true), [false, false, false, true, true]);
	assert.equal(itemsById(snapshot).get("tool:builtin:read")?.requestOnly, undefined, "unchanged tools are not");
});

test("a branch with no recorded system state uses the live prompt", () => {
	const session = SessionManager.inMemory("/tmp/project");
	session.appendMessage({ role: "user", content: "first prompt", timestamp: 1 });
	const snapshot = buildInjectionsSnapshot(input(session));

	assert.equal(itemsById(snapshot).get("base-prompt")?.text, "live prompt");
	assert.equal(itemsById(snapshot).get("tool:builtin")?.children?.length, 1);

	const live = input(session, {}, { hiddenTools: ["read"] });
	const hidden = buildInjectionsSnapshot({ ...live, options: { ...live.options, hiddenTools: ["bash"] } });
	assert.equal(itemsById(hidden).get("tool:builtin"), undefined, "the snapshot's hidden tools apply, not the live ones");
	assert.deepEqual(hidden.hiddenTools, ["read"]);
});

test("Injections uses the snapshot's leaf after later edits, branching, and tool changes", () => {
	const { session, entries } = createSession();
	const captured = input(session);
	session.appendContextEdit(entries.custom, { content: "newer content" });
	session.appendMessage({ role: "system", content: "", sections: { cwd: "<cwd>\n/new\n</cwd>" },
		toolsRemoved: [{ name: "read" }], timestamp: 8 });
	session.branch(entries.first);
	session.appendMessage(user("another branch"));
	const snapshot = buildInjectionsSnapshot({ ...captured, entries: session.getEntries() });
	const items = itemsById(snapshot);
	assert.equal(messagesRow(snapshot)?.sections?.[0]?.text, "stored note");
	assert.equal(items.get("base-prompt:current-dir")?.text, "/tmp/project");
	assert.equal(items.get("tool:builtin")?.children?.length, 2);
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
	const parts = messagesRow(snapshot)?.sections?.filter((part) => part.label.startsWith("user"));
	assert.match(parts?.[0]?.text ?? "", /<2.0KB omitted>/);
	assert.match(parts?.[0]?.message?.original?.text ?? "", /<1000B omitted>/);
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

test("payload changes form the last unattributed row and count only the lines the payload added", () => {
	const { session } = createSession();
	const snapshot = buildInjectionsSnapshot(input(session, {
		conversation: [{ type: "added", message: user("added user text"), attribution: {} }],
	}, complete([
		{ type: "payload-change", change: "added", part: "user", lines: [
			{ type: "added", text: "XYZZY edit line" }, { type: "added", text: "second" },
		] },
		{ type: "payload-change", change: "modified", part: "system", lines: [
			{ type: "removed", text: "old rule" }, { type: "added", text: "new rule!" },
		] },
		{ type: "payload-change", change: "deleted", part: "tool-result", lines: [{ type: "removed", text: "gone" }] },
		{ type: "payload-tool-change", change: "added", name: "edit_tool", lines: [{ type: "added", text: "Edit tool." }] },
		{ type: "payload-tool-change", change: "deleted", name: "bash", lines: [{ type: "removed", text: "Run commands" }] },
	])));

	assert.deepEqual(snapshot.groups.map((group) => group.source.label), ["pi", "unattributed"]);
	assert.deepEqual(snapshot.groups.at(-1)?.items.map((item) => item.id), ["messages", "payload-changes"]);
	assert.equal(payloadRow(snapshot)?.sections?.length, 5, "every finding counts, deletions included");
	assert.equal(itemsById(snapshot).get("tool:builtin:bash")?.change, undefined, "a payload removal does not stay in place");
	const changes = payloadRow(snapshot);
	assert.deepEqual(changes?.sections?.map((part) => [part.label, part.tokens, part.toolDeclaration === true]), [
		["user message", 6, false],
		["system message", 3, false],
		["tool result", 0, false],
		["edit_tool", 3, true],
		["bash", 0, true],
	], "one part per finding, in the guard's order");
	assert.equal(changes?.tokens, 12);
	assert.equal(changes?.children, undefined, "the row has no child rows");
	assert.ok([changes, ...(changes?.sections ?? [])].every((part) => part?.requestOnly === undefined),
		"payload changes are not request-only");
	const modified = changes?.sections?.[1];
	assert.equal(modified?.text, "new rule!", "the counted text holds only the added lines");
	assert.deepEqual(modified?.changedLines, [
		{ type: "removed", text: "old rule" }, { type: "added", text: "new rule!" },
	]);
	assert.equal(snapshot.groups.at(-1)?.totalTokens, (messagesRow(snapshot)?.tokens ?? 0) + 12,
		"payload changes count toward the group");
	assert.equal(snapshot.totalTokens, snapshot.groups.reduce((sum, group) => sum + group.totalTokens, 0));
});

test("tools Pi hid are left out and their names are retained for the description", () => {
	const { session } = createSession();
	const grep: Tool = { name: "grep", description: "Search files", parameters: { type: "object" } } as Tool;
	const snapshot = buildInjectionsSnapshot(input(session, {
		system: [{ type: "tool", name: "grep", declaration: grep }, { type: "tool", name: "read", declaration: null }],
	}, { ...complete([]), hiddenTools: ["bash", "grep", "unknown"] }));
	const items = itemsById(snapshot);

	assert.equal(items.get("tool:builtin")?.children?.filter((child) => child.change !== "deleted").length, 0,
		"no built-in declaration remains");
	assert.deepEqual(items.get("tool:builtin")?.sections?.map((part) => [part.label, part.change, part.tokens]), [
		["read", "deleted", 0],
	], "a deleted tool keeps its row");
	assert.equal(items.get("tool:builtin:bash"), undefined);
	assert.equal(items.get("tool:unattributed:grep"), undefined, "hiding wins over the structured addition");
	assert.deepEqual(snapshot.hiddenTools, ["bash", "grep"], "a hidden name the request did not declare is left out");
	assert.deepEqual(buildInjectionsSnapshot(input(session)).hiddenTools, []);
	assert.equal(payloadRow(snapshot), undefined, "a guard without findings adds no row");
});

test("only compared channels contribute findings; a pending guard has none", () => {
	const { session } = createSession();
	const finding: GuardFinding = {
		type: "payload-change", change: "added", part: "user", lines: [{ type: "added", text: "x" }],
	};
	const partial = buildInjectionsSnapshot(input(session, {}, {
		guard: { status: "incomplete", reason: "Message channel failed.", findings: [finding] },
	}));
	assert.equal(partial.groups.at(-1)?.items.at(-1)?.id, "payload-changes");
	assert.equal(payloadRow(partial)?.sections?.length, 1);
	const pending = buildInjectionsSnapshot(input(session, {}, { guard: { status: "pending" } }));
	assert.equal(payloadRow(pending), undefined);
});

// ============================================================================
// Token diffs
// ============================================================================

const SEARCH: Tool = { name: "search", description: "Search the web", parameters: { type: "object" } } as Tool;
const SEARCH_INFO = {
	...SEARCH, promptGuidelines: ["Use search to verify claims"], sourceInfo: { source: "npm:web", path: "/ext/web" },
} as unknown as ToolInfo;

/** A session whose saved prompt carries an extension tool's lines and two extension sections. */
function createExtensionSession(): SessionManager {
	const session = SessionManager.inMemory("/tmp/project");
	session.appendMessage({
		role: "system",
		content: "",
		sections: {
			...SECTIONS,
			tools: "<tools>\n- read: Read files\n- bash: Run commands\n- search: Search the web\n</tools>",
			rules: "<rules>\n- Use search to verify claims\n</rules>",
			"fixture-review": "<fixture-review>\nReview the changed files.\n</fixture-review>",
			"fixture-obsolete": "<fixture-obsolete>\nAn obsolete note.\n</fixture-obsolete>",
		},
		toolsAdded: [READ, BASH, SEARCH],
		timestamp: 1,
	});
	session.appendMessage({ role: "user", content: "first prompt", timestamp: 2 });
	return session;
}

/** `[id, value, +N, -N]` of an item and each of its children, independent of presentation labels. */
function diffRows(item: InjectionItem | undefined): Array<[string, number, number, number]> {
	return [item, ...(item?.children ?? [])].filter((entry) => entry !== undefined)
		.map((entry) => [entry.id, entry.tokens, entry.diff?.added ?? 0, entry.diff?.removed ?? 0]);
}

test("pi's rows compare with pi's default prompt, so saved and request-only extension text both count", () => {
	const session = createExtensionSession();
	const edit: Tool = { ...READ, description: "Read files, edited" };
	const snapshot = buildInjectionsSnapshot({
		...input(session, { system: [
			{ type: "section", name: "cwd", text: "<cwd>\n/tmp/project\nwith a note\n</cwd>" },
			{ type: "section", name: "docs", text: null },
			{ type: "section", name: "fixture-obsolete", text: null },
			{ type: "section", name: "fixture-added", text: "<fixture-added>\nRequest-only section.\n</fixture-added>" },
			{ type: "tool", name: "read", declaration: edit },
		] }),
		allTools: [...BUILTIN_TOOLS, SEARCH_INFO],
	});
	const items = itemsById(snapshot);

	// Shares round cumulatively, so the search line's 25 characters add 6 tokens to a 10-token default
	assert.deepEqual(diffRows(items.get("base-prompt")), [
		["base-prompt", 48, 28, 11],
		["base-prompt:preamble", 7, 0, 0],
		["base-prompt:available-tools", 16, 6, 0],
		["base-prompt:current-dir", 6, 3, 0],
		["base-prompt:guidelines", 7, 7, 0],
		["base-prompt:section:fixture-review", 7, 7, 0],
		["base-prompt:section:fixture-added", 5, 5, 0],
		["base-prompt:documentation", 0, 0, 7],
		["base-prompt:section:fixture-obsolete", 0, 0, 4],
	], "saved extension text counts as added: the tool's lines and its own section");
	assert.equal(items.get("base-prompt:section:fixture-obsolete")?.change, "deleted",
		"a deleted extension section compares with the session, so its deletion stays visible");
	const prompt = items.get("base-prompt");
	assert.deepEqual(prompt?.sections?.map((section) => section.diff), prompt?.children?.map((child) => child.diff),
		"preview subheaders show the rows' diffs");
	assert.deepEqual(prompt?.children?.filter((child) => child.requestOnly === true).map((child) => child.id),
		["current-dir", "section:fixture-added", "documentation", "section:fixture-obsolete"].map((id) => `base-prompt:${id}`),
		"saved extension text has a diff but is not request-only");
	assert.deepEqual(prompt?.children?.filter((child) => child.savedChange === true).map((child) => child.id),
		["available-tools", "guidelines", "section:fixture-review"].map((id) => `base-prompt:${id}`), "only diffs the session keeps are saved");
	assert.deepEqual(items.get("base-prompt:available-tools")?.editors, [
		{ type: "extension", source: { id: "tool-source:npm:web", label: "npm:web", native: false } },
	]);
	assert.deepEqual(items.get("base-prompt:current-dir")?.editors, [{ type: "unknown" }]);
	assert.equal(items.get("base-prompt:section:fixture-added")?.sessionOriginal, false);
	assert.equal(items.get("base-prompt:current-dir")?.sessionOriginal, true);

	assert.deepEqual(diffRows(items.get("tool:builtin")).map(([id, , added, removed]) => [id, added > 0, removed]),
		[["tool:builtin", true, 0], ["tool:builtin:read", true, 0], ["tool:builtin:bash", false, 0]]);
	assert.equal(items.get("tool:npm:web:search")?.diff, undefined, "a saved extension tool matches the session");
	const pi = snapshot.groups.find((group) => group.source.id === "pi");
	assert.deepEqual(pi?.diff, {
		added: (prompt?.diff?.added ?? 0) + (items.get("tool:builtin")?.diff?.added ?? 0),
		removed: prompt?.diff?.removed,
	}, "a group sums its items");
	assert.equal(snapshot.groups.find((group) => group.source.id === "tool-source:npm:web")?.diff, undefined,
		"the system prompt row repeats System Prompt changes, so the group leaves its diff out");
});

test("system prompt rows split pi's prompt changes by source and count toward no group", () => {
	const session = createExtensionSession();
	const snapshot = buildInjectionsSnapshot({
		...input(session, { system: [
			{ type: "section", name: "cwd", text: "<cwd>\n/tmp/project\nwith a note\n</cwd>" },
			{ type: "section", name: "docs", text: null },
			{ type: "section", name: "fixture-obsolete", text: null },
			{ type: "section", name: "fixture-added", text: "<fixture-added>\nRequest-only section.\n</fixture-added>" },
		] }),
		allTools: [...BUILTIN_TOOLS, SEARCH_INFO],
	});
	const items = itemsById(snapshot);
	const web = snapshot.groups.find((group) => group.source.id === "tool-source:npm:web");
	const unattributed = snapshot.groups.find((group) => group.source.id === AGGREGATE_SOURCE_ID);
	const webRow = web?.items.find((item) => item.diffOnly === true);
	const unattributedRow = unattributed?.items.find((item) => item.diffOnly === true);

	// Available Tools +6 and Guidelines +7 are the search tool's lines; the rest has no known source
	assert.deepEqual(web?.items.map((item) => item.id), ["tool:npm:web:search", "system-prompt:tool-source:npm:web"]);
	assert.deepEqual([webRow?.tokens, webRow?.diffOnly, webRow?.diff, webRow?.requestOnly], [0, true, { added: 13,
		removed: 0 }, undefined], "the extension's lines are saved");
	assert.deepEqual(webRow?.sections?.map((section) => [section.label, section.text, section.diff, section.diffOnly]), [
		["Tools", "\n- search: Search the web", { added: 6, removed: 0 }, true],
		["Rules", "\n- Use search to verify claims", { added: 7, removed: 0 }, true],
	]);
	assert.deepEqual([unattributedRow?.diff, unattributedRow?.requestOnly], [{ added: 15, removed: 11 }, true]);
	assert.equal(webRow?.savedChange, true);
	assert.equal(unattributedRow?.savedChange, true, "the row combines saved and request-only changes");
	assert.deepEqual(unattributedRow?.sections?.map((section) => [section.label, section.diff?.added,
		section.diff?.removed, section.requestOnly === true]), [
		["Current Dir", 3, 0, true],
		["fixture-review", 7, 0, false],
		["fixture-added", 5, 0, true],
		["Docs", 0, 7, true],
		["fixture-obsolete", 0, 4, true],
	]);
	const prompt = items.get("base-prompt");
	assert.deepEqual({
		added: (webRow?.diff?.added ?? 0) + (unattributedRow?.diff?.added ?? 0),
		removed: (webRow?.diff?.removed ?? 0) + (unattributedRow?.diff?.removed ?? 0),
	}, prompt?.diff, "together the rows repeat the System Prompt diff");

	assert.deepEqual([web?.totalTokens, web?.diff], [items.get("tool:npm:web:search")?.tokens, undefined],
		"a group counts neither the row's value nor its diff");
	assert.equal(unattributed?.diff, undefined);
	const counted = snapshot.groups.flatMap((group) => group.items).filter((item) => item.diffOnly !== true);
	assert.equal(snapshot.totalTokens, counted.reduce((sum, item) => sum + item.tokens, 0));
});

test("an extension's system prompt row is request-only when its lines differ from the session", () => {
	const session = createExtensionSession();
	const snapshot = buildInjectionsSnapshot({
		...input(session, { system: [
			{ type: "section", name: "tools", text: "<tools>\n- read: Read files\n- bash: Run commands\n</tools>" },
		] }),
		allTools: [...BUILTIN_TOOLS, SEARCH_INFO],
	});
	const web = snapshot.groups.find((group) => group.source.id === "tool-source:npm:web");
	const row = web?.items.find((item) => item.diffOnly === true);

	assert.deepEqual([row?.diff, row?.requestOnly], [{ added: 7, removed: 0 }, true],
		"the request dropped the snippet line the session keeps");
	assert.deepEqual(row?.sections?.map((section) => section.label), ["Rules"]);
});

test("system prompt rows hold guessed additions, and an unchanged prompt has none", () => {
	const live = [
		"You are a test assistant.",
		"<tools>\n- read: Read files\n</tools>",
		"<cwd>\n/tmp/project\n</cwd>",
		"Search tips live in npm:web docs.",
		"An addition without a source.",
	].join("\n\n");
	const snapshot = buildFallbackInjectionsSnapshot({
		systemPrompt: live, options: { cwd: "/tmp/project" }, allTools: [...BUILTIN_TOOLS, SEARCH_INFO],
		activeToolNames: ["read", "search"], promptSources: [{ source: "npm:web", path: "/ext/web" }],
	});
	const rows = snapshot.groups.flatMap((group) => group.items).filter((item) => item.diffOnly === true);
	const additions = itemsById(snapshot).get("base-prompt:additions");

	assert.deepEqual(rows.map((row) => [row.source.label, row.diff, row.requestOnly]), [
		["npm:web", { added: 9, removed: 0 }, undefined],
		["unattributed", { added: (additions?.diff?.added ?? 0) - 9, removed: 0 }, undefined],
	], "the degraded fallback compares the live prompt with itself, so nothing is request-only");
	assert.deepEqual(rows[0]?.sections?.map((section) => [section.label, section.text.trim(), section.attribution]), [
		["Extension Additions", "Search tips live in npm:web docs.", "guess"],
	]);
	assert.deepEqual(additions?.editors, [
		{ type: "extension", source: { id: "tool-source:npm:web", label: "npm:web", native: false },
			attribution: "guess" },
		{ type: "unknown" },
	]);
	assert.ok(rows.every((row) => row.savedChange === true));
	assert.equal(rows[1]?.sections?.[0]?.text, additions?.text, "unattributed previews the whole part");

	const plain = buildFallbackInjectionsSnapshot({
		systemPrompt: "You are a test assistant.\n\n<cwd>\n/tmp/project\n</cwd>", options: { cwd: "/tmp/project" },
		allTools: BUILTIN_TOOLS, activeToolNames: ["read"],
	});
	assert.ok(plain.groups.every((group) => group.items.every((item) => item.diffOnly !== true)));
});

test("a saved section's request-only edit stays partly saved and its editor is unknown", () => {
	const session = createExtensionSession();
	const snapshot = buildInjectionsSnapshot({
		...input(session, { system: [
			{ type: "section", name: "fixture-review", text: "<fixture-review>\nReview new files only.\n</fixture-review>" },
			{ type: "section", name: "tools", text: "<tools>\n- read: Read files\n- bash: Run commands\n" +
				"- search: Search the web\nUnknown request-only instruction\n</tools>" },
		] }),
		allTools: [...BUILTIN_TOOLS, SEARCH_INFO],
	});
	const items = itemsById(snapshot);
	for (const id of ["base-prompt:section:fixture-review", "base-prompt:available-tools"]) {
		const part = items.get(id);
		assert.ok(part?.diff);
		assert.equal(part?.requestOnly, true);
		assert.equal(part?.savedChange, true);
		assert.equal(part?.sessionOriginal, true);
		assert.deepEqual(part?.editors, [{ type: "unknown" }], "the owner of saved lines is not the request's editor");
	}
	const row = snapshot.groups.find((group) => group.source.id === AGGREGATE_SOURCE_ID)?.items[0];
	assert.equal(row?.requestOnly, true);
	assert.equal(row?.savedChange, true, "the saved custom section and request edit share a +N");
});

/** Recorded generated instruction-file and skill sections, as Pi supplies them. */
function createPromptRecordsSession(): SessionManager {
	const session = SessionManager.inMemory("/tmp/project");
	session.appendMessage({
		role: "system", content: "", toolsAdded: [READ], timestamp: 1,
		sections: {
			...SECTIONS,
			project_context: "<project_context>\n<project_instructions path=\"/tmp/AGENTS.md\">\nOriginal file\n" +
				"</project_instructions>\n</project_context>",
			skills: "<skills>\n<available_skills>\n<skill>\n<name>test-skill</name>\n" +
				"<description>Original description</description>\n<location>/tmp/SKILL.md</location>\n" +
				"</skill>\n</available_skills>\n</skills>",
		},
	});
	session.appendMessage({ role: "user", content: "prompt", timestamp: 2 });
	return session;
}

test("the unattributed system prompt row includes request-only instruction-file and skill edits", () => {
	const session = createPromptRecordsSession();
	const snapshot = buildInjectionsSnapshot(input(session, { system: [
		{ type: "section", name: "project_context", text: "<project_context>\n" +
			"<project_instructions path=\"/tmp/AGENTS.md\">\nChanged file\n</project_instructions>\n</project_context>" },
		{ type: "section", name: "skills", text: "<skills>\n<available_skills>\n<skill>\n<name>test-skill</name>\n" +
			"<description>Changed description</description>\n<location>/tmp/SKILL.md</location>\n" +
			"</skill>\n</available_skills>\n</skills>" },
	] }));
	const items = itemsById(snapshot);
	const row = snapshot.groups.find((group) => group.source.id === AGGREGATE_SOURCE_ID)?.items[0];
	const file = items.get("context-files");
	const skill = items.get("skills");
	assert.ok(file?.diff && skill?.diff);
	assert.deepEqual(row?.diff, {
		added: file.diff.added + skill.diff.added, removed: file.diff.removed + skill.diff.removed,
	});
	assert.equal(row?.requestOnly, true);
	assert.ok(file.children?.every((child) => child.requestOnly === true));
	assert.ok(skill.children?.every((child) => child.requestOnly === true));
	assert.deepEqual(row?.sections?.map((section) => [section.label, section.requestOnly]), [
		["/tmp/AGENTS.md", true], ["test-skill", true],
	]);
});

test("deleting generated instruction files and skills keeps their removals in prompt diffs", () => {
	const session = createPromptRecordsSession();
	const saved = itemsById(buildInjectionsSnapshot(input(session)));
	const snapshot = buildInjectionsSnapshot(input(session, { system: [
		{ type: "section", name: "project_context", text: null },
		{ type: "section", name: "skills", text: null },
	] }));
	const items = itemsById(snapshot);
	const row = snapshot.groups.find((group) => group.source.id === AGGREGATE_SOURCE_ID)?.items[0];
	const removed = (saved.get("context-files")?.tokens ?? 0) + (saved.get("skills")?.tokens ?? 0);
	assert.ok(removed > 0);
	assert.deepEqual(items.get("base-prompt")?.diff, { added: 0, removed });
	assert.equal(items.get("base-prompt:context-files")?.sessionOriginal, true,
		"a deleted generated section keeps its original under the session aggregate's id");
	assert.equal(items.get("base-prompt:skills")?.sessionOriginal, true);
	assert.deepEqual(row?.diff, { added: 0, removed });
	assert.equal(row?.requestOnly, true);
	assert.deepEqual(row?.sections?.map((section) => [section.label, section.text.includes("Original")]), [
		["Instruction Files", true], ["Skills", true],
	], "removed session sections remain available behind Enter");
});

test("tool and message rows compare with the session; deletions remove the session estimate", () => {
	const { session, entries } = createSession();
	const added: RequestMessage = {
		role: "custom", customType: "fixture-add", content: "added note", display: false, timestamp: 5,
	};
	const grep: Tool = { name: "grep", description: "Search files", parameters: { type: "object" } } as Tool;
	const snapshot = buildInjectionsSnapshot(input(session, {
		conversation: [
			{ type: "added", message: added, attribution: { customType: "fixture-add" } },
			{ type: "modified", entryId: entries.second, message: user("edited second prompt"), attribution: {} },
			{ type: "deleted", entryId: entries.first, attribution: {} },
		],
		system: [{ type: "tool", name: "grep", declaration: grep }, { type: "tool", name: "bash", declaration: null }],
	}));
	const messages = messagesRow(snapshot);

	assert.deepEqual(messages?.sections?.map((part) => [part.label, part.change, part.tokens, part.diff]), [
		["fixture-notes", undefined, 3, undefined],
		["user", "deleted", 0, { added: 0, removed: 3 }],
		["user", "modified", 5, { added: 1, removed: 0 }],
		["fixture-add", "added", 3, { added: 3, removed: 0 }],
	], "the modification reconciles with the 4-token session prompt");
	assert.deepEqual(messages?.diff, { added: 4, removed: 3 }, "the row sums its messages' diffs");
	const items = itemsById(snapshot);
	const grepTokens = items.get("tool:unattributed:grep")?.tokens ?? 0;
	assert.deepEqual(items.get("tool:unattributed:grep")?.diff, { added: grepTokens, removed: 0 });
	assert.deepEqual(items.get("tool:builtin:bash")?.diff, { added: 0, removed: 13 });
	const unattributed = snapshot.groups.find((group) => group.source.id === AGGREGATE_SOURCE_ID);
	assert.deepEqual(unattributed?.items.map((item) => item.id), ["tool:unattributed:grep", "messages"],
		"an unregistered tool joins unattributed");
	assert.deepEqual(unattributed?.diff, { added: grepTokens + 4, removed: 3 });
});

test("a payload change compares its added lines with the captured request's removed lines", () => {
	const { session } = createSession();
	const snapshot = buildInjectionsSnapshot(input(session, {}, complete([
		{ type: "payload-change", change: "modified", part: "system", lines: [
			{ type: "removed", text: "old rule" }, { type: "added", text: "new rule!" },
		] },
		{ type: "payload-change", change: "added", part: "user", lines: [{ type: "added", text: "XYZZY edit line" }] },
		{ type: "payload-tool-change", change: "deleted", name: "bash", lines: [{ type: "removed", text: "Run commands" }] },
	])));
	const changes = payloadRow(snapshot);

	assert.deepEqual(changes?.sections?.map((part) => [part.label, part.tokens, part.diff]), [
		["system message", 3, { added: 2, removed: 1 }],
		["user message", 4, { added: 4, removed: 0 }],
		["bash", 0, { added: 0, removed: 3 }],
	]);
	assert.deepEqual(changes?.diff, { added: 6, removed: 4 });
	assert.deepEqual(snapshot.groups.at(-1)?.diff, { added: 6, removed: 4 });
});

test("a forced prompt without sections compares with pi's whole default prompt", () => {
	const session = createExtensionSession();
	const forced = "Forced prompt text.";
	const snapshot = buildInjectionsSnapshot({
		...input(session, {}, { forcedPrompt: forced }), allTools: [...BUILTIN_TOOLS, SEARCH_INFO],
	});
	const prompt = itemsById(snapshot).get("base-prompt");

	assert.equal(prompt?.children, undefined);
	assert.equal(prompt?.change, "forced");
	// Pi's default prompt holds pi's parts without the extension's lines and sections
	const defaultText = [
		"You are a test assistant.", "\n- read: Read files\n- bash: Run commands", "Pi documentation lives here.", "/tmp/project",
	].join("\n");
	assert.deepEqual(prompt?.diff, { added: prompt?.tokens, removed: Math.ceil(defaultText.length / 4) });
});

test("a branch with no recorded system state and the degraded fallback compare with pi's default prompt", () => {
	const session = SessionManager.inMemory("/tmp/project");
	session.appendMessage({ role: "user", content: "first prompt", timestamp: 1 });
	const live = [
		"You are a test assistant.",
		"<tools>\n- read: Read files\n- search: Search the web\n</tools>",
		"<cwd>\n/tmp/project\n</cwd>",
	].join("\n\n");
	const native = {
		systemPrompt: live, options: { cwd: "/tmp/project", toolSnippets: { search: "Search the web" } },
		allTools: [...BUILTIN_TOOLS, SEARCH_INFO], activeToolNames: ["read", "search"],
	};
	const fromBranch = buildInjectionsSnapshot({ ...input(session), ...native });
	const fallback = buildFallbackInjectionsSnapshot(native);

	for (const snapshot of [fromBranch, fallback]) {
		const items = itemsById(snapshot);
		assert.deepEqual(items.get("base-prompt:available-tools")?.diff, { added: 6, removed: 0 });
		assert.equal(items.get("base-prompt:current-dir")?.diff, undefined);
		assert.equal(items.get("tool:npm:web:search")?.diff, undefined);
		assert.deepEqual(snapshot.groups[0]?.diff, { added: 6, removed: 0 });
	}
});
