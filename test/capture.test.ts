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
	captureActiveTools,
	collectPromptSources,
	CompactionState,
	copyPromptOptions,
	InitialCaptureState,
	measureInjectedMessages,
	mergeContextOnlyMessages,
	parsePersistedIdentities,
	SilentProbeState,
} from "../src/capture.ts";
import { buildSnapshot, type InjectionItem } from "../src/model.ts";

/** Minimal custom-role message fixture. */
function customMessage(customType: string, content: string, timestamp: number): ContextEvent["messages"][number] {
	return { role: "custom", customType, content, display: false, timestamp };
}

/** Skill fixture with explicit model-visibility state. */
function skill(
	name: string,
	disableModelInvocation: boolean,
): NonNullable<BuildSystemPromptOptions["skills"]>[number] {
	return {
		name,
		description: `${name} description`,
		filePath: `/tmp/${name}/SKILL.md`,
		baseDir: `/tmp/${name}`,
		disableModelInvocation,
		sourceInfo: {
			path: `/tmp/${name}/SKILL.md`,
			source: "temporary",
			scope: "temporary",
			origin: "top-level",
		},
	};
}

/** ToolInfo fixture with the given provenance source and one guideline. */
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

/** Assistant fixture for probe stop-reason tests. */
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

test("copyPromptOptions owns decomposition metadata and keeps only visible skills", () => {
	const contextFile = { path: "./AGENTS.md", content: "rules" };
	const visibleSkill = skill("visible", false);
	const options: BuildSystemPromptOptions = {
		cwd: "/tmp",
		contextFiles: [contextFile],
		skills: [visibleSkill, skill("hidden", true)],
	};

	const copied = copyPromptOptions(options);
	contextFile.path = "./changed.md";
	visibleSkill.description = "changed";

	assert.deepEqual(copied.contextFilePaths, ["./AGENTS.md"]);
	assert.deepEqual(copied.skills, [
		{ name: "visible", description: "visible description", filePath: "/tmp/visible/SKILL.md" },
	]);
});

