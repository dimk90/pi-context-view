import assert from "node:assert/strict";
import { test } from "node:test";

import type { InjectionItem, InjectionSnapshot } from "../src/model.ts";
import {
	buildInjectionRows,
	collectItemsById,
	filterInjections,
	type InjectionFilterMode,
	ListNavigator,
	PreviewScroller,
} from "../src/ui/injections-model.ts";

/** A neutral leaf: the messages and payload-change rows have kinds of their own. */
function item(id: string, sourceId: string, native: boolean, tokens: number): InjectionItem {
	return {
		id,
		kind: "base-prompt",
		source: { id: sourceId, label: sourceId, native },
		label: id,
		chars: tokens * 4,
		tokens,
		text: id,
	};
}

function snapshot(): InjectionSnapshot {
	const builtinTools: InjectionItem = {
		...item("tool:builtin", "pi", true, 60),
		children: [item("tool:builtin:bash", "pi", true, 40), item("tool:builtin:read", "pi", true, 20)],
	};
	const piItems = [item("base-prompt", "pi", true, 100), builtinTools, item("skills", "pi", true, 40)];
	const extensionItems = [item("web_search", "npm:web", false, 30)];
	return {
		groups: [
			{ source: { id: "pi", label: "pi", native: true }, items: piItems, totalTokens: 200 },
			{ source: { id: "npm:web", label: "npm:web", native: false }, items: extensionItems, totalTokens: 30 },
		],
		totalTokens: 230,
	};
}

test("buildInjectionRows flattens groups and separates the snapshot total", () => {
	const rows = buildInjectionRows(snapshot());

	assert.deepEqual(
		rows.map((row) => [row.kind, row.kind === "item" ? row.itemId : undefined, row.depth]),
		[
			["group", undefined, 0],
			["item", "base-prompt", 1],
			["item", "tool:builtin", 1],
			["item", "tool:builtin:bash", 2],
			["item", "tool:builtin:read", 2],
			["item", "skills", 1],
			["group", undefined, 0],
			["item", "web_search", 1],
			["separator", undefined, 0],
			["total", undefined, 0],
		],
	);
	const basePromptRow = rows[1];
	assert.equal(basePromptRow?.kind, "item");
	if (basePromptRow?.kind === "item") {
		assert.equal(basePromptRow.itemId, "base-prompt");
		assert.equal(basePromptRow.isLast, false);
	}
	const firstToolChild = rows[3];
	assert.equal(firstToolChild?.kind, "item");
	if (firstToolChild?.kind === "item") {
		assert.equal(firstToolChild.isLast, false);
		assert.equal(firstToolChild.parentContinues, true);
	}
	const finalToolChild = rows[4];
	assert.equal(finalToolChild?.kind, "item");
	if (finalToolChild?.kind === "item") {
		assert.equal(finalToolChild.isLast, true);
		assert.equal(finalToolChild.parentContinues, true);
	}
	const finalPiItem = rows[5];
	assert.equal(finalPiItem?.kind, "item");
	if (finalPiItem?.kind === "item") assert.equal(finalPiItem.isLast, true);
	assert.equal(rows.at(-1)?.tokens, 230);
});

test("collectItemsById indexes every snapshot item including children", () => {
	const items = collectItemsById(snapshot());

	assert.deepEqual(
		[...items.keys()].sort(),
		["base-prompt", "skills", "tool:builtin", "tool:builtin:bash", "tool:builtin:read", "web_search"],
	);
	assert.equal(items.get("tool:builtin:read")?.tokens, 20);
});

test("PreviewScroller clamps scrolling to the wrapped extent", () => {
	const scroller = new PreviewScroller();
	scroller.setExtent(20, 6);

	assert.equal(scroller.hasOverflow, true);
	assert.equal(scroller.visibleEnd, 6);
	assert.equal(scroller.scrollBy(-1), false);
	assert.equal(scroller.scrollBy(3), true);
	assert.equal(scroller.offset, 3);

	scroller.page(1);
	assert.equal(scroller.offset, 8);
	assert.equal(scroller.scrollTo(999), true);
	assert.equal(scroller.offset, scroller.maxOffset);
	assert.equal(scroller.maxOffset, 14);
	assert.equal(scroller.visibleEnd, 20);

	// Re-declaring a smaller extent (narrower wrap) keeps the offset valid.
	scroller.setExtent(10, 6);
	assert.equal(scroller.offset, 4);
	assert.equal(scroller.visibleEnd, 10);

	scroller.reset();
	assert.equal(scroller.offset, 0);
});

