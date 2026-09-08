/**
 * Shared preview body rendering for content that carries labeled parts, e.g. a
 * tool's prompt snippet, guideline bullets, and definition. Both the Injections
 * item preview and the Usage block stream present those parts the same way:
 * a bold subheader with its token share above each part. Pure string logic.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { InjectedReference, InjectionSection, JsonSpan } from "../model.ts";
import { normalizeInlineText, normalizePreviewText } from "../text.ts";
import { shiftJsonSpan } from "./json-preview.ts";
import { BODY_INDENT, calculateViewport, descriptionBlockRows, wrapDescriptionLines } from "./layout.ts";

const INJECTED_ATTRIBUTION_DESCRIPTION = "Highlighted parts are injected by extensions into pi’s system prompt.";
/** Accounting of lines pi actually rendered: their owner counts them instead of pi's prompt. */
const COUNTED_ATTRIBUTION_DESCRIPTION =
	" They are excluded from the System Prompt token count and included in the injecting extension’s count.";
/** Accounting of a preview whose highlighted lines were all dropped, so nothing counts them. */
const DROPPED_ATTRIBUTION_DESCRIPTION =
	" A custom system prompt replaced them, so they are counted neither by the System Prompt nor by the" +
	" injecting extension.";
/** Added where one preview mixes dropped lines with lines pi still sends. */
const MIXED_ATTRIBUTION_DESCRIPTION =
	" Parts marked Dropped were replaced by a custom system prompt and are counted nowhere.";
/** Added only where an owner was inferred, because pi reports no author for chained prompt edits. */
const GUESSED_ATTRIBUTION_DESCRIPTION =
	" Sources marked (guess) are inferred from the injected text itself.";
/**
 * State marker for content a `--system-prompt` replacement dropped, appended
 * after the estimate it explains. It marks a state rather than a usage
 * category, so its color is fixed instead of configurable.
 */
const DROPPED_MARKER = " · Dropped";
const DROPPED_MARKER_COLOR: ThemeColor = "toolDiffRemoved";
/**
 * State marker for a block an extension moved out of the region pi renders it
 * into. Pi still sends the text, so the marker explains the position alone and
 * its color is fixed like the dropped one.
 */
const MOVED_MARKER = " · Moved";
const MOVED_MARKER_COLOR: ThemeColor = "warning";
/**
 * Arrow introducing a restored line's source label. Non-breaking spaces bind
 * the preceding word, arrow, and label into one wrapping unit. Units wider
 * than the content width still hard-wrap, possibly just after the arrow.
 */
const SOURCE_ARROW = "\u00A0<-\u00A0";
/** Suffix distinguishing an inferred owner from a carved line's known one. */
const GUESS_MARKER = " (guess)";
/** Keep a normal block's worth of content visible before making room for its explanation. */
const DESCRIPTION_MIN_CONTENT_ROWS = 22;

/** Raw preview content plus the labeled parts it decomposes into, when known. */
export interface SectionedContent {
	readonly text: string;
	readonly jsonSpan?: JsonSpan;
	readonly sections?: readonly InjectionSection[];
	readonly injectedReferences?: readonly InjectedReference[];
	/** True when a `--system-prompt` replacement dropped this content; it reads 0 tokens. */
	readonly dropped?: boolean;
	/** True when an extension moved this content out of the region pi renders it into. */
	readonly moved?: boolean;
}

/** Themed marker naming content pi never sent, for a preview subheader or a hierarchy row. */
export function droppedMarker(theme: Theme): string {
	return theme.fg(DROPPED_MARKER_COLOR, DROPPED_MARKER);
}

/** Themed marker naming content pi sends from elsewhere in the prompt than it wrote it. */
export function movedMarker(theme: Theme): string {
	return theme.fg(MOVED_MARKER_COLOR, MOVED_MARKER);
}

