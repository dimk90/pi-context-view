/**
 * Pure measurement logic: split a captured system prompt into semantic items
 * and estimate token sizes. No pi API access — unit-testable.
 *
 * Splitting relies on structural markers that pi's buildSystemPrompt() emits
 * deterministically (verified against pi 0.81.1 dist/core/system-prompt.js):
 *
 * - context files: <project_instructions path="...">...</project_instructions>
 * - skills block: "The following skills provide..." through </available_skills>
 * - tool prompt lines: the bullet blocks under "Available tools:" and
 *   "Guidelines:", where pi renders each distinct bullet exactly once, in
 *   active-tool order (verified against pi 0.84.3)
 * - base prompt blocks: the "Available tools:", "Guidelines:", and
 *   "Pi documentation" headers pi emits in that order, which split its own
 *   prompt into the parts System Prompt presents as sub-items
 * - the "Current working directory" footer (pi 0.81), optionally preceded by a
 *   "Current date" line (pi 0.80), closes pi's own prompt: pi sends it with
 *   every request, so it is measured as the Current Dir part, and anything
 *   after it was appended by before_agent_start handlers.
 */
import {
	AGGREGATE_SOURCE_ID,
	BUILT_IN_TOOLS_LABEL,
	type InjectedReference,
	INSTRUCTION_FILES_LABEL,
	type InjectionItem,
	type InjectionKind,
	type InjectionSection,
	type InjectionSource,
	type JsonSpan,
	PI_SOURCE_ID,
	SKILLS_LABEL,
	SYSTEM_PROMPT_LABEL,
} from "./model.ts";

const PI_SOURCE: InjectionSource = { id: PI_SOURCE_ID, label: "pi", native: true };
const AGGREGATE_SOURCE: InjectionSource = {
	id: AGGREGATE_SOURCE_ID,
	label: "extensions (aggregate)",
	native: false,
};

/** Part names shared by a tool's carved prompt lines and pi's own prompt blocks. */
const AVAILABLE_TOOLS_LABEL = "Available Tools";
const GUIDELINES_LABEL = "Guidelines";

/** Leading part of pi's prompt, before the first block header pi renders. */
const PREAMBLE_BLOCK = { id: "base-prompt:preamble", label: "Preamble" };

/** Block pi renders one bullet per visible tool into. */
const AVAILABLE_TOOLS_BLOCK = {
	id: "base-prompt:available-tools",
	label: AVAILABLE_TOOLS_LABEL,
	header: "\nAvailable tools:\n",
};
/** Block pi renders tool guideline bullets into. */
const GUIDELINES_BLOCK = { id: "base-prompt:guidelines", label: GUIDELINES_LABEL, header: "\nGuidelines:\n" };

/** Blocks pi renders into its own base prompt, in emission order. */
const BASE_PROMPT_BLOCKS = [
	AVAILABLE_TOOLS_BLOCK,
	GUIDELINES_BLOCK,
	{ id: "base-prompt:documentation", label: "Documentation", header: "\nPi documentation" },
];

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
	const injectedSpans = measureTools(usesCustomPrompt ? "" : base, tools, items, carvedSpans);
	measureContextFiles(base, options, items, carvedSpans);
	measureSkills(base, options, items, carvedSpans);
	const appended = carveAppendedPrompt(base, options, carvedSpans);

	const parts = addInjectedReferences(
		splitBasePromptParts(carve(base, carvedSpans), usesCustomPrompt),
		base,
		carvedSpans,
		injectedSpans,
	);
	if (appended !== undefined) {
		parts.push({ id: "base-prompt:appended", kind: "append-prompt", label: "Appended Prompt", text: appended });
	}
	if (footer !== undefined) {
		const text = systemPrompt.slice(footer.start, footer.end);
		parts.push({ id: "base-prompt:current-dir", kind: "base-prompt", label: "Current Dir", text });
	}
	items.unshift(createSystemPromptItem(parts));

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
	return charTokens(text.length);
}

/** Token estimate for an already known character count. */
function charTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

/**
 * Measure active tool contributions: per-tool definition payloads plus the
 * prompt snippet/guideline lines carved out of the base prompt. Built-in
 * tools collapse into one aggregate pi-native item.
 */
