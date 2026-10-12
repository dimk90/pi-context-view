/**
 * Pure measurement logic: split a captured system prompt into semantic items
 * and estimate token sizes. No pi API access — unit-testable.
 *
 * Pi renders independently replaceable XML sections. Their wrappers locate
 * content; custom sections remain System Prompt parts rather than additions.
 * Unwrapped text between or after sections is an extension addition. In the
 * `tools` and `rules` sections, pi renders each distinct bullet exactly once,
 * in active-tool order, so tool lines are annotated with their tools. System
 * Prompt counts all of its text, extension lines included.
 */
import {
	AGGREGATE_SOURCE,
	BUILT_IN_TOOLS_LABEL,
	type ExtensionProvenance,
	extensionSource,
	type InjectedReference,
	INSTRUCTION_FILES_LABEL,
	type InjectionItem,
	type InjectionKind,
	type InjectionSection,
	type InjectionSource,
	type JsonSpan,
	PI_SOURCE,
	type RequestChange,
	SKILLS_LABEL,
	SYSTEM_PROMPT_LABEL,
	type TextSpan,
} from "./model.ts";
import { type PromptAdditionOptions, splitPromptAdditions } from "./prompt-additions.ts";
import {
	AVAILABLE_TOOLS_BLOCK,
	BASE_PROMPT_BLOCKS,
	DOCUMENTATION_BLOCK,
	findPromptSections,
	findSectionToolBlocks,
	GUIDELINES_BLOCK,
	type LocatedPromptBlock,
	type PromptSection,
} from "./prompt-blocks.ts";

/** Part names shared by a tool's dropped prompt lines and pi's own prompt blocks. */
const AVAILABLE_TOOLS_LABEL = AVAILABLE_TOOLS_BLOCK.label;
const GUIDELINES_LABEL = GUIDELINES_BLOCK.label;

/** System Prompt part holding the unwrapped text extensions added around pi's sections. */
const EXTENSION_ADDITIONS_BLOCK = { id: "base-prompt:additions", label: "Extension Additions" };

/** Leading part of pi's prompt, before its first XML section. */
const PREAMBLE_BLOCK = { id: "base-prompt:preamble", label: "Preamble" };

/** Id of the System Prompt item, which holds pi's whole prompt. */
export const SYSTEM_PROMPT_ITEM_ID = "base-prompt";

/** `ToolSlice.source` of a recorded tool no extension registers now: its owner is unknown. */
export const UNREGISTERED_TOOL_SOURCE = "unattributed";

/** Known XML section names retain the existing semantic ids and labels. */
const SECTION_PARTS: Readonly<Record<string, { id: string; label: string }>> = {
	tools: AVAILABLE_TOOLS_BLOCK,
	rules: GUIDELINES_BLOCK,
	docs: DOCUMENTATION_BLOCK,
	addendum: { id: "base-prompt:appended", label: "Appended Prompt" },
	cwd: { id: "base-prompt:current-dir", label: "Current Dir" },
	project_context: { id: "base-prompt:context-files", label: INSTRUCTION_FILES_LABEL },
	skills: { id: "base-prompt:skills", label: SKILLS_LABEL },
};

/** Ids of the System Prompt parts pi renders itself; custom sections and Extension Additions are not among them. */
const PI_PROMPT_PART_IDS: ReadonlySet<string> = new Set([
	PREAMBLE_BLOCK.id,
	...Object.values(SECTION_PARTS).map((part) => part.id),
]);

/**
 * Whether a System Prompt part is one pi renders itself, so pi's default
 * prompt has it too. A custom section is an extension's own, and Extension
 * Additions hold only text extensions added.
 */
export function isPiPromptPart(id: string): boolean {
	return PI_PROMPT_PART_IDS.has(id);
}