test("ListNavigator keeps the selection inside the scroll window", () => {
	const navigator = new ListNavigator(10, 4);

	assert.equal(navigator.moveBy(-1), false);
	assert.equal(navigator.moveBy(5), true);
	assert.equal(navigator.selected, 5);
	assert.equal(navigator.offset, 2);

	assert.equal(navigator.moveTo(0), true);
	assert.equal(navigator.offset, 0);

	navigator.page(1);
	assert.equal(navigator.selected, 3);
	navigator.moveTo(9);
	assert.equal(navigator.offset, 6);
	assert.equal(navigator.hasOverflow, true);

	navigator.setVisibleCount(12);
	assert.equal(navigator.offset, 0);
	assert.equal(navigator.windowSize, 10);
	assert.equal(navigator.hasOverflow, false);
});

test("ListNavigator skips non-selectable trailing rows while scrolling them into view", () => {
	const navigator = new ListNavigator(7, 3, 5);

	assert.equal(navigator.selectableCount, 5);
	assert.equal(navigator.selectedOrdinal, 0);
	assert.equal(navigator.moveTo(5), true);
	assert.equal(navigator.selected, 4);
	assert.equal(navigator.selectedOrdinal, 4);
	assert.equal(navigator.offset, 4);
	assert.equal(navigator.moveBy(1), false);
});

test("row status distinguishes saved changes from request-only additions, edits, and mixed changes", () => {
	const saved: InjectionItem = { ...item("saved", "pi", true, 10), diff: { added: 4, removed: 0 },
		editors: [{ type: "extension", source: { id: "ext", label: "npm:web", native: false } }] };
	const mixed: InjectionItem = { ...item("mixed", "pi", true, 10), diff: { added: 10, removed: 0 },
		requestOnly: true, savedChange: true };
	const added: InjectionItem = { ...item("added", "pi", true, 5), requestOnly: true, sessionOriginal: false };
	const edited: InjectionItem = { ...item("edited", "pi", true, 5), requestOnly: true };
	const children = [saved, mixed, added, edited];
	const prompt: InjectionItem = { ...item("base-prompt", "pi", true, 30), children, diff: { added: 14, removed: 0 } };
	const rows = buildInjectionRows({ groups: [{ source: prompt.source, items: [prompt], totalTokens: 30,
		diff: prompt.diff }], totalTokens: 30 });
	assert.deepEqual(rows.filter((row) => row.kind === "group" || row.kind === "item").map((row) => row.scope),
		["partly", "partly", "saved", "saved-and-edit", "request-new", "request-edit"]);
	const itemRows = rows.filter((row) => row.kind === "item");
	assert.equal(itemRows[0]?.editors, undefined, "parents do not repeat their children's editors");
	assert.deepEqual(itemRows[1]?.editors, saved.editors);
	assert.deepEqual(itemRows[2]?.editors, [{ type: "unknown" }], "pi is an affected source, never an editor");
});

test("row status includes request-only removals of session-only children and never guesses tool editors", () => {
	const saved: InjectionItem = { ...item("saved", "pi", true, 5), diff: { added: 3, removed: 0 } };
	const parent: InjectionItem = { ...item("parent", "pi", true, 5), children: [saved],
		diff: { added: 3, removed: 10 } };
	const tool: InjectionItem = { ...item("tool", "npm:web", false, 5), kind: "tool", requestOnly: true,
		change: "modified", diff: { added: 1, removed: 1 } };
	const rows = buildInjectionRows({ groups: [
		{ source: parent.source, items: [parent], totalTokens: 5, diff: parent.diff },
		{ source: tool.source, items: [tool], totalTokens: 5, diff: tool.diff },
	], totalTokens: 10 });
	assert.equal(rows[1]?.kind === "item" ? rows[1].scope : undefined, "partly");
	assert.equal(rows[3]?.kind === "group" ? rows[3].scope : undefined, "request");
	assert.deepEqual(rows[4]?.kind === "item" ? rows[4].editors : undefined, [{ type: "unknown" }]);
});

