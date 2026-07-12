import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

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
	const piItems = [
		item("base", "base-prompt", 10),
		item("builtins", "tool", 8, true, builtins),
		item("agents", "context-file", 6),
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
	const messages: ContextEvent["messages"] = [
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

	const usage = computeUsage({
		snapshot: snapshot(),
		messages,
		reported: { tokens: 100, contextWindow: 1_000, percent: 10 },
		modelLabel: "test-model",
		computedAt: new Date("2026-07-11T13:00:00Z"),
	});

	assert.equal(category(usage.categories, "system-prompt").tokens, 19);
	assert.deepEqual(category(usage.categories, "system-tools").children?.map((entry) => entry.id), [
		"item:bash",
		"item:read",
	]);
	assert.equal(category(usage.categories, "system-tools").tokens, 8);
	assert.equal(category(usage.categories, "custom-tools").tokens, 7);
	assert.equal(category(usage.categories, "mcp-tools").tokens, 5);
	assert.equal(category(usage.categories, "context-files").tokens, 6);
	assert.equal(category(usage.categories, "skills").tokens, 6);
	assert.equal(findCategory(usage.categories, "messages"), undefined);
	assert.equal(category(usage.categories, "user-messages").tokens, 2);
	assert.equal(category(usage.categories, "agent-text-messages").tokens, 1);
	assert.equal(category(usage.categories, "agent-thinking-messages").tokens, 2);
	assert.equal(category(usage.categories, "agent-tool-call-messages").tokens, 4);
	assert.equal(category(usage.categories, "tool-output").tokens, 4);
	assert.equal(category(usage.categories, "tool-result:read").tokens, 2);
	assert.equal(findCategory(usage.categories, "tool-results"), undefined);
	assert.equal(category(usage.categories, "extension-messages").tokens, 1);
	assert.equal(category(usage.categories, "bash-executions").tokens, 2);
	assert.equal(category(usage.categories, "compacted-data").tokens, 3);
	assert.equal(usage.estimatedTokens, usage.categories.reduce((sum, entry) => sum + entry.tokens, 0));
	assert.equal(usage.modelLabel, "test-model");
	assert.equal(usage.computedAt.toISOString(), "2026-07-11T13:00:00.000Z");
	assert.ok(!usage.categories.some((entry) => entry.tokens === 99));
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
	const textEntries = category(usage.categories, "agent-text-messages").entries ?? [];
	assert.deepEqual(textEntries.map((entry) => [...entry.breadcrumb]), [
		["assistant"],
		["assistant", "text 1/2"],
		["assistant", "text 2/2"],
	]);
	assert.equal(textEntries[1]?.text, "first block");

	// Tool calls: one entry per call with the tool name as a breadcrumb cell.
	const callEntries = category(usage.categories, "agent-tool-call-messages").entries ?? [];
	assert.deepEqual(callEntries.map((entry) => [entry.timestamp, [...entry.breadcrumb]]), [
		[2, ["assistant", "read"]],
		[20, ["assistant", "read"]],
		[20, ["assistant", "bash"]],
	]);
	assert.equal(callEntries[2]?.text, 'bash({"command":"ls"})');
	const callCategory = category(usage.categories, "agent-tool-call-messages");
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
	const systemTools = collectPreviewEntries(category(usage.categories, "system-tools"));
	assert.deepEqual(systemTools.map((entry) => [...entry.breadcrumb]), [["bash"], ["read"]]);
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
