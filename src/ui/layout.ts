/**
 * Shared pi-native fullscreen-view helpers: indentation constants,
 * terminal-height viewport math, width fitting, hint-row formatting, and
 * step-navigation key matching used by the Usage and Injections views. Pure
 * string/number logic — no pi access.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Narrowest gap between the hints and a right-aligned hint, as wide as the hint separator. */
const RIGHT_HINT_GAP = 3;

/** Two-space indent for descriptions, counters, hints, and body content. */
export const BODY_INDENT = "  ";
export const DEFAULT_TERMINAL_ROWS = 24;
/** Blank columns on each side of the frame content; the borders stay full width. */
const FRAME_PADDING = 2;
/** Narrowest content width that keeps the frame padding; a narrower frame gives it up. */
const MIN_PADDED_CONTENT_WIDTH = 40;

/** How many content rows fit and whether an overflow indicator is needed. */
export interface Viewport {
	visibleCount: number;
	showScroll: boolean;
}

/** Hint description naming the modes a key switches between, with the active one bold and underlined. */
export interface ModeDescription {
	readonly modes: readonly string[];
	readonly active: string;
	/** Plain text after the modes, such as a unit. */
	readonly suffix?: string;
}

/** One hint pair; an optional hint is the first to go when the row is too narrow. */
export type Hint = readonly [key: string, description: string | ModeDescription, optional?: boolean];

/** A hint at the right edge of a hint row, shown as `key description: detail`. */
export interface RightHint {
	readonly key: string;
	readonly description: string;
	/** Current value of what the key changes; the first thing a narrow row drops. */
	readonly detail: string;
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
	if (lines.length <= terminalRows)
		return lines;
	if (terminalRows === 1)
		return [border];

	return [...lines.slice(0, terminalRows - 1), border];
}

/** Frame padding on each side for the width: none when the content would get too narrow. */
export function framePadding(width: number): number {
	return width - 2 * FRAME_PADDING >= MIN_PADDED_CONTENT_WIDTH ? FRAME_PADDING : 0;
}

/**
 * Give a frame rendered at the content width its side padding: content rows
 * gain the left padding, and the first and last rows, which are always the
 * borders, become the full-width `topBorder` and `border`. A one-row frame
 * holds only the bottom border.
 */
export function padFrame(lines: string[], padding: number, topBorder: string, border: string): string[] {
	if (padding === 0)
		return lines;
	if (lines.length <= 1)
		return lines.map(() => border);

	const indent = " ".repeat(padding);
	const content = lines.slice(1, -1).map((line) => line === "" ? "" : `${indent}${line}`);

	return [topBorder, ...content, border];
}

/** Normalize an injected terminal-height reading to a usable positive integer. */
export function normalizeTerminalRows(rows: number): number {
	return Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : DEFAULT_TERMINAL_ROWS;
}

/** Whether input requests one step backwards: Up or vim-style `k`. */
export function isStepBackKey(data: string): boolean {
	return matchesKey(data, Key.up) || data === "k";
}

/** Whether input requests one step forwards: Down or vim-style `j`. */
export function isStepForwardKey(data: string): boolean {
	return matchesKey(data, Key.down) || data === "j";
}

/** Whether input requests one page backwards: PgUp or `Ctrl+U`. */
export function isPageBackKey(data: string): boolean {
	return matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"));
}

/** Whether input requests one page forwards: PgDn or `Ctrl+D`. */
export function isPageForwardKey(data: string): boolean {
	return matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"));
}

/** Truncate one rendered line to the supplied width. */
export function fitLine(line: string, width: number): string {
	return truncateToWidth(line, width, "…");
}

/**
 * Rows a description block occupies, including the blank row above it; zero
 * when collapsed. A description is the least important block on a frame, so
 * each view drops the whole block once its own content threshold is reached.
 */
export function descriptionBlockRows(lines: readonly string[]): number {
	return lines.length === 0 ? 0 : lines.length + 1;
}

/**
 * Wrap plain dialog-description text with semantic color, every line starting
 * after `indent`. Descriptions align with the title, so they default to none.
 */
