/**
 * State markers rendered after a token estimate, and the bullet legend that
 * explains the ones a frame shows. Markers name how pi accounts for a part
 * rather than a usage category, so their colors are fixed instead of
 * configurable. Pure string logic shared by both views.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { BODY_INDENT, fitLine } from "./layout.ts";

/** Separator introducing a state marker after the estimate it explains. */
const MARKER_SEPARATOR = " · ";

/** Markers a frame can show, in the fixed order their legend bullets render. */
const MARKER_ORDER = ["highlighted", "guess", "dropped", "moved"] as const;

/** One marked state a description bullet explains. */
export type ContextMarker = (typeof MARKER_ORDER)[number];

/** Bullet marker and hanging indent of a legend entry, both two columns wide. */
const BULLET_MARKER = "- ";
const BULLET_INDENT = `${BODY_INDENT}  `;

/** Keyword opening a legend bullet, its fixed color, and the sentence it heads. */
interface MarkerLegend {
	readonly keyword: string;
	readonly color: ThemeColor;
	readonly explanation: string;
}

/** One fixed sentence per marker: each states its own accounting, independent of the others. */
const MARKER_LEGENDS: Record<ContextMarker, MarkerLegend> = {
	highlighted: {
		keyword: "Highlighted",
		// Restored extension lines carry this color, so the bullet opens in it too.
		color: "syntaxNumber",
		explanation: " parts are injected by extensions into pi’s system prompt. They are excluded from the" +
			" System Prompt token count and included in the injecting extension’s count.",
	},
	guess: {
		keyword: "(guess)",
		color: "dim",
		explanation: " sources are inferred from the injected text itself.",
	},
	dropped: {
		keyword: "Dropped",
		color: "toolDiffRemoved",
		explanation: " parts were replaced by a custom system prompt and are counted nowhere.",
	},
	moved: {
		keyword: "Moved",
		color: "warning",
		explanation: " blocks sit outside the region pi renders them into and count normally.",
	},
};

/** Themed marker naming content pi never sent, for a preview subheader or a hierarchy row. */
export function droppedMarker(theme: Theme): string {
	return stateMarker(theme, MARKER_LEGENDS.dropped);
}

/** Themed marker naming content pi sends from elsewhere in the prompt than it wrote it. */
export function movedMarker(theme: Theme): string {
	return stateMarker(theme, MARKER_LEGENDS.moved);
}

/** Themed suffix naming an owner this extension inferred rather than one pi reported. */
export function guessMarker(theme: Theme): string {
	const { color, keyword } = MARKER_LEGENDS.guess;
	return theme.fg(color, ` ${keyword}`);
}

/**
 * Description bullets explaining the markers one frame shows, in fixed order
 * and without duplicates. Callers pass only the markers actually visible there,
 * so a view never explains a state it does not render.
 */
export function markerLegendLines(
	theme: Theme,
	markers: Iterable<ContextMarker>,
	width: number,
): string[] {
	const shown = new Set(markers);
	return MARKER_ORDER.filter((marker) => shown.has(marker))
		.flatMap((marker) => bulletLines(theme, MARKER_LEGENDS[marker], width));
}

/** Separator and keyword in the one fixed color its legend bullet also opens with. */
function stateMarker(theme: Theme, legend: MarkerLegend): string {
	return theme.fg(legend.color, `${MARKER_SEPARATOR}${legend.keyword}`);
}

/** One bullet: dim marker, keyword in the color it explains, dim sentence, hanging indent. */
function bulletLines(theme: Theme, legend: MarkerLegend, width: number): string[] {
	const text = `${theme.fg(legend.color, legend.keyword)}${theme.fg("dim", legend.explanation)}`;
	const wrapped = wrapTextWithAnsi(text, Math.max(1, width - BULLET_INDENT.length));
	const lead = `${BODY_INDENT}${theme.fg("dim", BULLET_MARKER)}`;
	return wrapped.map((line, index) => fitLine(`${index === 0 ? lead : BULLET_INDENT}${line}`, width));
}
