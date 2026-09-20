import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildSessionContext,
	type ContextEvent,
	SessionManager,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import { buildUsageSnapshot, InitialCaptureState, measureInjectedMessages } from "../src/capture.ts";
import { buildSnapshot } from "../src/model.ts";
import { replaySystemMessages, type SystemMessage, systemMessageText } from "../src/transcript.ts";
import { collectPreviewEntries, computeUsage } from "../src/usage.ts";

const FIRST_TOOL = { name: "read", description: "Old read definition", parameters: { type: "object" } };
const SECOND_TOOL = { name: "search", description: "Recorded search definition", parameters: { type: "object" } };
const INITIAL: SystemMessage = {
	role: "system", content: "", timestamp: 1,
	sections: { preamble: "Recorded preamble", rules: "<rules>\nOld rules\n</rules>", cwd: "<cwd>\n/recorded\n</cwd>" },
	toolsAdded: [FIRST_TOOL],
};
const PATCH: SystemMessage = {
	role: "system", content: "Additional system text", timestamp: 2,
	sections: { rules: "<rules>\nNew rules\n</rules>", review: "<review>\nReview instructions\n</review>" },
	toolsAdded: [SECOND_TOOL], toolsRemoved: [{ name: "read" }],
};
const CURRENT_TOOL: ToolInfo = {
	...SECOND_TOOL, description: "CURRENT definition must not replace the recorded one",
	parameters: {} as ToolInfo["parameters"],
	sourceInfo: { source: "npm:search", path: "/search.ts", scope: "temporary", origin: "top-level" },
};

/** Build Usage through the same prompt/tool replay path the command uses. */
function usageFor(messages: Parameters<typeof buildUsageSnapshot>[0]["messages"], patches: SystemMessage[] = []) {
	const snapshot = buildUsageSnapshot({
		systemPrompt: "LIVE PROMPT MUST NOT REPLACE TRANSCRIPT", options: { cwd: "/current" },
		allTools: [CURRENT_TOOL], activeToolNames: ["search"], messages,
		initial: buildSnapshot(measureInjectedMessages(patches, []), "real-turn", new Date(0)),
	});
	return computeUsage({ snapshot, messages });
}

/** Flatten every preview without logging or persisting captured text. */
function previewText(usage: ReturnType<typeof usageFor>): string {
	return usage.categories.flatMap(collectPreviewEntries).map((entry) => entry.text).join("\n");
}

/** Record synthetic warming charges through pi's real session API, without a provider call or disk writes. */
function appendCacheWarm(session: SessionManager) {
	return session.appendUsage("cache_warm", "anthropic", "warming-model", {
		input: 1_000, output: 0, cacheRead: 50_000, cacheWrite: 10_000, totalTokens: 61_000,
		cost: { input: 0.003, output: 0, cacheRead: 0.015, cacheWrite: 0.0375, total: 0.0555 },
	}, "CACHE_WARM_NOTE_MUST_NOT_APPEAR");
}

test("system replay appends content, patches sections, and applies tool removals before additions", () => {
	const replacement = { ...SECOND_TOOL, description: "Replacement definition" };
	const final: SystemMessage = {
		role: "system", content: [{ type: "text", text: "Final text", textSignature: "OPAQUE" }], timestamp: 3,
		sections: { rules: null, cwd: "<cwd>\n/changed\n</cwd>" },
		toolsRemoved: [{ name: "search" }], toolsAdded: [replacement],
	};
	const messages = [INITIAL, PATCH, final];
	const original = structuredClone(messages);
	const state = replaySystemMessages(messages);
	assert.ok(state);
	assert.deepEqual(Object.keys(state.sections), ["preamble", "cwd", "review"]);
	assert.deepEqual(state.tools, [replacement]);
	assert.equal(state.content, "Additional system text\n\nFinal text");
	assert.doesNotMatch(systemMessageText(state), /Old rules|New rules|OPAQUE/);
	assert.deepEqual(messages, original);
	assert.equal(replaySystemMessages([]), undefined);
	assert.deepEqual(replaySystemMessages([{ role: "system", content: "", timestamp: 1 }]),
		{ content: "", sections: {}, tools: [] });
});

