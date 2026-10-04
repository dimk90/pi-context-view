/**
 * Forced prompts on request snapshots: Injections measures the forced text the
 * request carried; Usage measures it while the recorded system state is
 * unchanged since capture, and reads the recorded structured state otherwise.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type BuildSystemPromptOptions, SessionManager, type ToolInfo } from "@earendil-works/pi-coding-agent";

// Deep import bypasses the package barrel, which does not re-export buildSystemPrompt.
import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { buildInjectionsSnapshot } from "../src/injections.ts";
import type { InjectionItem, UsagePreviewEntry } from "../src/model.ts";
import { applyRequestSnapshot } from "../src/projection.ts";
import { buildUsageSnapshot } from "../src/replay.ts";
import type { RequestSnapshot, SystemChange } from "../src/snapshot.ts";
import { collectPreviewEntries, computeUsage } from "../src/usage.ts";
import { FORCED_SYSTEM_PROMPT } from "./fixtures/forced-prompt.ts";

const CWD = "/fixture";
const SEARCH: ToolInfo = {
	name: "search",
	description: "Search",
	parameters: { type: "object" } as unknown as ToolInfo["parameters"],
	promptGuidelines: ["Cite sources"],
	exposure: "direct",
	sourceInfo: { path: "/search.ts", source: "npm:web", scope: "temporary", origin: "top-level" },
};

/** Structured options Pi keeps recording even when a handler forces the prompt. */
const OPTIONS: BuildSystemPromptOptions = {
	cwd: CWD,
	appendSystemPrompt: "APPENDED TEXT",
	selectedTools: ["search"],
	toolSnippets: { search: "Search the web" },
	promptGuidelines: ["Cite sources"],
};

/** A session whose recorded system state is the structured prompt and the search declaration. */
function createSession(): SessionManager {
	const session = SessionManager.inMemory(CWD);
	session.appendMessage({
		role: "system", content: "", timestamp: 1,
		sections: { preamble: "Recorded preamble", cwd: `<cwd>\n${CWD}\n</cwd>` },
		toolsAdded: [{ name: "search", description: "Recorded search definition", parameters: { type: "object" } }],
	});
	return session;
}

/** A request snapshot at the session's leaf whose run forced `forcedPrompt`. */
function forcedSnapshot(session: SessionManager, forcedPrompt: string, system: SystemChange[] = []): RequestSnapshot {
	return {
		id: 1, origin: "real-turn", capturedAt: 0, leafId: session.getLeafId(),
		changes: { conversation: [], system },
		forcedPrompt,
		guard: { status: "incomplete", reason: "No payload." },
	};
}

/** Injections items of a forced request, keyed by id. */
function injectionItems(forcedPrompt: string): InjectionItem[] {
	const session = createSession();
	const snapshot = buildInjectionsSnapshot({
		snapshot: forcedSnapshot(session, forcedPrompt),
		entries: session.getEntries(),
		filterMessages: (messages) => messages,
		options: { cwd: CWD },
		allTools: [SEARCH],
		systemPrompt: "live prompt",
		activeToolNames: ["search"],
	});
	return snapshot.groups.flatMap((group) => group.items);
}

test("Injections measures a forced prompt instead of the recorded sections", () => {
	const items = injectionItems(FORCED_SYSTEM_PROMPT);
	const base = items.find((item) => item.id === "base-prompt");
	assert.equal(base?.text, FORCED_SYSTEM_PROMPT);
	assert.equal(base?.change, "forced");
	assert.deepEqual(items.filter((item) => item.change !== undefined).map((item) => item.id), ["base-prompt"]);
	// Sections Pi recorded but did not send must be neither counted nor attributed.
	assert.doesNotMatch(items.map((item) => item.text).join("\n"), /Recorded preamble/);
	assert.equal(items.some((item) => item.kind === "prompt-addition"), false);
	// Tool declarations still reach the provider, whatever the forced text says.
	assert.equal(items.find((item) => item.kind === "tool")?.id, "tool:npm:web:search");
});

test("a forced prompt extending Pi's sections keeps the section parts and its addition", () => {
	const items = injectionItems(`${buildSystemPrompt(OPTIONS)}\n\nEXTRA INSTRUCTION`);
	const base = items.find((item) => item.id === "base-prompt");
	// Only the whole prompt is forced; its parts carry no marker of their own
	assert.equal(base?.change, "forced");
	assert.equal(base?.children?.some((child) => child.change !== undefined), false);
	assert.deepEqual(
		base?.children?.map((child) => child.label),
		["Preamble", "Available Tools", "Guidelines", "Documentation", "Appended Prompt", "Current Dir",
			"Extension Additions"],
	);
	assert.equal(items.find((item) => item.kind === "prompt-addition")?.text.trim(), "EXTRA INSTRUCTION");
});

