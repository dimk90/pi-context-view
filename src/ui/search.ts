/**
 * Shared find-as-you-type pieces for both views: the one-line query prompt,
 * case-insensitive matching, match highlighting inside rendered lines, and the
 * keys and hints every search prompt shares. Matching follows pi's fullscreen
 * transcript search: every whitespace run, line breaks included, matches a
 * single space, so a phrase that wraps across two preview lines is still found.
 * No pi access beyond the theme.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

import { normalizeInlineText, normalizePreviewText } from "../text.ts";
import { BODY_INDENT, fitLine, type Hint, spreadLine, STEP_KEY_HINT } from "./layout.ts";
import { parseWheelDirection } from "./wheel.ts";

/** Hint-row key label that opens the search prompt in either view. */
export const SEARCH_KEY = "/";
/** Hint-row key label for stepping through preview matches. */
export const MATCH_STEP_KEY_HINT = "n/N";
/** Lines kept above a match scrolled into view, so it is read in context. */
export const SEARCH_CONTEXT_LINES = 2;

/** CSI escape sequence, such as an SGR color change. */
const CSI_SEQUENCE = /\u001B\[[\u0030-\u003F]*[\u0020-\u002F]*[\u0040-\u007E]/;
/** Terminal string such as an OSC hyperlink, ended by BEL or ST. */
const TERMINAL_STRING = /\u001B[\]_P^X][^\u0007\u001B]*(?:\u0007|\u001B\\)/;
/** Any escape sequence a rendered line can carry. */
const ANSI_SEQUENCE = new RegExp(`${CSI_SEQUENCE.source}|${TERMINAL_STRING.source}`, "g");
/** Escape sequences that close a rendered line after its last visible column. */
const TRAILING_ANSI = new RegExp(`(?:${ANSI_SEQUENCE.source})+$`);
/** One whitespace-separated word of a plain line. */
const WORD = /\S+/gu;
/** Text whose every character takes exactly one column. */
const PRINTABLE_ASCII = /^[\u0020-\u007E]*$/;
/** Splits non-ASCII words into graphemes, which render as one unit. */
const SEGMENTER = new Intl.Segmenter();

/** Visible-column span of one match on one rendered line, end exclusive. */
export interface MatchSegment {
	readonly row: number;
	readonly start: number;
	readonly end: number;
}

/** One query occurrence; several segments when it wraps across rows. */
export interface SearchMatch {
	readonly segments: readonly MatchSegment[];
}

/** One highlight range on a rendered line. */
export interface HighlightRange {
	readonly start: number;
	readonly end: number;
	/** The match the user is on; emphasized over the others. */
	readonly current: boolean;
}

/** Case-insensitive pattern for a query, or undefined when it is blank. */
export function searchPattern(query: string): RegExp | undefined {
	const normalized = query.replace(/\s+/gu, " ").trim();
	if (normalized === "") return undefined;
	return new RegExp(normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
}

/** Whether a row label contains the query, compared as it renders on one line. */
export function labelMatches(label: string, pattern: RegExp): boolean {
	return pattern.test(normalizeInlineText(label));
}

/**
 * Searchable form of raw content: sanitized like a preview, with whitespace
 * collapsed so a phrase matches however it wraps. Callers cache the result.
 */
export function searchableContent(text: string): string {
	return normalizePreviewText(text).replace(/\s+/gu, " ");
}

/** Every occurrence of the query across rendered lines, in reading order. */
export function findMatches(lines: readonly string[], pattern: RegExp): SearchMatch[] {
	const corpus = buildCorpus(lines);
	const matches: SearchMatch[] = [];
	let spanIndex = 0;
	for (const found of corpus.text.matchAll(new RegExp(pattern.source, "giu"))) {
		const start = found.index;
		const end = start + found[0].length;
		if (end === start) continue;
		while (spanIndex < corpus.spans.length && (corpus.spans[spanIndex]?.textEnd ?? 0) <= start) spanIndex++;
		const segments = matchSegments(corpus.spans, spanIndex, start, end);
		if (segments.length > 0) matches.push({ segments });
	}
	return matches;
}

/**
 * Highlight ranges on one rendered line with pi's own transcript-search styles.
 * Styling is reapplied to every plain run, so the line's own color resets
 * cannot cut a highlight short.
 */
export function highlightLine(theme: Theme, line: string, ranges: readonly HighlightRange[]): string {
	const width = visibleWidth(line);
	let result = "";
	let column = 0;
	// Every slice comes from the original line, which carries the styles active at its start
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		const start = Math.max(column, Math.min(range.start, width));
		const end = Math.min(range.end, width);
		if (end <= start) continue;
		result += sliceByColumn(line, column, start - column, true);
		result += styleRuns(sliceByColumn(line, start, end - start, true), (text) => matchStyle(theme, text, range.current));
		column = end;
	}
	if (column === 0) return line;
	// Slicing stops at the last visible column, so restore the resets that close the line
	return `${result}${sliceByColumn(line, column, width - column, true)}${line.match(TRAILING_ANSI)?.[0] ?? ""}`;
}

