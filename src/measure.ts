/**
 * Pure measurement logic: split a captured system prompt into semantic items
 * and estimate token sizes. No pi API access — unit-testable.
 *
 * Splitting relies on structural markers that pi's buildSystemPrompt() emits
 * deterministically (verified against pi 0.80.6 dist/core/system-prompt.js):
 *
 * - context files: <project_instructions path="...">...</project_instructions>
 * - skills block: "The following skills provide..." through </available_skills>
 * - base prompt ends before the "Current date/Current working directory" footer
 *   → anything after that footer was appended by before_agent_start handlers.
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

/** One visible skill before pi adds XML transport framing. */
export interface SkillSlice {
	name: string;
	description: string;
	filePath: string;
}

/** Minimal slice of BuildSystemPromptOptions that measurement needs. */
export interface PromptOptionsSlice {
	cwd: string;
	/** Home directory used to abbreviate context-file paths; omitted disables it. */
	homeDir?: string;
	customPrompt?: string;
	appendSystemPrompt?: string;
	contextFilePaths?: string[];
	skills?: SkillSlice[];
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

	const footer = findBasePromptFooter(systemPrompt, options.cwd);
	const base = footer === undefined ? systemPrompt : systemPrompt.slice(0, footer.start);

	const usesCustomPrompt = options.customPrompt !== undefined && options.customPrompt.length > 0;
	measureTools(usesCustomPrompt ? "" : base, tools, items, carvedSpans);
	measureContextFiles(base, options, items, carvedSpans);
	measureSkills(base, options, items, carvedSpans);
	measureAppendedPrompt(base, options, items, carvedSpans);

	const baseLabel = usesCustomPrompt ? "Custom Prompt (--system-prompt)" : "Base Prompt";
	items.unshift(createItem("base-prompt", "base-prompt", PI_SOURCE, baseLabel, carve(base, carvedSpans)));