/** Space shared by uncapped preview content, its counter, and the attribution footer. */
export interface PreviewDescriptionLayout {
	readonly width: number;
	/** Rows left after the view's fixed frame, before the description and counter. */
	readonly availableRows: number;
	/** Wrapped content rows, including entry headers/separators but never the footer. */
	readonly contentLineCount: number;
}

/**
 * One fixed footer for previews with attributed extension lines, never part of
 * their raw content. Collapse it whole when fewer than
 * `DESCRIPTION_MIN_CONTENT_ROWS` content rows would remain, or when a shorter
 * preview would no longer fit in full. Uncapped line counts keep the collapse
 * decision independent of the Usage cap it helps determine.
 */
export function injectedDescriptionLines(
	theme: Theme,
	contents: readonly SectionedContent[],
	layout: PreviewDescriptionLayout,
): string[] {
	const parts = contents.flatMap((content) => referenceParts(content)).filter(hasInjectedReferences);
	if (parts.length === 0) return [];
	const description = `${attributionDescription(parts)}${
		parts.some(hasGuessedReferences) ? GUESSED_ATTRIBUTION_DESCRIPTION : ""
	}`;
	const lines = wrapDescriptionLines(theme, description, "dim", layout.width);
	const availableRows = layout.availableRows - descriptionBlockRows(lines);
	const viewport = calculateViewport(layout.contentLineCount, availableRows, 0);
	const floor = Math.min(DESCRIPTION_MIN_CONTENT_ROWS, layout.contentLineCount);
	return availableRows >= floor && viewport.visibleCount >= floor ? lines : [];
}

/**
 * Preview body lines for one item or entry: labeled parts under their
 * subheaders, or the raw text when no breakdown exists. The caller supplies
 * `wrapText` so each view keeps its own sanitizing, wrapping, indentation, and
 * choice of whether the marked JSON run is expanded at this level, and
 * `heading` so an undivided body can drop a line the heading already shows.
 */
export function previewBodyLines(
	theme: Theme,
	content: SectionedContent,
	wrapWidth: number,
	wrapText: (text: string, jsonSpan: JsonSpan | undefined) => string[],
	heading?: string,
): string[] {
	const sections = content.sections ?? [];
	if (sections.length === 0) return contentBodyLines(theme, content, wrapWidth, wrapText, heading);
	const lines: string[] = [];
	for (const section of sections) {
		if (lines.length > 0) {
			// Captured trailing whitespace must not add to the subsection separator
			while (lines.length > 0 && normalizeInlineText(lines[lines.length - 1] ?? "") === "") lines.pop();
			lines.push("", "");
		}
		lines.push(...sectionHeaderLines(theme, section, wrapWidth));
		lines.push(...contentBodyLines(theme, section, wrapWidth, wrapText, section.label));
	}
	return lines;
}

/**
 * How the highlighted lines are accounted for: counted by their extension,
 * counted nowhere once a prompt replacement dropped them all, or both at once
 * when one preview shows dropped parts beside parts pi still sends.
 */
function attributionDescription(parts: readonly SectionedContent[]): string {
	const dropped = parts.filter((part) => part.dropped === true).length;
	if (dropped === parts.length) return `${INJECTED_ATTRIBUTION_DESCRIPTION}${DROPPED_ATTRIBUTION_DESCRIPTION}`;
	const counted = `${INJECTED_ATTRIBUTION_DESCRIPTION}${COUNTED_ATTRIBUTION_DESCRIPTION}`;
	return dropped === 0 ? counted : `${counted}${MIXED_ATTRIBUTION_DESCRIPTION}`;
}

/** Only metadata on rendered body parts triggers the footer, never a text or label match. */
function hasInjectedReferences(part: SectionedContent): boolean {
	return (part.injectedReferences?.length ?? 0) > 0;
}

/** Whether a rendered reference names an inferred owner needing the extra caveat. */
function hasGuessedReferences(part: SectionedContent): boolean {
	return part.injectedReferences?.some((reference) => reference.attribution === "guess") === true;
}