function measureTools(
	base: string,
	tools: ToolSlice[],
	items: InjectionItem[],
	carvedSpans: Span[],
): InjectedSpan[] {
	const carver = createPromptCarver(base, carvedSpans);
	const claimedGuidelines = new Set(piOwnedGuidelines(tools));
	const builtinChildren: InjectionItem[] = [];
	for (const tool of tools) {
		// Built-in tools claim their bullets without carving them, so a later
		// extension tool repeating one cannot take a line pi already renders for
		// pi itself or for a built-in tool.
		const ownedGuidelines = claimGuidelines(tool, claimedGuidelines);
		const definition = createDefinitionSection(tool);
		if (tool.source === "builtin") {
			builtinChildren.push(createToolItem(`tool:builtin:${tool.name}`, PI_SOURCE, tool.name, [definition]));
			continue;
		}
		const sections = [...carveToolPromptSections(carver, tool, ownedGuidelines), definition];
		const source = extensionSource(tool.source);
		items.push(createToolItem(`tool:${tool.source}:${tool.name}`, source, tool.name, sections));
	}
	if (builtinChildren.length > 0) {
		builtinChildren.sort((a, b) => b.tokens - a.tokens);
		const label = `${BUILT_IN_TOOLS_LABEL} (${builtinChildren.length})`;
		items.push(createAggregateItem("tool:builtin", "tool", PI_SOURCE, label, builtinChildren));
	}
	return carver.injectedSpans;
}

/** One labeled part of a tool item's text, before it receives its token share. */
interface SectionDraft {
	readonly label: string;
	readonly text: string;
	/** Serialized JSON inside `text`; marked here rather than detected in the preview. */
	readonly jsonSpan?: JsonSpan;
	/** Prompt-line insertions that affect only the preview, never this section's estimate. */
	readonly injectedReferences?: readonly InjectedReference[];
}

/** The payload one tool sends with every request: its name, description, and parameter schema. */
function createDefinitionSection(tool: ToolSlice): SectionDraft {
	const heading = `${tool.name}: ${tool.description}\n`;
	return {
		label: "Definition",
		text: `${heading}${tool.parametersJson}`,
		jsonSpan: { start: heading.length, end: heading.length + tool.parametersJson.length },
	};
}

/**
 * Carve this tool's Available tools snippet and the Guidelines bullets it owns
 * out of the base prompt, so its prompt lines are attributed to the tool that
 * produced them.
 */
function carveToolPromptSections(
	carver: PromptCarver,
	tool: ToolSlice,
	ownedGuidelines: string[],
): SectionDraft[] {
	const sections: SectionDraft[] = [];
	const owner: InjectedOwner = {
		itemId: `tool:${tool.source}:${tool.name}`,
		source: extensionSource(tool.source),
	};
	const snippet = tool.snippet === undefined
		? undefined
		: carveInjectedLine(carver, carver.toolsBlock, `\n- ${tool.name}: ${tool.snippet}`, owner);
	if (snippet !== undefined) {
		sections.push({ label: AVAILABLE_TOOLS_LABEL, text: carver.base.slice(snippet.start, snippet.end) });
	}
	let bullets = "";
	for (const guideline of ownedGuidelines) {
		const span = carveInjectedLine(carver, carver.guidelinesBlock, `\n- ${guideline}`, owner);
		if (span === undefined) continue;
		bullets += carver.base.slice(span.start, span.end);
	}
	if (bullets.length > 0) sections.push({ label: GUIDELINES_LABEL, text: bullets });
	return sections;
}

/** Base-prompt regions where pi renders tool prompt lines, plus the carve log to append to. */
interface PromptCarver {
	readonly base: string;
	/** Bullet lines pi renders under "Available tools:". */
	readonly toolsBlock: CarvedBlock;
	/** Bullet lines pi renders under "Guidelines:". */
	readonly guidelinesBlock: CarvedBlock;
	readonly carvedSpans: Span[];
	readonly injectedSpans: InjectedSpan[];
}

/** One System Prompt part and the region of it pi renders tool prompt lines into. */
interface CarvedBlock {
	/** Id of the System Prompt part that keeps these lines as preview references. */
	readonly partId: string;
	readonly span: Span | undefined;
}

/** The tool item that counts a carved prompt line. */
interface InjectedOwner {
	readonly itemId: string;
	readonly source: InjectionSource;
}

/** Original prompt location, owner, and System Prompt part of a carved prompt line. */
interface InjectedSpan extends Span, InjectedOwner {
	readonly partId: string;
}

