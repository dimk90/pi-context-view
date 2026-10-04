import assert from "node:assert/strict";
import { test } from "node:test";

import type { BuildSystemPromptOptions, ToolInfo } from "@earendil-works/pi-coding-agent";

import { captureActiveTools, copyPromptOptions } from "../src/replay.ts";

/** ToolInfo fixture with the given provenance source and one guideline. */
function tool(name: string, source: string): ToolInfo {
	return {
		name,
		description: `${name} description`,
		parameters: {} as ToolInfo["parameters"],
		promptGuidelines: [`Use ${name}`],
		exposure: "direct",
		sourceInfo: {
			path: `/tmp/${name}.ts`,
			source,
			scope: "temporary",
			origin: "top-level",
		},
	};
}

test("captureActiveTools uses the final active set", () => {
	const tools = captureActiveTools(
		[tool("read", "builtin"), tool("search", "npm:web")],
		["search"],
		{ toolSnippets: { search: "Search the web" } },
	);

	assert.deepEqual(tools.map((entry) => entry.name), ["search"]);
	assert.equal(tools[0]?.source, "npm:web");
	assert.equal(tools[0]?.snippet, "Search the web");
});

test("captureActiveTools keeps pi's active-tool order and drops repeated names", () => {
	const tools = captureActiveTools(
		[tool("read", "builtin"), tool("search", "npm:web")],
		["search", "read", "search"],
		{},
	);

	// Guideline ownership follows this order, so it must match the order pi
	// builds its Guidelines section from.
	assert.deepEqual(tools.map((entry) => entry.name), ["search", "read"]);
});

test("copyPromptOptions owns the custom prompt and section overrides", () => {
	const sections = { review: "Original rule" };
	const options: BuildSystemPromptOptions = { cwd: "/tmp", customPrompt: "CUSTOM", sections };

	const copied = copyPromptOptions(options);
	sections.review = "Changed rule";

	assert.equal(copied.customPrompt, "CUSTOM");
	assert.deepEqual(copied.sections, { review: "Original rule" });
});