export function wrapDescriptionLines(
	theme: Theme,
	text: string,
	color: ThemeColor,
	width: number,
	indent = "",
): string[] {
	const indentWidth = Math.min(indent.length, Math.max(0, width - 1));
	const lead = indent.slice(0, indentWidth);
	const contentWidth = Math.max(1, width - indentWidth);
	const wrapped = wrapTextWithAnsi(text, contentWidth);

	return (wrapped.length === 0 ? [""] : wrapped).map((line) =>
		truncateToWidth(theme.fg(color, `${lead}${line}`), width, "")
	);
}

/**
 * Keep wrapped notice blocks within `maxLines` rows, so a broken configuration
 * file cannot push a view's content off the frame. On overflow, the last kept
 * row becomes a `… +N more` notice, wrapped by `wrapNotice`, counting every
 * block not shown whole.
 */
export function capNoticeLines(
	blocks: readonly (readonly string[])[],
	maxLines: number,
	wrapNotice: (notice: string) => string[],
): string[] {
	const lines = blocks.flat();
	if (lines.length <= maxLines)
		return lines;

	const kept = lines.slice(0, maxLines - 1);
	const hidden = blocks.length - countWholeBlocks(blocks, kept.length);

	return [...kept, ...wrapNotice(`… +${hidden} more`)];
}

/** Notices whose wrapped lines fit entirely into the first `keptLines` rows. */
function countWholeBlocks(blocks: readonly (readonly string[])[], keptLines: number): number {
	let used = 0;
	let whole = 0;
	for (const block of blocks) {
		if (used + block.length > keptLines)
			break;
		used += block.length;
		whole += 1;
	}

	return whole;
}

/** Spread left and right content across the width, truncating the left side on overlap. */
export function spreadLine(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap < 1) {
		return fitLine(`${truncateToWidth(left, Math.max(1, width - visibleWidth(right) - 2), "…")} ${right}`, width);
	}

	return `${left}${" ".repeat(gap)}${right}`;
}

/** Pi-style hint row aligned with the title: `key description` pairs joined by ` · `. */
export function hintRow(theme: Theme, hints: readonly Hint[]): string {
	const separator = theme.fg("dim", " · ");
	return `${hints.map(([key, description]) => hint(theme, key, description)).join(separator)}`;
}

/**
 * Hint row fitted to the width: optional hints drop out whole before any
 * required hint is truncated, so a narrow frame keeps its essential keys.
 * `rightHint` sits at the right edge and gives way first: it loses its detail,
 * then drops out whole, before any other hint does.
 */
export function fitHintRow(theme: Theme, hints: readonly Hint[], width: number, rightHint?: RightHint): string {
	const full = hintRow(theme, hints);
	if (rightHint !== undefined) {
		const right = [`${rightHint.description}: ${rightHint.detail}`, rightHint.description]
			.map((description) => hint(theme, rightHint.key, description))
			.find((candidate) => visibleWidth(full) + RIGHT_HINT_GAP + visibleWidth(candidate) <= width);
		if (right !== undefined)
			return spreadLine(full, right, width);
	}
	if (visibleWidth(full) <= width)
		return full;

	return fitLine(hintRow(theme, hints.filter(([, , optional]) => optional !== true)), width);
}

/** Hint: slightly brighter (muted) key, dim description. */
function hint(theme: Theme, key: string, description: string | ModeDescription): string {
	if (typeof description === "string")
		return theme.fg("muted", key) + theme.fg("dim", ` ${description}`);

	return theme.fg("muted", key) + theme.fg("dim", " ") + modeDescription(theme, description);
}

/**
 * Dim `mode/mode suffix` text. Each part is painted on its own, so the bold
 * reset after the active mode cannot clear a faint dim style from the rest.
 */
function modeDescription(theme: Theme, description: ModeDescription): string {
	const modes = description.modes.map((mode) => mode === description.active
		? theme.fg("dim", theme.bold(theme.underline(mode)))
		: theme.fg("dim", mode));
	const suffix = description.suffix === undefined ? "" : theme.fg("dim", ` ${description.suffix}`);

	return modes.join(theme.fg("dim", "/")) + suffix;
}
