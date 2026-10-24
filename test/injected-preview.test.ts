import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContextEvent, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULT_CATEGORY_COLORS, DEFAULT_MAP_SIZE } from "../src/config.ts";
import { buildInjectionsSnapshot } from "../src/injections.ts";
import { analyzeSystemPrompt } from "../src/measure.ts";
import { buildSnapshot, type InjectionSnapshot } from "../src/model.ts";
import { markForcedPrompt } from "../src/replay.ts";
import type { RequestMessage } from "../src/snapshot.ts";
import { forcedEditDiffLines, textDiffLines } from "../src/ui/diff-preview.ts";
import { InjectionsView } from "../src/ui/injections-view.ts";
import { type ContextMarker, markerLegendLines, markerStatusField, stateMarkers } from "../src/ui/markers.ts";
import { previewBodyLines, previewLegendLines } from "../src/ui/section-preview.ts";
import { UsageView } from "../src/ui/usage-view.ts";
import { collectPreviewEntries, computeUsage } from "../src/usage.ts";
import { containsBlock, createTheme, frameText, wholeOrAbsent } from "./harness/frame.ts";

const GUIDELINE = "Use search to verify claims";
const SNIPPET = "Search the web";
/** Line pi renders for the extension tool under "Available tools:". */
const SNIPPET_LINE = `search: ${SNIPPET}`;
const SOURCE = "npm:web";
/** Non-breaking spaces join the preceding word, arrow, and source label. */
const ARROW = "\u00A0<-\u00A0";
/** Carved lines name the tool pi reported for them, qualifying their source label. */
const TOOL = "search";
/** Measured prompt with short attributed lines and enough native lines to exercise caps. */
function createSnapshot(nativeLineCount = 16, withSnippet = false): InjectionSnapshot {
	const nativeLines = Array.from({ length: nativeLineCount }, (_, index) => `- Native rule ${index}`).join("\n");
	const toolsBlock = withSnippet ? `\n\n<tools>\n- ${SNIPPET_LINE}\n- read: Read files\n</tools>` : "";
	const prompt = `Preamble${toolsBlock}\n\n<rules>\n- ${GUIDELINE}\n${nativeLines}\n</rules>`;
	const items = analyzeSystemPrompt(prompt, {}, [{
		name: "search", description: "Search", parametersJson: "{}",
		snippet: withSnippet ? SNIPPET : undefined,
		guidelines: [GUIDELINE], source: SOURCE,
	}]);
	return buildSnapshot(items);
}

