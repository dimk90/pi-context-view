import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { analyzeSystemPrompt, type ToolSlice } from "../src/measure.ts";
import { findPromptSections } from "../src/prompt-blocks.ts";

const CWD = "/fixture";
const TOOL: ToolSlice = {
	name: "search", description: "Search", parametersJson: "{}", snippet: "Search the web",
	guidelines: ["Cite sources"], source: "npm:web",
};

test("XML sections after cwd remain named System Prompt parts, not guessed extension additions", () => {
	const sections = { review: "Read npm:web guidance.", constraints: "Keep it small." };
	const prompt = buildSystemPrompt({ cwd: CWD, sections });
	// Even a later handler's sections, missing from our prepared options, are recognized.
	for (const options of [{ cwd: CWD }, { cwd: CWD, sections }]) {
		const items = analyzeSystemPrompt(prompt, options, [], { sources: [{ source: "npm:web", path: "/web.ts" }] });
		assert.equal(items.some((item) => item.kind === "prompt-addition"), false);
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
	const items = analyzeSystemPrompt(prompt, { cwd: CWD, appendSystemPrompt: "OLD ADDENDUM", sections }, [TOOL]);
	const parts = items[0].children ?? [];
	for (const text of Object.values(sections)) assert.ok(parts.some((part) => part.text.trim() === text));
	assert.doesNotMatch(items[0].text, /OLD ADDENDUM|<\/?(?:tools|rules|skills|cwd)>/);
	assert.equal(items.some((item) => item.kind === "prompt-addition"), false);
	assert.deepEqual(items.find((item) => item.kind === "tool")?.sections?.map((part) => part.label), ["Definition"]);
});

test("a custom prefix can restore selected native XML sections without marking them dropped", () => {
	const sections = { tools: "- search: Search the web", docs: "Restored docs" };
	const prompt = buildSystemPrompt({ cwd: CWD, customPrompt: "Custom prefix", sections });
	const items = analyzeSystemPrompt(prompt, { cwd: CWD, customPrompt: "Custom prefix", sections }, [TOOL]);
	assert.deepEqual(items[0].children?.filter((part) => part.dropped).map((part) => part.label), ["Guidelines"]);
	const tool = items.find((item) => item.kind === "tool");
	assert.equal(tool?.sections?.find((part) => part.label === "Available Tools")?.dropped, undefined);
	assert.equal(tool?.sections?.find((part) => part.label === "Guidelines")?.tokens, 0);
	assert.equal(items[0].sections?.find((part) => part.label === "Available Tools")?.injectedReferences?.length, 1);
});

test("section discovery ignores nested and fenced examples, including unclosed fences inside sections", () => {
	const prompt = "Preamble\n\n```xml\n<rules>\nExample\n</rules>\n```\n\n" +
		"<addendum>\n<rules>\nNested example\n</rules>\n```\nUnclosed inner fence\n</addendum>\n\n" +
		"<cwd>\n/fixture\n</cwd>\n\n<review>\nReal section\n</review>";
	assert.deepEqual(findPromptSections(prompt).map((section) => section.name), ["addendum", "cwd", "review"]);
	const parts = analyzeSystemPrompt(prompt, { cwd: CWD })[0].children ?? [];
	assert.equal(parts.find((part) => part.label === "Appended Prompt")?.text,
		"<rules>\nNested example\n</rules>\n```\nUnclosed inner fence");
	assert.equal(parts.find((part) => part.label === "review")?.text, "Real section");
});

test("unwrapped gaps around custom sections remain additions without absorbing section text", () => {
	const prompt = buildSystemPrompt({ cwd: CWD, sections: { review: "Structured rule" } })
		.replace("<review>", "First addition\n\n<review>") + "\n\nLast addition";
	const items = analyzeSystemPrompt(prompt, { cwd: CWD });
	const addition = items.find((item) => item.kind === "prompt-addition");
	assert.ok(addition?.text.includes("First addition"));
	assert.ok(addition?.text.includes("Last addition"));
	assert.doesNotMatch(addition?.text ?? "", /Structured rule|<review>/);
});

test("section-only state without cwd retains tag labels and trailing unwrapped text", () => {
	const items = analyzeSystemPrompt("<review>\nOnly rule\n</review>\n\nExtra instruction", { cwd: CWD });
	assert.equal(items[0].children?.find((part) => part.label === "review")?.text, "Only rule");
	assert.equal(items.find((item) => item.kind === "prompt-addition")?.text, "\n\nExtra instruction");
});

test("a single custom section keeps its label and repeated tags remain additions", () => {
	const prompt = "<review>\nFirst rule\n</review>";
	const only = analyzeSystemPrompt(prompt, { cwd: CWD });
	assert.equal(only[0].sections?.[0]?.label, "review");
	const repeated = analyzeSystemPrompt(`${prompt}\n\n<review>\nSecond rule\n</review>`, { cwd: CWD });
	assert.equal(repeated[0].children?.filter((part) => part.label === "review").length, 1);
	assert.match(repeated.find((item) => item.kind === "prompt-addition")?.text ?? "", /Second rule/);
});

test("custom tool-surface prose and fenced examples are not carved as tool bullets", () => {
	const sections = { tools: "Example:\n```\n- search: Search the web\n```", rules: "Example:\n- Cite sources" };
	const prompt = buildSystemPrompt({ cwd: CWD, sections });
	const items = analyzeSystemPrompt(prompt, { cwd: CWD, sections }, [TOOL]);
	assert.deepEqual(items.find((item) => item.kind === "tool")?.sections?.map((part) => part.label), ["Definition"]);
	assert.match(items[0].text, /Search the web/);
});

test("captured instruction files and skill records do not require current loader metadata", () => {
	const prompt = "Preamble\n\n<project_context>\nProject-specific instructions and guidelines:\n\n" +
		'<project_instructions path="/old/AGENTS.md">\nRecorded rules\n</project_instructions>\n</project_context>\n\n' +
		"<skills>\nThe following skills provide specialized instructions\n<available_skills>\n<skill>\n" +
		"<name>test</name>\n<description>Test &amp; verify &lt;code&gt;</description>\n" +
		"<location>/old/SKILL.md</location>\n</skill>\n</available_skills>\n</skills>\n\n<cwd>\n/old\n</cwd>";
	const items = analyzeSystemPrompt(prompt, { cwd: CWD, contextFilePaths: ["/new/AGENTS.md"], skills: [] });
	assert.equal(items.find((item) => item.id === "context-files")?.children?.[0]?.text, "Recorded rules");
	assert.equal(items.find((item) => item.id === "skills")?.children?.[0]?.text,
		"test\nTest & verify <code>\n/old/SKILL.md");
	assert.doesNotMatch(items[0].text, /Recorded rules|available_skills|<skills>/);
});