/** Minimal slice of BuildSystemPromptOptions that measurement needs. */
export interface PromptOptionsSlice {
	/** Home directory used to abbreviate context-file paths; omitted disables it. */
	homeDir?: string;
	/** Replacement preamble; pi's native sections it leaves absent are marked dropped. */
	customPrompt?: string;
	/** Custom section bodies, including overrides of Pi's named sections. */
	sections?: Record<string, string>;
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
	/** Provenance, e.g. "builtin", "npm:pi-web-providers", or `UNREGISTERED_TOOL_SOURCE`. */
	source: string;
	/** Entry path of the owning extension; tells path extensions (`cli`, `local`) apart. */
	sourcePath?: string;
	/** Request-only change of the declaration; a deleted tool keeps only its uncounted definition. */
	change?: RequestChange;
}

/** One section the request deleted, as the session recorded it. */
export interface DeletedSection {
	readonly name: string;
	/** Recorded section text, including its XML wrapper. */
	readonly text: string;
}

/** Request-only prompt changes and their replayed layout; a forced prompt ignores them. */
export interface PromptChanges {
	/** Added or changed sections by name; `preamble` also stands for changed plain content. */
	readonly sections?: ReadonlyMap<string, Exclude<RequestChange, "deleted" | "forced">>;
	/** Sections the request removed, in session order. */
	readonly deleted?: readonly DeletedSection[];
	/** Exact recorded layout, including sections without Pi's usual XML framing. */
	readonly replayed?: { readonly content: string; readonly sections: Readonly<Record<string, string | null>> };
}

/**
 * Split a captured system prompt into semantic items: pi base prompt,
 * appended prompt, context files, skills, and active tool definitions. The
 * unwrapped text extensions added around pi's sections is the System Prompt's
 * Extension Additions part. `changes` marks the parts a request-only change
 * touched.
 */
export function analyzeSystemPrompt(
	systemPrompt: string,
	options: PromptOptionsSlice,
	tools: ToolSlice[] = [],
	additions: PromptAdditionOptions = {},
	changes: PromptChanges = {},
): InjectionItem[] {
	const names = new Set<string>();
	const sections = (changes.replayed === undefined
		? findPromptSections(systemPrompt)
		: locateReplayedSections(changes.replayed)).filter((section) => {
		if (names.has(section.name)) return false;
		names.add(section.name);
		return true;
	});
	if (sections.length === 0 && changes.replayed === undefined) {
		return analyzeForcedPrompt(systemPrompt, tools, additions.sources ?? []);
	}
	return analyzePromptSections(systemPrompt, sections, options, tools, additions, changes);
}

/**
 * Locate sections from the replay's exact join order, not by searching their
 * text. Request patches may supply inline wrappers, unwrapped text, or empty
 * sections; identical text elsewhere in the prompt must not steal their marker.
 */
function locateReplayedSections(state: NonNullable<PromptChanges["replayed"]>): PromptSection[] {
	const located: PromptSection[] = [];
	let offset = state.content.length;
	for (const [name, text] of Object.entries(state.sections)) {
		if (text === null) continue;
		const start = offset + (offset > 0 && text.length > 0 ? 2 : 0);
		const end = start + text.length;
		offset = end;
		if (name === "preamble") continue;
		const open = `<${name}>`;
		const close = `</${name}>`;
		const wrapped = text.startsWith(open) && text.endsWith(close);
		let bodyStart = wrapped ? start + open.length : start;
		let bodyEnd = wrapped ? end - close.length : end;
		if (wrapped && text[open.length] === "\n") bodyStart++;
		if (wrapped && text[text.length - close.length - 1] === "\n") bodyEnd--;
		// PromptSection includes the character before its body for tool bullet attribution
		located.push({ name, start, end, body: { start: bodyStart - 1, end: Math.max(bodyStart, bodyEnd) } });
	}
	return located;
}

/**
 * Pi always renders a `cwd` section, so only a forced prompt has none. It is
 * one undivided System Prompt part: no text in it is evidence of a block, an
 * addition, or a tool line.
 */
