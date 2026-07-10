/**
 * Pure measurement logic: split a captured system prompt into semantic items
 * and estimate token sizes. No pi API access — unit-testable.
 *
 * Splitting relies on structural markers that pi's buildSystemPrompt() emits
 * deterministically (verified against pi 0.80.6 dist/core/system-prompt.js):
 *
 * - context files: <project_instructions path="...">...</project_instructions>
 * - skills block: "The following skills provide..." through </available_skills>
 * - base prompt ends with "Current date: ...\nCurrent working directory: ..."
 *   → anything after that line was appended by before_agent_start handlers.
 */
import {
	AGGREGATE_SOURCE_ID,
	type InjectionItem,
	type InjectionKind,
	type InjectionSource,
	PI_SOURCE_ID,
} from "./model.ts";

const PI_SOURCE: InjectionSource = { id: PI_SOURCE_ID, label: "pi", native: true };
const AGGREGATE_SOURCE: InjectionSource = {
	id: AGGREGATE_SOURCE_ID,
	label: "extensions (aggregate)",
	native: false,
};

/** Minimal slice of BuildSystemPromptOptions that measurement needs. */
export interface PromptOptionsSlice {
	cwd: string;
	customPrompt?: string;
	appendSystemPrompt?: string;
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: Array<{ name: string }>;
}

/** One active tool as it contributes to the initial context. */
export interface ToolSlice {
	name: string;
	/** Sent to the provider with every request. */
	description: string;
	/** JSON-serialized parameter schema; sent to the provider with every request. */
	parametersJson: string;
	/** One-line snippet rendered into the prompt's Available tools list. */
	snippet?: string;
	/** Guideline bullets rendered into the prompt's Guidelines section. */
	guidelines: string[];
	/** Provenance, e.g. "builtin" or "npm:pi-web-providers". */
	source: string;
}

/**
 * Split a captured system prompt into semantic items: pi base prompt,
 * appended prompt, context files, skills, active tool contributions, and the
 * aggregate appended by extensions.
 */
export function analyzeSystemPrompt(
	systemPrompt: string,
	options: PromptOptionsSlice,
	tools: ToolSlice[] = [],
): InjectionItem[] {
	const items: InjectionItem[] = [];
	const carvedSpans: Span[] = [];

	const baseEnd = findBasePromptEnd(systemPrompt, options.cwd);
	const base = baseEnd === -1 ? systemPrompt : systemPrompt.slice(0, baseEnd);

	measureTools(base, tools, items, carvedSpans);
	measureContextFiles(base, options, items, carvedSpans);
	measureSkills(base, options, items, carvedSpans);
	measureAppendedPrompt(base, options, items, carvedSpans);

	const baseLabel =
		options.customPrompt !== undefined && options.customPrompt.length > 0
			? "custom system prompt (--system-prompt)"
			: "base system prompt";
	items.unshift(createItem("base-prompt", "base-prompt", PI_SOURCE, baseLabel, carve(base, carvedSpans)));

	if (baseEnd !== -1 && baseEnd < systemPrompt.length) {
		const added = systemPrompt.slice(baseEnd);
		if (added.trim().length > 0) {
			items.push(
				createItem(
					"prompt-addition:aggregate",
					"prompt-addition",
					AGGREGATE_SOURCE,
					"system prompt additions",
					added,
				),
			);
		}
	}

	return items;
}

/**
 * Locate the end of pi's base system prompt: the exact two-line
 * "Current date/Current working directory" suffix buildSystemPrompt emits last.
 * Returns the index just past that line, or -1 when not found.
 */
export function findBasePromptEnd(systemPrompt: string, cwd: string): number {
	const now = new Date();
	const date = [
		now.getFullYear(),
		String(now.getMonth() + 1).padStart(2, "0"),
		String(now.getDate()).padStart(2, "0"),
	].join("-");
	const promptCwd = cwd.replace(/\\/g, "/");
	// A context file duplicating this exact marker is less likely than an
	// extension appending arbitrary text after the marker.
	const marker = `\nCurrent date: ${date}\nCurrent working directory: ${promptCwd}`;
	const index = systemPrompt.indexOf(marker);
	return index === -1 ? -1 : index + marker.length;
}

/** Same chars/4 heuristic pi's estimateTokens uses for text content. */
export function textTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Measure active tool contributions: per-tool definition payloads plus the
 * prompt snippet/guideline lines carved out of the base prompt. Built-in
 * tools collapse into one aggregate pi-native item.
 */