/** Drop only our SGR styling, leaving any unsafe control sequences visible to assertions. */
function plain(lines: readonly string[]): string {
	return lines.join("\n").replace(/\u001b\[[\d;]*m/g, "");
}

/** Parent and standalone previews share these semantic colors and a single fixed attribution bullet. */
function assertAttribution(lines: readonly string[], theme: Theme, text = GUIDELINE): void {
	assertLegend(lines, theme, ["highlighted"]);
	assert.ok(plain(lines).includes(`- ${text}${ARROW}${SOURCE}:${TOOL}`));
	// The annotation marks counted text in place; the line is never shown twice.
	assert.equal(plain(lines).split(`- ${text}`).length, 2);
	const rendered = lines.find((line) => line.includes(text));
	assert.ok(rendered?.includes(theme.fg("syntaxNumber", `- ${text}`)));
	assert.ok(rendered?.includes(theme.fg("borderMuted", ARROW)));
	assert.ok(rendered?.includes(theme.fg("mdLink", SOURCE)));
	// The tool is a distinct span, so a themed label never swallows its qualifier.
	assert.ok(rendered?.includes(theme.fg("mdLinkUrl", `:${TOOL}`)));
}

/**
 * Complete preview bullet block for the given markers, in fixed order, ending
 * one blank row above the hints. Returns where it starts.
 */
function assertLegendBullets(lines: readonly string[], theme: Theme, markers: readonly ContextMarker[]): number {
	const expected = markerLegendLines(theme, markers, visibleWidth(lines[0] ?? ""), "default-prompt");
	assert.ok(containsBlock(lines, expected), "the selected marker explanations are complete and ordered");
	const start = lines.findIndex((line) => plain([line]).trim() === plain([expected[0] ?? ""]).trim());
	assert.ok(start > 0);
	return start;
}

/** A preview legend also sits outside the content and gutter, between blank rows above the hints. */
function assertLegend(lines: readonly string[], theme: Theme, markers: readonly ContextMarker[]): void {
	const start = assertLegendBullets(lines, theme, markers);
	const rendered = plain(lines).split("\n");
	assert.equal(rendered.findIndex((line) => line.includes("↑↓/jk")), lines.length - 3);
	assert.equal(rendered[start - 1], "");
}

/**
 * The list explains a marker only in the status bar of the selected row: one
 * field opening with the keyword in its fixed color, never a legend bullet.
 */
function assertStatusMarker(lines: readonly string[], theme: Theme, marker: "dropped" | "moved"): void {
	assert.ok(containsBlock(lines, [markerStatusField(theme, marker)]));
	assert.ok(!containsBlock(lines, markerLegendLines(theme, [marker], 500)), "the list has no marker legend");
}

/** Whether the extension-text explanation appears, independent of its wording. */
function hasHighlightLegend(lines: readonly string[]): boolean {
	return containsBlock(lines, markerLegendLines(createTheme(), ["highlighted"], 1_000));
}

/** Styled state marker: a dim separator, then the keyword in the one fixed color that marker uses. */
function styledMarker(theme: Theme, marker: "dropped" | "moved" | "forced"): string {
	return stateMarkers(theme, { dropped: marker === "dropped", moved: marker === "moved",
		change: marker === "forced" ? "forced" : undefined });
}

/** The hierarchy row naming a label, apart from the legend bullets that explain its marker. */
function rowLine(lines: readonly string[], label: string): string {
	return plain(lines).split("\n").find((line) => line.includes(label)) ?? "";
}

/** Assert a whole frame stays within the live terminal dimensions. */
function assertFrame(lines: readonly string[], width: number, height: number): void {
	assert.ok(lines.length <= height);
	assert.ok(lines.every((line) => visibleWidth(line) <= width));
}

/** Injections items of a request that added `message`, without the prompt items. */
function addedMessageSnapshot(message: RequestMessage): InjectionSnapshot {
	const full = buildInjectionsSnapshot({
		snapshot: {
			id: 1, origin: "real-turn", leafId: null,
			changes: { conversation: [{ type: "added", message, attribution: {} }], system: [] },
			guard: { status: "incomplete", reason: "No payload." },
		},
		entries: [],
		filterMessages: (messages) => messages,
		options: { cwd: "/tmp" },
		allTools: [],
		systemPrompt: "",
		activeToolNames: [],
	});
	const items = full.groups.flatMap((group) => group.items).filter((item) => item.kind === "message");
	return buildSnapshot(items);
}

test("request summaries and bash text reach both previews without envelope metadata", () => {
	const messages = [
		{ role: "compactionSummary", summary: "CAPTURE_VISIBLE_SUMMARY", tokensBefore: 42_000, timestamp: 1 },
		{ role: "branchSummary", summary: "CAPTURE_VISIBLE_SUMMARY", fromId: "INTERNAL_BRANCH_ID", timestamp: 2 },
		{
			role: "bashExecution", command: "ls", output: "CAPTURE_VISIBLE_OUTPUT", exitCode: 2,
			cancelled: false, truncated: false, timestamp: 3,
		},
	] satisfies ContextEvent["messages"];
	for (const message of messages) {
		let height = 40;
		const theme = createTheme();
		const injections = new InjectionsView(theme, { snapshot: addedMessageSnapshot(message) }, () => {}, () => height);
		injections.handleInput("j"); // Select the message below its source group
		const usage = new UsageView(theme, {
			usage: computeUsage({ snapshot: buildSnapshot([]), messages: [message] }),
			categoryColors: DEFAULT_CATEGORY_COLORS, mapSize: DEFAULT_MAP_SIZE,
		}, () => {}, () => height);
		for (const view of [injections, usage]) {
			const overview = view.render(120);
			assert.doesNotMatch(plain(overview), /CAPTURE_VISIBLE/);
			view.handleInput("\r");
			const preview = plain(view.render(120));
			assert.match(preview, /CAPTURE_VISIBLE/);
			assert.doesNotMatch(preview, /"role"|"summary"|tokensBefore|fromId|timestamp|exitCode|INTERNAL_BRANCH_ID/);
			// Injections previews what the provider receives; Usage keeps its own bash entry form
			if (message.role === "bashExecution" && view === injections) {
				assert.match(preview, /Ran `ls`/);
				assert.match(preview, /Command exited with code 2/);
			}
			for (const width of [30, 60, 80, 120]) {
				for (height of [12, 40]) assertFrame(view.render(width), width, height);
			}
			view.handleInput("\u001b");
			assert.deepEqual(view.render(120), overview);
		}
	}
});

test("Injections shows attributed guidelines only after Enter, for parent and child previews", () => {
	let height = 40;
	const theme = createTheme();
	const view = new InjectionsView(theme, { snapshot: createSnapshot() }, () => {}, () => height);
	assert.doesNotMatch(plain(view.render(120)), /verify claims/);
	assert.ok(!hasHighlightLegend(view.render(120)));
	view.handleInput("j"); // System Prompt
	const list = view.render(120);
	view.handleInput("\r");
	assertAttribution(view.render(120), theme);
	for (const width of [30, 60, 80, 120]) {
		for (height of [12, 24, 40]) {
			assertFrame(view.render(width), width, height);
		}
	}
	height = 12;
	view.render(120);
	view.handleInput("\u001b[F"); // End
	assert.doesNotMatch(plain(view.render(120)), /verify claims/);
	height = 40;
	view.render(120);
	view.handleInput("\u001b[H"); // Home
	assertAttribution(view.render(120), theme);

	const originalFg = theme.fg.bind(theme);
	theme.fg = (color, text) => originalFg(color === "syntaxNumber" ? "warning" : color, text);
	view.invalidate();
	assertAttribution(view.render(120), theme);
	view.handleInput("\u001b");
	assert.deepEqual(view.render(120), list);
	view.handleInput("j"); // Preamble
	view.handleInput("j"); // Guidelines
	view.handleInput("\r");
	assertAttribution(view.render(120), theme);
	view.handleInput("\u001b");
	view.handleInput("\u001b[F"); // Last tool
	view.handleInput("\r");
	// The tool counts only its definition; System Prompt counts and shows its guideline.
	assert.match(plain(view.render(120)), /Definition · \d+ tokens/);
	assert.doesNotMatch(plain(view.render(120)), /verify claims|<-\u00A0npm:web/);
	assert.ok(!hasHighlightLegend(view.render(120)));
});

test("Injections attributes Available Tools snippets in the parent and standalone child", () => {
	const theme = createTheme();
	const view = new InjectionsView(theme, { snapshot: createSnapshot(16, true) }, () => {}, () => 40);
	view.handleInput("j"); // System Prompt
	view.handleInput("\r");
	const parent = view.render(120);
	assertAttribution(parent, theme, SNIPPET_LINE);
	assertAttribution(parent, theme);
	// Pi's own bullet keeps the plain body treatment in the same part.
	assert.match(plain(parent), /- read: Read files/);
	assert.equal(frameText(parent).split(frameText(markerLegendLines(theme, ["highlighted"], 1_000))).length, 2);
	view.handleInput("\u001b");
	view.handleInput("j"); // Preamble
	view.handleInput("j"); // Available Tools
	view.handleInput("\r");
	const child = view.render(120);
	assertAttribution(child, theme, SNIPPET_LINE);
	assert.doesNotMatch(plain(child), /verify claims/);
});

test("Usage opens System Prompt sections directly and retains attribution without a block layer", () => {
	let height = 40;
	const theme = createTheme();
	const usage = computeUsage({ snapshot: createSnapshot(), messages: [] });
	const view = new UsageView(
		theme,
		{ usage, categoryColors: DEFAULT_CATEGORY_COLORS, mapSize: DEFAULT_MAP_SIZE },
		() => {},
		() => height,
	);
	const dashboard = view.render(120);
	assert.doesNotMatch(plain(dashboard), /verify claims/);
	assert.ok(!hasHighlightLegend(dashboard));
	view.handleInput("\r");
	const content = view.render(120);
	assertAttribution(content, theme);
	assert.doesNotMatch(plain(content), /┃|… \+|Enter - View Content/);
	assert.doesNotMatch(plain(content), /\[System Prompt\]/);
	assert.match(plain([content[2] ?? ""]), /^System Prompt\s+/);
	assert.equal(content[3], "");
	assert.match(plain([content[4] ?? ""]), /^\s+Preamble · \d+ tokens$/);
	assert.match(plain(content), /Native rule 15/);
	const category = usage.categories.find((category) => category.id === "system-prompt");
	assert.ok(category);
	const entry = collectPreviewEntries(category)[0];
	assert.ok(entry);
	const body = previewBodyLines(theme, entry, 115, (text) => text.split("\n"), "System Prompt");
	assert.ok(!hasHighlightLegend(body));
	view.handleInput("\r");
	assert.deepEqual(view.render(120), content, "Enter does not add a redundant full-content level");
	for (const width of [30, 60, 80, 120]) {
		for (height of [12, 24, 40]) {
			assertFrame(view.render(width), width, height);
		}
	}
	view.handleInput("\u001b[F"); // End
	assert.match(plain(view.render(120)), /Native rule 15/);
	view.handleInput("\u001b[H");
	assertAttribution(view.render(120), theme);
	const originalFg = theme.fg.bind(theme);
	theme.fg = (color, text) => originalFg(color === "mdLink" ? "success" : color, text);
	view.invalidate();
	assertAttribution(view.render(120), theme);
	view.handleInput("\u001b");
	assert.deepEqual(view.render(120), dashboard);
});

test("prompt additions render as guessed attributions with their own caveat", () => {
	const theme = createTheme();
	const addition = "\n\nAsk before editing: npm:web docs.";
	const prompt = `Preamble\n\n<rules>\n- Native rule\n</rules>\n\n<cwd>\n/fixture\n</cwd>${addition}`;
	const snapshot = buildSnapshot(analyzeSystemPrompt(prompt, {}, [], {
		sources: [{ source: "npm:web", path: "/pkgs/web/index.ts" }],
	}));
	const view = new InjectionsView(theme, { snapshot }, () => {}, () => 40);
	// System Prompt counts the addition; no extension row counts it again.
	const list = plain(view.render(120));
	assert.match(list, /└─ Extension Additions \.+ +9\n/);
	assert.doesNotMatch(list, /npm:web|system prompt additions/);
	view.handleInput("j"); // System Prompt
	view.handleInput("\r");

	const parent = view.render(120);
	assert.ok(plain(parent).includes(`${addition.trim()}${ARROW}npm:web (guess)`));
	const rendered = parent.find((line) => line.includes("(guess)"));
	assert.ok(rendered?.includes(theme.fg("mdLink", "npm:web")));
	// One marker covers a guessed extension and any tool guessed inside it.
	assert.ok(rendered?.includes(theme.fg("dim", " (guess)")));
	assertLegend(parent, theme, ["highlighted", "guess"]);

	view.handleInput("\u001b");
	for (let step = 0; step < 4; step++) view.handleInput("j"); // Extension Additions
	view.handleInput("\r");
	const child = view.render(120);
	assert.ok(plain(child).includes(`${addition.trim()}${ARROW}npm:web (guess)`));
	assertLegend(child, theme, ["highlighted", "guess"]);

	// Usage counts it in System Prompt too, not under the contributing extension.
	const usage = computeUsage({ snapshot, messages: [] });
	assert.equal(usage.categories.some((category) => category.id === "extensions"), false);
	assert.equal(usage.categories.find((category) => category.id === "system-prompt")?.tokens, snapshot.totalTokens);
});

test("a guessed addition names the extension tool its text mentions", () => {
	const theme = createTheme();
	const addition = "\n\nCall web_search before answering; npm:web docs explain why.";
	const prompt = `Preamble\n\n<rules>\n- Native rule\n</rules>\n\n<cwd>\n/fixture\n</cwd>${addition}`;
	const snapshot = buildSnapshot(analyzeSystemPrompt(prompt, {}, [], {
		sources: [{ source: "npm:web", path: "/pkgs/web/index.ts", names: ["web_search", "/web"] }],
	}));
	const view = new InjectionsView(theme, { snapshot }, () => {}, () => 40);
	view.handleInput("j"); // System Prompt
	view.handleInput("\r");

	const parent = view.render(120);
	assert.ok(plain(parent).includes(`${addition.trim()}${ARROW}npm:web:web_search (guess)`));
	const rendered = parent.find((line) => line.includes("(guess)"));
	assert.ok(rendered?.includes(theme.fg("mdLinkUrl", ":web_search")));
});

test("reference text and source are sanitized before coloring and wrapping", () => {
	const theme = createTheme();
	const line = "\n- A\u001b[2JB\u001b]52;c;clipboard-secret\u0007\n  continuation\t界";
	const lines = previewBodyLines(theme, {
		text: `Guidelines:${line}\n- Native rule`,
		injectedReferences: [{
			start: "Guidelines:".length,
			end: "Guidelines:".length + line.length,
			source: { id: "unsafe", label: "npm:\u001b[31mweb\u001b[0m\r\nowner", native: false },
			tool: "sea\u001b[31mrch\u0007",
		}],
	}, 28, () => { throw new Error("Referenced content must sanitize before adding theme colors"); });
	assert.doesNotMatch(plain(lines), /\u001b|clipboard-secret|\t|\r/);
	assert.match(plain(lines), /- AB/);
	assert.match(plain(lines), /npm:web owner:search/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 30));
	const continuation = lines.find((line) => line.includes("continuation"));
	assert.ok(continuation?.includes(theme.getFgAnsi("syntaxNumber")), "multiline references keep their color");
	assert.ok(!hasHighlightLegend(lines));
});

