import assert from "node:assert/strict";
import { test } from "node:test";

import type { TUI } from "@earendil-works/pi-tui";

import { DEFAULT_WHEEL_SCROLL_LINES, parseWheelDirection, readWheelScrollLines } from "../src/ui/wheel.ts";

/** One X10 wheel report: `ESC [ M` plus offset-encoded button, column, and row bytes. */
function x10Report(button: number, column: number, row: number): string {
	return `\u001b[M${String.fromCharCode(button + 32, column + 33, row + 33)}`;
}

/** Stand-in for the TUI object pi hands to a custom view, with an arbitrary wheel step. */
function tuiWithWheelScrollLines(lines: unknown): TUI {
	return { wheelScrollLines: lines } as unknown as TUI;
}

test("parseWheelDirection decodes vertical SGR and X10 notches only", () => {
	assert.equal(parseWheelDirection("\u001b[<64;20;5M"), -1);
	assert.equal(parseWheelDirection("\u001b[<65;20;5M"), 1);

	// Modifier bits and the release form still describe a plain vertical notch.
	assert.equal(parseWheelDirection("\u001b[<69;1;1M"), 1, "shift + wheel down");
	assert.equal(parseWheelDirection("\u001b[<80;1;1m"), -1, "ctrl + wheel up");

	assert.equal(parseWheelDirection(x10Report(64, 19, 4)), -1);
	assert.equal(parseWheelDirection(x10Report(65, 19, 4)), 1);

	// Horizontal notches, plain buttons, keys, and text are not vertical scrolling.
	assert.equal(parseWheelDirection("\u001b[<66;20;5M"), undefined, "wheel left");
	assert.equal(parseWheelDirection("\u001b[<67;20;5M"), undefined, "wheel right");
	assert.equal(parseWheelDirection("\u001b[<0;20;5M"), undefined, "left button press");
	assert.equal(parseWheelDirection(x10Report(0, 19, 4)), undefined);
	assert.equal(parseWheelDirection("\u001b[B"), undefined);
	assert.equal(parseWheelDirection("j"), undefined);
	assert.equal(parseWheelDirection(""), undefined);
	assert.equal(parseWheelDirection("\u001b[<64;20;5M\u001b[<64;20;5M"), undefined, "unsplit burst");
});

test("readWheelScrollLines honors pi's own step and falls back when it is unreadable", () => {
	assert.equal(readWheelScrollLines(tuiWithWheelScrollLines(4)), 4);
	assert.equal(readWheelScrollLines(tuiWithWheelScrollLines(1)), 1);
	assert.equal(readWheelScrollLines(tuiWithWheelScrollLines(2.7)), 2);

	// A pi without the private field, or with an unusable value, must not scroll by zero or backwards.
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
