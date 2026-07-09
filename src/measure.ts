/**
 * Pure measurement logic: split a captured system prompt into components and
 * estimate token sizes. No pi API access — unit-testable.
 *
 * Splitting relies on structural markers that pi's buildSystemPrompt() emits
 * deterministically (verified against pi 0.80.3 dist/core/system-prompt.js):
 *
 * - context files:  <project_instructions path="...">...</project_instructions>
 * - skills block:   "The following skills provide..." ... </available_skills>
 * - base prompt always ends with "Current date: ...\nCurrent working directory: ..."
 *   → anything after that line was appended by extensions via before_agent_start.
 */

/** One measured context injection. */
export interface MeasuredComponent {
	/** Human-readable source, e.g. `pi: base system prompt`, `extension msg: plan-mode`. */
	label: string;
	group: "pi" | "extensions";
	chars: number;
	tokens: number;
	/** Raw injected text (for future detail views). */
	text: string;
}

/** Minimal slice of BuildSystemPromptOptions that measurement needs. */
export interface PromptOptionsSlice {
	cwd: string;
	appendSystemPrompt?: string;
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: Array<{ name: string }>;
}

/**
 * Split the captured system prompt into measured components:
 * pi base prompt, --append-system-prompt, each context file, skills block,
 * and the aggregate appended by extensions.
 */
export function analyzeSystemPrompt(systemPrompt: string, options: PromptOptionsSlice): MeasuredComponent[] {
	const components: MeasuredComponent[] = [];
	const carvedSpans: Span[] = [];

	const baseEnd = findBasePromptEnd(systemPrompt, options.cwd);
	const base = baseEnd === -1 ? systemPrompt : systemPrompt.slice(0, baseEnd);

	for (const file of options.contextFiles ?? []) {
		const span = findContextFileSpan(base, file.path);
		if (span === undefined) continue;
		components.push(component(`pi: context file ${file.path}`, "pi", base.slice(span.start, span.end)));
		carvedSpans.push(span);
	}

	if ((options.skills?.length ?? 0) > 0) {
		const span = findSkillsSpan(base);
		if (span !== undefined) {
			components.push(component(`pi: skills (${options.skills?.length})`, "pi", base.slice(span.start, span.end)));
			carvedSpans.push(span);
		}
	}

	const append = options.appendSystemPrompt;
	if (append !== undefined && append.length > 0) {
		const start = base.indexOf(append);
		if (start !== -1) {
			components.push(component("pi: --append-system-prompt", "pi", append));
			carvedSpans.push({ start, end: start + append.length });
		}
	}

	// Base prompt = base minus all carved spans.
	carvedSpans.sort((a, b) => a.start - b.start);
	let remainder = "";
	let cursor = 0;
	for (const span of carvedSpans) {
		remainder += base.slice(cursor, span.start);
		cursor = Math.max(cursor, span.end);
	}
	remainder += base.slice(cursor);
	components.unshift(component("pi: base system prompt", "pi", remainder));

	if (baseEnd !== -1 && baseEnd < systemPrompt.length) {
		const added = systemPrompt.slice(baseEnd);
		if (added.trim().length > 0) {
			components.push(component("extensions: system prompt additions (aggregate)", "extensions", added));
		}
	}

	return components;
}

/**
 * Locate the end of pi's base system prompt: the exact two-line
 * "Current date/Current working directory" suffix buildSystemPrompt emits last.
 * Returns the index just past that line, or -1 when not found.
 */
export function findBasePromptEnd(systemPrompt: string, cwd: string): number {
	const now = new Date();
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const promptCwd = cwd.replace(/\\/g, "/");
	// First occurrence: a context file or extension text duplicating the exact
	// marker (with today's date and this cwd) is far less likely than an
	// extension appending arbitrary text after it.
	const marker = `\nCurrent date: ${date}\nCurrent working directory: ${promptCwd}`;
	const index = systemPrompt.indexOf(marker);
	return index === -1 ? -1 : index + marker.length;
}

/** Same chars/4 heuristic pi's estimateTokens uses for text content. */
export function textTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function component(label: string, group: "pi" | "extensions", text: string): MeasuredComponent {
	return { label, group, chars: text.length, tokens: textTokens(text), text };
}

interface Span {
	start: number;
	end: number;
}

/** Find `<project_instructions path="...">...</project_instructions>` for one file. */
function findContextFileSpan(systemPrompt: string, filePath: string): Span | undefined {
	const open = `<project_instructions path="${filePath}">`;
	const close = "</project_instructions>";
	const start = systemPrompt.indexOf(open);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(close, start);
	if (end === -1) return undefined;
	return { start, end: end + close.length };
}

/** Find the skills section (intro sentence through `</available_skills>`). */
function findSkillsSpan(systemPrompt: string): Span | undefined {
	const open = "The following skills provide specialized instructions";
	const close = "</available_skills>";
	const start = systemPrompt.indexOf(open);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(close, start);
	if (end === -1) return undefined;
	return { start, end: end + close.length };
}
