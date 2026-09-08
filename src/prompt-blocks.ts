/** Locate pi's semantic prompt blocks without assuming extensions preserve their order. */
import type { TextSpan } from "./model.ts";

/** Block pi renders one bullet per visible tool into. */
export const AVAILABLE_TOOLS_BLOCK = {
	id: "base-prompt:available-tools", label: "Available Tools", header: "\nAvailable tools:\n",
};
/** Block pi renders tool guideline bullets into. */
export const GUIDELINES_BLOCK = {
	id: "base-prompt:guidelines", label: "Guidelines", header: "\nGuidelines:\n",
};
/** Block pi renders its own documentation into. */
const DOCUMENTATION_BLOCK = {
	id: "base-prompt:documentation", label: "Documentation", header: "\nPi documentation",
};

/** Pi's normal emission order, also the blocks a custom prompt replaces. */
export const BASE_PROMPT_BLOCKS = [AVAILABLE_TOOLS_BLOCK, GUIDELINES_BLOCK, DOCUMENTATION_BLOCK];

const UNIVERSAL_GUIDELINES = ["Be concise in your responses", "Show file paths clearly when working with files"];
const CUSTOM_TOOLS_FILLER =
	"In addition to the tools above, you may have access to other custom tools depending on the project.";

/** Active-tool evidence used to distinguish relocated blocks from unrelated appended prose. */
export interface PromptBlockTool {
	readonly name: string;
	readonly snippet?: string;
	readonly guidelines: readonly string[];
}

/** One selected header and its bounded content, in original prompt coordinates. */
export interface LocatedPromptBlock extends TextSpan {
	readonly id: string;
	readonly label: string;
	/** Exact bullet region, including the newline before the first bullet. */
	readonly bullets?: TextSpan;
	/** Position differs from pi's normal block order; no claim about which handler moved it. */
	readonly moved?: boolean;
}

/**
 * Select one occurrence per block, preferring the pre-footer occurrence. Blocks
 * outside pi's normal pre-documentation region need contiguous bullets and an
 * exact active-tool snippet or known guideline match. Instructions, skills,
 * appended prompts, and fenced examples are never evidence of relocation.
 */
export function findPromptBlocks(
	prompt: string,
	baseEnd: number,
	tools: readonly PromptBlockTool[],
	ignored: readonly TextSpan[],
): LocatedPromptBlock[] {
	const excluded = [...ignored, ...findFencedSpans(prompt, ignored)];
	const documentationStart = headerStarts(prompt, DOCUMENTATION_BLOCK.header, excluded)
		.find((start) => start < baseEnd);
	const nativeEnd = documentationStart ?? baseEnd;
	const found: LocatedPromptBlock[] = [];
	for (const block of [AVAILABLE_TOOLS_BLOCK, GUIDELINES_BLOCK]) {
		const candidates = headerStarts(prompt, block.header, excluded).flatMap((start) => {
			const headerEnd = start + block.header.length - (start === 0 && prompt[0] !== "\n" ? 1 : 0);
			const bullets = findBulletSpan(prompt, headerEnd - 1);
			const native = start < nativeEnd;
			if (!native && (bullets === undefined || !hasKnownBullet(prompt, bullets, block.id, tools))) return [];
			const end = bullets?.end ?? headerEnd;
			return [{ ...block, start, end: includeFiller(prompt, end, block.id), bullets }];
		});
		const beforeFooter = candidates.find((candidate) => candidate.start < baseEnd);
		// Several post-footer copies are ambiguous; leave them as additions rather than guessing.
		const chosen = beforeFooter ?? (candidates.length === 1 ? candidates[0] : undefined);
		if (chosen !== undefined) found.push(chosen);
	}
	if (documentationStart !== undefined) {
		found.push({ ...DOCUMENTATION_BLOCK, start: documentationStart, end: baseEnd });
	}
	return found.map((block) => ({
		...block,
		moved: block.id !== DOCUMENTATION_BLOCK.id && (
			block.start >= baseEnd || found.some((other) =>
				BASE_PROMPT_BLOCKS.findIndex((entry) => entry.id === other.id) >
					BASE_PROMPT_BLOCKS.findIndex((entry) => entry.id === block.id) && other.start < block.start
			)
		) ? true : undefined,
	})).sort((a, b) => a.start - b.start);
}

/** Line-start header matches outside separately attributed content and fenced examples. */
function headerStarts(prompt: string, header: string, excluded: readonly TextSpan[]): number[] {
	const needle = header.slice(1);
	const starts: number[] = [];
	let position = prompt.indexOf(needle);
	while (position !== -1) {
		if ((position === 0 || prompt[position - 1] === "\n") &&
			!excluded.some((span) => position >= span.start && position < span.end)) {
			starts.push(Math.max(0, position - 1));
		}
		position = prompt.indexOf(needle, position + needle.length);
	}
	return starts;
}

/** Consecutive complete bullet lines; stop before any unrelated prose or following header. */
function findBulletSpan(prompt: string, start: number): TextSpan | undefined {
	let end = start;
	while (prompt.startsWith("\n- ", end)) {
		const newline = prompt.indexOf("\n", end + 1);
		end = newline === -1 ? prompt.length : newline;
	}
	return end === start ? undefined : { start, end };
}

/** Complete line equality, not prefix matching: a longer bullet is not evidence of pi's text. */
function hasKnownBullet(
	prompt: string,
	span: TextSpan,
	blockId: string,
	tools: readonly PromptBlockTool[],
): boolean {
	const lines = new Set(prompt.slice(span.start + 1, span.end).split("\n"));
	const known = blockId === AVAILABLE_TOOLS_BLOCK.id
		? tools.filter((tool) => tool.snippet).map((tool) => `${tool.name}: ${tool.snippet}`)
		: [...UNIVERSAL_GUIDELINES, ...tools.flatMap((tool) => tool.guidelines)].map((line) => line.trim());
	return known.some((line) => line.length > 0 && lines.has(`- ${line}`));
}

/** Pi's optional filler belongs to the tool list, never to an unrelated addition following it. */
function includeFiller(prompt: string, end: number, blockId: string): number {
	if (blockId !== AVAILABLE_TOOLS_BLOCK.id) return end;
	const match = prompt.slice(end).match(/^\n(?:[\t ]*\n)+/);
	if (match === null) return end;
	const start = end + match[0].length;
	const fillerEnd = start + CUSTOM_TOOLS_FILLER.length;
	return prompt.startsWith(CUSTOM_TOOLS_FILLER, start) &&
		(fillerEnd === prompt.length || prompt[fillerEnd] === "\n") ? fillerEnd : end;
}

/** Fence-delimited examples are quoted content, even when they repeat real tool snippets. */
function findFencedSpans(prompt: string, ignored: readonly TextSpan[]): TextSpan[] {
	const spans: TextSpan[] = [];
	let open: { start: number; marker: string } | undefined;
	for (const line of prompt.matchAll(/^ {0,3}(`{3,}|~{3,})([^\n]*)/gm)) {
		if (ignored.some((span) => line.index >= span.start && line.index < span.end)) continue;
		const marker = line[1] ?? "";
		if (open === undefined) open = { start: line.index, marker };
		else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && line[2]?.trim() === "") {
			spans.push({ start: open.start, end: line.index + line[0].length });
			open = undefined;
		}
	}
	if (open !== undefined) spans.push({ start: open.start, end: prompt.length });
	return spans;
}