test("attribution wraps the preceding word and label together unless wider than the content", () => {
	const theme = createTheme();
	const label = "npm:@eko24ive/pi-ask";
	const line = "\n- Ask the user before choosing between valid directions";
	const content = {
		text: `Guidelines:${line}`,
		injectedReferences: [{
			start: "Guidelines:".length,
			end: "Guidelines:".length + line.length,
			source: { id: "ask", label, native: false },
			tool: "ask_user",
		}],
	};
	const joinedSuffix = `directions${ARROW}${label}:ask_user`;
	for (let width = 12; width <= 90; width++) {
		const lines = plain(previewBodyLines(theme, content, width, () => [])).split("\n");
		assert.ok(lines.every((line) => visibleWidth(line) <= width + 2), `bounded lines at width ${width}`);
		// The leading non-breaking space also binds the last content word to the annotation
		if (width >= visibleWidth(joinedSuffix)) {
			assert.ok(lines.some((line) => line.includes(joinedSuffix)), `suffix kept whole at width ${width}`);
		}
		assert.equal(
			lines.join("").replace(/ /g, ""),
			`Guidelines:- Ask the user before choosing between valid ${joinedSuffix}`.replace(/ /g, ""),
			`wrapped content and both non-breaking spaces survive at width ${width}`,
		);
	}
	const narrow = plain(previewBodyLines(theme, content, 13, () => [])).split("\n");
	assert.ok(narrow.some((line) => line.endsWith("directions\u00A0<-")), "oversized suffix may split after the arrow");
});

