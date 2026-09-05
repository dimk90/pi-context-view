/**
 * Shared preview body rendering for content that carries labeled parts, e.g. a
 * tool's prompt snippet, guideline bullets, and definition. Both the Injections
 * item preview and the Usage block stream present those parts the same way:
 * a bold subheader with its token share above each part. Pure string logic.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { GuidelineReference, InjectionSection, JsonSpan } from "../model.ts";
import { normalizeInlineText, normalizePreviewText } from "../text.ts";
import { shiftJsonSpan } from "./json-preview.ts";
import { BODY_INDENT, calculateViewport, descriptionBlockRows, wrapDescriptionLines } from "./layout.ts";

const GUIDELINE_ATTRIBUTION_DESCRIPTION =
	"Highlighted parts are injected by extensions into pi’s system prompt. " +
	"They are excluded from the System Prompt token count and included in the injecting extension’s count.";
/** Keep a normal block's worth of content visible before making room for its explanation. */
const DESCRIPTION_MIN_CONTENT_ROWS = 22;

/** Raw preview content plus the labeled parts it decomposes into, when known. */
export interface SectionedContent {
	readonly text: string;
	readonly jsonSpan?: JsonSpan;
	readonly sections?: readonly InjectionSection[];
	readonly guidelineReferences?: readonly GuidelineReference[];
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
 * One fixed footer for previews with attributed guidelines, never part of their
 * raw content. Collapse it whole when fewer than ten content rows would remain,
 * or when a shorter preview would no longer fit in full. Uncapped line counts
 * keep the collapse decision independent of the Usage cap it helps determine.
 */
export function guidelineDescriptionLines(
	theme: Theme,
	contents: readonly SectionedContent[],
	layout: PreviewDescriptionLayout,
): string[] {
	if (!contents.some(hasGuidelineReferences)) return [];
	const lines = wrapDescriptionLines(theme, GUIDELINE_ATTRIBUTION_DESCRIPTION, "dim", layout.width);
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

/** Only metadata on rendered body parts triggers the footer, never a text or label match. */
function hasGuidelineReferences(content: SectionedContent): boolean {
	const parts = content.sections?.length ? content.sections : [content];
	return parts.some((part) => (part.guidelineReferences?.length ?? 0) > 0);
}

/** Render referenced guidelines locally; other content keeps the caller's JSON/skill transformations. */
function contentBodyLines(
	theme: Theme,
	content: SectionedContent,
	wrapWidth: number,
	wrapText: (text: string, jsonSpan: JsonSpan | undefined) => string[],
	heading: string | undefined,
): string[] {
	const references = content.guidelineReferences ?? [];
	if (references.length === 0) return bodyLines(content.text, content.jsonSpan, heading, wrapText);
	let text = "";
	let offset = 0;
	for (const reference of references) {
		text += normalizePreviewText(content.text.slice(offset, reference.offset));
		text += theme.fg("syntaxNumber", normalizePreviewText(reference.text));
		text += theme.fg("borderMuted", " <- ");
		text += theme.fg("mdLink", normalizeInlineText(reference.source.label));
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
	if (lineEnd === -1 || text.slice(0, lineEnd) !== heading) return text;
	return text.slice(lineEnd + 1);
}

/**
 * Bold subheader naming one part and its share of the parent estimate. Parts use
 * `syntaxKeyword` rather than the usual `mdHeading` subheader color, because they
 * nest under item and entry headings that already carry `mdHeading`.
 */
function sectionHeaderLines(theme: Theme, section: InjectionSection, wrapWidth: number): string[] {
	const label = theme.fg("syntaxKeyword", theme.bold(normalizeInlineText(section.label)));
	const tokens = theme.fg("muted", ` · ${section.tokens.toLocaleString("en-US")} tokens`);
	return wrapTextWithAnsi(`${label}${tokens}`, wrapWidth).map((line) => `${BODY_INDENT}${line}`);
}
