import assert from "node:assert/strict";
import { test } from "node:test";

import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { InitialSnapshot, InjectionGroup, InjectionItem } from "../src/model.ts";
import { InjectionsView } from "../src/ui/injections-view.ts";

const FG_COLORS: ThemeColor[] = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
	"thinkingText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
	"mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
	"mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
	"syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
	"syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
	"thinkingXhigh", "thinkingMax", "bashMode",
];
const BG_COLORS = [
	"selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
] as const;

function createTheme(): Theme {
	const foregroundOverrides: Partial<Record<ThemeColor, string>> = {
		accent: "#010203",
		text: "#040506",
		muted: "#070809",
		dim: "#101112",
		error: "#131415",
		mdHeading: "#161718",
		syntaxFunction: "#1c1d1e",
	};
	const fgColors = Object.fromEntries(FG_COLORS.map((color) => [color, foregroundOverrides[color] ?? "#aabbcc"]));
	const bgColors = Object.fromEntries(BG_COLORS.map((color) => [color, "#112233"]));
	return new Theme(
		fgColors as ConstructorParameters<typeof Theme>[0],
		bgColors as ConstructorParameters<typeof Theme>[1],
		"truecolor",
	);
}

function item(id: string, sourceId: string, native: boolean, tokens: number): InjectionItem {
	return {
		id,
		phase: "initial",
		kind: "message",
		source: { id: sourceId, label: sourceId, native },
		label: `${id} with a moderately long label for truncation checks`,
		chars: tokens * 4,
		tokens,
		text: Array.from({ length: 40 }, (_, line) => `${id} preview line ${line} ${"word ".repeat(12)}`).join("\n"),
	};
}

function group(sourceId: string, native: boolean, items: InjectionItem[]): InjectionGroup {
	return {
		source: { id: sourceId, label: sourceId, native },
		items,
		totalTokens: items.reduce((sum, entry) => sum + entry.tokens, 0),
	};
}

function snapshot(itemsPerGroup: number): InitialSnapshot {
	const piItems = Array.from({ length: itemsPerGroup }, (_, index) => item(`pi-${index}`, "pi", true, 1_234_567));
	const extensionItems = Array.from({ length: itemsPerGroup }, (_, index) => item(`ext-${index}`, "npm:web", false, 42));
	const groups = [group("pi", true, piItems), group("npm:web", false, extensionItems)];
	return {
		origin: "synthetic-probe",
		capturedAt: new Date("2026-07-10T12:00:00Z"),
		groups,
		totalTokens: groups.reduce((sum, entry) => sum + entry.totalTokens, 0),
	};
}

function createView(
	itemsPerGroup = 8,
	degradedReason?: string,
	getTerminalRows: () => number = () => 24,
): InjectionsView {
	return new InjectionsView(
		createTheme(),
		{ snapshot: snapshot(itemsPerGroup), degradedReason },
		() => {},
		getTerminalRows,
	);
}

