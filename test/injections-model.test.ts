import assert from "node:assert/strict";
import { test } from "node:test";

import type { InitialSnapshot, InjectionItem } from "../src/model.ts";
import {
	buildInjectionRows,
	collectItemsById,
	filterInjections,
	type InjectionFilterMode,
	ListNavigator,
	PreviewScroller,
} from "../src/ui/injections-model.ts";

function item(id: string, sourceId: string, native: boolean, tokens: number): InjectionItem {
	return {
		id,
		phase: "initial",
		kind: "message",
		source: { id: sourceId, label: sourceId, native },
		label: id,
		chars: tokens * 4,
		tokens,
		text: id,
	};
}

function snapshot(): InitialSnapshot {
	const builtinTools: InjectionItem = {
		...item("tool:builtin", "pi", true, 60),
		children: [item("tool:builtin:bash", "pi", true, 40), item("tool:builtin:read", "pi", true, 20)],
	};
	const piItems = [item("base-prompt", "pi", true, 100), builtinTools, item("skills", "pi", true, 40)];
	const extensionItems = [item("web_search", "npm:web", false, 30)];
	return {
		origin: "synthetic-probe",
		capturedAt: new Date("2026-07-10T12:00:00Z"),
		groups: [
			{ source: { id: "pi", label: "pi", native: true }, items: piItems, totalTokens: 200 },
			{ source: { id: "npm:web", label: "npm:web", native: false }, items: extensionItems, totalTokens: 30 },
		],
		totalTokens: 230,
	};
}

test("buildInjectionRows flattens groups and separates the Initial total", () => {
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
			["total", "TOTAL", 0],
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

/** Filter by a plain substring, the way the view compares labels and content. */
function filtered(mode: InjectionFilterMode, query: string, content: (item: InjectionItem) => string = (entry) => entry.text) {
	return filterInjections(snapshot(), {
		mode,
		nameMatches: (label) => label.includes(query),
		contentMatches: (entry) => content(entry).includes(query),
	});
}

/** Kind, label, and matched flag of every row a filter leaves. */
function rowSummary(result: ReturnType<typeof filtered>): Array<[string, string, boolean]> {
	return buildInjectionRows(result.snapshot, result.matched)
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

test("filterInjections leaves estimates and the Initial total unchanged", () => {
	const result = filtered("name", "bash");
	assert.equal(result.snapshot.totalTokens, 230);
	assert.equal(result.snapshot.groups[0]?.totalTokens, 200);
	assert.equal(result.snapshot.groups[0]?.items[0]?.tokens, 60);
	assert.deepEqual(filtered("name", "missing").snapshot.groups, []);
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
