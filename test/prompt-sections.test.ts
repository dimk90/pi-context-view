import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { analyzeSystemPrompt, type ToolSlice } from "../src/measure.ts";
import type { InjectionItem } from "../src/model.ts";
import { findPromptSections } from "../src/prompt-blocks.ts";

const CWD = "/fixture";
const TOOL: ToolSlice = {
	name: "search", description: "Search", parametersJson: "{}", snippet: "Search the web",
	guidelines: ["Cite sources"], source: "npm:web",
};

/** The System Prompt part holding the unwrapped text extensions added around pi's sections. */
function additionsPart(items: readonly InjectionItem[]): InjectionItem | undefined {
	return items[0]?.children?.find((part) => part.kind === "prompt-addition");
}

test("XML sections after cwd remain named System Prompt parts, not guessed extension additions", () => {
	const sections = { review: "Read npm:web guidance.", constraints: "Keep it small." };
	const prompt = buildSystemPrompt({ cwd: CWD, sections });
	// Even a later handler's sections, missing from our prepared options, are recognized.
	for (const options of [{}, { sections }]) {
		const items = analyzeSystemPrompt(prompt, options, [], { sources: [{ source: "npm:web", path: "/web.ts" }] });
		assert.equal(additionsPart(items), undefined);
		const base = items[0];
		assert.deepEqual(base.children?.slice(-2).map((part) => [part.label, part.text]), Object.entries(sections));
		assert.equal(base.sections?.reduce((sum, part) => sum + part.tokens, 0), base.tokens);
		assert.equal(base.sections?.map((part) => part.text).join(""), base.text);
	}
});

test("custom overrides of every generated section retain their actual text", () => {
	const sections = {
		tools: "Tools are unavailable.", rules: "Follow the review checklist.", docs: "Read the project manual.",
		addendum: "Changed addendum", project_context: "Replaced instructions", skills: "Replaced skills", cwd: "/remote",
	};
	const prompt = buildSystemPrompt({ cwd: CWD, appendSystemPrompt: "OLD ADDENDUM", sections });
	const items = analyzeSystemPrompt(prompt, { sections }, [TOOL]);
	const parts = items[0].children ?? [];
	for (const text of Object.values(sections)) assert.ok(parts.some((part) => part.text.trim() === text));
	assert.doesNotMatch(items[0].text, /OLD ADDENDUM|<\/?(?:tools|rules|skills|cwd)>/);
	assert.equal(additionsPart(items), undefined);
	assert.deepEqual(items.find((item) => item.kind === "tool")?.sections?.map((part) => part.label), ["Definition"]);
});

test("a custom prefix can restore selected native XML sections without marking them dropped", () => {
	const sections = { tools: "- search: Search the web", docs: "Restored docs" };
	const prompt = buildSystemPrompt({ cwd: CWD, customPrompt: "Custom prefix", sections });
	const items = analyzeSystemPrompt(prompt, { customPrompt: "Custom prefix", sections }, [TOOL]);
	assert.deepEqual(items[0].children?.filter((part) => part.dropped).map((part) => part.label), ["Rules"]);
	const tool = items.find((item) => item.kind === "tool");
	// Only the dropped guideline stays on the tool; the restored snippet counts in System Prompt.
	assert.deepEqual(tool?.sections?.map((part) => [part.label, part.dropped, part.tokens > 0]),
		[["Rules", true, false], ["Definition", undefined, true]]);
	assert.equal(items[0].sections?.find((part) => part.label === "Tools")?.injectedReferences?.length, 1);
});

test("section discovery ignores nested and fenced examples, including unclosed fences inside sections", () => {
	const prompt = "Preamble\n\n```xml\n<rules>\nExample\n</rules>\n```\n\n" +
		"<addendum>\n<rules>\nNested example\n</rules>\n```\nUnclosed inner fence\n</addendum>\n\n" +
		"<cwd>\n/fixture\n</cwd>\n\n<review>\nReal section\n</review>";
	assert.deepEqual(findPromptSections(prompt).map((section) => section.name), ["addendum", "cwd", "review"]);
	const parts = analyzeSystemPrompt(prompt, {})[0].children ?? [];
	assert.equal(parts.find((part) => part.label === "Addendum")?.text,
		"<rules>\nNested example\n</rules>\n```\nUnclosed inner fence");
	assert.equal(parts.find((part) => part.label === "review")?.text, "Real section");
});

test("unwrapped gaps around custom sections remain additions without absorbing section text", () => {
	const prompt = buildSystemPrompt({ cwd: CWD, sections: { review: "Structured rule" } })
		.replace("<review>", "First addition\n\n<review>") + "\n\nLast addition";
	const items = analyzeSystemPrompt(prompt, {});
	const addition = additionsPart(items);
	assert.ok(addition?.text.includes("First addition"));
	assert.ok(addition?.text.includes("Last addition"));
	assert.doesNotMatch(addition?.text ?? "", /Structured rule|<review>/);
});

test("section-only state without cwd retains tag labels and trailing unwrapped text", () => {
	const items = analyzeSystemPrompt("<review>\nOnly rule\n</review>\n\nExtra instruction", {});
	assert.equal(items[0].children?.find((part) => part.label === "review")?.text, "Only rule");
	assert.equal(additionsPart(items)?.text, "\n\nExtra instruction");
});

test("a single custom section keeps its label and repeated tags remain additions", () => {
	const prompt = "<review>\nFirst rule\n</review>";
	const only = analyzeSystemPrompt(prompt, {});
	assert.equal(only[0].sections?.[0]?.label, "review");
	const repeated = analyzeSystemPrompt(`${prompt}\n\n<review>\nSecond rule\n</review>`, {});
	assert.equal(repeated[0].children?.filter((part) => part.label === "review").length, 1);
	assert.match(additionsPart(repeated)?.text ?? "", /Second rule/);
});

test("custom tool-surface prose and fenced examples are not annotated as tool bullets", () => {
	const sections = { tools: "Example:\n```\n- search: Search the web\n```", rules: "Example:\n- Cite sources" };
	const prompt = buildSystemPrompt({ cwd: CWD, sections });
	const items = analyzeSystemPrompt(prompt, { sections }, [TOOL]);
	assert.deepEqual(items.find((item) => item.kind === "tool")?.sections?.map((part) => part.label), ["Definition"]);
	assert.equal(items[0].children?.some((part) => part.injectedReferences !== undefined), false);
	assert.match(items[0].text, /Search the web/);
});

test("instruction files and skill records are read from the captured prompt, not loader metadata", () => {
	const prompt = "Preamble\n\n<project_context>\nProject-specific instructions and guidelines:\n\n" +
		'<project_instructions path="/old/AGENTS.md">\nRecorded rules\n</project_instructions>\n</project_context>\n\n' +
		"<skills>\nThe following skills provide specialized instructions\n<available_skills>\n<skill>\n" +
		"<name>test</name>\n<description>Test &amp; verify &lt;code&gt;</description>\n" +
		"<location>/old/SKILL.md</location>\n</skill>\n</available_skills>\n</skills>\n\n<cwd>\n/old\n</cwd>";
	const items = analyzeSystemPrompt(prompt, {});
	assert.equal(items.find((item) => item.id === "context-files")?.children?.[0]?.text, "Recorded rules");
	assert.equal(items.find((item) => item.id === "skills")?.children?.[0]?.text,
		"test\nTest & verify <code>\n/old/SKILL.md");
	assert.doesNotMatch(items[0].text, /Recorded rules|available_skills|<skills>/);
});