/** All preview levels that can render attributed System Prompt text. */
type PreviewTarget = "injections-parent" | "injections-child" | "usage-single" | "usage-stream" | "usage-full";

/** Open a synthetic long preview through the same Enter gates as a user, optionally of a forced prompt. */
function createPreview(
	target: PreviewTarget,
	theme: Theme,
	getRows: () => number,
	forced = false,
): InjectionsView | UsageView {
	const snapshot = forced ? forcedSnapshot(createSnapshot(80)) : createSnapshot(80);
	if (target === "injections-parent" || target === "injections-child") {
		const view = new InjectionsView(theme, { snapshot }, () => {}, getRows);
		view.render(120);
		for (let step = 0; step < (target === "injections-child" ? 3 : 1); step++) view.handleInput("j");
		view.handleInput("\r");
		return view;
	}
	const usage = computeUsage({ snapshot, messages: [] });
	// Multi-entry fixtures keep coverage of capped and full-block attribution alongside the direct path
	const categories = target === "usage-single" ? usage.categories : usage.categories.map((category) =>
		category.id !== "system-prompt" ? category : {
			...category, tokens: category.tokens + 1, children: undefined,
			entries: [...collectPreviewEntries(category), { breadcrumb: ["Other"], tokens: 1, text: "More" }],
		}
	);
	const view = new UsageView(theme, {
		usage: { ...usage, categories, estimatedTokens: usage.estimatedTokens + (target === "usage-single" ? 0 : 1) },
		categoryColors: new Map(DEFAULT_CATEGORY_COLORS).set("system-prompt", "error"),
		mapSize: DEFAULT_MAP_SIZE,
	}, () => {}, getRows);
	view.render(120);
	view.handleInput("\r");
	view.render(120);
	if (target === "usage-full") view.handleInput("\r");
	return view;
}