/** Locate the two bullet blocks pi renders tool prompt lines into. */
function createPromptCarver(base: string, carvedSpans: Span[]): PromptCarver {
	return {
		base,
		toolsBlock: { partId: AVAILABLE_TOOLS_BLOCK.id, span: findBulletBlock(base, AVAILABLE_TOOLS_BLOCK.header) },
		guidelinesBlock: { partId: GUIDELINES_BLOCK.id, span: findBulletBlock(base, GUIDELINES_BLOCK.header) },
		carvedSpans,
		injectedSpans: [],
	};
}

/**
 * Span of the bullet lines one section header introduces: from the line break
 * before the first bullet to the blank line that closes the section. Bullets
 * never contain a blank line, so the block ends exactly where pi ends it.
 */
function findBulletBlock(text: string, header: string): Span | undefined {
	const headerStart = text.indexOf(header);
	if (headerStart === -1) return undefined;
	const start = headerStart + header.length - 1;
	const blank = text.indexOf("\n\n", start);
	return { start, end: blank === -1 ? text.length : blank };
}

/**
 * Carve one rendered prompt line out of its block and remember where pi put it,
 * so the part it left keeps it as a preview reference owned by its tool.
 */
function carveInjectedLine(
	carver: PromptCarver,
	block: CarvedBlock,
	line: string,
	owner: InjectedOwner,
): Span | undefined {
	const span = carveBlockLine(carver, block.span, line);
	if (span !== undefined) carver.injectedSpans.push({ ...span, ...owner, partId: block.partId });
	return span;
}

/** Record one complete prompt bullet inside its block, never a prefix of another bullet. */
function carveBlockLine(carver: PromptCarver, block: Span | undefined, line: string): Span | undefined {
	if (block === undefined) return undefined;
	let start = carver.base.indexOf(line, block.start);
	while (start !== -1 && start + line.length <= block.end) {
		const end = start + line.length;
		if (end === block.end || carver.base[end] === "\n") {
			const span = { start, end };
			carver.carvedSpans.push(span);
			return span;
		}
		start = carver.base.indexOf(line, end);
	}
	return undefined;
}

/**
 * Bullets pi's Guidelines section carries on its own behalf, reserved before
 * any tool can claim one. Pi adds this file-exploration bullet ahead of tool
 * guidelines, so an identical tool bullet is deduplicated away. Pi's two
 * trailing bullets ("Be concise in your responses", "Show file paths clearly
 * when working with files") need no reservation: pi appends them after tool
 * guidelines, where a tool declaring one already owns the rendered line.
 */
function piOwnedGuidelines(tools: ToolSlice[]): string[] {
	const names = new Set(tools.map((tool) => tool.name));
	const shellOnly = (names.has("bash") || names.has("powershell")) &&
		!names.has("grep") && !names.has("find") && !names.has("ls");
	if (!shellOnly) return [];
	if (names.has("bash") && names.has("powershell")) {
		return ["Use bash or PowerShell for file operations like listing, searching, and finding files"];
	}
	if (names.has("powershell")) {
		return ["Use PowerShell for file operations like listing, searching, and finding files"];
	}
	return ["Use bash for file operations like ls, rg, find"];
}

/**
 * Guideline texts this tool is the first to declare, in pi's active-tool
 * order. Pi renders each distinct bullet once, so a later tool repeating one
 * contributes no prompt line and must not count its tokens again.
 */
function claimGuidelines(tool: ToolSlice, claimed: Set<string>): string[] {
	const owned: string[] = [];
	for (const guideline of tool.guidelines) {
		const text = guideline.trim();
		if (text.length === 0 || claimed.has(text)) continue;
		claimed.add(text);
		owned.push(text);
	}
	return owned;
}

/**
 * Carve pi's project-context section and expose each context file as a child of
 * one Instruction Files aggregate, without counting the XML transport scaffolding.
 */
function measureContextFiles(
	base: string,
	options: PromptOptionsSlice,
	items: InjectionItem[],
	carvedSpans: Span[],
): void {
	const sectionSpan = findContextSectionSpan(base);
	if (sectionSpan === undefined) return;
	const children: InjectionItem[] = [];
	for (const filePath of options.contextFilePaths ?? []) {
		const content = findContextFileContent(base, filePath);
		if (content === undefined) continue;
		children.push(createItem(
			`context-file:${filePath}`,
			"context-file",
			PI_SOURCE,
			abbreviateHome(filePath, options.homeDir),
			content,
		));
	}
	children.sort((a, b) => b.tokens - a.tokens);
	carvedSpans.push(expandLineBreaks(base, sectionSpan));
	if (children.length === 0) return;

	const label = `${INSTRUCTION_FILES_LABEL} (${children.length})`;
	items.push(createAggregateItem("context-files", "context-file", PI_SOURCE, label, children));
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

	items.push(createAggregateItem("skills", "skills", PI_SOURCE, `${SKILLS_LABEL} (${children.length})`, children));
}