/** Status text for a query: blank, `No matches`, a `current/total` ordinal, or a match count. */
export function matchStatus(active: boolean, count: number, current: number | undefined): string {
	if (!active) return "";
	if (count === 0) return "No matches";
	if (current !== undefined) return `${current + 1}/${count}`;
	return `${count} ${count === 1 ? "match" : "matches"}`;
}

/** Match step a key requests: `n` for the next match, `N` for the previous one. */
export function matchStepDirection(data: string): -1 | 1 | undefined {
	if (data === "n") return 1;
	if (data === "N") return -1;
	return undefined;
}

/**
 * Whether a key still navigates while a search prompt is open: the arrows,
 * the page keys, and the wheel. Letter keys such as `j`/`k` type instead.
 */
export function isSearchNavigationKey(data: string): boolean {
	return parseWheelDirection(data) !== undefined ||
		matchesKey(data, Key.up) ||
		matchesKey(data, Key.down) ||
		matchesKey(data, Key.pageUp) ||
		matchesKey(data, Key.pageDown);
}

/** Preview hints for plain navigation, an open search prompt, or a kept search. */
export function searchHints(prompt: SearchPrompt, stepLabel: string): Hint[] {
	if (prompt.editing) return [["↑↓", stepLabel], ["Enter", "Done"], ["Esc", "Clear"]];
	if (prompt.active) {
		return [
			[STEP_KEY_HINT, stepLabel],
			[MATCH_STEP_KEY_HINT, "Next/Prev"],
			[SEARCH_KEY, "Search", true],
			["Esc", "Back"],
		];
	}
	return [[STEP_KEY_HINT, stepLabel], ["PgUp/PgDn", "Page"], [SEARCH_KEY, "Search", true], ["Esc", "Back"]];
}

/** Selection change waiting for the next render, which knows the wrapped lines. */
type PendingMove = "first" | -1 | 1;

/**
 * Find-in-preview state over rendered lines: the query prompt, its matches,
 * and the current match. Wrapping depends on width, so the view hands over
 * freshly rendered lines every frame and moves are resolved against them.
 */
export class PreviewSearch {
	public readonly prompt = new SearchPrompt();
	private matchList: readonly SearchMatch[] = [];
	private matchRows = new Map<number, RowSegment[]>();
	private source: readonly string[] | undefined;
	private sourceQuery = "";
	private currentIndex: number | undefined;
	private pending: PendingMove | undefined;
	private anchor = 0;

	/** Matches in the lines last passed to `sync`. */
	public get matches(): readonly SearchMatch[] {
		return this.matchList;
	}

	/** Index of the current match, if any. */
	public get current(): number | undefined {
		return this.currentIndex;
	}

	/** Status for the prompt row. */
	public get status(): string {
		return matchStatus(this.prompt.active, this.matchList.length, this.currentIndex);
	}

	/** Rows the prompt and its trailing blank row take; known before `sync`, so layout can reserve them. */
	public get promptRowCount(): number {
		return this.prompt.shown ? 2 : 0;
	}

	/** Open the prompt; typing selects the first match at or after `anchorRow`. */
	public edit(anchorRow: number): void {
		this.anchor = anchorRow;
		this.prompt.edit();
	}

	/** Feed one key to the open prompt; returns whether the query changed. */
	public type(data: string): boolean {
		if (!this.prompt.type(data)) return false;
		this.pending = "first";
		return true;
	}