function analyzeForcedPrompt(
	prompt: string,
	tools: ToolSlice[],
	roster: readonly ExtensionProvenance[],
): InjectionItem[] {
	const items: InjectionItem[] = [];
	measureTools(prompt, tools, items, [], [], roster);
	items.unshift(createSystemPromptItem([{ ...PREAMBLE_BLOCK, kind: "base-prompt", text: prompt }]));
	return items;
}

/** Measure XML section bodies once, keeping arbitrary sections out of extension attribution. */
function analyzePromptSections(
	prompt: string,
	sections: readonly PromptSection[],
	options: PromptOptionsSlice,
	tools: ToolSlice[],
	additions: PromptAdditionOptions,
	changes: PromptChanges,
): InjectionItem[] {
	const items: InjectionItem[] = [];
	const parts: PromptPart[] = [];
	const blocks = findSectionToolBlocks(prompt, sections);
	const replaced = Boolean(options.customPrompt);
	const droppedIds = replaced ? BASE_PROMPT_BLOCKS
		.filter((block) => !sections.some((section) => SECTION_PARTS[section.name]?.id === block.id)
			&& !changes.deleted?.some((section) => SECTION_PARTS[section.name]?.id === block.id))
		.map((block) => block.id) : [];
	const lines = measureTools(prompt, tools, items, droppedIds, blocks, additions.sources ?? []);
	const preambleEnd = sections[0]?.start ?? prompt.length;
	appendPromptPart(parts, { ...PREAMBLE_BLOCK, change: changes.sections?.get("preamble") },
		prompt.slice(0, preambleEnd).trimEnd());
	for (const block of BASE_PROMPT_BLOCKS) {
		if (droppedIds.includes(block.id)) {
			const dropped = lines.dropped.get(block.id);
			parts.push({ ...block, kind: "base-prompt", text: dropped?.text ?? "", dropped: true,
				injectedReferences: dropped?.injectedReferences });
		}
	}
	for (const section of sections) {
		const body = prompt.slice(section.body.start + 1, section.body.end);
		const change = changes.sections?.get(section.name);
		if (measureGeneratedSection(section.name, body, options, items, change)) continue;
		parts.push({
			...measureSectionPart(prompt, section, lines.rendered,
				blocks.find((candidate) => candidate.start === section.body.start)?.moved),
			...changeField(change),
		});
	}
	for (const deleted of changes.deleted ?? []) {
		const part = deletedSectionPart(deleted);
		// A dropped part already stands for a block the request lacks
		if (!parts.some((existing) => existing.id === part.id)) parts.push(part);
	}
	// Only unwrapped gaps are additions. Sections after cwd still belong to the
	// prompt, even when an earlier handler never saw them or cwd was removed.
	const extensionAdditions = measurePromptAdditions(prompt, preambleEnd, { ...additions, excluded: sections });
	if (extensionAdditions !== undefined) {
		parts.push({ ...EXTENSION_ADDITIONS_BLOCK, kind: "prompt-addition", ...extensionAdditions });
	}
	items.unshift(createSystemPromptItem(parts));
	return items;
}

/** Measure one XML section body, annotating the extension tool lines pi rendered into it. */
function measureSectionPart(
	prompt: string,
	section: PromptSection,
	lines: readonly InjectedSpan[],
	moved: boolean | undefined,
): PromptPart {
	const block = SECTION_PARTS[section.name] ?? { id: `base-prompt:section:${section.name}`, label: section.name };
	const toolSurface = section.name === "tools" || section.name === "rules";
	// A tool surface keeps the newline before its first bullet, so that bullet's span stays inside the part
	const start = toolSurface && prompt[section.body.start] === "\n" ? section.body.start : section.body.start + 1;
	const references = lines.filter((line) => line.partId === block.id && line.start >= start
		&& line.end <= section.body.end).sort((a, b) => a.start - b.start).map((line): InjectedReference => ({
			start: line.start - start, end: line.end - start, source: line.source, tool: line.tool,
		}));
	return {
		id: block.id, label: block.label, text: prompt.slice(start, section.body.end),
		kind: section.name === "addendum" ? "append-prompt" : "base-prompt", moved,
		injectedReferences: references.length > 0 ? references : undefined,
	};
}