test("Usage counts replayed sections and declarations once instead of live state or patch history", () => {
	const messages = [INITIAL, PATCH];
	const usage = usageFor(messages);
	const text = previewText(usage);
	assert.match(text, /Recorded preamble/);
	assert.match(text, /Additional system text/);
	assert.match(text, /New rules/);
	assert.match(text, /Review instructions/);
	assert.match(text, /Recorded search definition/);
	assert.doesNotMatch(text, /Old rules|Old read definition|LIVE PROMPT|CURRENT definition/);
	assert.equal(text.split("New rules").length - 1, 1);
	assert.equal(text.split("Recorded search definition").length - 1, 1);
	assert.equal(usage.categories.some((category) => category.id === "extensions"), false);
	assert.equal(usage.categories.some((category) => category.id === "built-in-tools"), false);
	assert.equal(usage.categories.find((category) => category.id === "custom-tools")?.children?.[0]?.label, "search");
	// Collapsing the same state has exactly the same semantic estimate, not another patch charge.
	const state = replaySystemMessages(messages);
	assert.ok(state);
	assert.equal(usage.estimatedTokens, usageFor([
		{ role: "system", content: state.content, sections: state.sections, toolsAdded: state.tools, timestamp: 1 },
	]).estimatedTokens);
});

test("Usage distinguishes legacy fallback from explicit removal of all prompt content and tools", () => {
	assert.match(previewText(usageFor([])), /LIVE PROMPT/);
	const removed: SystemMessage = {
		role: "system", content: "", timestamp: 3,
		sections: { preamble: null, rules: null, cwd: null }, toolsRemoved: [{ name: "read" }],
	};
	const usage = usageFor([INITIAL, removed]);
	assert.equal(usage.estimatedTokens, 0);
	assert.deepEqual(usage.categories, []);
});

test("tool declarations survive without a currently registered implementation", () => {
	const usage = usageFor([INITIAL]);
	assert.match(previewText(usage), /Old read definition/);
	assert.equal(usage.categories.find((category) => category.id === "custom-tools")?.children?.[0]?.label, "read");
});

test("Usage follows restored branches and compaction checkpoints without old system-message duplicates", () => {
	const session = SessionManager.inMemory("/fixture");
	const root = session.appendMessage(INITIAL);
	const user = session.appendMessage({ role: "user", content: "Retained user text", timestamp: 4 });
	const updated = session.appendMessage(PATCH);
	const beforeCompaction = usageFor(session.buildSessionContext().messages);
	assert.match(previewText(beforeCompaction), /New rules/);

	const header = session.getHeader();
	assert.ok(header);
	const restored = SessionManager.inMemory("/fixture", undefined, [header, ...session.getEntries()]);
	assert.equal(usageFor(restored.buildSessionContext().messages).estimatedTokens, beforeCompaction.estimatedTokens);
	assert.equal(usageFor(buildSessionContext(restored.getEntries(), root).messages).estimatedTokens,
		usageFor([INITIAL]).estimatedTokens);

	restored.branch(root);
	assert.doesNotMatch(previewText(usageFor(restored.buildSessionContext().messages)), /New rules|search definition/);
	restored.appendMessage({
		role: "system", content: "", sections: { rules: "<rules>\nBranch rules\n</rules>" }, timestamp: 5,
	});
	assert.match(previewText(usageFor(restored.buildSessionContext().messages)), /Branch rules/);
	restored.branch(updated);
	restored.appendCompaction("Synthetic compacted summary", user, 10_000);
	const compacted = restored.buildSessionContext().messages;
	assert.equal(compacted.filter((message) => message.role === "system").length, 1);
	const compactedUsage = usageFor(compacted);
	for (const id of ["system-prompt", "custom-tools"]) {
		assert.equal(compactedUsage.categories.find((category) => category.id === id)?.tokens,
			beforeCompaction.categories.find((category) => category.id === id)?.tokens);
	}
	assert.match(previewText(compactedUsage), /Synthetic compacted summary/);
	assert.doesNotMatch(previewText(compactedUsage), /Old rules|Branch rules/);
});

