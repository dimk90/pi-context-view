import assert from "node:assert/strict";
import { test } from "node:test";

import type { Tool } from "@earendil-works/pi-ai";
import type { BuildSystemPromptOptions, ToolInfo } from "@earendil-works/pi-coding-agent";

import type { InjectionSnapshot } from "../src/model.ts";
import {
	buildNativeSnapshot,
	buildUsageSnapshot,
	captureActiveTools,
	copyPromptOptions,
	type UsageSnapshotInput,
} from "../src/replay.ts";

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

test("buildUsageSnapshot neither lists nor counts the tools Pi hides", () => {
	const declarations = ["read", "bash", "codemode"].map((name) => ({
		name, description: `${name} description`, parameters: { type: "object", properties: {} },
	}) as Tool);
	const input: UsageSnapshotInput = {
		messages: [{
			role: "system", content: "", sections: { cwd: "<cwd>\n/tmp\n</cwd>" },
			toolsAdded: declarations, timestamp: 1,
		}],
		systemPrompt: "live prompt",
		options: { cwd: "/tmp" },
		allTools: [tool("read", "builtin"), tool("bash", "builtin"), tool("codemode", "builtin:codemode")],
		activeToolNames: ["read", "bash"],
	};
	const hidden = { ...input, options: { cwd: "/tmp", hiddenTools: ["read", "bash"] } };
	assert.deepEqual(toolNames(buildUsageSnapshot(input)), ["bash", "codemode", "read"]);
	assert.deepEqual(toolNames(buildUsageSnapshot(hidden)), ["codemode"]);
	assert.deepEqual(toolNames(buildUsageSnapshot({ ...hidden, forcedPrompt: "Forced prompt" })), ["codemode"],
		"tool filtering applies with a forced prompt too");
	assert.deepEqual(toolNames(buildUsageSnapshot({ ...input, messages: [] })), ["bash", "read"]);
	assert.deepEqual(toolNames(buildUsageSnapshot({ ...hidden, messages: [] })), [],
		"the live fallback without recorded state leaves them out too");
});

test("buildNativeSnapshot retains only names of active hidden tools for the description", () => {
	const snapshot = buildNativeSnapshot({
		systemPrompt: "live prompt",
		options: { cwd: "/tmp", hiddenTools: ["unknown", "write", "bash"] },
		allTools: [tool("read", "builtin"), tool("bash", "builtin"), tool("write", "builtin")],
		activeToolNames: ["bash", "read"],
	});
	assert.deepEqual(snapshot.hiddenTools, ["bash"]);
	assert.deepEqual(toolNames(snapshot), ["read"]);
});

/** Sorted names of every measured tool, built-in children included. */
function toolNames(snapshot: InjectionSnapshot): string[] {
	return snapshot.groups.flatMap((group) => group.items)
		.flatMap((item) => item.children ?? [item])
		.filter((item) => item.kind === "tool")
		.map((item) => item.label)
		.sort();
}