	if (footer !== undefined && footer.end < systemPrompt.length) {
		const added = systemPrompt.slice(footer.end);
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
	const builtinChildren: InjectionItem[] = [];
	for (const tool of tools) {
		const definition = `${tool.name}: ${tool.description}\n${tool.parametersJson}`;
		if (tool.source === "builtin") {
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
		const label = `Built-in Tools (${builtinChildren.length})`;
		const text = builtinChildren.map((child) => child.text).join("\n");
		items.push({
			...createItem("tool:builtin", "tool", PI_SOURCE, label, text),
			chars: builtinChildren.reduce((sum, child) => sum + child.chars, 0),
			tokens: builtinChildren.reduce((sum, child) => sum + child.tokens, 0),
			children: builtinChildren,
		});
	}
}

/** Measure context-file contents without counting pi's XML transport scaffolding. */
function measureContextFiles(
	base: string,
	options: PromptOptionsSlice,
	items: InjectionItem[],
	carvedSpans: Span[],
): void {
	const sectionSpan = findContextSectionSpan(base);
	if (sectionSpan === undefined) return;
	for (const filePath of options.contextFilePaths ?? []) {
		const content = findContextFileContent(base, filePath);
		if (content === undefined) continue;
		items.push(
			createItem(
				`context-file:${filePath}`,
				"context-file",
				PI_SOURCE,
				abbreviateHome(filePath, options.homeDir),
				content,
			),
		);
	}
	carvedSpans.push(expandLineBreaks(base, sectionSpan));
}

/** Carve the skills section and expose each semantic skill record as a child item. */
function measureSkills(
	base: string,
	options: PromptOptionsSlice,
	items: InjectionItem[],
	carvedSpans: Span[],
): void {
	const sectionSpan = findSkillsSpan(base);
	if (sectionSpan === undefined) return;
	const children = (options.skills ?? [])
		.map((skill) => createItem(
			`skill:${skill.name}`,
			"skills",
			PI_SOURCE,
			skill.name,
			[skill.name, skill.description, skill.filePath].join("\n"),
		))
		.sort((a, b) => b.tokens - a.tokens);
	carvedSpans.push(expandLineBreaks(base, sectionSpan));
	if (children.length === 0) return;

	items.push(createAggregateItem("skills", "skills", PI_SOURCE, `Skills (${children.length})`, children));
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
	const generatedStarts = [findContextSectionSpan(base)?.start, findSkillsSpan(base)?.start]
		.filter((start): start is number => start !== undefined);
	const generatedStart = generatedStarts.length === 0 ? base.length : Math.min(...generatedStarts);
	const beforeGeneratedSections = Math.max(0, generatedStart - append.length);
	const expectedStart = base.lastIndexOf(append, beforeGeneratedSections);
	const start = expectedStart === -1 ? base.lastIndexOf(append) : expectedStart;
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

/** Build an aggregate whose totals exactly reconcile with its child items. */
function createAggregateItem(
	id: string,
	kind: InjectionKind,
	source: InjectionSource,
	label: string,
	children: InjectionItem[],
): InjectionItem {
	return {
		...createItem(id, kind, source, label, children.map((child) => child.text).join("\n")),
		chars: children.reduce((sum, child) => sum + child.chars, 0),
		tokens: children.reduce((sum, child) => sum + child.tokens, 0),
		children,
	};
}

/** Injection source for a non-builtin tool provenance string. */
function extensionSource(source: string): InjectionSource {
	return { id: `tool-source:${source}`, label: source, native: false };
}

/** Replace a leading home-directory prefix with `~` for compact path labels. */
function abbreviateHome(path: string, homeDir: string | undefined): string {
	if (homeDir === undefined || homeDir.length === 0) return path;
	if (path === homeDir) return "~";
	if (path.startsWith(`${homeDir}/`)) return `~${path.slice(homeDir.length)}`;
	return path;
}

/** Remove the given spans from text, tolerating overlaps, and return the remainder. */
function carve(text: string, spans: Span[]): string {
	spans.sort((a, b) => a.start - b.start);
	let remainder = "";
	let cursor = 0;
	for (const span of spans) {
		if (span.start > cursor) remainder += text.slice(cursor, span.start);
		cursor = Math.max(cursor, span.end);
	}
	return remainder + text.slice(cursor);
}

/** Half-open [start, end) character range within the base prompt. */
interface Span {
	start: number;
	end: number;
}

/** Locate pi's dynamic date/CWD footer so it can be excluded from Base Prompt and extension additions. */
function findBasePromptFooter(systemPrompt: string, cwd: string): Span | undefined {
	const promptCwd = cwd.replace(/\\/g, "/");
	const cwdLine = `\nCurrent working directory: ${promptCwd}`;
	let cwdStart = systemPrompt.lastIndexOf(cwdLine);
	while (cwdStart !== -1) {
		const dateStart = systemPrompt.lastIndexOf("\nCurrent date: ", cwdStart);
		const dateLine = dateStart === -1 ? "" : systemPrompt.slice(dateStart, cwdStart);
		if (/^\nCurrent date: \d{4}-\d{2}-\d{2}$/.test(dateLine)) {
			return { start: dateStart, end: cwdStart + cwdLine.length };
		}
		cwdStart = systemPrompt.lastIndexOf(cwdLine, cwdStart - 1);
	}
	return undefined;
}

/** Span of the first exact occurrence of needle, or undefined. */
function findExactSpan(haystack: string, needle: string): Span | undefined {
	const start = haystack.indexOf(needle);
	return start === -1 ? undefined : { start, end: start + needle.length };
}

/** Span of pi's complete project-context transport section. */
function findContextSectionSpan(systemPrompt: string): Span | undefined {
	return findDelimitedSpan(systemPrompt, "<project_context>", "</project_context>");
}

/** Extract one context file's final content without its project-instructions wrapper. */
function findContextFileContent(systemPrompt: string, filePath: string): string | undefined {
	const open = `<project_instructions path="${filePath}">`;
	const close = "</project_instructions>";
	const wrapper = findDelimitedSpan(systemPrompt, open, close);
	if (wrapper === undefined) return undefined;
	let start = wrapper.start + open.length;
	let end = wrapper.end - close.length;
	if (systemPrompt.startsWith("\r\n", start)) start += 2;
	else if (systemPrompt[start] === "\n") start++;
	if (systemPrompt.slice(Math.max(start, end - 2), end) === "\r\n") end -= 2;
	else if (systemPrompt[end - 1] === "\n") end--;
	return systemPrompt.slice(start, end);
}

/** Span of the skills intro sentence through </available_skills>. */
function findSkillsSpan(systemPrompt: string): Span | undefined {
	const open = "The following skills provide specialized instructions";
	const close = "</available_skills>";
	const start = systemPrompt.lastIndexOf(open);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(close, start);
	return end === -1 ? undefined : { start, end: end + close.length };
}

/** Locate a complete delimited transport wrapper. */
function findDelimitedSpan(text: string, open: string, close: string): Span | undefined {
	const start = text.indexOf(open);
	if (start === -1) return undefined;
	const closeStart = text.indexOf(close, start + open.length);
	return closeStart === -1 ? undefined : { start, end: closeStart + close.length };
}

/** Include surrounding transport-only line breaks when carving a generated section. */
function expandLineBreaks(text: string, span: Span): Span {
	let start = span.start;
	let end = span.end;
	while (start > 0 && (text[start - 1] === "\n" || text[start - 1] === "\r")) start--;
	while (end < text.length && (text[end] === "\n" || text[end] === "\r")) end++;
	return { start, end };
}
