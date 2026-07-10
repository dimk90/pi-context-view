import assert from "node:assert/strict";
import { test } from "node:test";

import type {
	BuildSystemPromptOptions,
	ContextEvent,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";

import {
	captureActiveTools,
	InitialCaptureState,
	measureInjectedMessages,
} from "../src/capture.ts";

function customMessage(customType: string, content: string, timestamp: number): ContextEvent["messages"][number] {
	return { role: "custom", customType, content, display: false, timestamp };
}

function tool(name: string, source: string): ToolInfo {
	return {
		name,
		description: `${name} description`,
		parameters: {} as ToolInfo["parameters"],
		promptGuidelines: [`Use ${name}`],
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
		{ cwd: "/tmp", toolSnippets: { search: "Search the web" } },
	);

	assert.deepEqual(tools.map((entry) => entry.name), ["search"]);
	assert.equal(tools[0]?.source, "npm:web");
	assert.equal(tools[0]?.snippet, "Search the web");
});

test("measureInjectedMessages gives duplicate custom types stable occurrence ids", () => {
	const items = measureInjectedMessages([
		customMessage("marker", "first", 1),
		customMessage("marker", "second", 2),
	]);

	assert.deepEqual(items.map((entry) => entry.id), ["message:marker:0", "message:marker:1"]);
	assert.equal(items[0]?.source.id, "message-type:marker");
	assert.equal(items[1]?.text, "second");
});

test("InitialCaptureState refreshes pending options and freezes the first snapshot", () => {
	const state = new InitialCaptureState();
	const firstOptions: BuildSystemPromptOptions = { cwd: "/tmp" };
	const finalOptions: BuildSystemPromptOptions = { cwd: "/tmp", customPrompt: "CUSTOM" };
	const message = customMessage("marker", "captured", 1);
	const capturedAt = new Date("2026-07-10T12:00:00Z");

	state.prepare(firstOptions);
	state.prepare(finalOptions);
	const first = state.finalize({
		systemPrompt: "CUSTOM",
		messages: [message],
		allTools: [],
		activeToolNames: [],
		origin: "real-turn",
		capturedAt,
	});
	assert.ok(first !== undefined);
	assert.equal(first.groups[0]?.items[0]?.label, "custom system prompt (--system-prompt)");
	assert.equal(first.groups[1]?.items[0]?.text, "captured");

	if (message.role === "custom") message.content = "changed";
	capturedAt.setFullYear(2000);
	state.prepare({ cwd: "/different" });
	const second = state.finalize({
		systemPrompt: "DIFFERENT",
		messages: [],
		allTools: [],
		activeToolNames: [],
		origin: "synthetic-probe",
	});

	assert.strictEqual(second, first);
	assert.equal(second.groups[1]?.items[0]?.text, "captured");
	assert.equal(second.capturedAt.toISOString(), "2026-07-10T12:00:00.000Z");
});

test("InitialCaptureState does not finalize before prepare", () => {
	const state = new InitialCaptureState();
	assert.equal(
		state.finalize({
			systemPrompt: "prompt",
			messages: [],
			allTools: [],
			activeToolNames: [],
			origin: "real-turn",
		}),
		undefined,
	);
});