/**
 * Carve the --append-system-prompt text out of the base prompt so it becomes a
 * labeled part of System Prompt instead of free text inside pi's own blocks.
 */
function carveAppendedPrompt(
	base: string,
	options: PromptOptionsSlice,
	carvedSpans: Span[],
): string | undefined {
	const append = options.appendSystemPrompt;
	if (append === undefined || append.length === 0) return undefined;
	const generatedStarts = [findContextSectionSpan(base)?.start, findSkillsSpan(base)?.start]
		.filter((start): start is number => start !== undefined);
	const generatedStart = generatedStarts.length === 0 ? base.length : Math.min(...generatedStarts);
	const beforeGeneratedSections = Math.max(0, generatedStart - append.length);
	const expectedStart = base.lastIndexOf(append, beforeGeneratedSections);
	const start = expectedStart === -1 ? base.lastIndexOf(append) : expectedStart;
	if (start === -1) return undefined;
	carvedSpans.push({ start, end: start + append.length });
	return append;
}

/** One labeled part of the System Prompt item, before it receives its token share. */
interface PromptPart {
	readonly id: string;
	readonly kind: InjectionKind;
	readonly label: string;
	readonly text: string;
	readonly injectedReferences?: readonly InjectedReference[];
}

/**
 * Restore carved prompt lines as preview-only references in the part each was
 * taken from. Offsets refer to the carved text, so all existing char counts,
 * rounded token shares, and section concatenation remain unchanged.
 */
function addInjectedReferences(
	parts: PromptPart[],
	base: string,
	carvedSpans: Span[],
	injectedSpans: InjectedSpan[],
): PromptPart[] {
	if (injectedSpans.length === 0) return parts;
	let offset = 0;
	return parts.map((part) => {
		const partStart = offset;
		offset += part.text.length;
		const spans = injectedSpans.filter((span) => span.partId === part.id);
		if (spans.length === 0) return part;
		return {
			...part,
			injectedReferences: spans
				.sort((a, b) => a.start - b.start)
				.map((span) => ({
					offset: carve(base.slice(0, span.start), carvedSpans).length - partStart,
					text: base.slice(span.start, span.end),
					itemId: span.itemId,
					source: span.source,
				})),
		};
	});
}

/**
 * Split pi's own prompt at the block headers it renders deterministically, so
 * the tool list, guidelines, and documentation it already carries become
 * visible parts. Text before the first header opens the list as the preamble.
 * A --system-prompt replacement carries none of pi's blocks, so it stays one
 * undivided preamble.
 */
function splitBasePromptParts(base: string, usesCustomPrompt: boolean): PromptPart[] {
	const parts: PromptPart[] = [];
	let block = PREAMBLE_BLOCK;
	let start = 0;
	if (!usesCustomPrompt) {
		for (const next of BASE_PROMPT_BLOCKS) {
			const headerStart = base.indexOf(next.header, start);
			if (headerStart === -1) continue;
			appendPromptPart(parts, block, base.slice(start, headerStart));
			block = next;
			start = headerStart;
		}
	}
	appendPromptPart(parts, block, base.slice(start));
	return parts;
}

/** Record one pi-authored part, skipping a block pi rendered no text into. */
function appendPromptPart(parts: PromptPart[], block: { id: string; label: string }, text: string): void {
	if (text.length === 0) return;
	parts.push({ id: block.id, kind: "base-prompt", label: block.label, text });
}

/**
 * Build the System Prompt item from its labeled parts. Parts concatenate back to
 * the item text and take cumulative shares of its estimate, so children break the
 * item down without adding tokens. A prompt with one part stays undivided.
 */