test("row status leaves diff-only changes out of groups and shows them as saved or partly request-only", () => {
	const tool = { ...item("tool", "npm:web", false, 5), kind: "tool" as const };
	const saved: InjectionItem = { ...item("prompt-lines", "npm:web", false, 0), diffOnly: true,
		diff: { added: 10, removed: 0 }, savedChange: true };
	const mixed: InjectionItem = { ...saved, id: "mixed", requestOnly: true };
	const forced: InjectionItem = { ...item("forced", "pi", true, 10), change: "forced" };
	const rows = buildInjectionRows({ groups: [
		{ source: tool.source, items: [tool, saved, mixed], totalTokens: 5 },
		{ source: forced.source, items: [forced], totalTokens: 10 },
	], totalTokens: 15 });
	assert.deepEqual(rows.filter((row) => row.kind === "group" || row.kind === "item").map((row) => row.scope),
		[undefined, undefined, "saved", "partly", "request", "request-edit"]);
	for (const row of rows) {
		if (row.kind === "item" && row.diffOnly === true) {
			assert.equal(row.editors, undefined, "a diff-only row explains accounting instead of repeating its source");
		}
	}
});

test("unattributed message and payload rows are leaves with unknown editors, and extension tools carry tool:", () => {
	const unattributed = { id: "aggregate:extensions", label: "unattributed", native: false };
	const tool: InjectionItem = { ...item("tool:unattributed:grep", unattributed.id, false, 5), kind: "tool",
		label: "grep" };
	const messages: InjectionItem = { ...item("messages", unattributed.id, false, 9), kind: "message",
		label: "messages (2)", requestOnly: true, diff: { added: 4, removed: 6 } };
	const saved: InjectionItem = { ...messages, id: "saved", requestOnly: undefined, diff: undefined };
	const payload: InjectionItem = { ...item("payload-changes", unattributed.id, false, 3), kind: "payload-change",
		label: "payload changes (2)", diff: { added: 3, removed: 1 } };
	const builtin: InjectionItem = { ...item("tool:builtin", "pi", true, 4), kind: "tool",
		children: [{ ...item("tool:builtin:read", "pi", true, 4), kind: "tool", label: "read" }] };
	const rows = buildInjectionRows({ groups: [
		{ source: builtin.source, items: [builtin], totalTokens: 4 },
		{ source: unattributed, items: [tool, messages, payload], totalTokens: 17 },
	], totalTokens: 21 }).filter((row) => row.kind === "item" || row.kind === "group");
	assert.deepEqual(rows.map((row) => [row.kind === "item" ? row.itemId : row.kind,
		row.kind === "item" ? row.labelPrefix : undefined, row.scope]), [
		["group", undefined, undefined],
		["tool:builtin", undefined, undefined],
		["tool:builtin:read", undefined, undefined],
		["group", undefined, "request"],
		["tool:unattributed:grep", "tool:", undefined],
		["messages", undefined, "request"],
		["payload-changes", undefined, "payload"],
	], "every message change is only in this request; payload changes only in the payload");
	for (const row of rows.slice(-2)) {
		assert.deepEqual(row.kind === "item" ? row.editors : undefined, [{ type: "unknown" }]);
	}
	const unchanged = buildInjectionRows({ groups: [
		{ source: unattributed, items: [saved], totalTokens: 9 },
	], totalTokens: 9 });
	const savedRow = unchanged.find((row) => row.kind === "item");
	assert.deepEqual([savedRow?.scope, savedRow?.editors], [undefined, undefined],
		"an unchanged messages row has no change or editor status");
});

/** Filter by a plain substring, the way the view compares labels and content. */
function filtered(
	mode: InjectionFilterMode,
	query: string,
	content: (item: InjectionItem) => string = (entry) => entry.text,
	source: InjectionSnapshot = snapshot(),
) {
	return { source, result: filterInjections(source, {
		mode,
		nameMatches: (label) => label.includes(query),
		contentMatches: (entry) => content(entry).includes(query),
	}) };
}

/** Kind, label, and matched flag of every row a filter leaves. */
function rowSummary(result: ReturnType<typeof filtered>): Array<[string, string, boolean]> {
	return buildInjectionRows(result.source, result.result)
		.filter((row) => row.kind === "group" || row.kind === "item")
		.map((row) => [row.kind, row.label, row.matched === true]);
}