/** Preview entries of every Usage category, keyed by category id, with `snapshot` applied to the session. */
function usageEntries(session: SessionManager, snapshot: RequestSnapshot): Map<string, UsagePreviewEntry[]> {
	const { messages, systemChanges, forcedPrompt } = applyRequestSnapshot({
		snapshot,
		entries: session.getEntries(),
		leafId: session.getLeafId(),
		filterMessages: (projected) => projected,
	});
	const usageSnapshot = buildUsageSnapshot({
		// An idle read returns Pi's base prompt, never the forced text of the last run.
		systemPrompt: buildSystemPrompt({ cwd: "/current" }),
		options: { cwd: "/current" },
		allTools: [SEARCH],
		activeToolNames: ["search"],
		messages,
		systemChanges,
		forcedPrompt,
	});
	const usage = computeUsage({ snapshot: usageSnapshot, messages });
	return new Map(usage.categories.map((category) => [category.id, collectPreviewEntries(category)]));
}

/** Preview text of every Usage category, keyed by category id, with `snapshot` applied to the session. */
function usagePreviews(session: SessionManager, snapshot: RequestSnapshot): Map<string, string> {
	return new Map([...usageEntries(session, snapshot)].map(([id, entries]) =>
		[id, entries.map((entry) => entry.text).join("\n")]));
}

/** Request-only changes Usage carries on its System Prompt entries. */
function systemPromptChanges(session: SessionManager, snapshot: RequestSnapshot): unknown[] {
	return (usageEntries(session, snapshot).get("system-prompt") ?? []).map((entry) => entry.change);
}

test("Usage measures the forced prompt while the recorded system state is unchanged", () => {
	const session = createSession();
	const snapshot = forcedSnapshot(session, FORCED_SYSTEM_PROMPT);
	session.appendMessage({ role: "user", content: "later prompt", timestamp: 2 });
	const previews = usagePreviews(session, snapshot);
	assert.equal(previews.get("system-prompt"), FORCED_SYSTEM_PROMPT);
	assert.deepEqual(systemPromptChanges(session, snapshot), ["forced"]);
	// Tool declarations still reach the provider, whatever the forced text says.
	assert.match(previews.get("custom-tools") ?? "", /Recorded search definition/);
	assert.doesNotMatch([...previews.values()].join("\n"), /Recorded preamble|Pi documentation/);
});

test("Usage reads the recorded sections once the system state changed after a forced run", () => {
	const session = createSession();
	const snapshot = forcedSnapshot(session, FORCED_SYSTEM_PROMPT);
	session.appendMessage({ role: "system", content: "", timestamp: 2, sections: { preamble: "Newer preamble" } });
	const previews = [...usagePreviews(session, snapshot).values()].join("\n");
	assert.match(previews, /Newer preamble/);
	assert.deepEqual(systemPromptChanges(session, snapshot), [undefined]);
	assert.match(previews, /Recorded search definition/);
	assert.doesNotMatch(previews, /XYZZY_FORCED_PROMPT|Pi documentation/);
});

test("Usage applies only tool changes under a forced prompt", () => {
	const session = createSession();
	const previews = usagePreviews(session, forcedSnapshot(session, FORCED_SYSTEM_PROMPT, [
		{ type: "section", name: "extra", text: "<extra>\nRequest section\n</extra>" },
		{ type: "tool", name: "search", declaration: { name: "search", description: "Request search", parameters: {} } },
	]));
	assert.equal(previews.get("system-prompt"), FORCED_SYSTEM_PROMPT);
	assert.match(previews.get("custom-tools") ?? "", /Request search/);
	assert.doesNotMatch([...previews.values()].join("\n"), /Request section/);
});

test("Usage keeps Pi's sections of an extending forced prompt and counts its addition under Extensions", () => {
	const session = createSession();
	const previews = usagePreviews(session, forcedSnapshot(session, `${buildSystemPrompt(OPTIONS)}\n\nEXTRA INSTRUCTION`));
	assert.match(previews.get("system-prompt") ?? "", /APPENDED TEXT/);
	assert.match(previews.get("extensions") ?? "", /EXTRA INSTRUCTION/);
});

test("Usage measures the forced prompt on a branch with no recorded system message", () => {
	const session = SessionManager.inMemory(CWD);
	assert.equal(usagePreviews(session, forcedSnapshot(session, FORCED_SYSTEM_PROMPT)).get("system-prompt"),
		FORCED_SYSTEM_PROMPT);
});
