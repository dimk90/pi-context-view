import assert from "node:assert/strict";
import { test } from "node:test";

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

test("analyzeSystemPrompt emits stable semantic ids and sources", () => {
	const contextBlock = '<project_instructions path="./AGENTS.md">\nProject rules\n</project_instructions>';
	const skillsBlock = [
		"The following skills provide specialized instructions",
		"<available_skills><skill>testing</skill></available_skills>",
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
		`Current date: ${currentDate()}`,
		`Current working directory: ${CWD}`,
	].join("\n") + extensionAddition;
	const options: PromptOptionsSlice = {
		cwd: CWD,
		appendSystemPrompt: append,
		contextFiles: [{ path: "./AGENTS.md", content: "Project rules" }],
		skills: [{ name: "testing" }],
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
	assert.equal(items.find((entry) => entry.id === "context-file:./AGENTS.md")?.kind, "context-file");
	assert.equal(items.find((entry) => entry.id === "prompt-addition:aggregate")?.text, extensionAddition);
});
