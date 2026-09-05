import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import {
	AUTO_COMPACT_BUFFER_CATEGORY_ID,
	DEFAULT_CATEGORY_COLORS,
	FREE_SPACE_CATEGORY_ID,
} from "../src/config.ts";
import type { InitialSnapshot, InjectionItem, UsageCategory } from "../src/model.ts";
import { collectPreviewEntries, computeUsage, toReportedUsage } from "../src/usage.ts";

/** Minimal measured item fixture. */
function item(
	id: string,
	kind: InjectionItem["kind"],
	tokens: number,
	native = true,
	children?: InjectionItem[],
): InjectionItem {
	return {
		id,
		phase: "initial",
		kind,
		source: { id: native ? "pi" : "npm:test", label: native ? "pi" : "npm:test", native },
		label: id,
		chars: tokens * 4,
		tokens,
		text: id,
		children,
	};
}

/** Frozen Initial fixture covering every prompt/tool category. */
function snapshot(): InitialSnapshot {
	const builtins = [item("read", "tool", 3), item("bash", "tool", 5)];
	const skills = [item("code-style", "skills", 2), item("typescript-code", "skills", 4)];
	const contextFiles = [item("agents", "context-file", 2), item("global-agents", "context-file", 4)];
	const piItems = [
		item("base", "base-prompt", 10),
		item("builtins", "tool", 8, true, builtins),
		item("context-files", "context-file", 6, true, contextFiles),
		item("skills", "skills", 6, true, skills),
	];
	const mcpTool: InjectionItem = {
		...item("mcp_search", "tool", 5, false),
		source: { id: "tool-source:npm:mcp-client", label: "npm:mcp-client", native: false },
	};
	const extensionItems = [
		item("web_search", "tool", 7, false),
		mcpTool,
		item("addition", "prompt-addition", 9, false),
		item("initial-custom-message", "message", 99, false),
	];
	return {
		origin: "real-turn",
		capturedAt: new Date("2026-07-11T12:00:00Z"),
		groups: [
			{
				source: { id: "pi", label: "pi", native: true },
				items: piItems,
				totalTokens: piItems.reduce((sum, entry) => sum + entry.tokens, 0),
			},
			{
				source: { id: "npm:test", label: "npm:test", native: false },
				items: extensionItems,
				totalTokens: extensionItems.reduce((sum, entry) => sum + entry.tokens, 0),
			},
		],
		totalTokens: [...piItems, ...extensionItems].reduce((sum, entry) => sum + entry.tokens, 0),
	};
}

/** Assistant fixture containing text, thinking, and a tool call. */
function assistantMessage(): ContextEvent["messages"][number] {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "text" },
			{ type: "thinking", thinking: "thinking" },
			{ type: "toolCall", id: "call", name: "read", arguments: { path: "x" } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

/** Session fixture exercising every message-backed usage category. */
function sessionMessages(): ContextEvent["messages"] {
	return [
		{ role: "user", content: "12345678", timestamp: 1 },
		assistantMessage(),
		{
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text: "12345678" }],
			isError: false,
			timestamp: 3,
		},
		{ role: "custom", customType: "marker", content: "abcd", display: false, timestamp: 4 },
		{ role: "bashExecution", command: "ls", output: "123456", exitCode: 0, cancelled: false, truncated: false,
			timestamp: 5 },
		{ role: "bashExecution", command: "xx", output: "yyyyyy", exitCode: 0, cancelled: false, truncated: false,
			excludeFromContext: true, timestamp: 6 },
		{ role: "compactionSummary", summary: "abcdefgh", tokensBefore: 1_000, timestamp: 7 },
		{ role: "branchSummary", summary: "abcd", fromId: "old", timestamp: 8 },
	];
}

/** Find one category recursively by stable id. */
function category(categories: readonly UsageCategory[], id: string): UsageCategory {
	for (const entry of categories) {
		if (entry.id === id) return entry;
		const nested = findCategory(entry.children ?? [], id);
		if (nested !== undefined) return nested;
	}
	assert.fail(`missing category: ${id}`);
}

/** Recursive worker for category(). */
function findCategory(categories: readonly UsageCategory[], id: string): UsageCategory | undefined {
	for (const entry of categories) {
		if (entry.id === id) return entry;
		const nested = findCategory(entry.children ?? [], id);
		if (nested !== undefined) return nested;
	}
	return undefined;
}