function createSystemPromptItem(parts: readonly PromptPart[]): InjectionItem {
	const text = parts.map((part) => part.text).join("");
	const item = createItem("base-prompt", "base-prompt", PI_SOURCE, SYSTEM_PROMPT_LABEL, text);
	if (parts.length < 2) return item;
	const sections = allocateSectionTokens(parts.map((part) => ({
		label: part.label,
		text: part.text,
		injectedReferences: part.injectedReferences,
	})));
	return {
		...item,
		sections,
		children: parts.map((part, index) => ({
			...createItem(part.id, part.kind, PI_SOURCE, part.label, part.text),
			tokens: sections[index]?.tokens ?? 0,
			injectedReferences: part.injectedReferences,
		})),
	};
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

/** Build a tool item whose raw text is exactly the concatenation of its sections. */
function createToolItem(
	id: string,
	source: InjectionSource,
	label: string,
	sections: SectionDraft[],
): InjectionItem {
	const text = sections.map((section) => section.text).join("");
	return { ...createItem(id, "tool", source, label, text), sections: allocateSectionTokens(sections) };
}

/**
 * Give each section its share of the item estimate. Shares are cumulative
 * differences rather than independently rounded counts, so they always sum to
 * the item total.
 */
function allocateSectionTokens(sections: SectionDraft[]): InjectionSection[] {
	let chars = 0;
	let allocated = 0;
	return sections.map((section) => {
		chars += section.text.length;
		const cumulative = charTokens(chars);
		const tokens = cumulative - allocated;
		allocated = cumulative;
		return { ...section, tokens };
	});
}

/** Line break joining consecutive child texts inside an aggregate's raw text. */
const CHILD_SEPARATOR = "\n";

/**
 * Build an aggregate whose totals exactly reconcile with its child items and
 * whose preview presents every child as its own labeled part, so each child
 * keeps its subheader, token share, and marked JSON run.
 */
function createAggregateItem(
	id: string,
	kind: InjectionKind,
	source: InjectionSource,
	label: string,
	children: InjectionItem[],
): InjectionItem {
	return {
		...createItem(id, kind, source, label, children.map((child) => child.text).join(CHILD_SEPARATOR)),
		chars: children.reduce((sum, child) => sum + child.chars, 0),
		tokens: children.reduce((sum, child) => sum + child.tokens, 0),
		sections: children.map((child, index) =>
			childSection(child, index === 0 ? "" : CHILD_SEPARATOR)
		),
		children,
	};
}

/**
 * One child as a labeled part of its aggregate, opening with the separator the
 * aggregate text joins on; the preview drops that separator again.
 */
function childSection(child: InjectionItem, separator: string): InjectionSection {
	const span = childJsonSpan(child);
	return {
		label: child.label,
		text: `${separator}${child.text}`,
		tokens: child.tokens,
		jsonSpan: span === undefined
			? undefined
			: { start: span.start + separator.length, end: span.end + separator.length },
	};
}

/**
 * The JSON run marked inside a child's whole text: its own span, or the span of
 * its single part. A child split into several parts marks each part separately,
 * so no one run covers its text and the aggregate part expands nothing.
 */
function childJsonSpan(child: InjectionItem): JsonSpan | undefined {
	const sections = child.sections;
	if (sections === undefined) return child.jsonSpan;
	return sections.length === 1 ? sections[0]?.jsonSpan : undefined;
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

/**
 * Locate pi's dynamic CWD footer so it can be excluded from System Prompt and
 * extension additions. Pi 0.81 emits only the "Current working directory"
 * line; pi 0.80 preceded it with a "Current date" line, still recognized for
 * compatibility. The CWD line must match the exact resolved cwd on a complete
 * line (preceded by "\n", followed by "\n" or end of prompt) so ordinary
 * prompt text mentioning the cwd is not mistaken for the footer.
 */
function findBasePromptFooter(systemPrompt: string, cwd: string): Span | undefined {
	const promptCwd = cwd.replace(/\\/g, "/");
	const cwdLine = `\nCurrent working directory: ${promptCwd}`;
	let cwdStart = systemPrompt.lastIndexOf(cwdLine);
	while (cwdStart !== -1) {
		const end = cwdStart + cwdLine.length;
		if (end === systemPrompt.length || systemPrompt[end] === "\n") {
			const dateStart = systemPrompt.lastIndexOf("\nCurrent date: ", cwdStart);
			const dateLine = dateStart === -1 ? "" : systemPrompt.slice(dateStart, cwdStart);
			const start = /^\nCurrent date: \d{4}-\d{2}-\d{2}$/.test(dateLine) ? dateStart : cwdStart;
			return { start, end };
		}
		cwdStart = systemPrompt.lastIndexOf(cwdLine, cwdStart - 1);
	}
	return undefined;
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
