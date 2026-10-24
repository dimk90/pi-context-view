/**
 * Status bar of the Injections list: what the selected row's changes are,
 * where they live, who made them, and what its markers mean, one field per
 * line. It never shows raw text or repeats the row's source or location.
 * Pure string logic.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { ChangeEditor, TokenDiff } from "../model.ts";
import { normalizeInlineText } from "../text.ts";
import type { ChangeScope, InjectionRow } from "./injections-model.ts";
import { fitLine } from "./layout.ts";
import { formatDiffAdded, formatDiffRemoved, guessMarker, markerStatusField } from "./markers.ts";

/** Indent of each field, two columns deeper than the description, so the bar reads apart from it. */
const FIELD_INDENT = "    ";
/** Indent of a field's wrapped continuation lines. */
const CONTINUATION_INDENT = "      ";

/** Where a row's changes live, after the diff in its Change field. */
const SCOPE_PHRASES: Record<ChangeScope, string> = {
	saved: "saved in the session",
	"saved-and-edit": "saved in the session, with an edit only in this request",
	partly: "some saved in the session, some only in this request",
	request: "only in this request",
	"request-edit": "only in this request; the session keeps the original",
	"request-new": "only in this request; not in the session",
	payload: "only in the provider payload",
};

/** Why a `system prompt` row shows no value. */
const DIFF_ONLY_NOTE = "Already counted in System Prompt";

/**
 * Wrapped status lines of one list row: Change, then Changed By or the note
 * of a `system prompt` row, then one explanation per marker. Empty for a row
 * without a change or marker, and for the separator and TOTAL.
 */
export function statusBarLines(theme: Theme, row: InjectionRow, width: number): string[] {
	return statusFields(theme, row).flatMap((field) => wrapField(field, width));
}

/** Unwrapped fields of one row, in display order. */
function statusFields(theme: Theme, row: InjectionRow): string[] {
	if (row.kind !== "group" && row.kind !== "item") return [];
	const fields: string[] = [];
	if (row.scope !== undefined) fields.push(field(theme, "Change", changeText(theme, row.diff, row.scope)));
	if (row.kind !== "item") return fields;
	if (row.diffOnly === true) fields.push(theme.fg("dim", DIFF_ONLY_NOTE));
	else if (row.editors !== undefined) fields.push(field(theme, "Changed By", editorsText(theme, row.editors)));
	// A row shows one of Dropped and Moved, like its markers
	if (row.dropped === true) fields.push(markerStatusField(theme, "dropped"));
	else if (row.moved === true) fields.push(markerStatusField(theme, "moved"));
	if (row.change === "forced") fields.push(markerStatusField(theme, "forced"));
	if (row.forcedEdit !== undefined) {
		fields.push(markerStatusField(theme, row.forcedEdit.sent ? "forced-edit-sent" : "forced-edit-unsent"));
	}
	return fields;
}

/** One field: its `muted` name, then a dim colon and the value. */
function field(theme: Theme, name: string, value: string): string {
	return `${theme.fg("muted", name)}${theme.fg("dim", ": ")}${value}`;
}

/** `+N -N` in the diff colors, then where the changes live; only the phrase without a diff. */
function changeText(theme: Theme, diff: TokenDiff | undefined, scope: ChangeScope): string {
	const sides: string[] = [];
	if (diff !== undefined && diff.added > 0) sides.push(theme.fg("toolDiffAdded", formatDiffAdded(diff.added)));
	if (diff !== undefined && diff.removed > 0) sides.push(theme.fg("toolDiffRemoved", formatDiffRemoved(diff.removed)));
	const phrase = SCOPE_PHRASES[scope];
	if (sides.length === 0) return theme.fg("dim", phrase);
	return `${sides.join(" ")}${theme.fg("dim", `${scope === "partly" ? "," : ""} ${phrase}`)}`;
}

/** Comma-separated editors: sanitized extension labels with a dim `(guess)` where inferred, then `Unknown`. */
function editorsText(theme: Theme, editors: readonly ChangeEditor[]): string {
	return editors.map((editor) => {
		if (editor.type === "unknown") return theme.fg("dim", "Unknown");
		const label = theme.fg("dim", normalizeInlineText(editor.source.label));
		return editor.attribution === "guess" ? `${label}${guessMarker(theme)}` : label;
	}).join(theme.fg("dim", ", "));
}

/** Wrap one field under its indent, hanging continuation lines two columns deeper. */
function wrapField(text: string, width: number): string[] {
	const indentWidth = Math.min(CONTINUATION_INDENT.length, Math.max(0, width - 1));
	const wrapped = wrapTextWithAnsi(text, Math.max(1, width - indentWidth));
	return wrapped.map((line, index) => {
		const indent = (index === 0 ? FIELD_INDENT : CONTINUATION_INDENT).slice(0, indentWidth);
		return fitLine(`${indent}${line}`, width);
	});
}