test("computeUsage classifies Initial components and live session messages without double-counting", () => {
	const usage = computeUsage({
		snapshot: snapshot(),
		messages: sessionMessages(),
		reported: { tokens: 100, contextWindow: 1_000, percent: 10 },
		modelLabel: "test-model",
		computedAt: new Date("2026-07-11T13:00:00Z"),
	});

	assert.equal(category(usage.categories, "system-prompt").tokens, 19);
	assert.deepEqual(category(usage.categories, "built-in-tools").children?.map((entry) => entry.id), [
		"item:bash",
		"item:read",
	]);
	assert.equal(category(usage.categories, "built-in-tools").tokens, 8);
	assert.equal(category(usage.categories, "custom-tools").tokens, 7);
	assert.equal(category(usage.categories, "mcp-tools").tokens, 5);
	assert.deepEqual(category(usage.categories, "context-files").children?.map((entry) => entry.id), [
		"item:global-agents",
		"item:agents",
	]);
	assert.equal(category(usage.categories, "context-files").tokens, 6);
	assert.equal(category(usage.categories, "skills").tokens, 6);
	assert.equal(findCategory(usage.categories, "messages"), undefined);
	assert.equal(category(usage.categories, "user-messages").tokens, 2);
	assert.equal(category(usage.categories, "assistant-messages").tokens, 1);
	assert.equal(category(usage.categories, "assistant-thinking").tokens, 2);
	assert.equal(category(usage.categories, "tool-calls").tokens, 4);
	assert.equal(category(usage.categories, "tool-output").tokens, 8);
	assert.equal(category(usage.categories, "tool-result:read").tokens, 2);
	assert.equal(findCategory(usage.categories, "tool-results"), undefined);
	assert.equal(category(usage.categories, "extension-messages").tokens, 1);
	// Bash and summary estimates cover pi's LLM-transform text, not just command/output/summary.
	assert.equal(category(usage.categories, "bash-executions").tokens, 6);
	assert.equal(category(usage.categories, "compacted-data").tokens, 55);
	assert.equal(usage.estimatedTokens, usage.categories.reduce((sum, entry) => sum + entry.tokens, 0));
	assert.equal(usage.modelLabel, "test-model");
	assert.equal(usage.computedAt.toISOString(), "2026-07-11T13:00:00.000Z");
	assert.ok(!usage.categories.some((entry) => entry.tokens === 99));
});

test("computeUsage orders prompt categories the way pi assembles a request", () => {
	const usage = computeUsage({ snapshot: snapshot(), messages: [] });

	assert.deepEqual(
		usage.categories.map((entry) => [entry.id, entry.label]),
		[
			["system-prompt", "System Prompt"],
			["context-files", "Instruction Files"],
			["skills", "Skills"],
			["built-in-tools", "Built-in Tools"],
			["custom-tools", "Custom Tools"],
			["mcp-tools", "MCP Tools"],
		],
	);
});

test("computeUsage produces exactly the top-level categories that carry a configurable color", () => {
	const usage = computeUsage({ snapshot: snapshot(), messages: sessionMessages() });

	// Buffer and free space are view-local rows, so they are configurable without a computed category.
	const configuredIds = [...DEFAULT_CATEGORY_COLORS.keys()]
		.filter((id) => id !== AUTO_COMPACT_BUFFER_CATEGORY_ID && id !== FREE_SPACE_CATEGORY_ID)
		.sort();
	assert.deepEqual(usage.categories.map((entry) => entry.id).sort(), configuredIds);
});

test("computeUsage includes frozen context-only messages without recounting session-backed injections", () => {
	const initial = snapshot();
	const contextOnly = {
		...item("context-user", "message", 8, false),
		source: { id: "aggregate:extensions", label: "extensions (aggregate)", native: false },
		label: "user message",
		text: "context-only content",
		contextOnly: true,
	} satisfies InjectionItem;
	const contextGroup = {
		source: contextOnly.source,
		items: [contextOnly],
		totalTokens: contextOnly.tokens,
	};
	const usage = computeUsage({
		snapshot: {
			...initial,
			groups: [...initial.groups, contextGroup],
			totalTokens: initial.totalTokens + contextOnly.tokens,
		},
		messages: [],
	});

	const extensions = category(usage.categories, "extension-messages");
	assert.equal(extensions.tokens, 8);
	assert.deepEqual(extensions.children?.map((entry) => entry.label), ["extensions (aggregate)"]);
	assert.equal(collectPreviewEntries(extensions)[0]?.text, "context-only content");
});

