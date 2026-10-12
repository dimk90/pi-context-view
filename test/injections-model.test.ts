import assert from "node:assert/strict";
import { test } from "node:test";

import type { InjectionSnapshot, InjectionItem } from "../src/model.ts";
import { buildInjectionRows, collectItemsById, ListNavigator, PreviewScroller } from "../src/ui/injections-model.ts";

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
		rows.map((row) => [row.kind, row.label, row.depth]),
		[
			["group", "pi", 0],
			["item", "base-prompt", 1],
			["item", "tool:builtin", 1],
			["item", "tool:builtin:bash", 2],
			["item", "tool:builtin:read", 2],
			["item", "skills", 1],
			["group", "npm:web", 0],
			["item", "web_search", 1],
			["separator", "", 0],
			["total", "TOTAL (Prompt, Tools, Injections)", 0],
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
	assert.deepEqual(rows.map((row) => [row.label, row.kind === "item" ? row.labelPrefix : undefined, row.scope]), [
		["pi", undefined, undefined],
		["tool:builtin", undefined, undefined],
		["read", undefined, undefined],
		["unattributed", undefined, "request"],
		["grep", "tool:", undefined],
		["messages (2)", undefined, "request"],
		["payload changes (2)", undefined, "payload"],
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
