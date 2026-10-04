/**
 * Forced prompts on request snapshots: Injections measures the forced text the
 * request carried; Usage keeps reading the recorded structured state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type BuildSystemPromptOptions, SessionManager, type ToolInfo } from "@earendil-works/pi-coding-agent";

// Deep import bypasses the package barrel, which does not re-export buildSystemPrompt.
import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { buildInjectionsSnapshot } from "../src/injections.ts";
import type { InjectionItem } from "../src/model.ts";
import { applyRequestSnapshot } from "../src/projection.ts";
import { buildUsageSnapshot } from "../src/replay.ts";
import type { RequestSnapshot } from "../src/snapshot.ts";
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
function forcedSnapshot(session: SessionManager, forcedPrompt: string): RequestSnapshot {
	return {
		id: 1, origin: "real-turn", capturedAt: 0, leafId: session.getLeafId(),
		changes: { conversation: [], system: [] },
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
	assert.equal(items.find((item) => item.id === "base-prompt")?.text, FORCED_SYSTEM_PROMPT);
	// Sections Pi recorded but did not send must be neither counted nor attributed.
	assert.doesNotMatch(items.map((item) => item.text).join("\n"), /Recorded preamble/);
	assert.equal(items.some((item) => item.kind === "prompt-addition"), false);
	// Tool declarations still reach the provider, whatever the forced text says.
	assert.equal(items.find((item) => item.kind === "tool")?.id, "tool:npm:web:search");
});

test("a forced prompt extending Pi's sections keeps the section parts and its addition", () => {
	const items = injectionItems(`${buildSystemPrompt(OPTIONS)}\n\nEXTRA INSTRUCTION`);
	const base = items.find((item) => item.id === "base-prompt");
	assert.deepEqual(
		base?.children?.map((child) => child.label),
		["Preamble", "Available Tools", "Guidelines", "Documentation", "Appended Prompt", "Current Dir",
			"Extension Additions"],
	);
	assert.equal(items.find((item) => item.kind === "prompt-addition")?.text.trim(), "EXTRA INSTRUCTION");
});

test("Usage reads the recorded sections after a forced run, not the forced prompt", () => {
	const session = createSession();
	const { messages, systemChanges } = applyRequestSnapshot({
		snapshot: forcedSnapshot(session, FORCED_SYSTEM_PROMPT),
		entries: session.getEntries(),
		leafId: session.getLeafId(),
		filterMessages: (projected) => projected,
	});
	const snapshot = buildUsageSnapshot({
		// An idle read returns Pi's base prompt, never the forced text of the last run.
		systemPrompt: buildSystemPrompt({ cwd: "/current" }),
		options: { cwd: "/current" },
		allTools: [SEARCH],
		activeToolNames: ["search"],
		messages,
		systemChanges,
	});
	const usage = computeUsage({ snapshot, messages });
	const previews = usage.categories.flatMap(collectPreviewEntries).map((entry) => entry.text).join("\n");
	assert.match(previews, /Recorded preamble/);
	assert.match(previews, /Recorded search definition/);
	assert.doesNotMatch(previews, /XYZZY_FORCED_PROMPT|Pi documentation/);
});
