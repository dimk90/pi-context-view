import assert from "node:assert/strict";
import { test } from "node:test";

import { findPromptBlocks } from "../src/prompt-blocks.ts";

const TOOLS = [{ name: "read", snippet: "Read files", guidelines: ["Use read"] }];
const TOOL_BLOCK = "\nAvailable tools:\n- read: Read files";
const GUIDELINES = "\nGuidelines:\n- Use read\n- Be concise in your responses";
const DOCUMENTATION = "\nPi documentation:\n- Manual";
const FOOTER = "\nCurrent working directory: /fixture";

/** Locate sections against the real footer start, including when blocks precede all other text. */
function locate(prompt: string) {
	return findPromptBlocks(prompt, prompt.indexOf(FOOTER), TOOLS, []);
}

test("prompt blocks follow their actual order before or after the footer", () => {
	for (const prompt of [
		`Preamble${DOCUMENTATION}${TOOL_BLOCK}${GUIDELINES}${FOOTER}`,
		`Preamble${DOCUMENTATION}${FOOTER}${TOOL_BLOCK}\n\nOther addition.${GUIDELINES}`,
	]) {
		const blocks = locate(prompt);
		assert.deepEqual(blocks.map((block) => block.label), ["Documentation", "Available Tools", "Guidelines"]);
		assert.deepEqual(blocks.filter((block) => block.moved).map((block) => block.label), ["Available Tools", "Guidelines"]);
		const tools = blocks.find((block) => block.label === "Available Tools");
		assert.ok(tools);
		assert.equal(prompt.slice(tools.start, tools.end), TOOL_BLOCK);
	}
	const swapped = locate(`Preamble${GUIDELINES}${TOOL_BLOCK}${DOCUMENTATION}${FOOTER}`);
	assert.deepEqual(swapped.map((block) => block.label), ["Guidelines", "Available Tools", "Documentation"]);
	assert.equal(swapped.find((block) => block.label === "Available Tools")?.moved, true);
});

test("recovery needs contiguous complete bullets, not headers, prose, or prefix matches", () => {
	for (const invalid of [
		"\nAvailable tools:\nSome example.\n- read: Read files",
		"\nAvailable tools:\n- read: Read files remotely",
		"\nAvailable tools:\n- unknown: Other tool",
		"\nInline Available tools:\n- read: Read files",
		"\nGuidelines:\n- Use read for remote tasks",
		"\nGuidelines:\n- Unrelated instruction",
	]) {
		const prompt = `Preamble${DOCUMENTATION}${FOOTER}${invalid}`;
		assert.deepEqual(locate(prompt).map((block) => block.label), ["Documentation"]);
	}
});

test("invalid earlier headers and fenced examples cannot hide a later real block", () => {
	const prompt = `Preamble${DOCUMENTATION}${FOOTER}\n\n\`\`\`text${TOOL_BLOCK}\n\`\`\`\n` +
		`\nAvailable tools:\n- read: Read files remotely\n${TOOL_BLOCK}`;
	const block = locate(prompt).find((entry) => entry.label === "Available Tools");
	assert.equal(block?.start, prompt.lastIndexOf(TOOL_BLOCK));
});

test("pre-footer copies win; ambiguous post-footer duplicates remain additions", () => {
	const prompt = `Preamble${TOOL_BLOCK}${GUIDELINES}${DOCUMENTATION}${FOOTER}\n${TOOL_BLOCK}\n${GUIDELINES}`;
	assert.ok(locate(prompt).every((block) => block.moved !== true));
	const duplicated = `Preamble${DOCUMENTATION}${FOOTER}\n${TOOL_BLOCK}\n${TOOL_BLOCK}`;
	assert.deepEqual(locate(duplicated).map((block) => block.label), ["Documentation"]);
});

test("known separately counted regions do not suppress recovery", () => {
	const prompt = `Preamble${DOCUMENTATION}\nINSTRUCTIONS\n\`\`\`text${TOOL_BLOCK}${FOOTER}\n${TOOL_BLOCK}`;
	const baseEnd = prompt.indexOf(FOOTER);
	const blocks = findPromptBlocks(prompt, baseEnd, TOOLS, [{ start: prompt.indexOf("INSTRUCTIONS"), end: baseEnd }]);
	assert.equal(blocks.find((block) => block.label === "Available Tools")?.start, prompt.lastIndexOf(TOOL_BLOCK));
});

test("line-zero headers, Guidelines-only recovery, and pi's optional filler are recognized", () => {
	const prompt = `${TOOL_BLOCK.slice(1)}${GUIDELINES}${DOCUMENTATION}${FOOTER}`;
	assert.equal(locate(prompt)[0]?.start, 0);
	assert.equal(locate(prompt)[0]?.moved, undefined);
	const guidelinesOnly = `Preamble${DOCUMENTATION}${FOOTER}\nGuidelines:\n- Be concise in your responses`;
	assert.equal(findPromptBlocks(guidelinesOnly, guidelinesOnly.indexOf(FOOTER), [], [])[1]?.moved, true);
	const filler = "\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.";
	const relocated = `Preamble${DOCUMENTATION}${FOOTER}${TOOL_BLOCK}${filler}\n\nOther text.`;
	const block = locate(relocated)[1];
	assert.ok(block);
	assert.equal(relocated.slice(block.start, block.end), TOOL_BLOCK + filler);
});