/** Body parts carrying reference metadata: the item's sections, or the item itself. */
function referenceParts(content: SectionedContent): readonly SectionedContent[] {
	return content.sections?.length ? content.sections : [content];
}

/** Render referenced prompt lines locally; other content keeps the caller's JSON/skill transformations. */
function contentBodyLines(
	theme: Theme,
	content: SectionedContent,
	wrapWidth: number,
	wrapText: (text: string, jsonSpan: JsonSpan | undefined) => string[],
	heading: string | undefined,
): string[] {
	const references = content.injectedReferences ?? [];
	if (references.length === 0) return bodyLines(content.text, content.jsonSpan, heading, wrapText);
	let text = "";
	let offset = 0;
	for (const reference of references) {
		text += normalizePreviewText(content.text.slice(offset, reference.offset));
		// A part that opens with a reference drops its captured lead, as plain text does.
		const line = text.length === 0 ? reference.text.replace(/^\n+/, "") : reference.text;
		text += theme.fg("syntaxNumber", normalizePreviewText(line));
		text += theme.fg("borderMuted", SOURCE_ARROW);
		text += theme.fg("mdLink", normalizeInlineText(reference.source.label));
		if (reference.tool !== undefined) {
			text += theme.fg("mdLinkUrl", `:${normalizeInlineText(reference.tool)}`);
		}
		if (reference.attribution === "guess") text += theme.fg("dim", GUESS_MARKER);
		offset = reference.offset;
	}
	text += normalizePreviewText(content.text.slice(offset));
	const body = withoutRepeatedHeading(text.replace(/^\n+/, ""), heading);
	return wrapTextWithAnsi(body, wrapWidth)
		.map((line) => line === "" ? "" : `${BODY_INDENT}${line}`);
}

/**
 * One body part, wrapped after dropping the lead its heading already carries:
 * the newline that separated a carved prompt line, and a first line repeating
 * the heading itself, as a skill block opens with its own name.
 */
function bodyLines(
	text: string,
	jsonSpan: JsonSpan | undefined,
	heading: string | undefined,
	wrapText: (text: string, jsonSpan: JsonSpan | undefined) => string[],
): string[] {
	const body = withoutRepeatedHeading(text.replace(/^\n+/, ""), heading);
	return wrapText(body, shiftJsonSpan(jsonSpan, text.length - body.length));
}

/**
 * Text without a first line that only repeats the heading rendered above it.
 * The dropped line stays part of the estimate; it is redundant on screen only.
 */
function withoutRepeatedHeading(text: string, heading: string | undefined): string {
	if (heading === undefined) return text;
	const lineEnd = text.indexOf("\n");
	if (lineEnd === -1 || headingKey(text.slice(0, lineEnd)) !== headingKey(heading)) return text;
	return text.slice(lineEnd + 1);
}

/**
 * Comparable form of a heading or a first content line: case and a trailing
 * colon carry no information here, so pi's own block headers ("Available
 * tools:", "Guidelines:") read as repeats of the part labels above them.
 */
function headingKey(text: string): string {
	return text.trim().replace(/:$/, "").toLowerCase();
}

/**
 * Bold subheader naming one part and its share of the parent estimate. Parts use
 * `syntaxKeyword` rather than the usual `mdHeading` subheader color, because they
 * nest under item and entry headings that already carry `mdHeading`.
 */
function sectionHeaderLines(theme: Theme, section: InjectionSection, wrapWidth: number): string[] {
	const label = theme.fg("syntaxKeyword", theme.bold(normalizeInlineText(section.label)));
	const tokens = theme.fg("muted", ` · ${section.tokens.toLocaleString("en-US")} tokens`);
	const marker = section.dropped === true ? droppedMarker(theme) : section.moved === true ? movedMarker(theme) : "";
	return wrapTextWithAnsi(`${label}${tokens}${marker}`, wrapWidth).map((line) => `${BODY_INDENT}${line}`);
}
