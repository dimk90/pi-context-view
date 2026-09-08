import assert from "node:assert/strict";
import { test } from "node:test";

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
	state.observeInput("extension", "");
	assert.equal(state.beginRun(""), true);

	const probeUser = { role: "user", content: [], timestamp: 10 } satisfies ContextEvent["messages"][number];
	const realUser = { role: "user", content: [], timestamp: 11 } satisfies ContextEvent["messages"][number];
	const probeAssistant = assistantMessage("aborted", 12);

	state.recordMessage(probeUser);
	state.recordMessage(probeAssistant);
	const sanitized = state.sanitizeAssistant(probeAssistant);
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
	assert.equal(state.sanitizeAssistant(probeAssistant), undefined);
});

test("SilentProbeState sanitizes pi 0.84 setup abort errors only for a recorded probe assistant", () => {
	const state = new SilentProbeState();
	state.start(1_000);
	state.observeInput("extension", "");
	assert.equal(state.beginRun(""), true);

	const setupAbort = assistantMessage("error", 20, "This operation was aborted");
	const providerError = assistantMessage("error", 21, "Authentication failed");
	const unrecordedSetupAbort = assistantMessage("error", 22, "This operation was aborted");
	const unrecordedLegacyAbort = assistantMessage("aborted", 23);
	state.recordMessage(setupAbort);
	state.recordMessage(providerError);

	const sanitized = state.sanitizeAssistant(setupAbort);
	assert.equal(sanitized?.role, "assistant");
	if (sanitized?.role === "assistant") {
		assert.equal(sanitized.stopReason, "stop");
		assert.equal(sanitized.errorMessage, undefined);
		assert.deepEqual(sanitized.content, []);
	}
	assert.equal(state.sanitizeAssistant(providerError), undefined);
	assert.equal(state.sanitizeAssistant(unrecordedSetupAbort), undefined);
	assert.equal(state.sanitizeAssistant(unrecordedLegacyAbort), undefined);
	state.settle(true);
});

test("SilentProbeState filters restored identities without consuming the probe attempt", () => {
	const previousRuntime = new SilentProbeState();
	previousRuntime.start(1_000);
	previousRuntime.observeInput("extension", "");
	assert.equal(previousRuntime.beginRun(""), true);
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
	state.observeInput("extension", "");
	assert.equal(state.beginRun(""), true);

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

	state.observeInput("extension", "");
	assert.equal(state.beginRun("real prompt"), false);
	assert.equal(state.isCurrentRun, false);
	assert.equal(state.beginRun(""), true);
	assert.equal(state.isCurrentRun, true);
	assert.equal(state.settle(false), true);
});
