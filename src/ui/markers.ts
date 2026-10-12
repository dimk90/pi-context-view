/**
 * State markers rendered after a token estimate, token diffs, and the bullet
 * preview legend and selected-row status fields that explain them. Markers
 * name how pi accounts for a part rather than a usage category, so their colors are fixed instead
 * of configurable. Pure string logic shared by both views.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { RequestChange, TokenDiff } from "../model.ts";
import { BODY_INDENT, fitLine } from "./layout.ts";

/** Dim separator introducing a state marker after the estimate it explains. */
const MARKER_SEPARATOR = " · ";

/** Markers a frame can show, in the fixed order their legend bullets render. */
const MARKER_ORDER = ["highlighted", "guess", "dropped", "moved", "forced", "diff", "request-only"] as const;

/** One marked state a description bullet explains; `diff` stands for `+N`/`-N` token diffs. */
export type ContextMarker = (typeof MARKER_ORDER)[number];

/** The state of one part or row that markers show; only a `forced` change has a marker of its own. */
export interface MarkedState {
	readonly dropped?: boolean;
	readonly moved?: boolean;
	readonly change?: RequestChange;
	readonly requestOnly?: boolean;
}

/**
 * What the token diffs of a preview compare with:
 *   default-prompt     pi's default prompt, for contributions under pi
 *   session            the session, for extension tools and messages
 *   captured-request   the captured request, for payload changes
 */
export type DiffBase = "default-prompt" | "session" | "captured-request";

/** Preview diff-legend sentences by base; the fallback sentence names none. */
const DIFF_EXPLANATIONS: Record<DiffBase | "list", string> = {
	list: " Tokens extensions added or removed.",
	"default-prompt": " Tokens extensions added or removed, compared with pi’s default prompt.",
	session: " Tokens extensions added or removed, compared with the session.",
	"captured-request": " Tokens added or removed, compared with the captured request.",
};

/** Bullet marker and hanging indent of a legend entry, both two columns wide. */
const BULLET_MARKER = "- ";
const BULLET_INDENT = `${BODY_INDENT}  `;

/** Keyword opening a legend bullet, its fixed color, and the sentence it heads. */
interface MarkerLegend {
	readonly keyword: string;
	readonly color: ThemeColor;
	readonly explanation: string;
}

/** One fixed sentence per marker, independent of the others. */
const MARKER_LEGENDS: Record<Exclude<ContextMarker, "diff">, MarkerLegend> = {
	highlighted: {
		keyword: "Highlighted",
		// Extension lines carry this color, so the bullet opens in it too.
		color: "syntaxNumber",
		explanation: " parts are injected by extensions into pi’s system prompt.",
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
		explanation: " blocks appear in a different position in the system prompt than usual.",
	},
	forced: {
		keyword: "Forced",
		color: "warning",
		explanation: " prompts replace pi’s system prompt for this request.",
	},
	"request-only": {
		keyword: "Request-Only",
		color: "dim",
		explanation: " Includes changes made only in this request, not saved in the session.",
	},
};

/** Markers the Injections status bar explains on the selected row; its Change field covers diffs and Request-Only. */
export type StatusMarker = "dropped" | "moved" | "forced";

/** Status-bar explanation of each marker, about the one selected row. */
const MARKER_STATUS: Record<StatusMarker, string> = {
	dropped: "a custom system prompt replaced this part; counted nowhere",
	moved: "in a different position in the system prompt than usual",
	forced: "an extension’s prompt replaced pi’s system prompt for this request",
};

/** Themed marker naming content pi never sent, for a preview subheader or a hierarchy row. */
export function droppedMarker(theme: Theme): string {
	return stateMarker(theme, MARKER_LEGENDS.dropped);
}

/** Themed marker naming content pi sends from elsewhere in the prompt than it wrote it. */
export function movedMarker(theme: Theme): string {
	return stateMarker(theme, MARKER_LEGENDS.moved);
}

/** `+N` with thousands separators; the plain text of a diff column. */
export function formatDiffAdded(tokens: number): string {
	return `+${tokens.toLocaleString("en-US")}`;
}

/** `-N` with thousands separators; the plain text of a diff column. */
export function formatDiffRemoved(tokens: number): string {
	return `-${tokens.toLocaleString("en-US")}`;
}

/**
 * A token diff after an estimate in preview metadata, behind a dim separator:
 * `+N` in `toolDiffAdded` and `-N` in `toolDiffRemoved`, leaving out a zero
 * side. Empty without a diff.
 */
