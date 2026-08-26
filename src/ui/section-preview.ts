/**
 * Shared preview body rendering for content that carries labeled parts, e.g. a
 * tool's prompt snippet, guideline bullets, and definition. Both the Injections
 * item preview and the Usage block stream present those parts the same way:
 * a bold subheader with its token share above each part. Pure string logic.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { InjectionSection } from "../model.ts";
import { normalizeInlineText } from "./injections-model.ts";
import { BODY_INDENT } from "./layout.ts";

/** Raw preview content plus the labeled parts it decomposes into, when known. */
export interface SectionedContent {
	readonly text: string;
	readonly sections?: readonly InjectionSection[];
}

/**
 * Preview body lines for one item or entry: labeled parts under their
 * subheaders, or the raw text when no breakdown exists. The caller supplies
 * `wrapText` so each view keeps its own sanitizing, wrapping, and indentation.
 */
export function previewBodyLines(
	theme: Theme,
	content: SectionedContent,
	wrapWidth: number,
	wrapText: (text: string) => string[],
): string[] {
	const sections = content.sections ?? [];
	if (sections.length === 0) return wrapText(content.text);
	const lines: string[] = [];
	for (const section of sections) {
		if (lines.length > 0) lines.push("");
		lines.push(...sectionHeaderLines(theme, section, wrapWidth));
		// Carved prompt lines open with the newline that separated them in the
		// prompt; drop it so the part starts directly under its subheader.
		lines.push(...wrapText(section.text.replace(/^\n+/, "")));
	}
	return lines;
}

/**
 * Bold subheader naming one part and its share of the parent estimate. Parts use
 * `syntaxFunction` rather than the usual `mdHeading` subheader color, because they
 * nest under item and entry headings that already carry `mdHeading`.
 */
function sectionHeaderLines(theme: Theme, section: InjectionSection, wrapWidth: number): string[] {
	const label = theme.fg("syntaxFunction", theme.bold(normalizeInlineText(section.label)));
	const tokens = theme.fg("muted", ` · ${section.tokens.toLocaleString("en-US")} tokens`);
	return wrapTextWithAnsi(`${label}${tokens}`, wrapWidth).map((line) => `${BODY_INDENT}${line}`);
}
