/**
 * Shared pi-native fullscreen-view layout helpers: indentation constants,
 * terminal-height viewport math, width fitting, and hint-row formatting used
 * by the Usage and Injections views. Pure string/number logic — no pi access.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Two-space indent for descriptions, counters, hints, and body content. */
export const BODY_INDENT = "  ";
export const DEFAULT_TERMINAL_ROWS = 24;

/** How many content rows fit and whether an overflow indicator is needed. */
export interface Viewport {
	visibleCount: number;
	showScroll: boolean;
}

/** Divide terminal rows between content and an overflow indicator. */
export function calculateViewport(
	itemCount: number,
	terminalRows: number,
	fixedLineCount: number,
	extraLineCount = 0,
): Viewport {
	const available = Math.max(1, terminalRows - fixedLineCount - extraLineCount);
	const showScroll = itemCount > available && available > 1;
	return {
		visibleCount: Math.max(1, available - (showScroll ? 1 : 0)),
		showScroll,
	};
}

/** Keep emergency short-terminal output bounded while preserving both borders. */
export function fitToTerminalHeight(lines: string[], terminalRows: number, border: string): string[] {
	if (lines.length <= terminalRows) return lines;
	if (terminalRows === 1) return [border];
	return [...lines.slice(0, terminalRows - 1), border];
}

/** Normalize an injected terminal-height reading to a usable positive integer. */
export function normalizeTerminalRows(rows: number): number {
	return Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : DEFAULT_TERMINAL_ROWS;
}

/** Truncate one rendered line to the supplied width. */
export function fitLine(line: string, width: number): string {
	return truncateToWidth(line, width, "…");
}

/** Wrap plain dialog-description text with semantic color and an indented continuation column. */
export function wrapDescriptionLines(
	theme: Theme,
	text: string,
	color: ThemeColor,
	width: number,
): string[] {
	const indentWidth = Math.min(BODY_INDENT.length, Math.max(0, width - 1));
	const indent = BODY_INDENT.slice(0, indentWidth);
	const contentWidth = Math.max(1, width - indentWidth);
	const wrapped = wrapTextWithAnsi(text, contentWidth);
	return (wrapped.length === 0 ? [""] : wrapped).map((line) =>
		truncateToWidth(theme.fg(color, `${indent}${line}`), width, "")
	);
}

/** Spread left and right content across the width, truncating the left side on overlap. */
export function spreadLine(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap < 1) {
		return fitLine(`${truncateToWidth(left, Math.max(1, width - visibleWidth(right) - 2), "…")} ${right}`, width);
	}
	return `${left}${" ".repeat(gap)}${right}`;
}

/** Pi-style hint row: two-space indent, `key description` pairs joined by ` · `. */
export function hintRow(theme: Theme, hints: ReadonlyArray<readonly [string, string]>): string {
	const separator = theme.fg("dim", " · ");
	return `${BODY_INDENT}${hints.map(([key, description]) => hint(theme, key, description)).join(separator)}`;
}

/** Pi-style hint: dim key, slightly brighter (muted) description. */
function hint(theme: Theme, key: string, description: string): string {
	return theme.fg("dim", key) + theme.fg("muted", ` ${description}`);
}