for (const target of ["injections-parent", "injections-child", "usage-single", "usage-stream", "usage-full"] as const) {
	test(`${target} footer stays pinned, collapses whole, and returns on height-only resize`, () => {
		let height = 40;
		const theme = createTheme();
		const view = createPreview(target, theme, () => height);
		const initial = view.render(120);
		assertAttribution(initial, theme);
		const legendStart = assertLegendBullets(initial, theme, ["highlighted"]);
		for (const key of ["j", "\u001b[6~", "\u001b[F", "\u001b[<65;1;1M", "\u001b[5~", "\u001b[H"]) {
			view.handleInput(key);
			assert.deepEqual(view.render(120).slice(legendStart), initial.slice(legendStart));
		}
		for (const width of [30, 51, 60, 80, 120]) {
			let sawCollapsed = false;
			let sawVisible = false;
			for (height = 1; height <= 45; height++) {
				const lines = view.render(width);
				assertFrame(lines, width, height);
				if (wholeOrAbsent(lines, markerLegendLines(theme, ["highlighted"], width))) {
					assertLegend(lines, theme, ["highlighted"]);
					sawVisible = true;
				} else {
					sawCollapsed = true;
					if (height >= 12 && width >= 60) assert.match(plain(lines), /Esc Back/);
				}
			}
			assert.ok(sawCollapsed && sawVisible, `collapse and restoration at width ${width}`);
		}
		height = 40;
		view.render(120);
		view.handleInput("\u001b[H");
		assertAttribution(view.render(120), theme);
	});
}

test("the marker legend gives short content every row and never truncates on tiny terminals", () => {
	const theme = createTheme();
	const content = {
		text: "Guidelines:\n- Use search",
		injectedReferences: [{ start: 11, end: 24, source: { id: "web", label: SOURCE, native: false } }],
	};
	for (const width of [24, 60, 120]) {
		const expected = markerLegendLines(theme, ["highlighted"], width);
		for (const contentLineCount of [1, 2, 21, 22, 23, 80]) {
			let visible = false;
			let absent = false;
			for (let availableRows = 0; availableRows <= 100; availableRows++) {
				const lines = previewLegendLines(theme, [content], { width, contentLineCount, availableRows });
				if (lines.length === 0) {
					absent = true;
					assert.equal(visible, false, "more space never hides a visible legend");
				} else {
					visible = true;
					assert.equal(frameText(lines), frameText(expected));
					assert.ok(lines.length + Math.min(contentLineCount, 1) <= availableRows);
				}
			}
			assert.ok(visible && absent);
		}
	}
});

/** Snapshot of a --system-prompt replacement: every pi block dropped, one addition still sent. */
function createReplacedSnapshot(): InjectionSnapshot {
	const addition = "\n\nAsk before editing: npm:web docs.";
	const prompt = `Custom reviewer prompt.\n\n<cwd>\n/fixture\n</cwd>${addition}`;
	const items = analyzeSystemPrompt(prompt, { customPrompt: "Custom reviewer prompt." }, [{
		name: "search", description: "Search", parametersJson: "{}",
		snippet: SNIPPET, guidelines: [GUIDELINE], source: SOURCE,
	}], { sources: [{ source: SOURCE, path: "/pkgs/web/index.ts" }] });
	return buildSnapshot(items);
}