test("computeUsage carries measured tool parts into tool preview entries", () => {
	const snippet = "\n- web_search: Search the web";
	const definition = "web_search: Search\n{}";
	const customTool: InjectionItem = {
		...item("web_search", "tool", 12, false),
		text: `${snippet}${definition}`,
		sections: [
			{ label: "Available Tools", text: snippet, tokens: 7 },
			{ label: "Definition", text: definition, tokens: 5 },
		],
	};
	const builtinChild: InjectionItem = {
		...item("read", "tool", 3),
		text: definition,
		sections: [{ label: "Definition", text: definition, tokens: 3 }],
	};
	const piItems = [item("base", "base-prompt", 10), item("builtins", "tool", 3, true, [builtinChild])];
	const usage = computeUsage({
		snapshot: {
			origin: "real-turn",
			capturedAt: new Date("2026-07-11T12:00:00Z"),
			groups: [
				{ source: { id: "pi", label: "pi", native: true }, items: piItems, totalTokens: 13 },
				{
					source: { id: "npm:test", label: "npm:test", native: false },
					items: [customTool],
					totalTokens: customTool.tokens,
				},
			],
			totalTokens: 25,
		},
		messages: [],
	});

	const customEntry = collectPreviewEntries(category(usage.categories, "custom-tools"))[0];
	assert.deepEqual(customEntry?.sections?.map((section) => section.label), ["Available Tools", "Definition"]);
	// Parts break the entry down; they never add tokens to it.
	assert.equal(customEntry?.sections?.reduce((sum, section) => sum + section.tokens, 0), customEntry?.tokens);
	assert.equal(customEntry?.sections?.map((section) => section.text).join(""), customEntry?.text);

	const builtinEntry = collectPreviewEntries(category(usage.categories, "item:read"))[0];
	assert.deepEqual(builtinEntry?.sections?.map((section) => section.label), ["Definition"]);
	const promptEntry = collectPreviewEntries(category(usage.categories, "system-prompt"))[0];
	assert.equal(promptEntry?.sections, undefined);
});

test("computeUsage keeps System Prompt parts as sections of one entry, not separate blocks", () => {
	const preamble = "You are an expert coding assistant.";
	const guidelines = "\nGuidelines:\n- Be concise";
	const basePrompt: InjectionItem = {
		...item("base", "base-prompt", 13),
		text: `${preamble}${guidelines}`,
		sections: [
			{ label: "Preamble", text: preamble, tokens: 9 },
			{ label: "Guidelines", text: guidelines, tokens: 4 },
		],
		children: [
			{ ...item("base-prompt:preamble", "base-prompt", 9), label: "Preamble", text: preamble },
			{ ...item("base-prompt:guidelines", "base-prompt", 4), label: "Guidelines", text: guidelines },
		],
	};
	const usage = computeUsage({
		snapshot: {
			origin: "real-turn",
			capturedAt: new Date("2026-07-11T12:00:00Z"),
			groups: [{ source: { id: "pi", label: "pi", native: true }, items: [basePrompt], totalTokens: 13 }],
			totalTokens: 13,
		},
		messages: [],
	});

	// Prompt parts break one preview block down; they never become blocks of their own.
	const entries = collectPreviewEntries(category(usage.categories, "system-prompt"));
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.tokens, 13);
	assert.deepEqual(entries[0]?.sections?.map((section) => section.label), ["Preamble", "Guidelines"]);
});

