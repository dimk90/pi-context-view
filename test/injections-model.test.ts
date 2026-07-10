import assert from "node:assert/strict";
import { test } from "node:test";

import type { InitialSnapshot, InjectionItem } from "../src/model.ts";
import { buildInjectionRows, ListNavigator } from "../src/ui/injections-model.ts";

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
	const piItems = [item("base-prompt", "pi", true, 100), item("skills", "pi", true, 40)];
	const extensionItems = [item("web_search", "npm:web", false, 30)];
	return {
		origin: "synthetic-probe",
		capturedAt: new Date("2026-07-10T12:00:00Z"),
		groups: [
			{ source: { id: "pi", label: "pi", native: true }, items: piItems, totalTokens: 140 },
			{ source: { id: "npm:web", label: "npm:web", native: false }, items: extensionItems, totalTokens: 30 },
		],
		totalTokens: 170,
	};
}

test("buildInjectionRows flattens groups, items, and total in order", () => {
	const rows = buildInjectionRows(snapshot());

	assert.deepEqual(
		rows.map((row) => [row.kind, row.label, row.depth]),
		[
			["group", "pi", 0],
			["item", "base-prompt", 1],
			["item", "skills", 1],
			["group", "npm:web", 0],
			["item", "web_search", 1],
			["total", "TOTAL", 0],
		],
	);
	assert.equal(rows.at(-1)?.tokens, 170);
	assert.equal(rows[1]?.itemId, "base-prompt");
	assert.equal(rows[0]?.itemId, undefined);
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
