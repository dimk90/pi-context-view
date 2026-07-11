import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import type { InitialSnapshot, InjectionItem, UsageCategory } from "../src/model.ts";
import { computeUsage, toReportedUsage } from "../src/usage.ts";

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
	assert.equal(category(usage.categories, "messages").tokens, 13);
	assert.equal(category(usage.categories, "user-messages").tokens, 2);
	assert.equal(category(usage.categories, "assistant-messages").tokens, 7);
	assert.equal(category(usage.categories, "tool-results").tokens, 2);
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

	assert.deepEqual(category(usage.categories, "tool-results").children, [
		{ id: "tool-result:read", label: "read", tokens: 3 },
	]);
	assert.deepEqual(category(usage.categories, "extension-messages").children, [
		{ id: "custom-message:marker", label: "marker", tokens: 3 },
	]);
	assert.equal(findCategory(usage.categories, "user-messages"), undefined);
	assert.ok(!usage.categories.some((entry) => entry.id === "compacted-data"));
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
