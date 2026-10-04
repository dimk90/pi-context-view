import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateTokens } from "@earendil-works/pi-coding-agent";

import type {
	BuildSystemPromptOptions,
	ContextEvent,
	SlashCommandInfo,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";

import {
	collectPromptSources,
	InitialCaptureState,
	measureInjectedMessages,
	mergeRequestOnlyMessages,
} from "../src/capture.ts";
import { captureActiveTools, copyPromptOptions } from "../src/replay.ts";
import { buildSnapshot, type InjectionItem } from "../src/model.ts";

/** Minimal custom-role message fixture. */
function customMessage(customType: string, content: string, timestamp: number): ContextEvent["messages"][number] {
	return { role: "custom", customType, content, display: false, timestamp };
}

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

/** Assistant fixture with the given stop reason. */
function assistantMessage(
	stopReason: "aborted" | "error",
	timestamp: number,
	errorMessage?: string,
): Extract<ContextEvent["messages"][number], { role: "assistant" }> {
	return {
		role: "assistant",
		content: [],
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
		stopReason,
		errorMessage,
		timestamp,
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

test("collectPromptSources rosters the names of extension tools and commands", () => {
	const command = (name: string, source: string): SlashCommandInfo => ({
		name,
		source: "extension",
		sourceInfo: { path: `/tmp/${name}.ts`, source, scope: "temporary", origin: "top-level" },
	});
	const sources = collectPromptSources(
		[tool("read", "builtin"), tool("search", "npm:web"), tool("fetch", "npm:web")],
		[command("ask", "npm:ask"), command("/web", "npm:web")],
	);

	// One roster entry per extension file, and commands keep the slash prompts use.
	assert.deepEqual(sources.map((source) => [source.source, source.names]), [
		["npm:web", ["search"]],
		["npm:web", ["fetch"]],
		["npm:ask", ["/ask"]],
		["npm:web", ["/web"]],
	]);
});

test("copyPromptOptions owns the custom prompt and section overrides", () => {
	const sections = { review: "Original rule" };
	const options: BuildSystemPromptOptions = { cwd: "/tmp", customPrompt: "CUSTOM", sections };

	const copied = copyPromptOptions(options);
	sections.review = "Changed rule";

	assert.equal(copied.customPrompt, "CUSTOM");
	assert.deepEqual(copied.sections, { review: "Original rule" });
});

test("measureInjectedMessages attributes custom and request-only messages without session history", () => {
	const ordinaryUser = { role: "user", content: "ordinary", timestamp: 1 } satisfies ContextEvent["messages"][number];
	const sessionCustom = customMessage("marker", "session", 2);
	const requestCustom = customMessage("marker", "request only", 3);
	const injectedUser = { role: "user", content: "injected", timestamp: 4 } satisfies ContextEvent["messages"][number];
	const blockUser = {
		role: "user",
		content: [{ type: "text", text: "injected" }],
		timestamp: 5,
	} satisfies ContextEvent["messages"][number];
	const items = measureInjectedMessages(
		[ordinaryUser, sessionCustom, requestCustom, injectedUser, blockUser],
		[ordinaryUser, sessionCustom],
	);

	assert.deepEqual(
		items.map((entry) => entry.id),
		["message:marker:0", "message:marker:1", "message:context:user:0", "message:context:user:1"],
	);
	assert.equal(items[0]?.source.id, "message-type:marker");
	assert.equal(items[0]?.requestOnly, undefined);
	assert.equal(items[1]?.requestOnly, true);
	assert.equal(items[2]?.source.id, "aggregate:extensions");
	assert.equal(items[2]?.text, "injected");
	// String content is text; serialized block content is marked JSON for full-content previews.
	assert.equal(items[2]?.jsonSpan, undefined);
	assert.equal(items[3]?.text, '[{"type":"text","text":"injected"}]');
	assert.deepEqual(items[3]?.jsonSpan, { start: 0, end: items[3]?.text.length });
});

test("Initial capture omits opaque signatures from injected and transformed assistant previews", () => {
	const message = {
		...assistantMessage("aborted", 8),
		content: [
			{ type: "text", text: "visible answer", textSignature: "OPAQUE_TEXT_SENTINEL" },
			{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "OPAQUE_THINKING_SENTINEL" },
			{
				type: "toolCall", id: "call-1", name: "read",
				arguments: {
					path: "example.txt",
					textSignature: "text argument data",
					thinkingSignature: "argument data",
					thoughtSignature: "more argument data",
				},
				thoughtSignature: "OPAQUE_THOUGHT_SENTINEL",
			},
		],
	} satisfies Extract<ContextEvent["messages"][number], { role: "assistant" }>;
	const original = structuredClone(message);
	const expectedTokens = estimateTokens(message);
	const baselines: ContextEvent["messages"][] = [
		[],
		[{ ...message, content: [{ type: "text", text: "before context transformation" }] }],
	];
	for (const baselineMessages of baselines) {
		const originalBaseline = structuredClone(baselineMessages);
		const capture = new InitialCaptureState();
		capture.prepare({ cwd: "/tmp", customPrompt: "system" });
		const snapshot = capture.finalize(() => ({
			systemPrompt: "system", messages: [message], baselineMessages,
			allTools: [], activeToolNames: [], origin: "real-turn",
		}));
		assert.ok(snapshot);
		const item = snapshot.groups.flatMap((group) => group.items).find((item) => item.kind === "message");
		assert.ok(item);
		assert.equal(item.requestOnly, true);
		assert.equal(item.tokens, expectedTokens);
		assert.equal(item.chars, item.text.length);
		assert.deepEqual(item.jsonSpan, { start: 0, end: item.text.length });
		assert.deepEqual(JSON.parse(item.text), [
			{ type: "text", text: "visible answer" },
			{ type: "thinking", thinking: "visible reasoning" },
			{
				type: "toolCall", id: "call-1", name: "read",
				arguments: {
					path: "example.txt",
					textSignature: "text argument data",
					thinkingSignature: "argument data",
					thoughtSignature: "more argument data",
				},
			},
		]);
		assert.doesNotMatch(JSON.stringify(snapshot), /OPAQUE_(TEXT|THINKING|THOUGHT)_SENTINEL/);
		assert.deepEqual(message, original);
		assert.deepEqual(baselineMessages, originalBaseline);
	}
	// Preview-only redaction does not change structural baseline matching.
	assert.deepEqual(measureInjectedMessages([message], [original]), []);
});

test("Initial capture reports injected image sizes instead of retaining their payloads", () => {
	const payload = "B".repeat(2_048);
	const imageUser = {
		role: "user",
		content: [
			{ type: "text", text: "look at this" },
			{ type: "image", data: payload, mimeType: "image/png" },
		],
		timestamp: 1,
	} satisfies ContextEvent["messages"][number];
	const imageToolResult = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "screenshot",
		content: [{ type: "image", data: "tiny", mimeType: "image/jpeg" }],
		isError: false,
		timestamp: 2,
	} satisfies ContextEvent["messages"][number];
	const original = structuredClone([imageUser, imageToolResult]);

	const items = measureInjectedMessages([imageUser, imageToolResult], []);

	assert.deepEqual(JSON.parse(items[0]?.text ?? ""), [
		{ type: "text", text: "look at this" },
		{ type: "image", data: "<2.0KB omitted>", mimeType: "image/png" },
	]);
	assert.deepEqual(JSON.parse(items[1]?.text ?? ""), [
		{ type: "image", data: "<4B omitted>", mimeType: "image/jpeg" },
	]);
	// Estimates keep using pi's own image proxy, which the omitted text must not change.
	assert.equal(items[0]?.tokens, estimateTokens(imageUser));
	assert.equal(items[0]?.chars, items[0]?.text.length);
	assert.deepEqual([imageUser, imageToolResult], original);
});

test("captured summary previews omit envelope metadata without changing the content", () => {
	const messages = [
		{
			role: "compactionSummary", summary: "We fixed image previews.\nNext: update the tests.",
			tokensBefore: 42_000, timestamp: 1_700_000_000_000,
		},
		{
			role: "branchSummary", summary: '{"fromId":"actual summary content"}',
			fromId: "INTERNAL_BRANCH_ID", timestamp: 1_700_000_000_001,
		},
	] satisfies ContextEvent["messages"];
	const original = structuredClone(messages);
	const items = measureInjectedMessages(messages, []);

	assert.deepEqual(items.map((item) => item.text), messages.map((message) => message.summary));
	for (const [index, item] of items.entries()) {
		assert.equal(item.jsonSpan, undefined);
		assert.equal(item.chars, item.text.length);
		assert.equal(item.tokens, estimateTokens(messages[index]));
		assert.equal(item.requestOnly, true);
	}
	assert.deepEqual(messages, original);
	assert.deepEqual(measureInjectedMessages(messages, original), []);
});

test("captured bash previews use provider-facing text instead of message metadata", () => {
	const base = {
		role: "bashExecution", command: "ls", output: "example.txt", exitCode: 0,
		cancelled: false, truncated: false, fullOutputPath: "/tmp/full-output.txt", timestamp: 1,
	} satisfies ContextEvent["messages"][number];
	const messages = [
		base,
		{ ...base, output: "", timestamp: 2 },
		{ ...base, output: "failed", exitCode: 2, timestamp: 3 },
		{ ...base, output: "partial", exitCode: undefined, cancelled: true, timestamp: 4 },
		{ ...base, truncated: true, timestamp: 5 },
		{ ...base, excludeFromContext: true, timestamp: 6 },
	];
	const original = structuredClone(messages);
	const items = measureInjectedMessages(messages, []);

	assert.deepEqual(items.map((item) => item.text), [
		"Ran `ls`\n```\nexample.txt\n```",
		"Ran `ls`\n(no output)",
		"Ran `ls`\n```\nfailed\n```\n\nCommand exited with code 2",
		"Ran `ls`\n```\npartial\n```\n\n(command cancelled)",
		"Ran `ls`\n```\nexample.txt\n```\n\n[Output truncated. Full output: /tmp/full-output.txt]",
		"",
	]);
	for (const [index, item] of items.entries()) {
		assert.equal(item.jsonSpan, undefined);
		assert.equal(item.chars, item.text.length);
		assert.equal(item.tokens, estimateTokens(messages[index]));
	}
	assert.deepEqual(messages, original);
	assert.deepEqual(measureInjectedMessages(messages, original), []);
});

test("mergeRequestOnlyMessages carries only request-only mutations into Usage snapshots", () => {
	const source = { id: "aggregate:extensions", label: "unattributed", native: false };
	const requestMessage = {
		id: "request-message",
		phase: "initial",
		kind: "message",
		source,
		label: "user message",
		chars: 8,
		tokens: 2,
		text: "injected",
		requestOnly: true,
	} satisfies InjectionItem;
	const sessionMessage = { ...requestMessage, id: "session-message", requestOnly: undefined };
	const current = buildSnapshot([], "synthetic-probe", new Date("2026-07-10T12:00:00Z"));
	const initial = buildSnapshot([requestMessage, sessionMessage], "real-turn", new Date());

	const merged = mergeRequestOnlyMessages(current, initial);
	assert.deepEqual(merged.groups.flatMap((group) => group.items).map((entry) => entry.id), ["request-message"]);
	assert.equal(merged.capturedAt.toISOString(), "2026-07-10T12:00:00.000Z");
});

test("InitialCaptureState owns prepared options before later handlers can mutate them", () => {
	const state = new InitialCaptureState();
	const options: BuildSystemPromptOptions = {
		cwd: "/tmp",
		toolSnippets: { search: "Original snippet" },
	};
	state.prepare(options);
	if (options.toolSnippets !== undefined) options.toolSnippets.search = "Changed snippet";

	const snapshot = state.finalize(() => ({
		systemPrompt: "Base\n\n<tools>\n- search: Original snippet\n</tools>\n\n<cwd>\n/tmp\n</cwd>",
		messages: [],
		baselineMessages: [],
		allTools: [tool("search", "npm:web")],
		activeToolNames: ["search"],
		origin: "real-turn",
	}));

	assert.ok(snapshot !== undefined);
	const search = snapshot.groups.flatMap((group) => group.items).find((entry) => entry.label === "search");
	assert.match(search?.text ?? "", /Original snippet/);
});

test("InitialCaptureState refreshes pending options and freezes the first snapshot", () => {
	const state = new InitialCaptureState();
	const firstOptions: BuildSystemPromptOptions = { cwd: "/tmp" };
	const finalOptions: BuildSystemPromptOptions = { cwd: "/tmp", customPrompt: "CUSTOM" };
	const message = customMessage("marker", "captured", 1);
	const capturedAt = new Date("2026-07-10T12:00:00Z");

	state.prepare(firstOptions);
	state.prepare(finalOptions);
	const first = state.finalize(() => ({
		systemPrompt: "CUSTOM",
		messages: [message],
		baselineMessages: [message],
		allTools: [],
		activeToolNames: [],
		origin: "real-turn",
		capturedAt,
	}));
	assert.ok(first !== undefined);
	assert.equal(first.groups[0]?.items[0]?.label, "System Prompt");
	assert.equal(first.groups[1]?.items[0]?.text, "captured");

	if (message.role === "custom") message.content = "changed";
	capturedAt.setFullYear(2000);
	state.prepare({ cwd: "/different" });
	const second = state.finalize(() => ({
		systemPrompt: "DIFFERENT",
		messages: [],
		baselineMessages: [],
		allTools: [],
		activeToolNames: [],
		origin: "synthetic-probe",
	}));

	assert.strictEqual(second, first);
	assert.equal(second.groups[1]?.items[0]?.text, "captured");
	assert.equal(second.capturedAt.toISOString(), "2026-07-10T12:00:00.000Z");
});

test("InitialCaptureState does not finalize before prepare", () => {
	const state = new InitialCaptureState();
	assert.equal(
		state.finalize(() => ({
			systemPrompt: "prompt",
			messages: [],
			baselineMessages: [],
			allTools: [],
			activeToolNames: [],
			origin: "real-turn",
		})),
		undefined,
	);
});
