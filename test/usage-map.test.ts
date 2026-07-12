import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContextUsageSnapshot, UsageCategory } from "../src/model.ts";
import { buildUsageMap } from "../src/ui/usage-map.ts";

/** Minimal usage fixture for proportional map tests. */
function usage(
	categories: UsageCategory[],
	reported: ContextUsageSnapshot["reported"],
): ContextUsageSnapshot {
	return {
		computedAt: new Date("2026-07-11T12:00:00Z"),
		reported,
		categories,
		estimatedTokens: categories.reduce((sum, category) => sum + category.tokens, 0),
	};
}

test("buildUsageMap uses estimated category occupancy independently of reported tokens", () => {
	const map = buildUsageMap(
		usage(
			[
				{ id: "first", label: "First", tokens: 25 },
				{ id: "second", label: "Second", tokens: 25 },
			],
			{ tokens: 80, contextWindow: 100, percent: 80 },
		),
		10,
		1,
	);

	assert.ok(map !== undefined);
	assert.equal(map.columns, 10);
	assert.equal(map.rows, 1);
	assert.deepEqual(map.cells, [
		{ categoryId: "first", fill: "full" },
		{ categoryId: "first", fill: "full" },
		{ categoryId: "first", fill: "partial" },
		{ categoryId: "second", fill: "full" },
		{ categoryId: "second", fill: "full" },
		{ fill: "free" },
		{ fill: "free" },
		{ fill: "free" },
		{ fill: "free" },
		{ fill: "free" },
	]);
});

test("buildUsageMap works when pi usage is unknown", () => {
	const map = buildUsageMap(
		usage([{ id: "messages", label: "Messages", tokens: 45 }], { contextWindow: 100 }),
		10,
		1,
	);

	assert.ok(map !== undefined);
	assert.deepEqual(map.cells.slice(0, 5), [
		{ categoryId: "messages", fill: "full" },
		{ categoryId: "messages", fill: "full" },
		{ categoryId: "messages", fill: "full" },
		{ categoryId: "messages", fill: "full" },
		{ categoryId: "messages", fill: "partial" },
	]);
	assert.ok(map.cells.slice(5).every((cell) => cell.fill === "free"));
});

test("buildUsageMap clamps over-capacity usage and rejects unusable dimensions", () => {
	const full = buildUsageMap(
		usage([{ id: "messages", label: "Messages", tokens: 150 }], {
			tokens: 150,
			contextWindow: 100,
			percent: 150,
		}),
		5,
		2,
	);
	assert.ok(full !== undefined);
	assert.ok(full.cells.every((cell) => cell.fill === "full"));
	assert.equal(buildUsageMap(usage([], undefined), 5, 2), undefined);
	assert.equal(buildUsageMap(usage([], { contextWindow: 100 }), 0, 2), undefined);
});
