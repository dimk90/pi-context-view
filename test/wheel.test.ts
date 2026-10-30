import assert from "node:assert/strict";
import { test } from "node:test";

import type { TUI } from "@earendil-works/pi-tui";

import { DEFAULT_WHEEL_SCROLL_LINES, readWheelScrollLines } from "../src/ui/wheel.ts";

/** Stand-in for the TUI object pi hands to a custom view, with an arbitrary wheel step. */
function tuiWithWheelScrollLines(lines: unknown): TUI {
	return { wheelScrollLines: lines } as unknown as TUI;
}

test("readWheelScrollLines honors pi's own step and falls back when it is unreadable", () => {
	assert.equal(DEFAULT_WHEEL_SCROLL_LINES, 3);
	assert.equal(readWheelScrollLines(tuiWithWheelScrollLines(4)), 4);
	assert.equal(readWheelScrollLines(tuiWithWheelScrollLines(1)), 1);
	assert.equal(readWheelScrollLines(tuiWithWheelScrollLines(2.7)), 2);

	// A pi without the private field, or with an unusable value, must not scroll by zero or backwards
	assert.equal(readWheelScrollLines(tuiWithWheelScrollLines(undefined)), DEFAULT_WHEEL_SCROLL_LINES);
	assert.equal(readWheelScrollLines(tuiWithWheelScrollLines("4")), DEFAULT_WHEEL_SCROLL_LINES);
	assert.equal(readWheelScrollLines(tuiWithWheelScrollLines(Number.NaN)), DEFAULT_WHEEL_SCROLL_LINES);
	assert.equal(
		readWheelScrollLines(tuiWithWheelScrollLines(Number.POSITIVE_INFINITY)),
		DEFAULT_WHEEL_SCROLL_LINES,
	);
	assert.equal(readWheelScrollLines(tuiWithWheelScrollLines(0)), 1);
	assert.equal(readWheelScrollLines(tuiWithWheelScrollLines(-3)), 1);
});