	/**
	 * Handle one non-navigation key while the prompt is open: Enter keeps a
	 * non-blank query, Escape or Enter on a blank one drops it, and any other
	 * key edits it.
	 */
	public handlePromptKey(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.clear();
		} else if (matchesKey(data, Key.enter)) {
			if (this.prompt.active) this.prompt.submit();
			else this.clear();
		} else {
			this.type(data);
		}
	}

	/** Select the first match at or after `anchorRow` once the next frame's lines are known. */
	public restart(anchorRow = 0): void {
		this.anchor = anchorRow;
		this.currentIndex = undefined;
		this.pending = this.prompt.active ? "first" : undefined;
	}

	/** Move to the next or previous match, wrapping around; false without a query. */
	public step(direction: -1 | 1): boolean {
		if (!this.prompt.active) return false;
		this.pending = direction;
		return true;
	}

	/** Drop the query, its matches, and any pending move. */
	public clear(): void {
		this.prompt.clear();
		this.matchList = [];
		this.matchRows.clear();
		this.source = undefined;
		this.sourceQuery = "";
		this.currentIndex = undefined;
		this.pending = undefined;
	}

	/**
	 * Match the query against this frame's lines and resolve any pending move.
	 * Returns the row the view should reveal, or undefined when nothing moved.
	 */
	public sync(lines: readonly string[]): number | undefined {
		if (lines !== this.source || this.prompt.query !== this.sourceQuery) {
			this.source = lines;
			this.sourceQuery = this.prompt.query;
			const pattern = this.prompt.pattern;
			this.matchList = pattern === undefined ? [] : findMatches(lines, pattern);
			this.matchRows = segmentsByRow(this.matchList);
			if (this.currentIndex !== undefined && this.currentIndex >= this.matchList.length) {
				this.currentIndex = this.matchList.length === 0 ? undefined : this.matchList.length - 1;
			}
		}
		const pending = this.pending;
		this.pending = undefined;
		if (pending === undefined || this.matchList.length === 0) {
			if (pending !== undefined) this.currentIndex = undefined;
			return undefined;
		}
		this.currentIndex = this.resolve(pending);
		return this.matchList[this.currentIndex]?.segments[0]?.row;
	}

	/** Prompt row and its trailing blank row while shown; render after `sync` so the status is current. */
	public promptLines(theme: Theme, width: number): string[] {
		if (!this.prompt.shown) return [];
		return [this.prompt.render(theme, width, "Search", this.status), ""];
	}

	/** Highlight every match segment on one rendered row. */
	public highlight(theme: Theme, line: string, row: number): string {
		const segments = this.matchRows.get(row);
		if (segments === undefined) return line;
		const ranges = segments.map(({ match, start, end }) => ({ start, end, current: match === this.currentIndex }));
		return highlightLine(theme, line, ranges);
	}

	/** Index a pending move lands on; the match list is non-empty. */
	private resolve(pending: PendingMove): number {
		const count = this.matchList.length;
		if (pending === "first") {
			const index = this.matchList.findIndex((match) => (match.segments[0]?.row ?? 0) >= this.anchor);
			return index === -1 ? 0 : index;
		}
		if (this.currentIndex === undefined) return pending === 1 ? 0 : count - 1;
		return (this.currentIndex + pending + count) % count;
	}
}

/**
 * One-line query prompt. While open it edits through pi's own `Input`, so
 * word deletion, kill/yank, and undo behave as everywhere else in pi; once
 * submitted it keeps showing the query as read-only text.
 */
export class SearchPrompt {
	private input = new Input({ prompt: "" });
	private open = false;

	/** Whether keys currently edit the query. */
	public get editing(): boolean {
		return this.open;
	}

	/** The query as typed. */
	public get query(): string {
		return this.input.getValue();
	}

	/** Pattern for the current query, or undefined when it is blank. */
	public get pattern(): RegExp | undefined {
		return searchPattern(this.query);
	}

	/** Whether a non-blank query is set, typed or submitted. */
	public get active(): boolean {
		return this.pattern !== undefined;
	}

	/** Whether the prompt row renders: while editing or while a query is kept. */
	public get shown(): boolean {
		return this.open || this.active;
	}

	/** Start editing, keeping the current query so it can be refined. */
	public edit(): void {
		this.open = true;
	}

	/** Stop editing and keep the query. */
	public submit(): void {
		this.open = false;
	}

	/** Drop the query and stop editing. */
	public clear(): void {
		this.input = new Input({ prompt: "" });
		this.open = false;
	}

	/** Replace the query with the cursor at its end, without editing. */
	public set(query: string): void {
		this.input = new Input({ prompt: "" });
		this.input.handleInput(query);
		this.open = false;
	}

	/** Feed one key to the open prompt; returns whether the query changed. */
	public type(data: string): boolean {
		const previous = this.query;
		this.input.handleInput(data);
		return this.query !== previous;
	}

	/**
	 * Prompt row: dim label, the query (with pi's fake cursor while editing),
	 * and a right-aligned status such as the match count.
	 */
	public render(theme: Theme, width: number, label: string, status: string): string {
		return this.renderAfter(theme, width, theme.fg("dim", `${label}: `), status);
	}