test("computeUsage drops empty categories and aggregates duplicate tool/custom message sources", () => {
	const messages: ContextEvent["messages"] = [
		{
			role: "toolResult",
			toolCallId: "one",
			toolName: "read",
			content: [{ type: "text", text: "1234" }],
			isError: false,
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: "two",
			toolName: "read",
			content: [{ type: "text", text: "12345678" }],
			isError: false,
			timestamp: 2,
		},
		{ role: "custom", customType: "marker", content: "1234", display: false, timestamp: 3 },
		{ role: "custom", customType: "marker", content: "12345678", display: true, timestamp: 4 },
	];
	const usage = computeUsage({ snapshot: snapshot(), messages });

	const toolOutput = category(usage.categories, "tool-output");
	assert.equal(toolOutput.tokens, 3);
	assert.deepEqual(toolOutput.children?.map((entry) => [entry.id, entry.tokens]), [["tool-result:read", 3]]);
	assert.deepEqual(
		category(usage.categories, "extension-messages").children?.map((entry) => [entry.id, entry.tokens]),
		[["custom-message:marker", 3]],
	);
	assert.equal(category(usage.categories, "tool-result:read").entries?.length, 2);
	assert.equal(findCategory(usage.categories, "user-messages"), undefined);
	assert.ok(!usage.categories.some((entry) => entry.id === "compacted-data"));
});

test("computeUsage estimates images while previews expose placeholders only", () => {
	const messages: ContextEvent["messages"] = [
		{
			role: "user",
			content: [
				{ type: "text", text: "abcd" },
				{ type: "image", data: "sensitive-base64", mimeType: "image/png" },
			],
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: "image-call",
			toolName: "read_image",
			content: [{ type: "image", data: "sensitive-base64", mimeType: "image/png" }],
			isError: false,
			timestamp: 2,
		},
	];
	const usage = computeUsage({ snapshot: snapshot(), messages });

	const user = category(usage.categories, "user-messages");
	assert.equal(user.tokens, 1_201);
	assert.equal(user.entries?.[0]?.text, "abcd\n[image]");
	const imageResult = category(usage.categories, "tool-result:read_image");
	assert.equal(imageResult.tokens, 1_200);
	assert.equal(imageResult.entries?.[0]?.text, "[image]");
	assert.ok(!collectPreviewEntries(user).some((entry) => entry.text.includes("sensitive-base64")));
});

test("computeUsage builds per-block preview entries with timestamps and breadcrumbs", () => {
	const base = assistantMessage();
	assert.equal(base.role, "assistant");
	const multiBlock: ContextEvent["messages"][number] = {
		...base,
		content: [
			{ type: "text", text: "first block" },
			{ type: "text", text: "second block" },
			{ type: "toolCall", id: "a", name: "read", arguments: { path: "x" } },
			{ type: "toolCall", id: "b", name: "bash", arguments: { command: "ls" } },
		],
		timestamp: 20,
	};
	const messages: ContextEvent["messages"] = [
		{ role: "user", content: "hello there", timestamp: 10 },
		assistantMessage(),
		multiBlock,
		{ role: "bashExecution", command: "ls", output: "out", exitCode: 0, cancelled: false, truncated: false,
			timestamp: 30 },
	];
	const usage = computeUsage({ snapshot: snapshot(), messages });

	const userEntries = category(usage.categories, "user-messages").entries ?? [];
	assert.deepEqual(userEntries.map((entry) => [entry.timestamp, [...entry.breadcrumb], entry.text]), [
		[10, ["user"], "hello there"],
	]);

	// Single text block: no index cell. Multiple text blocks: `text i/n` cells.
	const textEntries = category(usage.categories, "assistant-messages").entries ?? [];
	assert.deepEqual(textEntries.map((entry) => [...entry.breadcrumb]), [
		["assistant"],
		["assistant", "text 1/2"],
		["assistant", "text 2/2"],
	]);
	assert.equal(textEntries[1]?.text, "first block");

	// Tool calls: one entry per call with the tool name as a breadcrumb cell.
	const callEntries = category(usage.categories, "tool-calls").entries ?? [];
	assert.deepEqual(callEntries.map((entry) => [entry.timestamp, [...entry.breadcrumb]]), [
		[2, ["assistant", "read"]],
		[20, ["assistant", "read"]],
		[20, ["assistant", "bash"]],
	]);
	assert.equal(callEntries[2]?.text, 'bash({"command":"ls"})');
	// Arguments are marked where they were serialized, between the call parentheses.
	const argumentsSpan = callEntries[2]?.jsonSpan;
	assert.ok(argumentsSpan !== undefined);
	assert.equal(callEntries[2]?.text.slice(argumentsSpan.start, argumentsSpan.end), '{"command":"ls"}');
	const callCategory = category(usage.categories, "tool-calls");
	assert.equal(callCategory.tokens, callEntries.reduce((sum, entry) => sum + entry.tokens, 0));

	const bashEntries = category(usage.categories, "bash-executions").entries ?? [];
	assert.deepEqual(bashEntries.map((entry) => [entry.timestamp, [...entry.breadcrumb], entry.text]), [
		[30, ["bash"], "$ ls\nout"],
	]);

	// Snapshot-backed categories carry timeless content entries.
	const promptEntries = category(usage.categories, "system-prompt").children?.flatMap(
		(child) => child.entries ?? [],
	) ?? [];
	assert.ok(promptEntries.length > 0);
	assert.ok(promptEntries.every((entry) => entry.timestamp === undefined));
});

