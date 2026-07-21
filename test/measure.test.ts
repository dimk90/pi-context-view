import assert from "node:assert/strict";
import { test } from "node:test";

// Deep import bypasses the package barrel, which does not re-export buildSystemPrompt.
import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { analyzeSystemPrompt, type PromptOptionsSlice, type ToolSlice } from "../src/measure.ts";

const CWD = "/tmp/context-project";

/** Today's date formatted like pi's base-prompt "Current date:" line. */
function currentDate(): string {
	const now = new Date();
	return [
		now.getFullYear(),
		String(now.getMonth() + 1).padStart(2, "0"),
		String(now.getDate()).padStart(2, "0"),
	].join("-");
}

test("analyzeSystemPrompt emits stable semantic ids and content-only measurements", () => {
	const contextBlock = [
		"<project_context>",
		"",
		"Project-specific instructions and guidelines:",
		"",
		'<project_instructions path="./AGENTS.md">',
		"Project rules",
		"</project_instructions>",
		"",
		"</project_context>",
	].join("\n");
	const skillsBlock = [
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"<available_skills>",
		"  <skill>",
		"    <name>testing</name>",
		"    <description>Test &amp; verify</description>",
		"    <location>/skills/testing/SKILL.md</location>",
		"  </skill>",
		"  <skill>",
		"    <name>docs</name>",
		"    <description>Write docs</description>",
		"    <location>/skills/docs/SKILL.md</location>",
		"  </skill>",
		"</available_skills>",
	].join("\n");
	const append = "APPENDED INSTRUCTION";
	const extensionAddition = "\nEXTENSION INSTRUCTION";
	const systemPrompt = [
		"BASE PROMPT",
		"- search: Search the web",
		"- Cite sources",
		contextBlock,
		skillsBlock,
		append,
		"Current date: 2001-02-03",
		`Current working directory: ${CWD}`,
	].join("\n") + extensionAddition;
	const options: PromptOptionsSlice = {
		cwd: CWD,
		appendSystemPrompt: append,
		contextFilePaths: ["./AGENTS.md"],
		skills: [
			{ name: "testing", description: "Test & verify", filePath: "/skills/testing/SKILL.md" },
			{ name: "docs", description: "Write docs", filePath: "/skills/docs/SKILL.md" },
		],
	};
	const tools: ToolSlice[] = [
		{
			name: "read",
			description: "Read files",
			parametersJson: "{}",
			guidelines: [],
			source: "builtin",
		},
		{
			name: "bash",
			description: "Run a bash command with a much longer description than read",
			parametersJson: "{}",
			guidelines: [],
			source: "builtin",
		},
		{
			name: "search",
			description: "Search",
			parametersJson: "{}",
			snippet: "Search the web",
			guidelines: ["Cite sources"],
			source: "npm:web",
		},
	];

	const items = analyzeSystemPrompt(systemPrompt, options, tools);
	assert.deepEqual(
		items.map((entry) => entry.id),
		[
			"base-prompt",
			"tool:npm:web:search",
			"tool:builtin",
			"context-file:./AGENTS.md",
			"skills",
			"append-prompt",
			"prompt-addition:aggregate",
		],
	);
	assert.equal(items.find((entry) => entry.id === "tool:npm:web:search")?.source.id, "tool-source:npm:web");
	const base = items.find((entry) => entry.id === "base-prompt");
	assert.doesNotMatch(base?.text ?? "", /project_context|project_instructions|Project-specific instructions/);
	assert.doesNotMatch(base?.text ?? "", /available_skills|The following skills/);
	assert.doesNotMatch(base?.text ?? "", /Current date|Current working directory/);
	const contextFile = items.find((entry) => entry.id === "context-file:./AGENTS.md");
	assert.equal(contextFile?.kind, "context-file");
	assert.equal(contextFile?.text, "Project rules");
	assert.equal(contextFile?.chars, "Project rules".length);
	assert.equal(items.find((entry) => entry.id === "prompt-addition:aggregate")?.text, extensionAddition);

	const skills = items.find((entry) => entry.id === "skills");
	assert.equal(skills?.label, "Skills (2)");
	assert.deepEqual(
		skills?.children?.map((child) => [child.id, child.label, child.text]),
		[
			["skill:testing", "testing", "testing\nTest & verify\n/skills/testing/SKILL.md"],
			["skill:docs", "docs", "docs\nWrite docs\n/skills/docs/SKILL.md"],
		],
	);
	assert.equal(skills?.chars, skills?.children?.reduce((sum, child) => sum + child.chars, 0));
	assert.equal(skills?.tokens, skills?.children?.reduce((sum, child) => sum + child.tokens, 0));
	assert.doesNotMatch(skills?.text ?? "", /<skill>|<name>|available_skills|Use the read tool/);

	const builtin = items.find((entry) => entry.id === "tool:builtin");
	assert.equal(builtin?.label, "Built-in Tools (2)");
	assert.deepEqual(
		builtin?.children?.map((child) => child.id),
		["tool:builtin:bash", "tool:builtin:read"],
	);
	const childTokens = builtin?.children?.reduce((sum, child) => sum + child.tokens, 0) ?? 0;
	assert.ok(childTokens > 0);
	assert.equal(builtin?.tokens, childTokens);
});