for (const transcriptBacked of [false, true]) {
	test(`cache warming does not change ${transcriptBacked ? "transcript-backed" : "legacy"} Usage totals or previews`, () => {
		const session = SessionManager.inMemory("/fixture");
		const messages = [
			...(transcriptBacked ? [INITIAL, PATCH] : []),
			{ role: "user", content: "Real user text", timestamp: 10 },
			{ role: "custom", customType: "marker", content: "Real injected text", display: false, timestamp: 11 },
		] satisfies ContextEvent["messages"];
		const expected = usageFor(messages);
		const firstWarm = appendCacheWarm(session);
		for (const message of messages) {
			session.appendMessage(message);
			appendCacheWarm(session);
		}

		// Entry-based rendering still sees billed work, including the final leaf; model context must not.
		const entries = session.getEntries();
		assert.equal(entries.filter((entry) => entry.type === "usage").length, messages.length + 1);
		assert.equal(session.getLeafEntry()?.type, "usage");
		assert.ok(session.buildContextEntries().some((entry) => entry.type === "usage"));
		const context = buildSessionContext(entries, session.getLeafId()).messages;
		assert.deepEqual(context, messages);
		const usage = usageFor(context);
		assert.ok(usage.estimatedTokens > 0);
		assert.equal(usage.estimatedTokens, expected.estimatedTokens);
		assert.deepEqual(usage.categories, expected.categories);
		assert.deepEqual(usage.categories.flatMap(collectPreviewEntries), expected.categories.flatMap(collectPreviewEntries));
		assert.match(previewText(usage), /Real user text/);
		assert.match(previewText(usage), /Real injected text/);
		assert.doesNotMatch(previewText(usage), /cache_warm|warming-model|CACHE_WARM_NOTE/);

		// Restore the entry tree as on resume, then navigate to the warming-only branch prefix.
		const header = session.getHeader();
		assert.ok(header);
		const restored = SessionManager.inMemory("/fixture", undefined, [header, ...entries]);
		const resumed = buildSessionContext(restored.getEntries(), restored.getLeafId()).messages;
		assert.deepEqual(resumed, messages);
		assert.deepEqual(usageFor(resumed).categories, expected.categories);
		restored.branch(firstWarm.id);
		assert.deepEqual(buildSessionContext(restored.getEntries(), restored.getLeafId()).messages, []);
	});
}

test("warming-only sessions add no message categories or previews to Usage", () => {
	const session = SessionManager.inMemory("/fixture");
	appendCacheWarm(session);
	appendCacheWarm(session);
	const messages = buildSessionContext(session.getEntries(), session.getLeafId()).messages;
	assert.deepEqual(messages, []);
	const usage = usageFor(messages);
	const expected = usageFor([]);
	assert.equal(usage.estimatedTokens, expected.estimatedTokens);
	assert.deepEqual(usage.categories, expected.categories);
	assert.deepEqual(usage.categories.flatMap(collectPreviewEntries), expected.categories.flatMap(collectPreviewEntries));
	assert.doesNotMatch(previewText(usage), /cache_warm|warming-model|CACHE_WARM_NOTE/);
});

test("captured system previews include section content and omit opaque text signatures", () => {
	const message: SystemMessage = {
		role: "system", content: [{ type: "text", text: "", textSignature: "OPAQUE_SYSTEM_SIGNATURE" }],
		sections: { review: "<review>\nSection-only instructions\n</review>", rules: null }, timestamp: 1,
	};
	const original = structuredClone(message);
	const items = measureInjectedMessages([message], []);
	assert.equal(items[0].text, "<review>\nSection-only instructions\n</review>");
	assert.ok(items[0].tokens > 0);
	assert.equal(items[0].jsonSpan, undefined);
	assert.doesNotMatch(JSON.stringify(items), /OPAQUE_SYSTEM_SIGNATURE/);
	assert.deepEqual(message, original);
	assert.deepEqual(measureInjectedMessages([message], [original]), []);
});

test("frozen request-only system patches replay in request order and do not count as Extensions", () => {
	const first: SystemMessage = { role: "system", content: "", timestamp: 1,
		sections: { rules: "<rules>\n" + "Long earlier rule ".repeat(50) + "\n</rules>" } };
	const last: SystemMessage = { role: "system", content: "", timestamp: 1,
		sections: { rules: "<rules>\nFinal short rule\n</rules>" },
		toolsAdded: [SECOND_TOOL], toolsRemoved: [{ name: "read" }] };
	const usage = usageFor([INITIAL], [first, last]);
	assert.match(previewText(usage), /Final short rule/);
	assert.doesNotMatch(previewText(usage), /Long earlier rule|Old rules/);
	assert.equal(usage.categories.some((category) => category.id === "extensions"), false);
	assert.equal(usage.estimatedTokens, usageFor([INITIAL, last]).estimatedTokens);
});

test("Initial keeps the effective prompt while owning request-only system patch replay inputs", () => {
	const state = new InitialCaptureState();
	state.prepare({ cwd: "/fixture" });
	const patch = structuredClone(PATCH);
	const snapshot = state.finalize(() => ({
		systemPrompt: "EFFECTIVE PROMPT", messages: [INITIAL, patch], baselineMessages: [INITIAL],
		allTools: [], activeToolNames: [], origin: "real-turn",
	}));
	assert.ok(snapshot);
	assert.equal(snapshot.groups[0]?.items[0]?.text, "EFFECTIVE PROMPT");
	const item = snapshot.groups.flatMap((group) => group.items).find((item) => item.systemMessage !== undefined);
	assert.ok(item);
	patch.sections = {};
	patch.toolsAdded = [];
	assert.deepEqual(item.systemMessage?.message.sections, PATCH.sections);
	assert.deepEqual(item.systemMessage?.message.toolsAdded, PATCH.toolsAdded);
});