test("computeUsage counts pi's LLM-transform text for bash executions and summaries", () => {
	const messages: ContextEvent["messages"] = [
		{ role: "bashExecution", command: "ls", output: "123456", exitCode: 0, cancelled: false, truncated: false,
			timestamp: 1 },
		{ role: "bashExecution", command: "ls", output: "", exitCode: 0, cancelled: false, truncated: false,
			timestamp: 2 },
		{ role: "bashExecution", command: "ls", output: "err", exitCode: 2, cancelled: false, truncated: false,
			timestamp: 3 },
		{ role: "bashExecution", command: "ls", output: "partial", exitCode: undefined, cancelled: true,
			truncated: false, timestamp: 4 },
		{ role: "bashExecution", command: "ls", output: "12345678", exitCode: 0, cancelled: false, truncated: true,
			fullOutputPath: "/tmp/out.txt", timestamp: 5 },
		{ role: "bashExecution", command: "ls", output: "hidden", exitCode: 0, cancelled: false, truncated: false,
			excludeFromContext: true, timestamp: 6 },
		{ role: "compactionSummary", summary: "abcdefgh", tokensBefore: 1_000, timestamp: 7 },
		{ role: "branchSummary", summary: "abcd", fromId: "old", timestamp: 8 },
	];

	const usage = computeUsage({ snapshot: snapshot(), messages });

	// "Ran `ls`" plus output fences or "(no output)", cancellation, exit code, and truncation notice.
	const bash = category(usage.categories, "bash-executions");
	assert.deepEqual(bash.entries?.map((entry) => [entry.timestamp, entry.tokens]), [
		[1, 6],
		[2, 5],
		[3, 12],
		[4, 12],
		[5, 18],
	]);
	assert.equal(bash.tokens, 53);
	// `!!` bash executions never reach the provider and are excluded entirely.
	assert.ok(!bash.entries?.some((entry) => entry.text.includes("hidden")));

	// Summary prefix plus <summary> tags: 96 + 8 + 11 and 89 + 4 + 10 characters.
	const compacted = category(usage.categories, "compacted-data");
	assert.deepEqual(compacted.entries?.map((entry) => [...entry.breadcrumb, entry.tokens]), [
		["compaction", 29],
		["branch", 26],
	]);
	assert.equal(compacted.tokens, 55);
	// Previews still show only the bare summary text, without the transform wrapper.
	assert.deepEqual(compacted.entries?.map((entry) => entry.text), ["abcdefgh", "abcd"]);
});

