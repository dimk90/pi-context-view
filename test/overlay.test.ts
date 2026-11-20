import assert from "node:assert/strict";
import { test } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { type OverlayView, renderPadded } from "../src/ui/overlay.ts";
import { createTheme, stripSgr } from "./harness/frame.ts";

/** A view that frames `content` between plain borders and records the width it rendered at. */
function createFrameView(content: readonly string[]): OverlayView & { readonly widths: number[] } {
	const widths: number[] = [];
	return {
		widths,
		render: (width) => {
			widths.push(width);
			return ["-".repeat(width), ...content.map((line) => line.slice(0, width)), "-".repeat(width)];
		},
		topBorder: (width) => `[top ${width}]`,
		invalidate: () => {},
		dispose: () => {},
		handleInput: () => {},
		handleMouse: () => undefined,
	};
}

test("the overlay pads content on both sides and keeps the borders full width", () => {
	const view = createFrameView(["Title", "", "  body"]);
	const lines = renderPadded(view, createTheme(), 80).map(stripSgr);

	assert.deepEqual(view.widths, [76], "the view renders for the width between the side padding");
	assert.deepEqual(lines, ["[top 80]", "  Title", "", "    body", "─".repeat(80)]);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));
});

test("the overlay drops the padding when the content would get too narrow", () => {
	const view = createFrameView(["Title"]);
	const lines = renderPadded(view, createTheme(), 30);

	assert.deepEqual(view.widths, [30]);
	assert.deepEqual(lines, ["-".repeat(30), "Title", "-".repeat(30)], "the view's own frame is kept unchanged");
});

test("the overlay keeps a one-row emergency frame as the full-width bottom border", () => {
	const view: OverlayView = { ...createFrameView([]), render: (width) => ["-".repeat(width)] };

	assert.deepEqual(renderPadded(view, createTheme(), 80).map(stripSgr), ["─".repeat(80)]);
});