test("analyzeSystemPrompt does not attribute context-file lines as custom-prompt tool guidance", () => {
	const filePath = "./AGENTS.md";
	const contextBlock = [
		"<project_context>",
		`<project_instructions path="${filePath}">`,
		"- search: Search the web",
		"- Cite sources",
		"</project_instructions>",
		"</project_context>",
	].join("\n");
	const systemPrompt = [
		"CUSTOM PROMPT",
		contextBlock,
		`Current date: ${currentDate()}`,
		`Current working directory: ${CWD}`,
	].join("\n");
	const tools: ToolSlice[] = [{
		name: "search",
		description: "Search",
		parametersJson: "{}",
		snippet: "Search the web",
		guidelines: ["Cite sources"],
		source: "npm:web",
	}];

	const items = analyzeSystemPrompt(systemPrompt, {
		cwd: CWD,
		customPrompt: "CUSTOM PROMPT",
		contextFilePaths: [filePath],
	}, tools);
	const search = items.find((entry) => entry.id === "tool:npm:web:search");
	const base = items.find((entry) => entry.id === "base-prompt");
	assert.equal(search?.text, "search: Search\n{}");
	assert.equal(base?.text.trim(), "CUSTOM PROMPT");
});

test("analyzeSystemPrompt recognizes the pi 0.81 CWD-only footer", () => {
	const extensionAddition = "\nEXTENSION INSTRUCTION";
	const systemPrompt = [
		"BASE PROMPT",
		`Current working directory: ${CWD}`,
	].join("\n") + extensionAddition;

	const items = analyzeSystemPrompt(systemPrompt, { cwd: CWD });
	const base = items.find((entry) => entry.id === "base-prompt");
	assert.equal(base?.text, "BASE PROMPT");
	assert.equal(items.find((entry) => entry.id === "prompt-addition:aggregate")?.text, extensionAddition);
});

test("analyzeSystemPrompt rejects CWD lines that are not the exact footer line", () => {
	const systemPrompt = [
		"BASE PROMPT",
		// Prefix of a longer path: not followed by a line boundary.
		`Current working directory: ${CWD}/subdir`,
		// Different cwd entirely.
		"Current working directory: /tmp/other-project",
		"TRAILING BASE TEXT",
	].join("\n");

	const items = analyzeSystemPrompt(systemPrompt, { cwd: CWD });
	assert.equal(items.length, 1);
	assert.equal(items[0]?.id, "base-prompt");
	assert.equal(items[0]?.text, systemPrompt);
});

test("analyzeSystemPrompt finds the footer in real buildSystemPrompt output", () => {
	const append = "APPENDED INSTRUCTION";
	const systemPrompt = buildSystemPrompt({
		cwd: CWD,
		appendSystemPrompt: append,
		contextFiles: [{ path: "./AGENTS.md", content: "Project rules" }],
	});
	const extensionAddition = "\nEXTENSION INSTRUCTION";
	const options: PromptOptionsSlice = {
		cwd: CWD,
		appendSystemPrompt: append,
		contextFilePaths: ["./AGENTS.md"],
	};

	const items = analyzeSystemPrompt(systemPrompt + extensionAddition, options);
	const base = items.find((entry) => entry.id === "base-prompt");
	assert.ok(base !== undefined);
	assert.doesNotMatch(base.text, /Current working directory/);
	assert.equal(items.find((entry) => entry.id === "context-file:./AGENTS.md")?.text, "Project rules");
	assert.equal(items.find((entry) => entry.id === "append-prompt")?.text, append);
	assert.equal(items.find((entry) => entry.id === "prompt-addition:aggregate")?.text, extensionAddition);
});

test("analyzeSystemPrompt abbreviates home-directory context-file labels with ~", () => {
	const homeDir = "/home/tester";
	const filePath = `${homeDir}/.pi/agent/AGENTS.md`;
	const contextBlock = [
		"<project_context>",
		`<project_instructions path="${filePath}">`,
		"Global rules",
		"</project_instructions>",
		"</project_context>",
	].join("\n");
	const systemPrompt = [
		"BASE PROMPT",
		contextBlock,
		`Current date: ${currentDate()}`,
		`Current working directory: ${CWD}`,
	].join("\n");
	const options: PromptOptionsSlice = {
		cwd: CWD,
		homeDir,
		contextFilePaths: [filePath],
	};

	const items = analyzeSystemPrompt(systemPrompt, options);
	const contextFile = items.find((entry) => entry.id === `context-file:${filePath}`);
	assert.equal(contextFile?.label, "~/.pi/agent/AGENTS.md");
});
