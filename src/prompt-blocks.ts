/** Locate pi's XML prompt sections without assuming extensions preserve their order. */
import type { TextSpan } from "./model.ts";

/** Block pi renders one bullet per visible tool into, in its `tools` section. */
export const AVAILABLE_TOOLS_BLOCK = { id: "base-prompt:available-tools", label: "Available Tools" };
/** Block pi renders tool guideline bullets into, in its `rules` section. */
export const GUIDELINES_BLOCK = { id: "base-prompt:guidelines", label: "Guidelines" };
/** Block pi renders its own documentation into, in its `docs` section. */
export const DOCUMENTATION_BLOCK = { id: "base-prompt:documentation", label: "Documentation" };

/** Pi's normal emission order, also the blocks a custom prompt replaces. */
export const BASE_PROMPT_BLOCKS = [AVAILABLE_TOOLS_BLOCK, GUIDELINES_BLOCK, DOCUMENTATION_BLOCK];

/** One complete top-level XML section, with transport framing separated from its body. */
export interface PromptSection extends TextSpan {
	readonly name: string;
	/** Includes the newline before the body, but not the newline before the closing tag. */
	readonly body: TextSpan;
}

/**
 * Locate pi's sections in rendered order. Skip whole sections and fenced examples
 * so tags in instruction files, skills, addenda, and custom sections are not blocks.
 */
export function findPromptSections(prompt: string): PromptSection[] {
	const sections: PromptSection[] = [];
	let fence: string | undefined;
	const pattern = /^<([a-z][a-z0-9_-]*)>\n|^ {0,3}(`{3,}|~{3,})([^\n]*)/gm;
	for (let match = pattern.exec(prompt); match !== null; match = pattern.exec(prompt)) {
		const marker = match[2];
		if (marker !== undefined) {
			if (fence === undefined) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length && match[3].trim() === "") fence = undefined;
			continue;
		}
		if (fence !== undefined) continue;
		const name = match[1];
		const closing = `\n</${name}>`;
		const end = prompt.indexOf(closing, pattern.lastIndex);
		if (end === -1) continue;
		const after = end + closing.length;
		if (after < prompt.length && prompt[after] !== "\n") continue;
		sections.push({ name, start: match.index, end: after, body: { start: pattern.lastIndex - 1, end } });
		pattern.lastIndex = after;
	}
	return sections;
}

/** Locate native XML tool surfaces with bounded, consecutive bullet regions and positional markers. */
export function findSectionToolBlocks(prompt: string, sections: readonly PromptSection[]): LocatedPromptBlock[] {
	const order = ["tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"];
	return sections.flatMap((section): LocatedPromptBlock[] => {
		if (section.name !== "tools" && section.name !== "rules") return [];
		const block = section.name === "tools" ? AVAILABLE_TOOLS_BLOCK : GUIDELINES_BLOCK;
		const moved = sections.some((other) => other.start < section.start &&
			order.indexOf(other.name) > order.indexOf(section.name));
		const bullets = findBulletSpan(prompt, section.body.start);
		return [{ ...block, ...section.body, bullets, moved: moved || undefined }];
	});
}

/** One native tool-surface section body and its bullet region, in original prompt coordinates. */
export interface LocatedPromptBlock extends TextSpan {
	readonly id: string;
	readonly label: string;
	/** Exact bullet region, including the newline before the first bullet. */
	readonly bullets?: TextSpan;
	/** Position differs from pi's normal block order; no claim about which handler moved it. */
	readonly moved?: boolean;
}

/** Consecutive complete bullet lines; stop before any unrelated prose. */
function findBulletSpan(prompt: string, start: number): TextSpan | undefined {
	let end = start;
	while (prompt.startsWith("\n- ", end)) {
		const newline = prompt.indexOf("\n", end + 1);
		end = newline === -1 ? prompt.length : newline;
	}
	return end === start ? undefined : { start, end };
}
