/**
 * Preview-only expansion of the JSON runs the model marks structurally: a
 * tool's parameter schema, tool-call arguments, and serialized message
 * content. Every preview level expands them; the compact provider-bound form
 * still backs every token estimate. Pure string logic — no pi or TUI access.
 */
import type { JsonSpan } from "../model.ts";

/** Spaces per nesting level, matching how tool schemas are usually authored. */
const JSON_INDENT = 2;

/**
 * Text with its marked JSON run re-serialized across indented lines. Text
 * without a span, and a span whose slice no longer parses, are returned
 * unchanged, so a stale marker degrades to the captured form.
 */
export function expandJsonSpan(text: string, span: JsonSpan | undefined): string {
	if (span === undefined) return text;
	const expanded = prettifyJson(text.slice(span.start, span.end));
	if (expanded === undefined) return text;
	return `${text.slice(0, span.start)}${expanded}${text.slice(span.end)}`;
}

/**
 * Re-anchor a span after `removed` characters were dropped from the front of
 * its text; undefined once the removal reaches into the JSON run itself.
 */
export function shiftJsonSpan(span: JsonSpan | undefined, removed: number): JsonSpan | undefined {
	if (span === undefined || removed === 0) return span;
	if (removed > span.start) return undefined;
	return { start: span.start - removed, end: span.end - removed };
}

/** Indented re-serialization of one JSON document, or undefined when the run does not parse. */
function prettifyJson(source: string): string | undefined {
	try {
		return JSON.stringify(JSON.parse(source), undefined, JSON_INDENT);
	} catch {
		return undefined;
	}
}