test("a replaced prompt marks its dropped blocks in the tree and in previews", () => {
	let height = 40;
	const theme = createTheme();
	const view = new InjectionsView(theme, { snapshot: createReplacedSnapshot() }, () => {}, () => height);
	const list = view.render(120);

	// Dropped blocks stay visible at 0 tokens, marked after the estimate they explain.
	for (const label of ["Tools", "Rules", "Docs"]) {
		assert.match(plain(list).replace(/\.{2,}/g, "\u2026"), new RegExp(`${label} \u2026 +0 · Dropped`));
	}
	const row = list.find((line) => plain([line]).includes("Docs"));
	assert.ok(row?.includes(styledMarker(theme, "dropped")), "a dim separator carries the keyword's fixed color");
	// The status bar explains the marker of the selected row.
	for (let step = 0; step < 3; step++) view.handleInput("j"); // Available Tools
	assertStatusMarker(view.render(120), theme, "dropped");
	// A marker that no longer fits is dropped whole rather than truncated, while the bar still explains it.
	const narrow = view.render(25);
	assert.match(rowLine(narrow, "Docs"), /Docs/);
	assert.doesNotMatch(rowLine(narrow, "Docs"), /Dropped/);
	assertStatusMarker(narrow, theme, "dropped");
	view.handleInput("\u001b[H");

	view.handleInput("j"); // System Prompt
	view.handleInput("\r");
	const parent = plain(view.render(120));
	assert.match(parent.replace(/\s+/g, " "), /Tools · 0 tokens · Dropped/);
	assert.match(parent.replace(/\s+/g, " "), /Docs · 0 tokens · Dropped/);
	assert.ok(parent.includes(`- search: ${SNIPPET}${ARROW}${SOURCE}:${TOOL}`));
	assert.ok(parent.includes(`- ${GUIDELINE}${ARROW}${SOURCE}:${TOOL}`));
	// Extension Additions survive the replacement, so this preview explains attribution and dropped parts
	assertLegend(view.render(120), theme, ["highlighted", "guess", "dropped"]);

	view.handleInput("\u001b");
	view.handleInput("j"); // Preamble
	view.handleInput("j"); // Available Tools
	view.handleInput("\r");
	assert.ok(plain(view.render(120)).includes(`- search: ${SNIPPET}${ARROW}${SOURCE}:${TOOL}`));
	// The Dropped bullet explains that replaced highlighted lines count nowhere
	assertLegend(view.render(120), theme, ["highlighted", "dropped"]);

	for (const width of [30, 60, 80, 120]) {
		for (height of [12, 24, 40]) assertFrame(view.render(width), width, height);
	}
});

/** Snapshot of a prompt whose tool-surface sections an extension moved past pi's cwd section. */
function createRelocatedSnapshot(): InjectionSnapshot {
	const prompt = [
		"Preamble line.",
		"",
		"<docs>",
		"Pi documentation (read only when the user asks about pi itself):",
		"- Main documentation: /docs/README.md",
		"</docs>",
		"",
		"<cwd>",
		"/fixture",
		"</cwd>",
		"",
		"<tools>",
		`- ${SNIPPET_LINE}`,
		"- read: Read files",
		"</tools>",
		"",
		"<rules>",
		`- ${GUIDELINE}`,
		"- Be concise in your responses",
		"</rules>",
	].join("\n");
	const items = analyzeSystemPrompt(prompt, {}, [
		{
			name: "search", description: "Search", parametersJson: "{}",
			snippet: SNIPPET, guidelines: [GUIDELINE], source: SOURCE,
		},
		{
			name: "read", description: "Read", parametersJson: "{}",
			snippet: "Read files", guidelines: [], source: "builtin",
		},
	]);
	return buildSnapshot(items);
}

test("a relocated block stays a counted System Prompt part, marked where it now sits", () => {
	let height = 40;
	const theme = createTheme();
	const view = new InjectionsView(theme, { snapshot: createRelocatedSnapshot() }, () => {}, () => height);
	const list = view.render(120);

	// Both sections follow cwd, keep their estimates, and name their new position.
	const rows = plain(list).replace(/\.{2,}/g, "\u2026").split("\n");
	assert.deepEqual(
		rows.map((row) => row.replace(/^[\s│├└─]+/, ""))
			.filter((row) => /^(Current Dir|Tools|Rules) …/.test(row)),
		["Current Dir \u2026  2", "Tools \u2026 11 · Moved", "Rules \u2026 16 · Moved"],
	);
	const row = list.find((line) => plain([line]).includes("Rules"));
	assert.ok(row?.includes(styledMarker(theme, "moved")), "a dim separator carries the keyword's fixed color");
	for (let step = 0; step < 5; step++) view.handleInput("j"); // Guidelines
	assertStatusMarker(view.render(120), theme, "moved");
	// A marker that no longer fits is dropped whole rather than truncated, while the bar still explains it.
	const narrow = view.render(27);
	assert.match(rowLine(narrow, "Rules"), /Rules/);
	assert.doesNotMatch(rowLine(narrow, "Rules"), /Moved/);
	assertStatusMarker(narrow, theme, "moved");
	view.handleInput("\u001b[H");

	view.handleInput("j"); // System Prompt
	view.handleInput("\r");
	const parent = plain(view.render(120));
	assert.match(parent.replace(/\s+/g, " "), /Tools · 11 tokens · Moved/);
	assert.match(parent.replace(/\s+/g, " "), /Rules · 16 tokens · Moved/);
	assert.ok(parent.includes(`- ${SNIPPET_LINE}${ARROW}${SOURCE}:${TOOL}`));

	view.handleInput("\u001b");
	for (let step = 0; step < 4; step++) view.handleInput("j"); // Available Tools
	view.handleInput("\r");
	assert.match(plain(view.render(120)), /Tools\s+pi · 11 tokens · Moved/);
	assert.ok(plain(view.render(120)).includes(`- ${SNIPPET_LINE}${ARROW}${SOURCE}:${TOOL}`));

	for (const width of [30, 60, 80, 120]) {
		for (height of [12, 24, 40]) assertFrame(view.render(width), width, height);
	}
});

