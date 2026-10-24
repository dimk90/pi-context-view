/** Sanitized message and payload diffs, sharing the word alignment used by token estimates. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { ForcedEdit, InjectionSection, TextDiff, TextSpan } from "../model.ts";
import type { PayloadChangeLine } from "../snapshot.ts";
import { normalizePreviewText } from "../text.ts";
import { diffWords, type WordDiffPart } from "../token-diff.ts";
import { expandJsonSpan } from "./json-preview.ts";
import { BODY_INDENT } from "./layout.ts";

/** Diff gutter shared by changed lines, context, and wrapped continuations. */
const DIFF_INDENT = "  ";

/** One sanitized physical line and its changed character ranges. */
interface DiffLine {
	text: string;
	changes: TextSpan[];
}

/** A line's side and whether its changed words belong to a replacement. */
interface DiffRow extends DiffLine {
	readonly type: WordDiffPart["type"];
	readonly highlight: boolean;
}

/**
 * One message's full diff body. Expand marked JSON on each side before
 * comparing, never affecting estimates. Unchanged and added messages keep the
 * gutter without signs: an addition has nothing to compare with, and its `+N`
 * already says so. Deletions use only their side's color, without inverse words.
 */
export function messageDiffLines(theme: Theme, section: InjectionSection, width: number): string[] {
	const text = normalizePreviewText(expandJsonSpan(section.text, section.jsonSpan));
	const original = section.message?.original;
	const before = section.change === "added" || original === undefined
		? text : normalizePreviewText(expandJsonSpan(original.text, original.jsonSpan));
	const after = section.change === "deleted" ? "" : text;
	return messageRows(diffWords(before, after)).flatMap((row) => renderRow(theme, row, width));
}

/**
 * Word diff from the request edit a forced prompt replaced to the text Pi
 * sent instead, laid out like a message diff. Added lines are what Pi sent,
 * as in every other diff; an unsent part compares with no text.
 */
export function forcedEditDiffLines(theme: Theme, sent: string, edit: ForcedEdit, width: number): string[] {
	return textDiffLines(theme, { base: edit.text, request: edit.sent ? sent : "" }, width);
}

/**
 * Word diff of a System Prompt part from its diff base to what the request
 * sent, laid out like a message diff, so the body matches its token diff.
 */
export function textDiffLines(theme: Theme, diff: TextDiff, width: number): string[] {
	return messageRows(diffWords(normalizePreviewText(diff.base), normalizePreviewText(diff.request)))
		.flatMap((row) => renderRow(theme, row, width));
}

/**
 * Highlight a finding's retained lines without changing their guard order or
 * inventing missing context. All removed and added lines share one word
 * comparison, exactly as their token diff does.
 */
export function payloadDiffLines(theme: Theme, lines: readonly PayloadChangeLine[], width: number): string[] {
	// A lone carriage return inside a retained line must not create another finding line
	const safe = lines.map((line) => ({ ...line, text: normalizePreviewText(line.text).replaceAll("\n", " ") }));
	const before = safe.filter((line) => line.type === "removed");
	const after = safe.filter((line) => line.type === "added");
	const parts = diffWords(before.map((line) => line.text).join("\n"), after.map((line) => line.text).join("\n"));
	const removed = sideLines(parts, "removed");
	const added = sideLines(parts, "added");
	const highlight = before.length > 0 && after.length > 0;
	let removedIndex = 0;
	let addedIndex = 0;
	return safe.flatMap((line) => {
		const body = line.type === "removed" ? removed[removedIndex++] : added[addedIndex++];
		return renderRow(theme, { ...body, type: line.type, highlight }, width);
	});
}

/**
 * Flush message lines at shared newline boundaries, keeping complete unchanged
 * lines as context and changed blocks as removals followed by additions.
 */
