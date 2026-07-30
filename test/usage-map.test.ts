import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContextUsageSnapshot, UsageCategory } from "../src/model.ts";
import { buildUsageMap, calculateFitMapScale } from "../src/ui/usage-map.ts";

/** Minimal usage fixture for proportional map tests. */
function usage(
	categories: UsageCategory[],
	reported: ContextUsageSnapshot["reported"],
	autoCompactReserveTokens?: number,
): ContextUsageSnapshot {
	return {
		computedAt: new Date("2026-07-11T12:00:00Z"),
		reported,
		categories,
		estimatedTokens: categories.reduce((sum, category) => sum + category.tokens, 0),
		autoCompactReserveTokens,
	};
}

test("calculateFitMapScale adds headroom and rounds upward within its floor and window cap", () => {
	assert.equal(calculateFitMapScale(
		usage([{ id: "messages", label: "Messages", tokens: 100_000 }], { contextWindow: 1_000_000 }),
	), 120_000);
	assert.equal(calculateFitMapScale(
		usage([{ id: "messages", label: "Messages", tokens: 43_800 }], { contextWindow: 1_000_000 }),
	), 51_000);
	assert.equal(calculateFitMapScale(
		usage([{ id: "messages", label: "Messages", tokens: 200_000 }], { contextWindow: 1_000_000 }),
	), 230_000);
	assert.equal(calculateFitMapScale(
		usage([{ id: "messages", label: "Messages", tokens: 1 }], { contextWindow: 1_000_000 }),
	), 10_000);
	assert.equal(calculateFitMapScale(
		usage([{ id: "messages", label: "Messages", tokens: 1 }], { contextWindow: 8_000 }),
	), 8_000);
	assert.equal(calculateFitMapScale(
		usage([{ id: "messages", label: "Messages", tokens: 900_000 }], { contextWindow: 1_000_000 }),
	), 1_000_000);
	assert.equal(calculateFitMapScale(usage([], undefined)), undefined);
	assert.equal(calculateFitMapScale(usage([], { contextWindow: 0 })), undefined);
});

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

test("buildUsageMap changes only the denominator for a smaller anchored scale", () => {
	const fit = buildUsageMap(
		usage(
			[
				{ id: "first", label: "First", tokens: 25 },
				{ id: "second", label: "Second", tokens: 25 },
			],
			{ contextWindow: 100 },
		),
		10,
		1,
		60,
	);

	assert.ok(fit !== undefined);
	assert.deepEqual(fit.cells, [
		{ categoryId: "first", fill: "full" },
		{ categoryId: "first", fill: "full" },
		{ categoryId: "first", fill: "full" },
		{ categoryId: "first", fill: "full" },
		{ categoryId: "second", fill: "full" },
		{ categoryId: "second", fill: "full" },
		{ categoryId: "second", fill: "full" },
		{ categoryId: "second", fill: "full" },
		{ categoryId: "second", fill: "partial" },
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

test("buildUsageMap marks trailing auto-compact buffer cells after free space", () => {
	const map = buildUsageMap(
		usage([{ id: "messages", label: "Messages", tokens: 40 }], { contextWindow: 100 }, 20),
		10,
		1,
	);

	assert.ok(map !== undefined);
	assert.deepEqual(map.cells.map((cell) => cell.fill), [
		"full",
		"full",
		"full",
		"full",
		"free",
		"free",
		"free",
		"free",
		"buffer",
		"buffer",
	]);
	assert.ok(map.cells.slice(8).every((cell) => cell.categoryId === undefined));
});

test("buildUsageMap leaves the true-window buffer beyond a smaller Fit range", () => {
	const map = buildUsageMap(
		usage([{ id: "messages", label: "Messages", tokens: 40 }], { contextWindow: 100 }, 100),
		10,
		1,
		50,
	);

	assert.ok(map !== undefined);
	assert.deepEqual(map.cells.map((cell) => cell.fill), [
		"full",
		"full",
		"full",
		"full",
		"full",
		"full",
		"full",
		"full",
		"free",
		"free",
	]);
	assert.ok(map.cells.every((cell) => cell.fill !== "buffer"));
});

test("buildUsageMap shrinks the buffer when content grows into the reserve", () => {
	// 90 occupied + 20 reserve overflows the window: only the remaining 10 tokens can be buffer.
	const map = buildUsageMap(
		usage([{ id: "messages", label: "Messages", tokens: 90 }], { contextWindow: 100 }, 20),
		10,
		1,
	);

	assert.ok(map !== undefined);
	assert.deepEqual(map.cells.slice(8).map((cell) => cell.fill), ["full", "buffer"]);
});

test("buildUsageMap omits buffer cells when auto-compaction is disabled", () => {
	const map = buildUsageMap(
		usage([{ id: "messages", label: "Messages", tokens: 40 }], { contextWindow: 100 }),
		10,
		1,
	);

	assert.ok(map !== undefined);
	assert.ok(map.cells.every((cell) => cell.fill !== "buffer"));
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
	assert.equal(buildUsageMap(usage([], { contextWindow: 100 }), 5, 2, Number.NaN), undefined);
});