test("Usage preserves moved parts, their estimates, and their marker across theme invalidation", () => {
	const theme = createTheme();
	const usage = computeUsage({ snapshot: createRelocatedSnapshot(), messages: [] });
	const view = new UsageView(
		theme,
		{ usage, categoryColors: DEFAULT_CATEGORY_COLORS, mapSize: DEFAULT_MAP_SIZE },
		() => {},
		() => 40,
	);
	const dashboard = view.render(120);
	assert.doesNotMatch(plain(dashboard), /Read files|Moved/);
	view.handleInput("\r");
	const preview = view.render(120);
	assert.match(plain(preview), /Tools · 11 tokens · Moved/);
	assert.match(plain(preview), /Rules · 16 tokens · Moved/);
	assertLegend(preview, theme, ["highlighted", "moved"]);
	assert.ok(preview.some((line) => line.includes(styledMarker(theme, "moved"))));
	const originalFg = theme.fg.bind(theme);
	theme.fg = (color, text) => originalFg(color === "warning" ? "success" : color, text);
	view.invalidate();
	assert.ok(view.render(120).some((line) => line.includes(styledMarker(theme, "moved"))));
	view.handleInput("\u001b");
	assert.deepEqual(view.render(120), dashboard);
});

test("a tool preview shows its dropped prompt lines without claiming their tokens", () => {
	const theme = createTheme();
	const snapshot = createReplacedSnapshot();
	const view = new InjectionsView(theme, { snapshot }, () => {}, () => 40);
	view.handleInput("\u001b[F"); // last selectable row: the extension tool
	view.handleInput("\r");
	const preview = plain(view.render(120)).replace(/\s+/g, " ");
	assert.match(preview, new RegExp(`Tools · 0 tokens · Dropped - search: ${SNIPPET}`));
	assert.match(preview, new RegExp(`Rules · 0 tokens · Dropped - ${GUIDELINE}`));
	// A tool's own lines are not injections into someone else's text.
	assert.ok(!hasHighlightLegend([preview]));

	// Usage counts the same tool without its dropped lines.
	const usage = computeUsage({ snapshot, messages: [] });
	const customTools = usage.categories.find((category) => category.id === "custom-tools");
	const entry = collectPreviewEntries(customTools ?? { id: "", label: "", tokens: 0 })[0];
	assert.equal(entry?.tokens, customTools?.tokens);
	assert.deepEqual(
		entry?.sections?.filter((section) => section.dropped === true).map((section) => section.tokens),
		[0, 0],
	);
});

test("Usage explains markers in categories beyond the System Prompt, at both preview levels", () => {
	const theme = createTheme();
	const usage = computeUsage({ snapshot: createReplacedSnapshot(), messages: [] });
	const tools = usage.categories.find((category) => category.id === "custom-tools");
	assert.ok(tools !== undefined);
	const open = (categories: typeof usage.categories): readonly string[] => {
		const view = new UsageView(theme, {
			usage: { ...usage, categories },
			categoryColors: DEFAULT_CATEGORY_COLORS,
			mapSize: DEFAULT_MAP_SIZE,
		}, () => {}, () => 40);
		view.render(120);
		view.handleInput("\r");
		return view.render(120);
	};

	const direct = open([tools]);
	assert.match(plain(direct), /Tools · 0 tokens · Dropped/);
	// A tool's own lines are not injections, so the state marker alone is explained.
	assertLegend(direct, theme, ["dropped"]);

	const stream = open([{
		...tools,
		tokens: tools.tokens + 1,
		children: undefined,
		entries: [...collectPreviewEntries(tools), { breadcrumb: ["Other"], tokens: 1, text: "More" }],
	}]);
	assertLegend(stream, theme, ["dropped"]);
});

/** The snapshot with its System Prompt marked as a forced prompt. */
function forcedSnapshot(snapshot: InjectionSnapshot): InjectionSnapshot {
	return {
		...snapshot,
		groups: snapshot.groups.map((group) => ({ ...group, items: markForcedPrompt([...group.items], "forced") })),
	};
}

for (const target of ["injections-parent", "usage-single", "usage-stream", "usage-full"] as const) {
	test(`${target} marks a forced System Prompt in its header and explains it in the legend`, () => {
		let height = 40;
		const theme = createTheme();
		const lines = createPreview(target, theme, () => height, true).render(120);
		const header = lines.find((line) => plain([line]).startsWith("System Prompt")) ?? "";
		assert.match(plain([header]), /· Forced $/);
		assert.ok(header.includes(styledMarker(theme, "forced")));
		assertLegend(lines, theme, ["highlighted", "forced"]);

		// The bullet collapses with the legend; the header keeps its marker
		height = 12;
		const short = plain(createPreview(target, theme, () => height, true).render(120));
		assert.doesNotMatch(short, /Forced prompts|Highlighted/);
		assert.match(short, /· Forced/);
		height = 40;
		assert.doesNotMatch(plain(createPreview(target, theme, () => height).render(120)), /Forced/);
	});
}