function messageRows(parts: readonly WordDiffPart[]): DiffRow[] {
	const rows: DiffRow[] = [];
	let before = emptyLines();
	let after = emptyLines();
	for (const part of parts) {
		if (part.type !== "unchanged") {
			appendText(part.type === "removed" ? before : after, part.text, true);
			continue;
		}
		const lines = part.text.split("\n");
		for (const [index, text] of lines.entries()) {
			appendText(before, text, false);
			appendText(after, text, false);
			if (index === lines.length - 1) continue;
			rows.push(...blockRows(before, after));
			before = emptyLines();
			after = emptyLines();
		}
	}
	// An absent side or a final newline does not create a phantom empty line
	if (before.at(-1)?.text === "") before.pop();
	if (after.at(-1)?.text === "") after.pop();
	return [...rows, ...blockRows(before, after)];
}

/** Context at either end stays once; the middle shows each side and inverse changed words for replacements. */
function blockRows(before: readonly DiffLine[], after: readonly DiffLine[]): DiffRow[] {
	let start = 0;
	while (start < before.length && start < after.length && sameLine(before[start], after[start])) start++;
	let beforeEnd = before.length;
	let afterEnd = after.length;
	while (beforeEnd > start && afterEnd > start && sameLine(before[beforeEnd - 1], after[afterEnd - 1])) {
		beforeEnd--;
		afterEnd--;
	}
	const highlight = beforeEnd > start && afterEnd > start;
	return [
		...before.slice(0, start).map((line): DiffRow => ({ ...line, type: "unchanged", highlight: false })),
		...before.slice(start, beforeEnd).map((line): DiffRow => ({ ...line, type: "removed", highlight })),
		...after.slice(start, afterEnd).map((line): DiffRow => ({ ...line, type: "added", highlight })),
		...before.slice(beforeEnd).map((line): DiffRow => ({ ...line, type: "unchanged", highlight: false })),
	];
}

/** Equal text is context only when the word alignment left both lines untouched. */
function sameLine(before: DiffLine, after: DiffLine): boolean {
	return before.text === after.text && before.changes.length === 0 && after.changes.length === 0;
}

/** Lines of just one side, with word changes anchored before wrapping. */
function sideLines(parts: readonly WordDiffPart[], side: "added" | "removed"): DiffLine[] {
	const lines = emptyLines();
	for (const part of parts) {
		if (part.type === "unchanged" || part.type === side) appendText(lines, part.text, part.type === side);
	}
	return lines;
}

/** Start a physical-line buffer for a side of a comparison. */
function emptyLines(): DiffLine[] {
	return [{ text: "", changes: [] }];
}

/** Append a word run to physical lines, keeping changed ranges local to each line. */
function appendText(lines: DiffLine[], text: string, changed: boolean): void {
	for (const [index, part] of text.split("\n").entries()) {
		if (index > 0) lines.push({ text: "", changes: [] });
		const line = lines[lines.length - 1];
		if (changed && part.length > 0) line.changes.push({ start: line.text.length, end: line.text.length + part.length });
		line.text += part;
	}
}

/** Apply inverse to changed words, not leading whitespace, as Pi's diffs do; colors and wrapping come afterward. */
function highlightLine(theme: Theme, line: DiffRow): string {
	if (!line.highlight) return line.text;
	let text = "";
	let offset = 0;
	for (const span of line.changes) {
		const start = span.start + (/^\s*/u.exec(line.text.slice(span.start, span.end))?.[0].length ?? 0);
		if (start >= span.end) continue;
		text += line.text.slice(offset, start) + theme.inverse(line.text.slice(start, span.end));
		offset = span.end;
	}
	return text + line.text.slice(offset);
}

/** Keep diff colors and inverse words through wrapping, with continuations under the text, not its sign. */
function renderRow(theme: Theme, row: DiffRow, width: number): string[] {
	const prefix = row.type === "added" ? "+ " : row.type === "removed" ? "- " : DIFF_INDENT;
	const color = row.type === "added" ? "toolDiffAdded" : row.type === "removed" ? "toolDiffRemoved" : "toolDiffContext";
	const text = theme.fg(color, highlightLine(theme, row));
	const wrapped = wrapTextWithAnsi(text, Math.max(1, width - DIFF_INDENT.length));
	return (wrapped.length === 0 ? [""] : wrapped).map((line, index) =>
		`${BODY_INDENT}${index === 0 ? theme.fg(color, prefix) : DIFF_INDENT}${line}`);
}
