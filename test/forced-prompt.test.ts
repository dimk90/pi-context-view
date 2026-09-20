import assert from "node:assert/strict";
import { test } from "node:test";

import type { BuildSystemPromptOptions, ToolInfo } from "@earendil-works/pi-coding-agent";

// Deep import bypasses the package barrel, which does not re-export buildSystemPrompt.
import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { buildUsageSnapshot, InitialCaptureState } from "../src/capture.ts";
import type { InitialSnapshot, InjectionItem } from "../src/model.ts";
import type { SystemMessage } from "../src/transcript.ts";
import { collectPreviewEntries, computeUsage } from "../src/usage.ts";
import { FORCED_SYSTEM_PROMPT } from "./fixtures/forced-prompt.ts";

const CWD = "/fixture";
const SEARCH: ToolInfo = {
	name: "search",
	description: "Search",
	parameters: {} as ToolInfo["parameters"],
	promptGuidelines: ["Cite sources"],
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

/** Freeze Initial for one run whose effective prompt is `systemPrompt`. */
function captureRun(
	options: BuildSystemPromptOptions,
	promptAtHandler: string,
	systemPrompt: string,
): InitialSnapshot {
	const capture = new InitialCaptureState();
	capture.prepare(options, promptAtHandler);
	const snapshot = capture.finalize(() => ({
		systemPrompt,
		messages: [],
		baselineMessages: [],
		allTools: [SEARCH],
		activeToolNames: ["search"],
		origin: "real-turn",
	}));
	assert.ok(snapshot);
	return snapshot;
}

/** Every measured item of a frozen snapshot, without its grouping. */
function snapshotItems(snapshot: InitialSnapshot): InjectionItem[] {
	return snapshot.groups.flatMap((group) => group.items);
}

test("Initial captures a forced prompt instead of the recorded sections, in both extension orders", () => {
	const structured = buildSystemPrompt(OPTIONS);
	const orders = {
		// Loaded before us, the forcing extension already replaced event.systemPrompt.
		before: captureRun(
			{ ...OPTIONS, forceSystemPrompt: FORCED_SYSTEM_PROMPT },
			FORCED_SYSTEM_PROMPT,
			FORCED_SYSTEM_PROMPT,
		),
		// Loaded after us, it forces the prompt only after our before_agent_start copy.
		after: captureRun(OPTIONS, structured, FORCED_SYSTEM_PROMPT),
	};
	for (const [order, snapshot] of Object.entries(orders)) {
		const items = snapshotItems(snapshot);
		assert.equal(items.find((item) => item.id === "base-prompt")?.text, FORCED_SYSTEM_PROMPT, order);
		// Sections Pi recorded but did not send must be neither counted nor attributed.
		assert.doesNotMatch(items.map((item) => item.text).join("\n"), /APPENDED TEXT|Pi documentation/, order);
		assert.equal(items.some((item) => item.kind === "prompt-addition"), false, order);
		// Tool declarations still reach the provider, whatever the forced text says.
		assert.equal(items.find((item) => item.kind === "tool")?.id, "tool:npm:web:search", order);
	}
});

test("a forced prompt extending Pi's sections keeps the section parts and its addition, in both orders", () => {
	const structured = buildSystemPrompt(OPTIONS);
	const forced = `${structured}\n\nEXTRA INSTRUCTION`;
	for (const promptAtHandler of [forced, structured]) {
		const order = promptAtHandler === forced ? "before" : "after";
		const items = snapshotItems(captureRun(OPTIONS, promptAtHandler, forced));
		const base = items.find((item) => item.id === "base-prompt");
		assert.deepEqual(
			base?.children?.map((child) => child.label),
			["Preamble", "Available Tools", "Guidelines", "Documentation", "Appended Prompt", "Current Dir",
				"Extension Additions"],
			order,
		);
		assert.equal(items.find((item) => item.kind === "prompt-addition")?.text.trim(), "EXTRA INSTRUCTION", order);
	}
});

test("Usage reads the recorded sections after a forced run, not the frozen forced prompt", () => {
	const recorded: SystemMessage = {
		role: "system",
		content: "",
		timestamp: 1,
		sections: { preamble: "Recorded preamble", cwd: "<cwd>\n/recorded\n</cwd>" },
		toolsAdded: [{ name: "search", description: "Recorded search definition", parameters: { type: "object" } }],
	};
	const initial = captureRun(
		{ ...OPTIONS, forceSystemPrompt: FORCED_SYSTEM_PROMPT },
		FORCED_SYSTEM_PROMPT,
		FORCED_SYSTEM_PROMPT,
	);
	const snapshot = buildUsageSnapshot({
		// An idle read returns Pi's base prompt, never the forced text of the last run.
		systemPrompt: buildSystemPrompt({ cwd: "/current" }),
		options: { cwd: "/current" },
		allTools: [SEARCH],
		activeToolNames: ["search"],
		messages: [recorded],
		initial,
	});
	const usage = computeUsage({ snapshot, messages: [recorded] });
	const previews = usage.categories.flatMap(collectPreviewEntries).map((entry) => entry.text).join("\n");
	assert.match(previews, /Recorded preamble/);
	assert.match(previews, /Recorded search definition/);
	assert.doesNotMatch(previews, /XYZZY_FORCED_PROMPT|Pi documentation/);
});