test("Usage keeps the Forced marker out of previews other than System Prompt", () => {
	const view = new UsageView(createTheme(), {
		usage: computeUsage({ snapshot: forcedSnapshot(createSnapshot()), messages: [] }),
		categoryColors: DEFAULT_CATEGORY_COLORS,
		mapSize: DEFAULT_MAP_SIZE,
	}, () => {}, () => 40);
	assert.doesNotMatch(plain(view.render(120)), /Forced/);
	view.handleInput("j"); // Custom Tools
	view.handleInput("\r");
	const preview = plain(view.render(120));
	assert.match(preview, /Custom Tools/);
	assert.doesNotMatch(preview, /Forced/);
});

test("native-only System Prompt and sibling previews do not claim extension injection", () => {
	const snapshot = buildSnapshot(analyzeSystemPrompt(
		"Preamble\n\n<rules>\n- Native rule -> npm:web\n</rules>", {}, [],
	));
	const theme = createTheme();
	const view = new InjectionsView(theme, { snapshot }, () => {}, () => 40);
	view.handleInput("j"); // System Prompt
	view.handleInput("\r");
	assert.ok(!hasHighlightLegend(view.render(120)));
	view.handleInput("\u001b");
	view.handleInput("j"); // Preamble
	view.handleInput("j"); // Guidelines
	view.handleInput("\r");
	assert.ok(!hasHighlightLegend(view.render(120)));

	const usage = new UsageView(theme, {
		usage: computeUsage({ snapshot, messages: [] }),
		categoryColors: DEFAULT_CATEGORY_COLORS,
		mapSize: DEFAULT_MAP_SIZE,
	}, () => {}, () => 40);
	usage.handleInput("\r");
	assert.ok(!hasHighlightLegend(usage.render(120)));

	const injected = new InjectionsView(theme, { snapshot: createSnapshot() }, () => {}, () => 40);
	injected.handleInput("j"); // System Prompt
	injected.handleInput("j"); // Preamble sibling of attributed Guidelines
	injected.handleInput("\r");
	assert.ok(!hasHighlightLegend(injected.render(120)));
});

test("replaced edits preview as diffs with the Forced marker and its own legend", () => {
	const theme = createTheme();
	const sent = { label: "review", text: "Review the change.", tokens: 5, forcedEdit: { text: "Review the tests.", sent: true } };
	const unsent = { label: "checklist", text: "", tokens: 0, forcedEdit: { text: "Run the tests.", sent: false } };
	const content = { text: sent.text, sections: [sent, unsent] };
	const body = previewBodyLines(theme, content, 100, () => { throw new Error("A replaced edit renders its diff"); });
	assert.ok(containsBlock(body, forcedEditDiffLines(theme, sent.text, sent.forcedEdit, 100)));
	assert.ok(containsBlock(body, forcedEditDiffLines(theme, unsent.text, unsent.forcedEdit, 100)));
	assert.equal(body.filter((line) => line.includes(stateMarkers(theme, { forcedEdit: { sent: true } }))).length, 2);
	const standalone = previewBodyLines(theme, sent, 100, () => []);
	assert.deepEqual(standalone, forcedEditDiffLines(theme, sent.text, sent.forcedEdit, 100));
	const legend = previewLegendLines(theme, [content], { width: 100, availableRows: 100, contentLineCount: body.length });
	assert.ok(containsBlock(legend, markerLegendLines(theme, ["forced-edit"], 100)));
	// The legend names diff signs in the colors their lines open with
	assert.ok(legend.some((line) => line.includes(theme.fg("toolDiffAdded", "+"))));
	assert.ok(legend.some((line) => line.includes(theme.fg("toolDiffRemoved", "-"))));
	assert.ok(!containsBlock(legend, markerLegendLines(theme, ["forced"], 100)), "only a whole forced prompt explains Forced prompts");
});

test("changed prompt parts preview their text diff, standalone and as parts", () => {
	const theme = createTheme();
	const removed = { label: "legacy", text: "Legacy note.", tokens: 0, change: "deleted" as const,
		diff: { added: 0, removed: 3 }, textDiff: { base: "Legacy note.", request: "" } };
	const body = previewBodyLines(theme, { text: "", sections: [removed] }, 100,
		() => { throw new Error("A changed part renders its diff"); });
	assert.ok(containsBlock(body, textDiffLines(theme, removed.textDiff, 100)));
	assert.deepEqual(previewBodyLines(theme, removed, 100, () => []), textDiffLines(theme, removed.textDiff, 100));
	assert.match(plain(textDiffLines(theme, removed.textDiff, 100)), /^ {2}- Legacy note\.$/);
	// Without a base the whole part is added: plain text, as before diff bodies
	const added = { label: "notes", text: "New note.", tokens: 3, diff: { added: 3, removed: 0 },
		textDiff: { base: "", request: "New note." } };
	const plainText = previewBodyLines(theme, { ...added, textDiff: undefined }, 100, (text) => [text]);
	assert.deepEqual(previewBodyLines(theme, added, 100, (text) => [text]), plainText);
});