export function diffMarker(theme: Theme, diff: TokenDiff | undefined): string {
	const sides: string[] = [];
	if (diff !== undefined && diff.added > 0) sides.push(theme.fg("toolDiffAdded", formatDiffAdded(diff.added)));
	if (diff !== undefined && diff.removed > 0) sides.push(theme.fg("toolDiffRemoved", formatDiffRemoved(diff.removed)));
	return sides.length === 0 ? "" : `${theme.fg("dim", MARKER_SEPARATOR)}${sides.join(" ")}`;
}

/** Themed marker naming a request that carried an extension's forced prompt instead of pi's. */
export function forcedMarker(theme: Theme): string {
	return stateMarker(theme, MARKER_LEGENDS.forced);
}

/**
 * Every state marker of one part, in legend order: dropped, moved, forced,
 * then request-only. Empty when the part carries none. Token diffs, not
 * markers, show what an added, modified, or deleted part changed.
 */
export function stateMarkers(theme: Theme, part: MarkedState): string {
	let markers = part.dropped === true ? droppedMarker(theme) : part.moved === true ? movedMarker(theme) : "";
	if (part.change === "forced") markers += forcedMarker(theme);
	if (part.requestOnly === true) markers += stateMarker(theme, MARKER_LEGENDS["request-only"]);
	return markers;
}

/** Markers one part carries, including its token diff, for the legend of the frame showing it. */
export function partMarkers(part: MarkedState & { readonly diff?: TokenDiff }): ContextMarker[] {
	const markers: ContextMarker[] = [];
	if (part.dropped === true) markers.push("dropped");
	if (part.moved === true) markers.push("moved");
	if (part.change === "forced") markers.push("forced");
	if (part.diff !== undefined && (part.diff.added > 0 || part.diff.removed > 0)) markers.push("diff");
	if (part.requestOnly === true) markers.push("request-only");
	return markers;
}

/** Themed suffix naming an owner this extension inferred rather than one pi reported. */
export function guessMarker(theme: Theme): string {
	const { color, keyword } = MARKER_LEGENDS.guess;
	return theme.fg(color, ` ${keyword}`);
}

/**
 * Description bullets explaining the markers one frame shows, in fixed order
 * and without duplicates. Callers pass only the markers actually visible there,
 * so a view never explains a state it does not render. `diffBase` names what
 * the preview's token diffs compare with; omitted, the bullet names no base.
 */
export function markerLegendLines(
	theme: Theme,
	markers: Iterable<ContextMarker>,
	width: number,
	diffBase?: DiffBase,
): string[] {
	const shown = new Set(markers);
	return MARKER_ORDER.filter((marker) => shown.has(marker)).flatMap((marker) => {
		if (marker === "diff") {
			const keyword = `${theme.fg("toolDiffAdded", "+N")} ${theme.fg("toolDiffRemoved", "-N")}`;
			return bulletLines(theme, keyword, DIFF_EXPLANATIONS[diffBase ?? "list"], width);
		}
		const legend = MARKER_LEGENDS[marker];
		return bulletLines(theme, theme.fg(legend.color, legend.keyword), legend.explanation, width);
	});
}

/**
 * Status-bar field explaining one marker of the selected row: the keyword in
 * the marker's fixed color, then a dim colon and explanation.
 */
export function markerStatusField(theme: Theme, marker: StatusMarker): string {
	const { color, keyword } = MARKER_LEGENDS[marker];
	return `${theme.fg(color, keyword)}${theme.fg("dim", `: ${MARKER_STATUS[marker]}`)}`;
}

/** One dim description bullet with a hanging indent, for a note that is not a marker legend. */
export function noteBulletLines(theme: Theme, text: string, width: number): string[] {
	return bulletLines(theme, "", text, width);
}

/** Dim separator plus the keyword in the one fixed color its legend bullet also opens with. */
function stateMarker(theme: Theme, legend: MarkerLegend): string {
	return `${theme.fg("dim", MARKER_SEPARATOR)}${theme.fg(legend.color, legend.keyword)}`;
}

/** One bullet: dim marker, styled keyword in the colors it explains, dim sentence, hanging indent. */
function bulletLines(theme: Theme, keyword: string, explanation: string, width: number): string[] {
	const text = `${keyword}${theme.fg("dim", explanation)}`;
	const wrapped = wrapTextWithAnsi(text, Math.max(1, width - BULLET_INDENT.length));
	const lead = `${BODY_INDENT}${theme.fg("dim", BULLET_MARKER)}`;
	return wrapped.map((line, index) => fitLine(`${index === 0 ? lead : BULLET_INDENT}${line}`, width));
}