/**
 * Uncounted part for a section the request deleted, keeping the session text
 * without its XML wrapper for the preview.
 */
function deletedSectionPart(section: DeletedSection): PromptPart {
	const block = SECTION_PARTS[section.name] ??
		(section.name === "preamble" ? PREAMBLE_BLOCK : { id: `base-prompt:section:${section.name}`, label: section.name });
	const open = `<${section.name}>`;
	const close = `</${section.name}>`;
	const wrapped = section.text.startsWith(open) && section.text.endsWith(close);
	return {
		id: block.id,
		kind: section.name === "addendum" ? "append-prompt" : "base-prompt",
		label: block.label,
		text: wrapped ? section.text.slice(open.length, section.text.length - close.length).replace(/^\n|\n$/g, "") : section.text,
		change: "deleted",
	};
}

/** Split generated records only when present; overridden or unknown content stays visible. */
function measureGeneratedSection(
	name: string,
	body: string,
	options: PromptOptionsSlice,
	items: InjectionItem[],
	change: RequestChange | undefined,
): boolean {
	if (options.sections?.[name]) return false;
	if (name === "project_context" && body.includes("<project_instructions path=")) {
		const before = items.length;
		measureContextFiles(body, options.homeDir, items);
		if (change !== undefined && items.length > before) items[items.length - 1] = { ...items[items.length - 1], change };
		return true;
	}
	if (name === "skills" && body.includes("<available_skills>")) {
		// Read the captured records, not today's loader metadata after resume or a patch.
		const record =
			/<skill>\s*<name>(.*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>(.*?)<\/location>/g;
		const skills = [...body.matchAll(record)].map((match) => ({
			name: decodeXml(match[1]), description: decodeXml(match[2]), filePath: decodeXml(match[3]),
		}));
		if (skills.length === 0) return false;
		const children = skills.map((skill) => createItem(`skill:${skill.name}`, "skills", PI_SOURCE, skill.name,
			[skill.name, skill.description, skill.filePath].join("\n"))).sort((a, b) => b.tokens - a.tokens);
		const aggregate = createAggregateItem("skills", "skills", PI_SOURCE, `${SKILLS_LABEL} (${children.length})`, children);
		items.push(change === undefined ? aggregate : { ...aggregate, change });
		return true;
	}
	return false;
}

/** Decode the five XML entities Pi escapes when rendering skill metadata. */
function decodeXml(text: string): string {
	const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
	return text.replace(/&(amp|lt|gt|quot|apos);/g, (_match, name: string) => entities[name]);
}

/**
 * Join the unwrapped text extensions added around pi's sections into the text
 * of the Extension Additions part, which System Prompt counts. Each run is
 * annotated with the extension it was guessed to belong to, or with
 * unattributed. Undefined when there is no such text.
 */
function measurePromptAdditions(
	systemPrompt: string,
	start: number,
	options: PromptAdditionOptions,
): AnnotatedLines | undefined {
	if (systemPrompt.slice(start).trim().length === 0) return undefined;
	const additions: AnnotatedLines = { text: "", injectedReferences: [] };
	for (const run of splitPromptAdditions(systemPrompt, start, options)) {
		appendAnnotatedLine(additions, run.text, { source: run.source, tool: run.tool, attribution: run.attribution });
	}
	return additions.injectedReferences.length > 0 ? additions : undefined;
}

/** Extension lines joined into the text of one System Prompt part, each annotated with its source. */
interface AnnotatedLines {
	text: string;
	readonly injectedReferences: InjectedReference[];
}

/** Append one extension line and annotate its range with the line's source. */
function appendAnnotatedLine(
	lines: AnnotatedLines,
	text: string,
	owner: Omit<InjectedReference, keyof TextSpan>,
): void {
	lines.injectedReferences.push({ start: lines.text.length, end: lines.text.length + text.length, ...owner });
	lines.text += text;
}

/** Same chars/4 heuristic pi's estimateTokens uses for text content. */
export function textTokens(text: string): number {
	return charTokens(text.length);
}

/** Token estimate for an already known character count. */
export function charTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

/** Where extension tools' prompt lines ended up: rendered into pi's blocks, or dropped with them. */
interface ToolPromptLines {
	/** Rendered lines, annotated on the System Prompt part that counts them. */
	readonly rendered: InjectedSpan[];
	/** Extension lines a replacement suppressed, keyed by the part that would have carried them. */
	readonly dropped: Map<string, AnnotatedLines>;
}

/**
 * Measure active tool definitions and locate the prompt snippet/guideline lines
 * pi rendered for extension tools, which System Prompt counts. Built-in tools
 * collapse into one aggregate pi-native item. Lines a `--system-prompt`
 * replacement suppressed belong to the parts named by `droppedPartIds`; each
 * tool keeps those as dropped, uncounted sections. `roster` holds every
 * extension's provenance, so path extensions get distinct labels.
 */
function measureTools(
	prompt: string,
	tools: ToolSlice[],
	items: InjectionItem[],
	droppedPartIds: readonly string[],
	blocks: readonly LocatedPromptBlock[],
	roster: readonly ExtensionProvenance[],
): ToolPromptLines {
	const claimedGuidelines = new Set(piOwnedGuidelines(tools.filter((tool) => tool.change !== "deleted")));
	const rendered: InjectedSpan[] = [];
	const dropped = new Map<string, AnnotatedLines>();
	const builtinChildren: InjectionItem[] = [];
	for (const tool of tools) {
		if (tool.change === "deleted") {
			const deleted = createDeletedToolItem(tool, toolSource(tool, roster));
			if (tool.source === "builtin") builtinChildren.push(deleted);
			else items.push(deleted);
			continue;
		}
		// Built-in tools claim their bullets without annotating them, so a later
		// extension tool repeating one cannot take a line pi already renders for
		// pi itself or for a built-in tool.
		const ownedGuidelines = claimGuidelines(tool, claimedGuidelines);
		const definition = { ...createDefinitionSection(tool), ...changeField(tool.change) };
		const lines = toolPromptLines(tool, ownedGuidelines);
		const droppedLines = lines.filter((line) => droppedPartIds.includes(line.partId));
		// A tool counts only its definition; its rendered lines count in System Prompt
		const sections = [...droppedSections(droppedLines), definition];
		if (tool.source === "builtin") {
			builtinChildren.push(withChange(createToolItem(`tool:builtin:${tool.name}`, PI_SOURCE, tool.name, sections),
				tool.change));
			continue;
		}
		const owner: InjectedOwner = { source: toolSource(tool, roster), tool: tool.name };
		collectDroppedLines(dropped, droppedLines, owner);
		rendered.push(...locateRenderedLines(prompt, blocks, lines, owner));
		items.push(withChange(createToolItem(`tool:${tool.source}:${tool.name}`, owner.source, tool.name, sections),
			tool.change));
	}
	if (builtinChildren.length > 0) {
		builtinChildren.sort((a, b) => b.tokens - a.tokens);
		// The count names the tools the request declared, not the deleted ones listed with them
		const declared = builtinChildren.filter((child) => child.change !== "deleted").length;
		const label = `${BUILT_IN_TOOLS_LABEL} (${declared})`;
		items.push(createAggregateItem("tool:builtin", "tool", PI_SOURCE, label, builtinChildren));
	}
	return { rendered, dropped };
}

/**
 * A tool the request deleted: its session definition only, for the preview, at
 * 0 tokens. Its prompt lines stay with whatever text still holds them.
 */
function createDeletedToolItem(tool: ToolSlice, source: InjectionSource): InjectionItem {
	const id = tool.source === "builtin" ? `tool:builtin:${tool.name}` : `tool:${tool.source}:${tool.name}`;
	const definition: SectionDraft = { ...createDefinitionSection(tool), change: "deleted" };
	return { ...createToolItem(id, source, tool.name, [definition]), change: "deleted" };
}

/**
 * Owner of a tool: pi for a built-in, `unattributed` for an unregistered
 * tool, otherwise its extension labelled against the roster.
 */
function toolSource(tool: ToolSlice, roster: readonly ExtensionProvenance[]): InjectionSource {
	if (tool.source === "builtin") return PI_SOURCE;
	if (tool.source === UNREGISTERED_TOOL_SOURCE) return AGGREGATE_SOURCE;
	return extensionSource({ source: tool.source, path: tool.sourcePath }, roster);
}

/** The item with a request-only change, or unchanged when there is none. */
function withChange(item: InjectionItem, change: RequestChange | undefined): InjectionItem {
	return change === undefined ? item : { ...item, change };
}

/** `{ change }` when there is one, so unchanged parts carry no extra key. */
function changeField(change: RequestChange | undefined): { readonly change?: RequestChange } {
	return change === undefined ? {} : { change };
}

/** One prompt line pi renders for a tool, and the System Prompt part it renders it into. */
interface ToolPromptLine {
	readonly partId: string;
	/** Section name the line belongs to, shared by the part and the owning tool. */
	readonly label: string;
	/** Line exactly as pi renders it, including its leading line break. */
	readonly text: string;
}

/** Prompt lines pi renders for one tool: its snippet bullet, then the guidelines it owns. */
function toolPromptLines(tool: ToolSlice, ownedGuidelines: string[]): ToolPromptLine[] {
	const lines: ToolPromptLine[] = [];
	if (tool.snippet !== undefined) {
		lines.push({
			partId: AVAILABLE_TOOLS_BLOCK.id,
			label: AVAILABLE_TOOLS_LABEL,
			text: `\n- ${tool.name}: ${tool.snippet}`,
		});
	}
	for (const guideline of ownedGuidelines) {
		lines.push({ partId: GUIDELINES_BLOCK.id, label: GUIDELINES_LABEL, text: `\n- ${guideline}` });
	}
	return lines;
}

/**
 * Group one tool's dropped lines into a preview-only section per part, so its
 * preview shows what the replacement gave up without claiming tokens pi never
 * sent.
 */
function droppedSections(lines: readonly ToolPromptLine[]): SectionDraft[] {
	const sections: SectionDraft[] = [];
	for (const line of lines) {
		const last = sections.length - 1;
		const current = sections[last];
		if (current !== undefined && current.label === line.label) {
			sections[last] = { ...current, text: current.text + line.text };
			continue;
		}
		sections.push({ label: line.label, text: line.text, dropped: true });
	}
	return sections;
}

/**
 * Add one extension tool's dropped lines, annotated, to the uncounted text of
 * the parts pi would have rendered them into.
 */
function collectDroppedLines(
	dropped: Map<string, AnnotatedLines>,
	lines: readonly ToolPromptLine[],
	owner: InjectedOwner,
): void {
	for (const line of lines) {
		let part = dropped.get(line.partId);
		if (part === undefined) {
			part = { text: "", injectedReferences: [] };
			dropped.set(line.partId, part);
		}
		appendAnnotatedLine(part, line.text, owner);
	}
}

/** One labeled part of a tool item's text, before it receives its token share. */
interface SectionDraft {
	readonly label: string;
	readonly text: string;
	/** True for text a `--system-prompt` replacement dropped: shown for reference, never counted. */
	readonly dropped?: boolean;
	/** True for a block an extension moved out of the region pi rendered it into. */
	readonly moved?: boolean;
	/** Request-only change; a deleted section is shown for reference, never counted. */
	readonly change?: RequestChange;
	/** Serialized JSON inside `text`; marked here rather than detected in the preview. */
	readonly jsonSpan?: JsonSpan;
	/** Extension lines inside `text`, annotated with their source in previews. */
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

/** The extension tool that produced a prompt line. */
interface InjectedOwner {
	readonly source: InjectionSource;
	/** Tool of `source` that produced the line, rendered as a label qualifier. */
	readonly tool?: string;
}

/** Prompt location, owner, and System Prompt part of a rendered extension tool line. */
interface InjectedSpan extends Span, InjectedOwner {
	readonly partId: string;
}

/**
 * Locate one extension tool's lines in the bullet regions of the blocks pi
 * renders them into. A line pi did not render there gets no annotation.
 */
function locateRenderedLines(
	prompt: string,
	blocks: readonly LocatedPromptBlock[],
	lines: readonly ToolPromptLine[],
	owner: InjectedOwner,
): InjectedSpan[] {
	return lines.flatMap((line) => {
		const span = findBlockLine(prompt, blocks.find((block) => block.id === line.partId)?.bullets, line.text);
		return span === undefined ? [] : [{ ...span, ...owner, partId: line.partId }];
	});
}

/** Find one complete prompt bullet inside its block, never a prefix of another bullet. */
function findBlockLine(prompt: string, block: Span | undefined, line: string): Span | undefined {
	if (block === undefined) return undefined;
	let start = prompt.indexOf(line, block.start);
	while (start !== -1 && start + line.length <= block.end) {
		const end = start + line.length;
		if (end === block.end || prompt[end] === "\n") return { start, end };
		start = prompt.indexOf(line, end);
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
 * Expose each context file recorded in pi's project-context section body as a
 * child of one Instruction Files aggregate, without counting the XML transport
 * scaffolding. Paths come from the captured records, not today's loader.
 */
function measureContextFiles(body: string, homeDir: string | undefined, items: InjectionItem[]): void {
	const children: InjectionItem[] = [];
	for (const match of body.matchAll(/<project_instructions path="([^"]+)">/g)) {
		const filePath = match[1];
		const content = findContextFileContent(body, filePath);
		if (content === undefined) continue;
		children.push(createItem(
			`context-file:${filePath}`,
			"context-file",
			PI_SOURCE,
			abbreviateHome(filePath, homeDir),
			content,
		));
	}
	children.sort((a, b) => b.tokens - a.tokens);
	if (children.length === 0) return;

	const label = `${INSTRUCTION_FILES_LABEL} (${children.length})`;
	items.push(createAggregateItem("context-files", "context-file", PI_SOURCE, label, children));
}

/** One labeled part of the System Prompt item, before it receives its token share. */
interface PromptPart {
	readonly id: string;
	readonly kind: InjectionKind;
	readonly label: string;
	readonly text: string;
	/**
	 * True for a block a `--system-prompt` replacement dropped: no pi text, no
	 * tokens. Its text holds only the extension lines pi would have rendered.
	 */
	readonly dropped?: boolean;
	/** True for a block an extension moved out of the region pi rendered it into. */
	readonly moved?: boolean;
	/** Request-only change; a deleted part keeps its session text but no tokens. */
	readonly change?: RequestChange;
	/** Extension lines inside `text`, annotated with their source in previews. */
	readonly injectedReferences?: readonly InjectedReference[];
}

/** Record one pi-authored part, skipping a block pi rendered no text into. */
function appendPromptPart(
	parts: PromptPart[],
	block: Pick<PromptPart, "id" | "label" | "moved" | "change">,
	text: string,
): void {
	if (text.length === 0 && block.change === undefined) return;
	parts.push({ id: block.id, kind: "base-prompt", label: block.label, text, moved: block.moved,
		...changeField(block.change) });
}

/**
 * Build the System Prompt item from its labeled parts. Parts concatenate back to
 * the item text and take cumulative shares of its estimate, so children break the
 * item down without adding tokens. A prompt with one part stays undivided.
 */
function createSystemPromptItem(parts: readonly PromptPart[]): InjectionItem {
	const text = countedText(parts);
	const item = createItem(SYSTEM_PROMPT_ITEM_ID, "base-prompt", PI_SOURCE, SYSTEM_PROMPT_LABEL, text);
	if (parts.length === 0) return item;
	if (parts.length === 1 && parts[0].id === PREAMBLE_BLOCK.id && parts[0].change !== "deleted") {
		return withChange(item, parts[0].change);
	}
	const sections = allocateSectionTokens(parts.map((part) => ({
		label: part.label,
		text: part.text,
		dropped: part.dropped,
		moved: part.moved,
		...changeField(part.change),
		injectedReferences: part.injectedReferences,
	})));
	return {
		...item,
		sections,
		children: parts.map((part, index) => ({
			...createItem(part.id, part.kind, PI_SOURCE, part.label, part.text),
			chars: isUncounted(part) ? 0 : part.text.length,
			tokens: sections[index]?.tokens ?? 0,
			dropped: part.dropped,
			moved: part.moved,
			...changeField(part.change),
			injectedReferences: part.injectedReferences,
		})),
	};
}

/** Build an InjectionItem with derived char/token sizes. */
function createItem(
	id: string,
	kind: InjectionKind,
	source: InjectionSource,
	label: string,
	text: string,
): InjectionItem {
	return {
		id,
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
	const text = countedText(sections);
	return { ...createItem(id, "tool", source, label, text), sections: allocateSectionTokens(sections) };
}

/** Text an item actually sends: everything but dropped and deleted parts. */
function countedText(parts: readonly UncountablePart[]): string {
	return parts.filter((part) => !isUncounted(part)).map((part) => part.text).join("");
}

/** A part that may carry text the request never sent. */
interface UncountablePart {
	readonly text: string;
	readonly dropped?: boolean;
	readonly change?: RequestChange;
}

/** Whether a part's text is shown for reference only: a replacement dropped it, or the request deleted it. */
function isUncounted(part: UncountablePart): boolean {
	return part.dropped === true || part.change === "deleted";
}

/**
 * Give each section its share of the item estimate. Shares are cumulative
 * differences rather than independently rounded counts, so they always sum to
 * the item total. A dropped or deleted section reads 0 tokens and leaves the
 * shares of the sections pi did send unchanged.
 */
function allocateSectionTokens(sections: SectionDraft[]): InjectionSection[] {
	let chars = 0;
	let allocated = 0;
	return sections.map((section) => {
		if (isUncounted(section)) return { ...section, tokens: 0 };
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
	const text = child.change === "deleted" ? child.sections?.[0]?.text ?? child.text : child.text;
	return {
		label: child.label,
		text: `${separator}${text}`,
		tokens: child.tokens,
		...changeField(child.change),
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

/** Replace a leading home-directory prefix with `~` for compact path labels. */
function abbreviateHome(path: string, homeDir: string | undefined): string {
	if (homeDir === undefined || homeDir.length === 0) return path;
	if (path === homeDir) return "~";
	if (path.startsWith(`${homeDir}/`)) return `~${path.slice(homeDir.length)}`;
	return path;
}

/** Half-open [start, end) character range within the base prompt. */
interface Span {
	start: number;
	end: number;
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

/** Locate a complete delimited transport wrapper. */
function findDelimitedSpan(text: string, open: string, close: string): Span | undefined {
	const start = text.indexOf(open);
	if (start === -1) return undefined;
	const closeStart = text.indexOf(close, start + open.length);
	return closeStart === -1 ? undefined : { start, end: closeStart + close.length };
}