test("measureInjectedMessages attributes custom and context-only messages without session history", () => {
	const ordinaryUser = { role: "user", content: "ordinary", timestamp: 1 } satisfies ContextEvent["messages"][number];
	const sessionCustom = customMessage("marker", "session", 2);
	const contextCustom = customMessage("marker", "context only", 3);
	const injectedUser = { role: "user", content: "injected", timestamp: 4 } satisfies ContextEvent["messages"][number];
	const blockUser = {
		role: "user",
		content: [{ type: "text", text: "injected" }],
		timestamp: 5,
	} satisfies ContextEvent["messages"][number];
	const items = measureInjectedMessages(
		[ordinaryUser, sessionCustom, contextCustom, injectedUser, blockUser],
		[ordinaryUser, sessionCustom],
	);

	assert.deepEqual(
		items.map((entry) => entry.id),
		["message:marker:0", "message:marker:1", "message:context:user:0", "message:context:user:1"],
	);
	assert.equal(items[0]?.source.id, "message-type:marker");
	assert.equal(items[0]?.contextOnly, undefined);
	assert.equal(items[1]?.contextOnly, true);
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
		assert.equal(item.contextOnly, true);
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
		assert.equal(item.contextOnly, true);
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

test("mergeContextOnlyMessages carries only provider-context mutations into Usage snapshots", () => {
	const source = { id: "aggregate:extensions", label: "unattributed", native: false };
	const contextMessage = {
		id: "context-message",
		phase: "initial",
		kind: "message",
		source,
		label: "user message",
		chars: 8,
		tokens: 2,
		text: "injected",
		contextOnly: true,
	} satisfies InjectionItem;
	const sessionMessage = { ...contextMessage, id: "session-message", contextOnly: undefined };
	const current = buildSnapshot([], "synthetic-probe", new Date("2026-07-10T12:00:00Z"));
	const initial = buildSnapshot([contextMessage, sessionMessage], "real-turn", new Date());

	const merged = mergeContextOnlyMessages(current, initial);
	assert.deepEqual(merged.groups.flatMap((group) => group.items).map((entry) => entry.id), ["context-message"]);
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
		systemPrompt: "Base\n\nAvailable tools:\n- search: Original snippet\n",
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

test("CompactionState follows the current lifecycle signal", () => {
	const state = new CompactionState();
	const first = new AbortController();
	const second = new AbortController();

	state.begin(first.signal);
	assert.equal(state.isActive, true);
	state.begin(second.signal);
	first.abort();
	assert.equal(state.isActive, true, "an obsolete signal cannot clear the current compaction");
	second.abort();
	assert.equal(state.isActive, false);

	const completed = new AbortController();
	state.begin(completed.signal);
	state.finish();
	assert.equal(state.isActive, false);

	const alreadyAborted = new AbortController();
	alreadyAborted.abort();
	state.begin(alreadyAborted.signal);
	assert.equal(state.isActive, false);
});

test("SilentProbeState sanitizes and filters only exact probe identities", async () => {
	const state = new SilentProbeState();
	const attempt = state.start(1_000);
	const concurrentAttempt = state.start();
	assert.equal(concurrentAttempt.started, false);
	assert.strictEqual(concurrentAttempt.completion, attempt.completion);
	assert.strictEqual(concurrentAttempt.token, attempt.token);
	assert.equal(state.isProbeInput("extension", attempt.token), true);
	assert.equal(state.beginRun(attempt.token), true);

	const probeUser = { role: "user", content: [], timestamp: 10 } satisfies ContextEvent["messages"][number];
	const realUser = { role: "user", content: [], timestamp: 11 } satisfies ContextEvent["messages"][number];
	const probeAssistant = assistantMessage("aborted", 12);

	state.recordMessage(probeUser);
	state.recordMessage(probeAssistant);
	// An already empty prompt needs no replacement.
	assert.equal(state.sanitizeMessage(probeUser), undefined);
	const sanitized = state.sanitizeMessage(probeAssistant);
	assert.equal(sanitized?.role, "assistant");
	if (sanitized?.role === "assistant") {
		assert.equal(sanitized.stopReason, "stop");
		assert.deepEqual(sanitized.content, []);
	}
	assert.deepEqual(state.filterMessages([probeUser, realUser, probeAssistant]), [realUser]);
	assert.deepEqual(state.syntheticMessages, [
		{ role: "user", timestamp: 10 },
		{ role: "assistant", timestamp: 12 },
	]);

	assert.equal(state.settle(true), true);
	assert.deepEqual(await attempt.completion, { status: "captured" });
	assert.equal(state.start().started, false);
	assert.equal(state.sanitizeMessage(probeAssistant), undefined);
});

test("SilentProbeState claims its run by token when an input transform rewrites the prompt", () => {
	const state = new SilentProbeState();
	const attempt = state.start(1_000);

	// Another extension prepends instructions to the synthetic empty prompt.
	const transformed = "Additional instructions\n";
	assert.equal(state.isProbeInput("extension", attempt.token), true);
	assert.equal(state.beginRun(attempt.token), true, "rewritten text must not hide the probe run");

	const probePrompt = { role: "user", content: transformed, timestamp: 30 } satisfies ContextEvent["messages"][number];
	state.recordMessage(probePrompt);

	// Blanked for the transcript, filtered out of every later model context.
	assert.deepEqual(state.sanitizeMessage(probePrompt), { role: "user", content: [], timestamp: 30 });
	assert.deepEqual(state.filterMessages([probePrompt]), []);
	state.settle(true);
});

test("SilentProbeState leaves an unattributed run untouched and fails the attempt", async () => {
	const state = new SilentProbeState();
	const attempt = state.start(1_000);

	// A run without the token may belong to the user or to another extension.
	assert.equal(state.beginRun(undefined), false);
	assert.equal(state.isCurrentRun, false, "an unattributed run must not arm the abort guard");
	assert.deepEqual(await attempt.completion, {
		status: "failed",
		reason: "Another agent run started before the silent probe was recognized.",
	});

	// A delayed probe run is still claimed, so it is aborted and sanitized.
	assert.equal(state.beginRun(attempt.token), true);
	assert.equal(state.isCurrentRun, true);
	assert.equal(state.settle(false), true);
});

test("SilentProbeState recognizes probe input only for its own token and source", () => {
	const state = new SilentProbeState();
	assert.equal(state.isProbeInput("extension", "any-token"), false, "no attempt is pending");

	const attempt = state.start(1_000);
	assert.equal(state.isProbeInput("extension", undefined), false);
	assert.equal(state.isProbeInput("extension", `${attempt.token}-other`), false);
	assert.equal(state.isProbeInput("interactive", attempt.token), false);
	assert.equal(state.isProbeInput("rpc", attempt.token), false);

	assert.equal(state.beginRun(attempt.token), true);
	assert.equal(state.isProbeInput("extension", attempt.token), false, "the token is single-use");
	state.settle(true);
});

test("SilentProbeState sanitizes pi 0.84 setup abort errors only for a recorded probe assistant", () => {
	const state = new SilentProbeState();
	const attempt = state.start(1_000);
	assert.equal(state.beginRun(attempt.token), true);

	const setupAbort = assistantMessage("error", 20, "This operation was aborted");
	const providerError = assistantMessage("error", 21, "Authentication failed");
	const unrecordedSetupAbort = assistantMessage("error", 22, "This operation was aborted");
	const unrecordedLegacyAbort = assistantMessage("aborted", 23);
	state.recordMessage(setupAbort);
	state.recordMessage(providerError);

	const sanitized = state.sanitizeMessage(setupAbort);
	assert.equal(sanitized?.role, "assistant");
	if (sanitized?.role === "assistant") {
		assert.equal(sanitized.stopReason, "stop");
		assert.equal(sanitized.errorMessage, undefined);
		assert.deepEqual(sanitized.content, []);
	}
	assert.equal(state.sanitizeMessage(providerError), undefined);
	assert.equal(state.sanitizeMessage(unrecordedSetupAbort), undefined);
	assert.equal(state.sanitizeMessage(unrecordedLegacyAbort), undefined);
	state.settle(true);
});

test("SilentProbeState filters restored identities without consuming the probe attempt", () => {
	const previousRuntime = new SilentProbeState();
	const previousAttempt = previousRuntime.start(1_000);
	assert.equal(previousRuntime.beginRun(previousAttempt.token), true);
	const probeUser = { role: "user", content: [], timestamp: 10 } satisfies ContextEvent["messages"][number];
	previousRuntime.recordMessage(probeUser);
	previousRuntime.settle(true);

	const state = new SilentProbeState();
	state.restoreIdentities(previousRuntime.syntheticMessages);

	const emptyRealUser = { role: "user", content: [], timestamp: 11 } satisfies ContextEvent["messages"][number];
	assert.deepEqual(state.filterMessages([probeUser, emptyRealUser]), [emptyRealUser]);
	assert.deepEqual(state.syntheticMessages, [{ role: "user", timestamp: 10 }]);

	// Restoration must not consume this runtime's single probe attempt.
	assert.equal(state.isCurrentRun, false);
	const attempt = state.start(1_000);
	assert.equal(attempt.started, true);
	state.fail("cleanup");
});

test("parsePersistedIdentities accepts only exact role/timestamp records", () => {
	assert.deepEqual(
		parsePersistedIdentities({
			messages: [
				{ role: "user", timestamp: 10 },
				{ role: "assistant", timestamp: 12 },
				{ role: "custom", timestamp: 13 },
				{ role: "user", timestamp: "10" },
				{ role: "user" },
				"garbage",
				null,
			],
		}),
		[
			{ role: "user", timestamp: 10 },
			{ role: "assistant", timestamp: 12 },
		],
	);
	assert.deepEqual(parsePersistedIdentities(undefined), []);
	assert.deepEqual(parsePersistedIdentities(null), []);
	assert.deepEqual(parsePersistedIdentities({ messages: "not-an-array" }), []);
	assert.deepEqual(parsePersistedIdentities([]), []);
});

test("SilentProbeState keeps a timed-out running probe abortable until settlement", async () => {
	const state = new SilentProbeState();
	const attempt = state.start(1);
	assert.equal(state.beginRun(attempt.token), true);

	assert.deepEqual(await attempt.completion, { status: "failed", reason: "Silent probe timed out." });
	assert.equal(state.isCurrentRun, true);
	assert.equal(state.settle(false), true);
	assert.equal(state.isCurrentRun, false);
});

test("SilentProbeState retains a delayed synthetic turn after a pre-run timeout", async () => {
	const state = new SilentProbeState();
	const attempt = state.start(1);

	assert.deepEqual(await attempt.completion, { status: "failed", reason: "Silent probe timed out." });
	assert.equal(state.isCurrentRun, false);

	assert.equal(state.beginRun(undefined), false);
	assert.equal(state.isCurrentRun, false);
	assert.equal(state.beginRun(attempt.token), true);
	assert.equal(state.isCurrentRun, true);
	assert.equal(state.settle(false), true);
});