/** Remove SGR sequences so tests can inspect visual columns. */
function stripSgr(text: string): string {
	return text.replace(/\u001b\[[\d;]*m/g, "");
}

test("InjectionsView follows pi selector styling and cursor alignment", () => {
	const child = item("child", "pi", true, 20);
	const parent: InjectionItem = { ...item("parent", "pi", true, 50), children: [child] };
	const sibling = item("sibling", "pi", true, 10);
	const piGroup = group("pi", true, [parent, sibling]);
	const styledSnapshot: InitialSnapshot = {
		origin: "real-turn",
		capturedAt: new Date("2026-07-10T12:00:00Z"),
		groups: [piGroup],
		totalTokens: piGroup.totalTokens,
	};
	const theme = createTheme();
	const view = new InjectionsView(theme, { snapshot: styledSnapshot }, () => {});

	let lines = view.render(80);
	assert.equal(lines[1], "");
	assert.equal(lines.at(-2), "");
	const headerIndex = lines.findIndex((line) => stripSgr(line).includes("Context Injections"));
	const tabIndex = lines.findIndex((line) => stripSgr(line).includes("Context Injections · [INITIAL]"));
	assert.ok(headerIndex >= 0 && tabIndex === headerIndex);
	assert.equal(lines[headerIndex + 1], "");
	assert.equal(stripSgr(lines[headerIndex] ?? "").indexOf("Context Injections"), 0);
	assert.equal(stripSgr(lines[tabIndex] ?? ""), "Context Injections · [INITIAL]");
	// Chalk emits bold SGR only on capable terminals, so derive the environment-specific nested style.
	assert.ok((lines[tabIndex] ?? "").includes(theme.fg("mdHeading", theme.bold("[INITIAL]"))));
	// Runtime stays hidden until the runtime-inspection roadmap step.
	assert.ok(!lines.some((line) => stripSgr(line).includes("RUNTIME")));
	assert.ok(!lines.some((line) => stripSgr(line).includes("Runtime Logging:")));
	const selectedGroup = lines.find((line) => stripSgr(line).includes("→ pi"));
	assert.ok(selectedGroup !== undefined);
	assert.equal(stripSgr(selectedGroup).indexOf("→"), 0);
	assert.match(selectedGroup, /\u001b\[38;2;1;2;3m→ /);
	assert.match(selectedGroup, /\u001b\[38;2;1;2;3m60/);
	assert.match(stripSgr(selectedGroup), /→ pi \.{2,}\s+60/);
	assert.doesNotMatch(selectedGroup, /\u001b\[48;/);
	const parentLine = lines.find((line) => stripSgr(line).includes("parent with a moderately"));
	const childLine = lines.find((line) => stripSgr(line).includes("child with a moderately"));
	assert.match(stripSgr(parentLine ?? ""), /^  ├─ parent/);
	assert.match(parentLine ?? "", /\u001b\[38;2;16;17;18m├─ /);
	assert.match(parentLine ?? "", /\u001b\[38;2;7;8;9mparent/);
	assert.match(parentLine ?? "", /\u001b\[38;2;7;8;9m50/);
	assert.match(stripSgr(childLine ?? ""), /^  │  └─ child/);
	assert.match(childLine ?? "", /\u001b\[38;2;16;17;18m│  └─ /);
	assert.match(childLine ?? "", /\u001b\[38;2;16;17;18mchild/);
	assert.match(childLine ?? "", /\u001b\[38;2;7;8;9m20/);
	const siblingLine = lines.find((line) => stripSgr(line).includes("sibling with a moderately"));
	assert.match(stripSgr(siblingLine ?? ""), /^  └─ sibling/);

	const alignedValues = [
		["→ pi", "60"],
		["parent with", "50"],
		["child with", "20"],
		["sibling with", "10"],
	].map(([label, value]) => {
		const line = lines.map(stripSgr).find((candidate) => candidate.includes(label));
		assert.ok(line !== undefined);
		return line.lastIndexOf(value);
	});
	assert.equal(new Set(alignedValues).size, 1);
	assert.ok((alignedValues[0] ?? 80) < 64, "the capped token column stays near the hierarchy");

	// TOTAL is the final table row and sums the snapshot without double-counting children.
	const totalRowIndex = lines.findIndex((line) => stripSgr(line).includes("TOTAL"));
	const descIndex = lines.findIndex((line) => stripSgr(line).includes("Injections into the model context"));
	assert.ok(totalRowIndex >= 0 && totalRowIndex < descIndex);
	assert.equal(lines[totalRowIndex - 1], "");
	assert.equal(stripSgr(lines[totalRowIndex] ?? "").indexOf("TOTAL"), 2);
	assert.match(stripSgr(lines[totalRowIndex] ?? ""), /TOTAL \.{2,}\s+60/);
	assert.doesNotMatch(stripSgr(lines[totalRowIndex] ?? ""), /→/);

	view.handleInput("\u001b[B");
	view.handleInput("\u001b[B");
	lines = view.render(80);
	const selectedChild = lines.find((line) => stripSgr(line).includes("→ │  └─ child"));
	assert.ok(selectedChild !== undefined);
	assert.equal(stripSgr(selectedChild).indexOf("→"), 0);
	assert.match(selectedChild, /\u001b\[38;2;16;17;18m│  └─ /);
	assert.match(selectedChild, /\u001b\[38;2;1;2;3mchild/);
	assert.match(selectedChild, /\u001b\[38;2;1;2;3m20/);

	const descriptionIndex = lines.findIndex((line) => stripSgr(line).includes("Injections into the model context"));
	const hintsIndex = lines.findIndex((line) => stripSgr(line).includes("↑↓/jk Navigate"));
	assert.ok(descriptionIndex > 0 && hintsIndex === descriptionIndex + 2);
	assert.equal(lines[descriptionIndex - 1], "");
	assert.equal(lines[descriptionIndex + 1], "");
	assert.equal(stripSgr(lines[descriptionIndex] ?? "").indexOf("Injections into"), 2);
	assert.equal(stripSgr(lines[hintsIndex] ?? "").indexOf("↑↓"), 2);
	assert.match(lines[descriptionIndex] ?? "", /\u001b\[38;2;16;17;18m  Injections into/);
	assert.match(lines[hintsIndex] ?? "", /\u001b\[38;2;16;17;18m↑↓/);
	assert.match(lines[hintsIndex] ?? "", /\u001b\[38;2;7;8;9m Navigate/);
	assert.doesNotMatch(stripSgr(lines[hintsIndex] ?? ""), /Switch Tabs|←→\/Tab/);
	assert.match(lines[hintsIndex] ?? "", / · /);
	assert.doesNotMatch(stripSgr(lines[hintsIndex] ?? ""), /Toggle Runtime|\bR\b/);
});

test("InjectionsView wraps narrow descriptions instead of truncating them", () => {
	const lines = createView(4).render(40).map(stripSgr);
	const descriptionStart = lines.findIndex((line) => line.includes("Injections into the model context"));
	const hintsIndex = lines.findIndex((line) => line.includes("↑↓/jk Navigate"));

	assert.ok(descriptionStart >= 0 && hintsIndex > descriptionStart);
	assert.equal(lines[hintsIndex - 1], "");
	const descriptionLines = lines.slice(descriptionStart, hintsIndex - 1);
	assert.ok(descriptionLines.length > 1);
	assert.ok(descriptionLines.every((line) => line.startsWith("  ")));
	assert.equal(
		descriptionLines.map((line) => line.trim()).join(" "),
		"Injections into the model context for the first turn, with token estimates.",
	);
	assert.doesNotMatch(descriptionLines.join("\n"), /…/);
});

test("InjectionsView keeps the description while the list window stays readable", () => {
	const scrollCounter = /\(\d+\/\d+\)/;
	const visibleRowCount = (lines: string[]) => lines.filter((line) => /\s[\d,]+$/.test(line)).length;
	// Sixteen items per group build a 36-row list, so it outgrows the 26-row description floor.
	let rows = 46;
	const view = createView(16, undefined, () => rows);
	const full = view.render(80).map(stripSgr);
	assert.ok(full.some((line) => line.includes("Injections into the model context")));
	assert.ok(!full.some((line) => scrollCounter.test(line)), "every row fits beside the description");

	// A scrolling list keeps its description: the counter alone never collapses it.
	rows = 37;
	const scrolled = view.render(80).map(stripSgr);
	assert.ok(scrolled.some((line) => line.includes("Injections into the model context")));
	assert.ok(scrolled.some((line) => scrollCounter.test(line)));

	// One row further, the window would drop below the floor, so the description goes whole.
	rows = 36;
	const descriptionless = view.render(80).map(stripSgr);
	assert.ok(!descriptionless.some((line) => line.includes("Injections into")));
	const hintsIndex = descriptionless.findIndex((line) => line.includes("↑↓/jk Navigate"));
	assert.equal(hintsIndex, descriptionless.length - 3, "the hints keep their place below one blank row");
	assert.equal(descriptionless[hintsIndex - 1], "", "the description takes its separating blank row with it");
	assert.ok(
		visibleRowCount(descriptionless) > visibleRowCount(scrolled),
		"the freed rows go to the list",
	);

	// Growing the terminal restores the collapsed description.
	rows = 46;
	assert.deepEqual(view.render(80).map(stripSgr), full);
});

test("InjectionsView keeps the description for lists shorter than the floor", () => {
	// Two items per group build an 8-row list, so the floor is the list itself.
	let rows = 18;
	const view = createView(2, undefined, () => rows);
	assert.ok(view.render(80).map(stripSgr).some((line) => line.includes("Injections into the model context")));

	rows = 17;
	const collapsed = view.render(80).map(stripSgr);
	assert.ok(!collapsed.some((line) => line.includes("Injections into")));
	assert.ok(collapsed.some((line) => line.includes("↑↓/jk Navigate")), "the hints never collapse");
});

test("InjectionsView adds degraded INITIAL capture to the dialog description", () => {
	const plain = createView(4);
	const plainLines = plain.render(80);
	const plainInitialIndex = plainLines.findIndex((line) => stripSgr(line).includes("INITIAL"));
	assert.ok(plainInitialIndex >= 0);
	assert.equal(stripSgr(plainLines[plainInitialIndex] ?? ""), "Context Injections · [INITIAL]");
	assert.ok(!plainLines.some((line) => stripSgr(line).includes("Degraded:")));

	const reason = "Silent probe unavailable: no model is selected. Extension additions were not observed.";
	// Tall enough for the wrapped reason, the whole list, and the description block at both widths.
	const degraded = createView(4, reason, () => 40);
	const degradedLines = degraded.render(80);
	const degradedInitialIndex = degradedLines.findIndex((line) => stripSgr(line).includes("INITIAL"));
	assert.ok(degradedInitialIndex >= 0);
	assert.equal(stripSgr(degradedLines[degradedInitialIndex] ?? ""), "Context Injections · [INITIAL]");
	assert.equal(degradedLines[degradedInitialIndex + 1], "");
	assert.match(stripSgr(degradedLines[degradedInitialIndex + 2] ?? ""), /Silent probe unavailable/);

	const descriptionIndex = degradedLines.findIndex((line) =>
		stripSgr(line).includes("Injections into the model context"),
	);
	assert.ok(descriptionIndex >= 0);
	const degradedDescription = degradedLines[descriptionIndex + 1] ?? "";
	assert.equal(stripSgr(degradedDescription), "  [Degraded: pi-native fallback used]");
	assert.match(degradedDescription, /\u001b\[38;2;170;187;204m  \[Degraded: pi-native fallback used\]/);

	const narrowLines = degraded.render(24).map(stripSgr);
	const degradedStart = narrowLines.findIndex((line) => line.includes("[Degraded:"));
	const hintsIndex = narrowLines.findIndex((line) => line.includes("↑↓/jk Navigate"));
	assert.ok(degradedStart >= 0 && hintsIndex > degradedStart);
	const wrappedDegradedLines = narrowLines.slice(degradedStart, hintsIndex - 1);
	assert.ok(wrappedDegradedLines.length > 1);
	assert.equal(
		wrappedDegradedLines.map((line) => line.trim()).join(" "),
		"[Degraded: pi-native fallback used]",
	);
	assert.doesNotMatch(wrappedDegradedLines.join("\n"), /…/);
});

test("InjectionsView keeps Runtime inactive when label-switch keys are pressed", () => {
	const view = createView(4);
	const initial = view.render(80);

	for (const key of ["\u001b[C", "\u001b[D", "\t", "\u001b[Z"]) {
		view.handleInput(key);
		assert.equal(view.render(80), initial);
	}
	assert.ok(initial.some((line) => stripSgr(line).includes("Context Injections · [INITIAL]")));
	assert.ok(!initial.some((line) => stripSgr(line).includes("RUNTIME")));
});

test("InjectionsView keeps every rendered line within the width", () => {
	for (const width of [24, 40, 60, 80, 120]) {
		const view = createView(8, "Silent probe unavailable: no model is selected. Extension additions were not observed.");
		const listLines = view.render(width);
		for (const line of listLines) {
			assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
		}
		if (width === 24) {
			const plain = listLines.map(stripSgr);
			const titleIndex = plain.indexOf("Context Injections");
			const tabsIndex = plain.indexOf("[INITIAL]");
			assert.ok(titleIndex >= 0 && tabsIndex === titleIndex + 2);
			assert.equal(plain[titleIndex + 1], "");
			assert.equal(plain[tabsIndex + 1], "");
		}
		view.handleInput("\u001b[B"); // select first item row
		view.handleInput("\r"); // open preview
		for (const line of view.render(width)) {
			assert.ok(visibleWidth(line) <= width, `preview line exceeds width ${width}: ${JSON.stringify(line)}`);
		}
	}
});

test("InjectionsView reflows on height-only resize and bounds very short output", () => {
	let terminalRows = 30;
	const reason = "Silent probe unavailable: no model is selected. Extension additions were not observed.";
	const view = createView(30, reason, () => terminalRows);

	const tall = view.render(40);
	assert.equal(tall.length, 30);
	assert.ok(tall.some((line) => stripSgr(line).includes("Silent probe unavailable")));

	terminalRows = 18;
	const resized = view.render(40);
	assert.equal(resized.length, 18);
	assert.notStrictEqual(resized, tall);

	terminalRows = 8;
	const veryShort = view.render(40);
	assert.equal(veryShort.length, 8);
	assert.match(stripSgr(veryShort[0] ?? ""), /^─+$/);
	assert.match(stripSgr(veryShort.at(-1) ?? ""), /^─+$/);

	view.handleInput("\u001b[B");
	view.handleInput("\r");
	const shortPreview = view.render(40);
	assert.equal(shortPreview.length, 8);
	assert.match(stripSgr(shortPreview.at(-1) ?? ""), /^─+$/);
});

test("InjectionsView preview opens on items, scrolls, and returns to the same row", () => {
	let closed = false;
	const view = new InjectionsView(createTheme(), { snapshot: snapshot(8) }, () => {
		closed = true;
	});

	// Enter on a group row does nothing.
	view.handleInput("\r");
	assert.doesNotMatch(view.render(80).join("\n"), /pi-0 preview line/);

	// Select the second item row and open its preview.
	view.handleInput("\u001b[B");
	view.handleInput("\u001b[B");
	const listBefore = view.render(80).join("\n");
	view.handleInput("\r");
	const previewLines = view.render(80);
	const preview = previewLines.join("\n");
	assert.doesNotMatch(preview, /Raw captured text/);
	assert.match(preview, /pi-1 preview line 0/);
	assert.match(preview, /\(\d+\/\d+\)/);
	const previewHeaderIndex = previewLines.findIndex((line) => stripSgr(line).includes("tokens"));
	const firstContentIndex = previewLines.findIndex((line) => stripSgr(line).includes("preview line 0"));
	assert.ok(previewHeaderIndex >= 0 && firstContentIndex === previewHeaderIndex + 2);
	// Preview content is indented two spaces.
	assert.equal(stripSgr(previewLines[firstContentIndex] ?? "").indexOf("pi-1"), 2);
	assert.equal(previewLines[previewHeaderIndex + 1], "");
	const hintIndex = previewLines.findIndex((line) => stripSgr(line).includes("↑↓/jk Scroll"));
	assert.ok(hintIndex > 0);
	assert.equal(previewLines[hintIndex - 1], "");

	// Scrolling changes the visible window; Escape returns to the unchanged list.
	view.handleInput("\u001b[6~"); // PgDn
	const scrolled = view.render(80).join("\n");
	assert.notEqual(scrolled, preview);
	assert.doesNotMatch(scrolled, /preview line 0 /);
	view.handleInput("\u001b[4~"); // End
	assert.match(stripSgr(view.render(80).join("\n")), /\((\d+)\/\1\)/);

	view.handleInput("\u001b");
	assert.equal(closed, false);
	assert.equal(view.render(80).join("\n"), listBefore);

	// A fresh preview starts back at the top.
	view.handleInput("\r");
	assert.match(view.render(80).join("\n"), /preview line 0 /);
});

test("InjectionsView preview labels every known section", () => {
	const snippet = "\n- search: Search the web";
	const guidelines = "\n- Use search when the user asks for current information\n- Cite sources";
	const definition = 'search: Search\n{"q":"string"}';
	const sectioned: InjectionItem = {
		...item("search", "npm:web", false, 30),
		kind: "tool",
		text: `${snippet}${guidelines}${definition}`,
		sections: [
			{ label: "Prompt Snippet", text: snippet, tokens: 6 },
			{ label: "Guidelines", text: guidelines, tokens: 17 },
			{ label: "Definition", text: definition, tokens: 7 },
		],
	};
	const plain: InjectionItem = {
		...item("read", "npm:web", false, 7),
		kind: "tool",
		text: definition,
		sections: [{ label: "Definition", text: definition, tokens: 7 }],
	};
	const toolGroup = group("npm:web", false, [sectioned, plain]);
	const theme = createTheme();
	const view = new InjectionsView(theme, {
		snapshot: {
			origin: "real-turn",
			capturedAt: new Date("2026-07-10T12:00:00Z"),
			groups: [toolGroup],
			totalTokens: toolGroup.totalTokens,
		},
	}, () => {});

	view.handleInput("\u001b[B");
	view.handleInput("\r");
	for (const width of [60, 80, 120]) {
		const rendered = view.render(width);
		for (const line of rendered) {
			assert.ok(visibleWidth(line) <= width, `preview line exceeds width ${width}: ${line}`);
		}
		assert.match(rendered.map((line) => stripSgr(line)).join("\n"), /Prompt Snippet · 6 tokens/);
	}
	const lines = view.render(80);
	const plainLines = lines.map((line) => stripSgr(line));
	const snippetIndex = plainLines.indexOf("  Prompt Snippet · 6 tokens");
	const guidelinesIndex = plainLines.indexOf("  Guidelines · 17 tokens");
	const definitionIndex = plainLines.indexOf("  Definition · 7 tokens");
	assert.ok(snippetIndex > 0, "missing Prompt Snippet subheader");
	assert.ok(guidelinesIndex > snippetIndex, "Guidelines does not follow Prompt Snippet");
	assert.ok(definitionIndex > guidelinesIndex, "Definition does not follow Guidelines");
	// Parts use syntaxKeyword, leaving mdHeading to the headings they nest under.
	assert.ok((lines[guidelinesIndex] ?? "").includes(theme.fg("syntaxKeyword", theme.bold("Guidelines"))));
	assert.ok((lines[guidelinesIndex] ?? "").includes(theme.fg("muted", " · 17 tokens")));
	// Section bodies start directly below their subheader, separated only between sections.
	assert.equal(plainLines[snippetIndex + 1], "  - search: Search the web");
	assert.equal(plainLines[guidelinesIndex + 1], "  - Use search when the user asks for current information");
	assert.equal(plainLines[guidelinesIndex + 2], "  - Cite sources");
	assert.equal(plainLines[guidelinesIndex - 1], "");
	assert.equal(plainLines[definitionIndex + 1], "  search: Search");

	// A single known section retains the same labeled structure.
	view.handleInput("\u001b");
	view.handleInput("\u001b[B");
	view.handleInput("\r");
	const singleSection = view.render(80).map((line) => stripSgr(line));
	const singleDefinitionIndex = singleSection.indexOf("  Definition · 7 tokens");
	assert.ok(singleDefinitionIndex > 0, "missing Definition subheader");
	assert.equal(singleSection[singleDefinitionIndex + 1], "  search: Search");
});

test("InjectionsView preview expands the JSON runs the model marks", () => {
	const heading = "search: Search\n";
	const definition = `${heading}{"type":"object","properties":{"q":{"type":"string"}}}`;
	const schemaTool: InjectionItem = {
		...item("search", "npm:web", false, 30),
		kind: "tool",
		text: definition,
		sections: [{
			label: "Definition",
			text: definition,
			tokens: 30,
			jsonSpan: { start: heading.length, end: definition.length },
		}],
	};
	const content = '[{"type":"text","text":"injected"}]';
	const serializedMessage: InjectionItem = {
		...item("context message", "npm:web", false, 9),
		text: content,
		jsonSpan: { start: 0, end: content.length },
	};
	const toolGroup = group("npm:web", false, [schemaTool, serializedMessage]);
	const view = new InjectionsView(createTheme(), {
		snapshot: {
			origin: "real-turn",
			capturedAt: new Date("2026-07-10T12:00:00Z"),
			groups: [toolGroup],
			totalTokens: toolGroup.totalTokens,
		},
	}, () => {});

	// The item preview is full content, so a labeled part expands its marked schema.
	view.handleInput("\u001b[B");
	view.handleInput("\r");
	const sectionLines = view.render(80).map((line) => stripSgr(line));
	const definitionIndex = sectionLines.indexOf("  Definition · 30 tokens");
	assert.ok(definitionIndex > 0, "missing Definition subheader");
	assert.equal(sectionLines[definitionIndex + 1], "  search: Search");
	assert.equal(sectionLines[definitionIndex + 2], "  {");
	assert.equal(sectionLines[definitionIndex + 3], '    "type": "object",');

	// An item without parts expands the whole marked text.
	view.handleInput("\u001b");
	view.handleInput("\u001b[B");
	view.handleInput("\r");
	const messageLines = view.render(80).map((line) => stripSgr(line));
	assert.ok(messageLines.includes("  ["));
	assert.ok(messageLines.includes('      "text": "injected"'));
	assert.ok(!messageLines.some((line) => line.includes('[{"type"')));
});

test("InjectionsView preview separates aggregate children and expands each child's JSON", () => {
	const schema = '{"type":"object","properties":{"path":{"type":"string"}}}';
	const child = (name: string, tokens: number): InjectionItem => {
		const heading = `${name}: Do ${name} things\n`;
		const text = `${heading}${schema}`;
		return {
			...item(name, "pi", true, tokens),
			kind: "tool",
			label: name,
			text,
			sections: [{
				label: "Definition",
				text,
				tokens,
				jsonSpan: { start: heading.length, end: text.length },
			}],
		};
	};
	const bash = child("bash", 20);
	const read = child("read", 14);
	const builtin: InjectionItem = {
		...item("tool:builtin", "pi", true, 34),
		kind: "tool",
		label: "Built-in Tools (2)",
		text: `${bash.text}\n${read.text}`,
		sections: [
			{ label: "bash", text: bash.text, tokens: 20, jsonSpan: bash.sections?.[0]?.jsonSpan },
			{
				label: "read",
				text: `\n${read.text}`,
				tokens: 14,
				jsonSpan: { start: 1 + (read.sections?.[0]?.jsonSpan?.start ?? 0), end: 1 + read.text.length },
			},
		],
		children: [bash, read],
	};
	const piGroup = group("pi", true, [builtin]);
	const view = new InjectionsView(createTheme(), {
		snapshot: {
			origin: "real-turn",
			capturedAt: new Date("2026-07-10T12:00:00Z"),
			groups: [piGroup],
			totalTokens: piGroup.totalTokens,
		},
	}, () => {}, () => 40);

	view.handleInput("\u001b[B");
	view.handleInput("\r");
	const lines = view.render(80).map((line) => stripSgr(line));

	// Every child keeps its own subheader, token share, and expanded schema.
	const bashIndex = lines.indexOf("  bash · 20 tokens");
	const readIndex = lines.indexOf("  read · 14 tokens");
	assert.ok(bashIndex > 0 && readIndex > bashIndex, "missing per-child subheaders");
	assert.equal(lines[bashIndex + 1], "  bash: Do bash things");
	assert.equal(lines[bashIndex + 2], "  {");
	assert.equal(lines[readIndex + 1], "  read: Do read things");
	assert.equal(lines[readIndex + 2], "  {");
	assert.ok(!lines.some((line) => line.includes('{"type":"object"')), "schema left compact");
	// One blank row separates the children instead of running them together.
	assert.equal(lines[readIndex - 1], "");
	assert.notEqual(lines[readIndex - 2], "");
});

test("InjectionsView invalidation rebuilds theme-colored section subheaders", () => {
	const theme = createTheme();
	const originalFg = theme.fg.bind(theme);
	let colorCode = 31;
	theme.fg = (color, text) => `\u001b[${colorCode}m${originalFg(color, text)}\u001b[0m`;
	const definition = 'search: Search\n{"q":"string"}';
	const tool: InjectionItem = {
		...item("search", "npm:web", false, 7),
		kind: "tool",
		text: definition,
		sections: [{ label: "Definition", text: definition, tokens: 7 }],
	};
	const toolGroup = group("npm:web", false, [tool]);
	const view = new InjectionsView(theme, {
		snapshot: {
			origin: "real-turn",
			capturedAt: new Date("2026-07-10T12:00:00Z"),
			groups: [toolGroup],
			totalTokens: toolGroup.totalTokens,
		},
	}, () => {});

	view.handleInput("\u001b[B");
	view.handleInput("\r");
	const findSubheader = (): string | undefined =>
		view.render(80).find((line) => stripSgr(line).includes("Definition · 7 tokens"));
	assert.match(findSubheader() ?? "", /\u001b\[31m/);

	colorCode = 32;
	view.invalidate();
	const recolored = findSubheader() ?? "";
	assert.match(recolored, /\u001b\[32m/);
	assert.doesNotMatch(recolored, /\u001b\[31m/);
});

test("InjectionsView accepts j/k wherever it accepts the arrow keys", () => {
	let closed = false;
	const arrows = createView(8);
	const vim = new InjectionsView(createTheme(), { snapshot: snapshot(8) }, () => {
		closed = true;
	}, () => 24);
	const frame = (view: InjectionsView) => view.render(80).join("\n");

	// Both views must render once so the viewport size is known before any input.
	const start = frame(vim);
	assert.equal(frame(arrows), start);

	// List navigation: j and k move exactly like Down and Up.
	for (let step = 0; step < 3; step++) {
		arrows.handleInput("\u001b[B");
		vim.handleInput("j");
	}
	assert.notEqual(frame(vim), start);
	assert.match(stripSgr(frame(vim)), /→ ├─ pi-2/);
	assert.equal(frame(vim), frame(arrows));
	arrows.handleInput("\u001b[A");
	vim.handleInput("k");
	assert.match(stripSgr(frame(vim)), /→ ├─ pi-1/);
	assert.equal(frame(vim), frame(arrows));

	// Preview scrolling: j and k move the wrapped text, and neither key closes the view.
	arrows.handleInput("\r");
	vim.handleInput("\r");
	const previewTop = frame(vim);
	assert.equal(previewTop, frame(arrows));
	for (let step = 0; step < 4; step++) {
		arrows.handleInput("\u001b[B");
		vim.handleInput("j");
	}
	assert.notEqual(frame(vim), previewTop);
	assert.equal(frame(vim), frame(arrows));
	arrows.handleInput("\u001b[A");
	vim.handleInput("k");
	assert.equal(frame(vim), frame(arrows));
	assert.equal(closed, false);

	const hints = frame(vim).split("\n").map(stripSgr);
	assert.ok(hints.some((line) => line.includes("↑↓/jk Scroll")));
});

test("InjectionsView accepts Ctrl+u/d wherever it accepts the page keys", () => {
	const pageKeys = createView(30);
	const aliases = createView(30);
	const frame = (view: InjectionsView) => view.render(80).join("\n");

	// Both views must render once so the viewport size is known before any input.
	const listTop = frame(aliases);
	assert.equal(frame(pageKeys), listTop);

	pageKeys.handleInput("\u001b[6~"); // PgDn
	aliases.handleInput("\u0004"); // Ctrl+D
	assert.notEqual(frame(aliases), listTop);
	assert.equal(frame(aliases), frame(pageKeys));
	pageKeys.handleInput("\u001b[5~"); // PgUp
	aliases.handleInput("\u0015"); // Ctrl+U
	assert.equal(frame(aliases), listTop);
	assert.equal(frame(pageKeys), listTop);

	pageKeys.handleInput("\u001b[B");
	aliases.handleInput("\u001b[B");
	pageKeys.handleInput("\r");
	aliases.handleInput("\r");
	const previewTop = frame(aliases);
	assert.equal(frame(pageKeys), previewTop);

	pageKeys.handleInput("\u001b[6~");
	aliases.handleInput("\u0004");
	assert.notEqual(frame(aliases), previewTop);
	assert.equal(frame(aliases), frame(pageKeys));
	pageKeys.handleInput("\u001b[5~");
	aliases.handleInput("\u0015");
	assert.equal(frame(aliases), previewTop);
	assert.equal(frame(pageKeys), previewTop);
});

test("InjectionsView scrolls with the mouse wheel and honors pi's own wheel step", () => {
	// Fullscreen pi forwards wheel reports to the focused overlay as raw SGR sequences.
	const wheelUp = "\u001b[<64;20;5M";
	const wheelDown = "\u001b[<65;20;5M";
	const arrows = createView(8);
	const wheel = new InjectionsView(createTheme(), { snapshot: snapshot(8) }, () => {}, () => 24, 4);
	const frame = (view: InjectionsView) => view.render(80).join("\n");

	// Both views must render once so the viewport size is known before any input.
	const start = frame(wheel);
	assert.equal(frame(arrows), start);

	// List: one notch selects one row, regardless of the scroll step.
	arrows.handleInput("\u001b[B");
	wheel.handleInput(wheelDown);
	assert.match(stripSgr(frame(wheel)), /→ ├─ pi-0/);
	assert.equal(frame(wheel), frame(arrows));

	// Preview: one notch scrolls pi's own line step.
	arrows.handleInput("\r");
	wheel.handleInput("\r");
	const previewTop = frame(wheel);
	assert.equal(frame(arrows), previewTop);
	for (let step = 0; step < 4; step++) arrows.handleInput("\u001b[B");
	wheel.handleInput(wheelDown);
	assert.notEqual(frame(wheel), previewTop);
	assert.equal(frame(wheel), frame(arrows));
	for (let step = 0; step < 4; step++) arrows.handleInput("\u001b[A");
	wheel.handleInput(wheelUp);
	assert.equal(frame(wheel), previewTop);
	assert.equal(frame(arrows), previewTop);
});

test("InjectionsView navigation scrolls the non-selectable total and Escape closes", () => {
	let closed = false;
	const view = new InjectionsView(createTheme(), { snapshot: snapshot(30) }, () => {
		closed = true;
	});

	const initialLines = view.render(80);
	const scrollIndicator = initialLines.find((line) => /\(1\/\d+\)/.test(stripSgr(line)));
	assert.ok(scrollIndicator !== undefined);
	assert.match(stripSgr(scrollIndicator), /\(1\/62\)/);
	assert.match(scrollIndicator, /\u001b\[38;2;16;17;18m  \(1\/62\)/);
	const before = initialLines.join("\n");
	view.handleInput("\u001b[B");
	const afterDown = view.render(80).join("\n");
	assert.notEqual(afterDown, before);

	view.handleInput("\u001b[4~"); // End
	const atEnd = view.render(80).join("\n");
	assert.match(stripSgr(atEnd), /→ └─ ext-29/);
	assert.match(atEnd, /TOTAL/);
	assert.doesNotMatch(stripSgr(atEnd), /→ TOTAL/);

	view.handleInput("\u001b[B");
	assert.equal(view.render(80).join("\n"), atEnd);
	view.handleInput("r");
	assert.equal(view.render(80).join("\n"), atEnd);

	view.handleInput("\u001b");
	assert.equal(closed, true);
});