test("computeUsage uses provider reasoning per message and keeps signature estimates out of raw previews", () => {
	const base = assistantMessage();
	assert.equal(base.role, "assistant");
	const messages: ContextEvent["messages"] = [
		{
			...base,
			timestamp: 10,
			content: [
				{ type: "thinking", thinking: "abcde", thinkingSignature: "signature-one" },
				{ type: "thinking", thinking: "fghij", thinkingSignature: "signature-two" },
				{
					type: "toolCall",
					id: "call",
					name: "read",
					arguments: { path: "x" },
					thoughtSignature: "tool-signature",
				},
			],
			usage: { ...base.usage, reasoning: 11 },
		},
		{
			...base,
			timestamp: 20,
			content: [
				{ type: "thinking", thinking: "12345678", thinkingSignature: "123456789" },
				{
					type: "toolCall",
					id: "fallback-call",
					name: "bash",
					arguments: { command: "ls" },
					thoughtSignature: "1234567",
				},
			],
		},
		{
			...base,
			timestamp: 30,
			content: [{ type: "thinking", thinking: "1234567890123456", thinkingSignature: "blob" }],
			usage: { ...base.usage, reasoning: 2 },
		},
		{
			...base,
			timestamp: 40,
			content: [{ type: "thinking", thinking: "abcd" }],
			usage: { ...base.usage, reasoning: 6 },
		},
	];

	const usage = computeUsage({ snapshot: snapshot(), messages });
	const thinking = category(usage.categories, "assistant-thinking");
	const entries = thinking.entries ?? [];

	// Per-message totals are max(visible chars/4, reported reasoning): 11 + 2 + 4 + 6.
	assert.equal(thinking.tokens, 23);
	assert.equal(thinking.tokens, entries.reduce((sum, entry) => sum + entry.tokens, 0));
	assert.deepEqual(entries.map((entry) => entry.tokens), [10, 1, 2, 4, 6]);
	assert.deepEqual(entries.map((entry) => entry.visibleTokens), [2, undefined, 2, undefined, 1]);
	assert.deepEqual(entries.map((entry) => entry.invisibleReasoning), [
		{ tokens: 8, basis: "provider-reported", encoded: true },
		undefined,
		{ tokens: 4, basis: "signature-proxy", encoded: true },
		undefined,
		{ tokens: 5, basis: "provider-reported", encoded: false },
	]);
	assert.deepEqual(entries.slice(0, 2).map((entry) => [...entry.breadcrumb]), [
		["assistant", "thinking 1/2"],
		["assistant", "thinking 2/2"],
	]);
	assert.deepEqual(
		entries.map((entry) => entry.text),
		["abcde", "fghij", "12345678", "1234567890123456", "abcd"],
	);
	assert.ok(!entries.some((entry) => entry.text.includes("signature")));
});

test("computeUsage represents encoded-only reasoning without retaining its signature", () => {
	const base = assistantMessage();
	assert.equal(base.role, "assistant");
	const messages: ContextEvent["messages"] = [{
		...base,
		content: [{
			type: "toolCall",
			id: "call",
			name: "read",
			arguments: { path: "x" },
			thoughtSignature: "opaque-reasoning-payload",
		}],
		usage: { ...base.usage, reasoning: 7 },
	}];

	const usage = computeUsage({ snapshot: snapshot(), messages });
	const entries = category(usage.categories, "assistant-thinking").entries ?? [];
	assert.deepEqual(entries, [{
		timestamp: 2,
		breadcrumb: ["assistant"],
		tokens: 7,
		visibleTokens: 0,
		invisibleReasoning: { tokens: 7, basis: "provider-reported", encoded: true },
		text: "",
	}]);
});

test("collectPreviewEntries flattens aggregates chronologically", () => {
	const messages: ContextEvent["messages"] = [
		{
			role: "toolResult",
			toolCallId: "one",
			toolName: "read",
			content: [{ type: "text", text: "later read" }],
			isError: false,
			timestamp: 200,
		},
		{
			role: "toolResult",
			toolCallId: "two",
			toolName: "bash",
			content: [{ type: "text", text: "earlier bash" }],
			isError: false,
			timestamp: 100,
		},
	];
	const usage = computeUsage({ snapshot: snapshot(), messages });

	const flattened = collectPreviewEntries(category(usage.categories, "tool-output"));
	assert.deepEqual(flattened.map((entry) => entry.text), ["earlier bash", "later read"]);

	// Timeless snapshot entries keep category order instead of sorting.
	const builtInTools = collectPreviewEntries(category(usage.categories, "built-in-tools"));
	assert.deepEqual(builtInTools.map((entry) => [...entry.breadcrumb]), [["bash"], ["read"]]);
});

test("toReportedUsage preserves known values and maps unknown nullable values to undefined", () => {
	assert.deepEqual(toReportedUsage({ tokens: 42, contextWindow: 1_000, percent: 4.2 }), {
		tokens: 42,
		contextWindow: 1_000,
		percent: 4.2,
	});
	assert.deepEqual(toReportedUsage({ tokens: null, contextWindow: 1_000, percent: null }), {
		tokens: undefined,
		contextWindow: 1_000,
		percent: undefined,
	});
	assert.equal(toReportedUsage(undefined), undefined);
});
