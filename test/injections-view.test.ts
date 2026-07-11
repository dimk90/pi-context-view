import assert from "node:assert/strict";
import { test } from "node:test";

import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { InitialSnapshot, InjectionGroup, InjectionItem } from "../src/model.ts";
import { InjectionsView, type RuntimeToggle } from "../src/ui/injections-view.ts";

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

function createRuntime(): RuntimeToggle & { enabled: boolean } {
	return {
		enabled: false,
		isEnabled() {
			return this.enabled;
		},
		setEnabled(enabled: boolean) {
			this.enabled = enabled;
		},
	};
}

function createView(itemsPerGroup = 8, degradedReason?: string): InjectionsView {
	return new InjectionsView(
		createTheme(),
		{ snapshot: snapshot(itemsPerGroup), degradedReason, runtime: createRuntime() },
		() => {},
	);
}

/** Remove SGR sequences so tests can inspect visual columns. */
function stripSgr(text: string): string {
	return text.replace(/\u001b\[[\d;]*m/g, "");
}

test("InjectionsView follows pi selector styling and cursor alignment", () => {
	const child = item("child", "pi", true, 20);
	const parent: InjectionItem = { ...item("parent", "pi", true, 50), children: [child] };
	const piGroup = group("pi", true, [parent]);
	const styledSnapshot: InitialSnapshot = {
		origin: "real-turn",
		capturedAt: new Date("2026-07-10T12:00:00Z"),
		groups: [piGroup],
		totalTokens: piGroup.totalTokens,
	};
	const view = new InjectionsView(createTheme(), { snapshot: styledSnapshot, runtime: createRuntime() }, () => {});

	let lines = view.render(80);
	assert.equal(lines[1], "");
	assert.equal(lines.at(-2), "");
	const headerIndex = lines.findIndex((line) => stripSgr(line).includes("Context Injections"));
	const initialIndex = lines.findIndex((line) => stripSgr(line).trim() === "INITIAL");
	assert.ok(headerIndex >= 0 && initialIndex === headerIndex + 2);
	assert.equal(lines[headerIndex + 1], "");
	assert.equal(stripSgr(lines[headerIndex] ?? "").indexOf("Context Injections"), 0);
	assert.equal(stripSgr(lines[initialIndex] ?? "").indexOf("INITIAL"), 0);
	// The INITIAL sub-header uses the theme's mdHeading color.
	assert.match(lines[initialIndex] ?? "", /\u001b\[38;2;22;23;24mINITIAL/);
	assert.match(stripSgr(lines[headerIndex] ?? ""), /Runtime Logging: Off/);
	// "Runtime Logging:" is dim, "Off" is muted.
	assert.match(lines[headerIndex] ?? "", /\u001b\[38;2;16;17;18mRuntime Logging:/);
	assert.match(lines[headerIndex] ?? "", /\u001b\[38;2;7;8;9mOff/);
	assert.ok(!lines.some((line) => stripSgr(line).includes("RUNTIME")));
	const selectedGroup = lines.find((line) => stripSgr(line).includes("→ pi"));
	assert.ok(selectedGroup !== undefined);
	assert.equal(stripSgr(selectedGroup).indexOf("→"), 0);
	assert.match(selectedGroup, /\u001b\[38;2;1;2;3m→ /);
	assert.match(selectedGroup, /\u001b\[38;2;1;2;3m50/);
	assert.doesNotMatch(selectedGroup, /\u001b\[48;/);
	const parentLine = lines.find((line) => stripSgr(line).includes("parent with a moderately"));
	const childLine = lines.find((line) => stripSgr(line).includes("child with a moderately"));
	assert.match(parentLine ?? "", /\u001b\[38;2;7;8;9mparent/);
	assert.match(parentLine ?? "", /\u001b\[38;2;7;8;9m50/);
	assert.match(childLine ?? "", /\u001b\[38;2;16;17;18mchild/);
	assert.match(childLine ?? "", /\u001b\[38;2;7;8;9m20/);

	// TOTAL is a fixed summary outside the scroll area, one blank row below the
	// sections; it sums the whole snapshot (nested children are not double-counted).
	const totalRowIndex = lines.findIndex((line) => stripSgr(line).includes("TOTAL"));
	const descIndex = lines.findIndex((line) => stripSgr(line).includes("Initial injections and estimated"));
	assert.ok(totalRowIndex >= 0 && totalRowIndex < descIndex);
	assert.equal(lines[totalRowIndex - 1], "");
	assert.equal(stripSgr(lines[totalRowIndex] ?? "").indexOf("TOTAL"), 2);
	assert.match(stripSgr(lines[totalRowIndex] ?? ""), /TOTAL\s+50/);

	view.handleInput("\u001b[B");
	view.handleInput("\u001b[B");
	lines = view.render(80);
	const selectedChild = lines.find((line) => stripSgr(line).includes("→     child"));
	assert.ok(selectedChild !== undefined);
	assert.equal(stripSgr(selectedChild).indexOf("→"), 0);
	assert.match(selectedChild, /\u001b\[38;2;1;2;3mchild/);
	assert.match(selectedChild, /\u001b\[38;2;1;2;3m20/);

	const descriptionIndex = lines.findIndex((line) => stripSgr(line).includes("Initial injections and estimated"));
	const hintsIndex = lines.findIndex((line) => stripSgr(line).includes("↑↓ Navigate"));
	assert.ok(descriptionIndex > 0 && hintsIndex === descriptionIndex + 2);
	assert.equal(lines[descriptionIndex - 1], "");
	assert.equal(lines[descriptionIndex + 1], "");
	assert.equal(stripSgr(lines[descriptionIndex] ?? "").indexOf("Initial injections"), 2);
	assert.equal(stripSgr(lines[hintsIndex] ?? "").indexOf("↑↓"), 2);
	assert.match(lines[descriptionIndex] ?? "", /\u001b\[38;2;7;8;9m  Initial injections/);
	assert.match(lines[hintsIndex] ?? "", /\u001b\[38;2;16;17;18m↑↓/);
	assert.match(lines[hintsIndex] ?? "", /\u001b\[38;2;7;8;9m Navigate/);
	assert.match(lines[hintsIndex] ?? "", / · /);
});

test("InjectionsView tags the INITIAL header only when the capture is degraded", () => {
	const plain = createView(4);
	const plainInitial = plain.render(80).find((line) => stripSgr(line).includes("INITIAL"));
	assert.ok(plainInitial !== undefined);
	assert.equal(stripSgr(plainInitial).trim(), "INITIAL");

	const reason = "Silent probe unavailable: no model is selected. Extension additions were not observed.";
	const degraded = createView(4, reason);
	const degradedInitial = degraded.render(80).find((line) => stripSgr(line).includes("INITIAL"));
	assert.ok(degradedInitial !== undefined);
	assert.equal(stripSgr(degradedInitial).trim(), "INITIAL [Degraded: pi-native fallback used]");
	// "Degraded:" is drawn in the error color; the brackets/detail stay dim.
	assert.match(degradedInitial, /\u001b\[38;2;19;20;21mDegraded:/);
	assert.match(degradedInitial, /\u001b\[38;2;16;17;18m pi-native fallback used\]/);
});

test("InjectionsView keeps every rendered line within the width", () => {
	for (const width of [24, 40, 66, 120]) {
		const view = createView(8, "Silent probe unavailable: no model is selected. Extension additions were not observed.");
		for (const line of view.render(width)) {
			assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
		}
		view.handleInput("\u001b[B"); // select first item row
		view.handleInput("\r"); // open preview
		for (const line of view.render(width)) {
			assert.ok(visibleWidth(line) <= width, `preview line exceeds width ${width}: ${JSON.stringify(line)}`);
		}
	}
});

test("InjectionsView preview opens on items, scrolls, and returns to the same row", () => {
	let closed = false;
	const view = new InjectionsView(createTheme(), { snapshot: snapshot(8), runtime: createRuntime() }, () => {
		closed = true;
	});

	// Enter on a group row does nothing.
	view.handleInput("\r");
	assert.doesNotMatch(view.render(80).join("\n"), /Raw captured text/);

	// Select the second item row and open its preview.
	view.handleInput("\u001b[B");
	view.handleInput("\u001b[B");
	const listBefore = view.render(80).join("\n");
	view.handleInput("\r");
	const previewLines = view.render(80);
	const preview = previewLines.join("\n");
	assert.match(preview, /Raw captured text/);
	assert.match(preview, /pi-1 preview line 0/);
	assert.match(preview, /\(\d+\/\d+\)/);
	const previewHeaderIndex = previewLines.findIndex((line) => stripSgr(line).includes("tokens"));
	const firstContentIndex = previewLines.findIndex((line) => stripSgr(line).includes("preview line 0"));
	assert.ok(previewHeaderIndex >= 0 && firstContentIndex === previewHeaderIndex + 2);
	// Preview content is indented two spaces.
	assert.equal(stripSgr(previewLines[firstContentIndex] ?? "").indexOf("pi-1"), 2);
	assert.equal(previewLines[previewHeaderIndex + 1], "");
	const descriptionIndex = previewLines.findIndex((line) => stripSgr(line).includes("Raw captured text"));
	assert.ok(descriptionIndex > 0);
	assert.equal(previewLines[descriptionIndex - 1], "");
	assert.equal(previewLines[descriptionIndex + 1], "");
	assert.match(previewLines[descriptionIndex] ?? "", /\u001b\[38;2;7;8;9m  Raw captured text/);

	// Scrolling changes the visible window; Escape returns to the unchanged list.
	view.handleInput("\u001b[6~"); // PgDn
	const scrolled = view.render(80).join("\n");
	assert.notEqual(scrolled, preview);
	assert.doesNotMatch(scrolled, /preview line 0 /);

	view.handleInput("\u001b");
	assert.equal(closed, false);
	assert.equal(view.render(80).join("\n"), listBefore);

	// A fresh preview starts back at the top.
	view.handleInput("\r");
	assert.match(view.render(80).join("\n"), /preview line 0 /);
});

test("InjectionsView navigation scrolls and Escape closes", () => {
	let closed = false;
	const runtime = createRuntime();
	const view = new InjectionsView(createTheme(), { snapshot: snapshot(30), runtime }, () => {
		closed = true;
	});

	const initialLines = view.render(80);
	const scrollIndicator = initialLines.find((line) => /\(1\/\d+\)/.test(stripSgr(line)));
	assert.ok(scrollIndicator !== undefined);
	assert.match(scrollIndicator, /\u001b\[38;2;16;17;18m  \(1\/\d+\)/);
	const before = initialLines.join("\n");
	view.handleInput("\u001b[B");
	const afterDown = view.render(80).join("\n");
	assert.notEqual(afterDown, before);

	view.handleInput("\u001b[4~"); // End
	const atEnd = view.render(80).join("\n");
	assert.match(stripSgr(atEnd), /→   ext-29/);
	assert.match(atEnd, /TOTAL/);

	view.handleInput("r");
	assert.equal(runtime.enabled, true);
	const enabledLines = view.render(80);
	const enabledHeader = enabledLines.find((line) => stripSgr(line).includes("Runtime Logging: On"));
	assert.ok(enabledHeader !== undefined);
	// "On" switches to accent.
	assert.match(enabledHeader, /\u001b\[38;2;1;2;3mOn/);

	view.handleInput("\u001b");
	assert.equal(closed, true);
});