	/** Prompt row after an already styled `lead`, such as a mode switcher, instead of a plain label. */
	public renderAfter(theme: Theme, width: number, lead: string, status: string): string {
		const prefix = `${BODY_INDENT}${lead}`;
		const right = status === "" ? "" : `${theme.fg("dim", status)} `;
		const queryWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(right) - 1);
		const query = this.open
			? truncateToWidth(this.input.render(queryWidth)[0] ?? "", queryWidth, "").trimEnd()
			: theme.fg("text", truncateToWidth(normalizeInlineText(this.query), queryWidth, "…"));
		return right === "" ? fitLine(`${prefix}${query}`, width) : spreadLine(`${prefix}${query}`, right, width);
	}
}

// ============================================================================
// Private helpers
// ============================================================================

/** Pi's transcript-search look: underlined match colors, or bold inverse for the current match. */
function matchStyle(theme: Theme, text: string, current: boolean): string {
	const colored = theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
	return current ? theme.bold(theme.inverse(colored)) : theme.underline(colored);
}

/** Apply a style to each plain-text run while passing escape sequences through unchanged. */
function styleRuns(text: string, style: (text: string) => string): string {
	let result = "";
	let offset = 0;
	for (const sequence of text.matchAll(ANSI_SEQUENCE)) {
		if (sequence.index > offset) result += style(text.slice(offset, sequence.index));
		result += sequence[0];
		offset = sequence.index + sequence[0].length;
	}
	if (offset < text.length) result += style(text.slice(offset));
	return result;
}

/** Corpus character range mapped back to a run of visible columns on one row. */
interface CorpusSpan {
	readonly textStart: number;
	readonly textEnd: number;
	readonly row: number;
	readonly start: number;
	readonly end: number;
	/** One column per character, so inner offsets map linearly. */
	readonly linear: boolean;
}

/** Whitespace-collapsed text of every line plus its mapping to rows and columns. */
interface SearchCorpus {
	readonly text: string;
	readonly spans: readonly CorpusSpan[];
}

/** Join every word on every line with single spaces, remembering where each word renders. */
function buildCorpus(lines: readonly string[]): SearchCorpus {
	let text = "";
	const spans: CorpusSpan[] = [];
	const append = (piece: string, row: number, start: number, width: number, linear: boolean): void => {
		spans.push({ textStart: text.length, textEnd: text.length + piece.length, row, start, end: start + width, linear });
		text += piece;
	};
	for (const [row, line] of lines.entries()) {
		const plain = stripTerminalSequences(line);
		for (const word of plain.matchAll(WORD)) {
			if (text.length > 0) text += " ";
			let column = visibleWidth(plain.slice(0, word.index));
			if (PRINTABLE_ASCII.test(word[0])) {
				append(word[0], row, column, word[0].length, true);
				continue;
			}
			for (const { segment } of SEGMENTER.segment(word[0])) {
				const width = visibleWidth(segment);
				append(segment, row, column, width, false);
				column += width;
			}
		}
	}
	return { text, spans };
}

/** Row segments of the corpus range `[start, end)`, scanning spans from `firstSpan`. */
function matchSegments(spans: readonly CorpusSpan[], firstSpan: number, start: number, end: number): MatchSegment[] {
	const segments: MatchSegment[] = [];
	for (let index = firstSpan; index < spans.length; index++) {
		const span = spans[index];
		if (span === undefined || span.textStart >= end) break;
		const segmentStart = span.linear ? span.start + Math.max(start, span.textStart) - span.textStart : span.start;
		const segmentEnd = span.linear ? span.start + Math.min(end, span.textEnd) - span.textStart : span.end;
		const previous = segments.at(-1);
		// Consecutive spans on one row, including the space between words, join into one segment
		if (previous !== undefined && previous.row === span.row) {
			segments[segments.length - 1] = { ...previous, end: Math.max(previous.end, segmentEnd) };
		} else {
			segments.push({ row: span.row, start: segmentStart, end: segmentEnd });
		}
	}
	return segments;
}

/** One match segment on a row, tagged with the match it belongs to. */
interface RowSegment {
	readonly match: number;
	readonly start: number;
	readonly end: number;
}

/** Match segments grouped by row, so rendering a row never scans every match. */
function segmentsByRow(matches: readonly SearchMatch[]): Map<number, RowSegment[]> {
	const rows = new Map<number, RowSegment[]>();
	for (const [match, { segments }] of matches.entries()) {
		for (const segment of segments) {
			const row = rows.get(segment.row);
			const entry = { match, start: segment.start, end: segment.end };
			if (row === undefined) rows.set(segment.row, [entry]);
			else row.push(entry);
		}
	}
	return rows;
}