test("filterInjections keeps a name match's ancestors as unmatched context", () => {
	assert.deepEqual(rowSummary(filtered("name", "bash")), [
		["group", "pi", false],
		["item", "tool:builtin", false],
		["item", "tool:builtin:bash", true],
	]);
});

test("filterInjections keeps the whole subtree of a matching group or item", () => {
	assert.deepEqual(rowSummary(filtered("name", "tool:builtin")).map(([, label, matched]) => [label, matched]), [
		["pi", false],
		["tool:builtin", true],
		["tool:builtin:bash", true],
		["tool:builtin:read", true],
	]);
	assert.deepEqual(rowSummary(filtered("name", "npm:")), [
		["group", "npm:web", true],
		["item", "web_search", false],
	]);
	// Rows inside a matching group still count as matches when their own label matches.
	assert.deepEqual(rowSummary(filtered("name", "web")), [
		["group", "npm:web", true],
		["item", "web_search", true],
	]);
});

test("filterInjections matches content through children, not their concatenated parent", () => {
	const texts: Record<string, string> = {
		"tool:builtin": "runs bash and reads files",
		"tool:builtin:bash": "runs bash",
		"tool:builtin:read": "reads files",
		"skills": "unrelated",
	};
	const content = (entry: InjectionItem) => texts[entry.id] ?? "";
	assert.deepEqual(rowSummary(filtered("content", "bash", content)), [
		["group", "pi", false],
		["item", "tool:builtin", false],
		["item", "tool:builtin:bash", true],
	]);

	// Content only the aggregate carries keeps it alone, without unrelated children.
	texts["tool:builtin"] = "aggregate-only notes";
	assert.deepEqual(rowSummary(filtered("content", "aggregate-only", content)), [
		["group", "pi", false],
		["item", "tool:builtin", true],
	]);
	// Group labels are names, so content mode never matches them.
	assert.deepEqual(rowSummary(filtered("content", "npm:web", content)), []);
});

test("filterInjections leaves estimates, diffs, change scopes, and the snapshot total unchanged", () => {
	const { source, result } = filtered("name", "bash");
	const rows = buildInjectionRows(source, result);
	assert.equal(rows.at(-1)?.tokens, 230);
	assert.deepEqual(rows.filter((row) => row.kind !== "separator" && row.kind !== "total").map((row) => row.tokens),
		[200, 60, 40]);
	assert.deepEqual(buildInjectionRows(source, filtered("name", "missing").result).map((row) => row.kind),
		["separator", "total"]);

	// Hiding a changed parent's other children must not read as a request-only removal.
	const saved: InjectionItem = { ...item("saved", "pi", true, 5), diff: { added: 3, removed: 0 } };
	const other: InjectionItem = { ...item("other", "pi", true, 5), diff: { added: 2, removed: 0 } };
	const parent: InjectionItem = { ...item("parent", "pi", true, 10), children: [saved, other],
		diff: { added: 5, removed: 0 } };
	const changed: InjectionSnapshot = { groups: [{ source: parent.source, items: [parent], totalTokens: 10,
		diff: parent.diff }], totalTokens: 10 };
	const scopes = (rows: ReturnType<typeof buildInjectionRows>) => rows
		.filter((row) => row.kind === "group" || row.kind === "item")
		.map((row) => [row.label, row.scope, row.diff]);
	const unfiltered = new Map(scopes(buildInjectionRows(changed)).map(([label, ...rest]) => [label, rest]));
	const kept = scopes(buildInjectionRows(changed, filtered("name", "saved", undefined, changed).result));
	assert.deepEqual(kept.map(([label]) => label), ["pi", "parent", "saved"]);
	for (const [label, ...rest] of kept) assert.deepEqual(rest, unfiltered.get(label), `${String(label)} keeps its status`);
});

test("PreviewScroller.reveal leaves visible lines alone and scrolls hidden ones into context", () => {
	const scroller = new PreviewScroller();
	scroller.setExtent(100, 10);
	assert.equal(scroller.reveal(5, 2), false);
	assert.equal(scroller.reveal(40, 2), true);
	assert.equal(scroller.offset, 38);
	assert.equal(scroller.reveal(99, 2), true);
	assert.equal(scroller.offset, 90, "clamped to the last full page");
	assert.equal(scroller.reveal(1, 2), true);
	assert.equal(scroller.offset, 0);
});