function measureTools(base: string, tools: ToolSlice[], items: InjectionItem[], carvedSpans: Span[]): void {
	let builtinDefinitions = "";
	const builtinChildren: InjectionItem[] = [];
	for (const tool of tools) {
		const definition = `${tool.name}: ${tool.description}\n${tool.parametersJson}`;
		if (tool.source === "builtin") {
			builtinDefinitions += `${definition}\n`;
			builtinChildren.push(createItem(`tool:builtin:${tool.name}`, "tool", PI_SOURCE, tool.name, definition));
			continue;
		}
		let promptText = "";
		if (tool.snippet !== undefined) {
			const span = findExactSpan(base, `\n- ${tool.name}: ${tool.snippet}`);
			if (span !== undefined) {
				promptText += base.slice(span.start, span.end);
				carvedSpans.push(span);
			}
		}
		for (const guideline of tool.guidelines) {
			const span = findExactSpan(base, `\n- ${guideline.trim()}`);
			if (span !== undefined) {
				promptText += base.slice(span.start, span.end);
				carvedSpans.push(span);
			}
		}
		const source = extensionSource(tool.source);
		items.push(createItem(`tool:${tool.source}:${tool.name}`, "tool", source, tool.name, promptText + definition));
	}
	if (builtinChildren.length > 0) {
		builtinChildren.sort((a, b) => b.tokens - a.tokens);
		items.push({
			...createItem(
				"tool:builtin",
				"tool",
				PI_SOURCE,
				`built-in tool definitions (${builtinChildren.length})`,
				builtinDefinitions,
			),
			children: builtinChildren,
		});
	}
}

/** Carve each <project_instructions> block out of the base prompt as its own item. */
function measureContextFiles(
	base: string,
	options: PromptOptionsSlice,
	items: InjectionItem[],
	carvedSpans: Span[],
): void {
	for (const file of options.contextFiles ?? []) {
		const span = findContextFileSpan(base, file.path);
		if (span === undefined) continue;
		items.push(
			createItem(
				`context-file:${file.path}`,
				"context-file",
				PI_SOURCE,
				file.path,
				base.slice(span.start, span.end),
			),
		);
		carvedSpans.push(span);
	}
}

/** Carve the skills block out of the base prompt as one aggregate item. */
function measureSkills(base: string, options: PromptOptionsSlice, items: InjectionItem[], carvedSpans: Span[]): void {
	const skillCount = options.skills?.length ?? 0;
	if (skillCount === 0) return;
	const span = findSkillsSpan(base);
	if (span === undefined) return;
	items.push(createItem("skills", "skills", PI_SOURCE, `skills (${skillCount})`, base.slice(span.start, span.end)));
	carvedSpans.push(span);
}

/** Carve the --append-system-prompt text out of the base prompt when present. */
function measureAppendedPrompt(
	base: string,
	options: PromptOptionsSlice,
	items: InjectionItem[],
	carvedSpans: Span[],
): void {
	const append = options.appendSystemPrompt;
	if (append === undefined || append.length === 0) return;
	const start = base.indexOf(append);
	if (start === -1) return;
	items.push(createItem("append-prompt", "append-prompt", PI_SOURCE, "appended system prompt", append));
	carvedSpans.push({ start, end: start + append.length });
}

/** Build an initial-phase InjectionItem with derived char/token sizes. */
function createItem(
	id: string,
	kind: InjectionKind,
	source: InjectionSource,
	label: string,
	text: string,
): InjectionItem {
	return {
		id,
		phase: "initial",
		kind,
		source,
		label,
		chars: text.length,
		tokens: textTokens(text),
		text,
	};
}

/** Injection source for a non-builtin tool provenance string. */
function extensionSource(source: string): InjectionSource {
	return { id: `tool-source:${source}`, label: source, native: false };
}

/** Remove the given spans from text, tolerating overlaps, and return the remainder. */
function carve(text: string, spans: Span[]): string {
	spans.sort((a, b) => a.start - b.start);
	let remainder = "";
	let cursor = 0;
	for (const span of spans) {
		remainder += text.slice(cursor, span.start);
		cursor = Math.max(cursor, span.end);
	}
	return remainder + text.slice(cursor);
}

/** Half-open [start, end) character range within the base prompt. */
interface Span {
	start: number;
	end: number;
}

/** Span of the first exact occurrence of needle, or undefined. */
function findExactSpan(haystack: string, needle: string): Span | undefined {
	const start = haystack.indexOf(needle);
	return start === -1 ? undefined : { start, end: start + needle.length };
}

/** Span of one <project_instructions path="...">...</project_instructions> block. */
function findContextFileSpan(systemPrompt: string, filePath: string): Span | undefined {
	const open = `<project_instructions path="${filePath}">`;
	const close = "</project_instructions>";
	const start = systemPrompt.indexOf(open);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(close, start);
	if (end === -1) return undefined;
	return { start, end: end + close.length };
}

/** Span of the skills intro sentence through </available_skills>. */
function findSkillsSpan(systemPrompt: string): Span | undefined {
	const open = "The following skills provide specialized instructions";
	const close = "</available_skills>";
	const start = systemPrompt.indexOf(open);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(close, start);
	if (end === -1) return undefined;
	return { start, end: end + close.length };
}
