import assert from "node:assert/strict";
import { test } from "node:test";

import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { AGGREGATE_SOURCE, type InjectionSnapshot, type InjectionGroup, type InjectionItem } from "../src/model.ts";
import type { GuardResult } from "../src/snapshot.ts";
import { InjectionsView } from "../src/ui/injections-view.ts";
import { previewBodyLines } from "../src/ui/section-preview.ts";

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
	const theme = new Theme(
		fgColors as ConstructorParameters<typeof Theme>[0],
		bgColors as ConstructorParameters<typeof Theme>[1],
		"truecolor",
	);
	// Chalk disables inverse without a TTY, so mark it visibly instead
	theme.inverse = (text) => `\u001b[7m${text}\u001b[27m`;
	return theme;
}

/** A neutral leaf: the messages and payload-change rows have kinds of their own. */
function item(id: string, sourceId: string, native: boolean, tokens: number): InjectionItem {
	return {
		id,
		kind: "base-prompt",
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

function snapshot(itemsPerGroup: number): InjectionSnapshot {
	const piItems = Array.from({ length: itemsPerGroup }, (_, index) => item(`pi-${index}`, "pi", true, 1_234_567));
	const extensionItems = Array.from({ length: itemsPerGroup }, (_, index) => item(`ext-${index}`, "npm:web", false, 42));
	const groups = [group("pi", true, piItems), group("npm:web", false, extensionItems)];
	return {
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

/** Trimmed status-bar lines of a list frame, from its first field to the blank row below; empty without a bar. */
function statusBar(lines: readonly string[]): string[] {
	const plain = lines.map(stripSgr);
	const start = plain.findIndex((line) => /^ {4}(Change|Changed By|Already|Dropped|Moved|Forced)\b/.test(line));
	if (start < 0) return [];
	const fields: string[] = [];
	for (const line of plain.slice(start)) {
		if (!/^ {4,6}\S/.test(line)) break;
		fields.push(line.trim());
	}
	return fields;
}

test("InjectionsView follows pi selector styling and cursor alignment", () => {
	const child = item("child", "pi", true, 20);
	const parent: InjectionItem = { ...item("parent", "pi", true, 50), children: [child] };
	const sibling = item("sibling", "pi", true, 10);
	const piGroup = group("pi", true, [parent, sibling]);
	const styledSnapshot: InjectionSnapshot = {
		groups: [piGroup],
		totalTokens: piGroup.totalTokens,
	};
	const theme = createTheme();
	const view = new InjectionsView(theme, { snapshot: styledSnapshot }, () => {});

	let lines = view.render(80);
	assert.equal(lines[1], "");
	assert.equal(lines.at(-2), "");
	const headerIndex = lines.findIndex((line) => stripSgr(line).includes("Context Injections"));
	const tabIndex = lines.findIndex((line) => stripSgr(line).includes("Context Injections · [Latest Request]"));
	assert.ok(headerIndex >= 0 && tabIndex === headerIndex);
	assert.equal(lines[headerIndex + 1], "");
	assert.equal(stripSgr(lines[headerIndex] ?? "").indexOf("Context Injections"), 0);
	assert.equal(stripSgr(lines[tabIndex] ?? ""), "Context Injections · [Latest Request]");
	assert.ok((lines[tabIndex] ?? "").includes(theme.fg("mdHeading", theme.bold("[Latest Request]"))));
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
	const totalRowIndex = lines.findIndex((line) => stripSgr(line).includes("TOTAL (Prompt, Tools, Injections)"));
	const descIndex = lines.findIndex((line) => stripSgr(line).includes("Injections into the model context"));
	assert.ok(totalRowIndex >= 0 && totalRowIndex < descIndex);
	assert.equal(lines[totalRowIndex - 1], "");
	assert.equal(stripSgr(lines[totalRowIndex] ?? "").indexOf("TOTAL"), 2);
	assert.match(stripSgr(lines[totalRowIndex] ?? ""), /TOTAL \(Prompt, Tools, Injections\) \.{2,}\s+60/);
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

test("InjectionsView clarifies the total scope and preserves its estimate at narrow widths", () => {
	const tool = { ...item("read", "pi", true, 1_234_567), label: "read" };
	const piGroup = group("pi", true, [tool]);
	const view = new InjectionsView(createTheme(), {
		snapshot: { groups: [piGroup], totalTokens: piGroup.totalTokens },
	}, () => {}, () => 40);

	for (const width of [24, 40, 60, 80, 120]) {
		const lines = view.render(width).map(stripSgr);
		const totalIndex = lines.findIndex((line) => line.startsWith("  TOTAL"));
		const total = lines[totalIndex] ?? "";
		assert.ok(totalIndex >= 0);
		assert.equal(lines[totalIndex - 1], "", "the total keeps its blank separator");
		assert.match(total, /1,234,567$/);
		if (width >= 60) {
			assert.match(total, /^  TOTAL \(Prompt, Tools, Injections\) \.{2,}\s+1,234,567$/);
		} else {
			assert.match(total, /…/, "the label yields space to the full estimate");
		}
		const valueRows = lines.filter((line) => /1,234,567$/.test(line));
		assert.equal(valueRows.length, 3, "the group, tool, and total keep their estimates");
		assert.equal(new Set(valueRows.map(visibleWidth)).size, 1, "the total shares the value column");
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
});

test("InjectionsView pins TOTAL below the viewport through navigation, resize, and preview return", () => {
	let height = 24;
	const data = snapshot(30);
	const view = new InjectionsView(createTheme(), { snapshot: data }, () => {}, () => height);
	for (const width of [24, 60, 80, 120]) {
		for (height of [10, 12, 16, 24, 40, 90, 24]) {
			view.handleInput("\u001b[H");
			let fixedTotal: string | undefined;
			let fixedIndex: number | undefined;
			for (const key of ["", "j", "\u001b[6~", "\u001b[F", "\u001b[<65;20;5M", "\u001b[H"]) {
				view.handleInput(key);
				const frame = view.render(width);
				const plain = frame.map(stripSgr);
				const total = plain.findIndex((line) => line.startsWith("  TOTAL"));
				assert.ok(total >= 0, `${width}x${height}: TOTAL is always visible`);
				assert.equal(plain.filter((line) => line.startsWith("  TOTAL")).length, 1);
				assert.match(plain[total] ?? "", new RegExp(`${data.totalTokens.toLocaleString("en-US")}$`));
				assert.doesNotMatch(plain[total] ?? "", /→|\+\d|-[\d,]+/);
				const selected = plain.findIndex((line) => line.startsWith("→"));
				assert.ok(selected >= 0 && selected < total, "the selected row stays above TOTAL");
				const counter = plain.findIndex((line) => /^  \(\d+\/62\)$/.test(line));
				if (counter >= 0) assert.equal(total, counter + 2, "TOTAL follows the counter and one blank row");
				if (fixedTotal === undefined) {
					fixedTotal = frame[total];
					fixedIndex = total;
				} else {
					assert.equal(frame[total], fixedTotal, "navigation does not change TOTAL");
					assert.equal(total, fixedIndex, "navigation does not move TOTAL");
				}
				assert.ok(frame.length <= height);
				assert.ok(frame.every((line) => visibleWidth(line) <= width));
			}
		}
		height = 24;
		view.handleInput("\u001b[F");
		const before = view.render(width);
		view.handleInput("\r");
		assert.ok(!view.render(width).map(stripSgr).some((line) => line.startsWith("  TOTAL")),
			"the fixed total belongs to the list, not raw previews");
		view.handleInput("\u001b");
		assert.deepEqual(view.render(width), before);
	}
});

test("InjectionsView keeps a fixed zero total when the contribution tree is empty", () => {
	const view = new InjectionsView(createTheme(), {
		snapshot: { groups: [], totalTokens: 0 },
	}, () => {}, () => 24);
	const before = view.render(80);
	assert.match(before.map(stripSgr).join("\n"), /TOTAL \(Prompt, Tools, Injections\) .*0/);
	assert.doesNotMatch(before.map(stripSgr).join("\n"), /→|\(\d+\/\d+\)/);
	for (const key of ["j", "\u001b[F", "\r"]) {
		view.handleInput(key);
		assert.deepEqual(view.render(80), before);
	}
});

test("InjectionsView right-aligns token values across every hierarchy level", () => {
	const children: InjectionItem[] = [
		{ ...item("wide", "pi", true, 1_234_560), label: "wide" },
		{ ...item("small", "pi", true, 7), label: "small 👩‍💻" },
		{ ...item("dropped", "pi", true, 0), label: "dropped", dropped: true },
	];
	const parent: InjectionItem = {
		...item("parent", "pi", true, 1_234_567), label: "parent", children,
	};
	const tool: InjectionItem = { ...item("tool", "npm:web", false, 42), label: "tool" };
	const groups = [group("pi", true, [parent]), group("npm:web", false, [tool])];
	const theme = createTheme();
	const view = new InjectionsView(theme, {
		snapshot: { groups, totalTokens: 1_234_609 },
	}, () => {}, () => 40);

	for (const width of [24, 40, 60, 80, 120]) {
		const lines = view.render(width).map(stripSgr);
		const values = lines.flatMap((line) => {
			const match = /(\d[\d,]*)(?: · Dropped)?$/.exec(line);
			return match === null ? [] : [{ value: match[1], end: visibleWidth(line.slice(0, match.index) + match[1]) }];
		});
		assert.deepEqual(values.map((entry) => entry.value), [
			"1,234,567", "1,234,567", "1,234,560", "7", "0", "42", "42", "1,234,609",
		]);
		assert.equal(new Set(values.map((entry) => entry.end)).size, 1, `right edges at width ${width}`);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}

	for (let step = 0; step < 3; step++) view.handleInput("j");
	const selected = view.render(120).find((line) => stripSgr(line).startsWith("→") && stripSgr(line).includes("small"));
	assert.ok(selected?.includes(theme.fg("accent", "        7")), "the right-aligned selected value stays accent");
	const dropped = view.render(120).map(stripSgr).find((line) => line.includes("dropped"));
	assert.match(dropped ?? "", / {8}0 · Dropped$/, "markers follow the full shared value column");
});

test("InjectionsView keeps the right-aligned value column stable while scrolling and resizing", () => {
	let height = 18;
	const view = createView(30, undefined, () => height);
	for (const width of [24, 60, 80, 120]) {
		view.handleInput("\u001b[H");
		const first = view.render(width).map(stripSgr).find((line) => line.startsWith("→ pi"));
		assert.ok(first !== undefined);
		view.handleInput("\u001b[F");
		const last = view.render(width).map(stripSgr).find((line) => line.startsWith("→ └─ ext-29"));
		assert.ok(last !== undefined);
		assert.equal(visibleWidth(last), visibleWidth(first), `right edge after scrolling at width ${width}`);

		height = 30;
		view.invalidate();
		const resized = view.render(width).map(stripSgr).find((line) => line.startsWith("→ └─ ext-29"));
		assert.ok(resized !== undefined);
		assert.equal(visibleWidth(resized), visibleWidth(first), `right edge after resizing at width ${width}`);
		height = 18;
	}
});

/** A small instruction-file tree with realistic child kinds and no real prompt content. */
function createInstructionFilesView(paths: readonly string[], theme = createTheme()): InjectionsView {
	const children: InjectionItem[] = paths.map((path, index) => ({
		...item(`file-${index}`, "pi", true, 10),
		kind: "context-file",
		label: path,
		text: "Instruction preview fixture",
	}));
	const parent: InjectionItem = {
		...item("files", "pi", true, children.length * 10),
		kind: "context-file",
		label: `Instruction Files (${children.length})`,
		children,
	};
	const piGroup = group("pi", true, [parent]);
	return new InjectionsView(theme, {
		snapshot: { groups: [piGroup], totalTokens: piGroup.totalTokens },
	}, () => {}, () => 40);
}

test("InjectionsView shortens instruction-file paths in the middle, keeping whole trailing directories", () => {
	const view = createInstructionFilesView([
		"~/projects/pi-context-view/.worktree/injection-redesign/AGENTS.md",
		"~/.pi/agent/AGENTS.md",
	]);
	for (const width of [60, 80, 120]) {
		const lines = view.render(width).map(stripSgr);
		assert.ok(lines.some((line) => line.includes("~/…/.worktree/injection-redesign/AGENTS.md")));
		assert.ok(lines.some((line) => line.includes("~/.pi/agent/AGENTS.md")), "short paths stay intact");
		assert.ok(lines.some((line) => line.includes("Instruction Files (2)")), "the parent stays intact");
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		const values = lines.filter((line) => /\s\d+$/.test(line));
		assert.equal(new Set(values.map(visibleWidth)).size, 1, "token alignment is unchanged");
	}
	assert.ok(view.render(40).map(stripSgr).some((line) => line.includes("~/…/AGENTS.md")));
	assert.ok(view.render(24).map(stripSgr).some((line) => line.includes("~/…/AGENTS.md")));
	assert.ok(view.render(20).map(stripSgr).some((line) => line.includes("AGENTS.md")));
});

test("InjectionsView preserves absolute, relative, Windows, and Unicode instruction-file names", () => {
	const cases = [
		["/a-very-long-directory-name/another-long-directory/AGENTS.md", "/…/AGENTS.md"],
		["relative-long-directory/another-long-directory/CLAUDE.md", "…/CLAUDE.md"],
		["C:\\a-very-long-directory-name\\another-long-directory\\AGENTS.md", "C:\\…\\AGENTS.md"],
		["~/a-very-long-directory-name/项目👩‍💻/指令.md", "~/…/项目👩‍💻/指令.md"],
	];
	for (const [path, expected] of cases) {
		const view = createInstructionFilesView([path]);
		const lines = view.render(30).map(stripSgr);
		assert.ok(lines.some((line) => line.includes(expected)), `path tail for ${path}`);
		assert.ok(lines.every((line) => visibleWidth(line) <= 30));
		for (const width of [1, 8, 16, 24, 60, 80, 120]) {
			assert.ok(view.render(width).every((line) => visibleWidth(line) <= width));
		}
	}
	const longName = createInstructionFilesView([`~/directory/${"指令👩‍💻".repeat(20)}.md`]);
	assert.ok(longName.render(24).every((line) => visibleWidth(line) <= 24));
});

test("InjectionsView keeps path shortening render-only, sanitized, and themed on selection", () => {
	const theme = createTheme();
	const path = "~/projects/pi-context-view/.worktree/injection-redesign/AGENTS.md";
	const view = createInstructionFilesView([`\u001b]0;unsafe\u0007${path}`], theme);
	view.handleInput("j");
	view.handleInput("j");
	const before = view.render(60);
	const selected = before.find((line) => stripSgr(line).startsWith("→"));
	assert.ok(selected !== undefined);
	assert.ok(selected.includes(theme.fg("accent", "~/…/.worktree/injection-redesign/AGENTS.md")));
	assert.ok(selected.includes(theme.fg("dim", "   └─ ")));
	assert.doesNotMatch(before.join("\n"), /unsafe|Instruction preview fixture|\u001b\]/);

	view.handleInput("\r");
	const preview = view.render(120).map(stripSgr).join("\n");
	assert.ok(preview.includes(path), "the preview still has the full path");
	assert.ok(preview.includes("Instruction preview fixture"));
	view.handleInput("\u001b");
	view.invalidate();
	assert.deepEqual(view.render(60), before, "return and invalidation preserve selection and rendering");
});

test("InjectionsView does not shorten other slash-containing labels as paths", () => {
	const label = "~/projects/pi-context-view/.worktree/injection-redesign/AGENTS.md";
	const message = { ...item("message", "pi", true, 10), label };
	const piGroup = group("pi", true, [message]);
	const view = new InjectionsView(createTheme(), {
		snapshot: { groups: [piGroup], totalTokens: piGroup.totalTokens },
	}, () => {}, () => 40);
	const lines = view.render(40).map(stripSgr);
	assert.ok(lines.some((line) => line.includes("~/projects/pi-context-view/")));
	assert.ok(!lines.some((line) => line.includes("AGENTS.md")));
});

test("InjectionsView wraps narrow descriptions instead of truncating them", () => {
	const lines = createView(4, undefined, () => 26).render(40).map(stripSgr);
	const descriptionStart = lines.findIndex((line) => line.includes("Injections into the model context"));
	const hintsIndex = lines.findIndex((line) => line.includes("↑↓/jk Navigate"));

	assert.ok(descriptionStart >= 0 && hintsIndex > descriptionStart);
	assert.equal(lines[hintsIndex - 1], "");
	const descriptionLines = lines.slice(descriptionStart, hintsIndex - 1);
	assert.ok(descriptionLines.length > 1);
	assert.ok(descriptionLines.every((line) => line.startsWith("  ")));
	assert.equal(
		descriptionLines.map((line) => line.trim()).join(" "),
		"Injections into the model context, with token estimates.",
	);
	assert.doesNotMatch(descriptionLines.join("\n"), /…/);
});

test("InjectionsView keeps the description while the list window stays readable", () => {
	const scrollCounter = /\(\d+\/\d+\)/;
	const visibleRowCount = (lines: string[]) => lines.filter((line) => /\s[\d,]+$/.test(line)).length;
	// Sixteen items per group build a 34-row list, excluding the fixed footer.
	let rows = 48;
	const view = createView(16, undefined, () => rows);
	const full = view.render(80).map(stripSgr);
	assert.ok(full.some((line) => line.includes("Injections into the model context")));
	assert.ok(!full.some((line) => scrollCounter.test(line)), "every row fits beside the description");

	// A scrolling list keeps its description: the counter alone never collapses it.
	rows = 41;
	const scrolled = view.render(80).map(stripSgr);
	assert.ok(scrolled.some((line) => line.includes("Injections into the model context")));
	assert.ok(scrolled.some((line) => scrollCounter.test(line)));

	// One row further, the window would drop below the floor, so the description goes whole.
	rows = 40;
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
	rows = 48;
	assert.deepEqual(view.render(80).map(stripSgr), full);
});

test("InjectionsView keeps the description for lists shorter than the floor", () => {
	// Two items per group build a 6-row list, so the floor is the list itself.
	let rows = 20;
	const view = createView(2, undefined, () => rows);
	assert.ok(view.render(80).map(stripSgr).some((line) => line.includes("Injections into the model context")));

	rows = 19;
	const collapsed = view.render(80).map(stripSgr);
	assert.ok(!collapsed.some((line) => line.includes("Injections into")));
	assert.ok(collapsed.some((line) => line.includes("↑↓/jk Navigate")), "the hints never collapse");
});

test("InjectionsView adds degraded capture to the dialog description", () => {
	const plain = createView(4);
	const plainLines = plain.render(80);
	const plainHeaderIndex = plainLines.findIndex((line) => stripSgr(line).includes("[Latest Request]"));
	assert.ok(plainHeaderIndex >= 0);
	assert.equal(stripSgr(plainLines[plainHeaderIndex] ?? ""), "Context Injections · [Latest Request]");
	assert.ok(!plainLines.some((line) => stripSgr(line).includes("Degraded:")));

	const reason = "No model is selected.";
	// Tall enough for the wrapped reason, the whole list, and the description block at both widths.
	const degraded = createView(4, reason, () => 40);
	const degradedLines = degraded.render(80);
	const degradedHeaderIndex = degradedLines.findIndex((line) => stripSgr(line).includes("[Latest Request]"));
	assert.ok(degradedHeaderIndex >= 0);
	assert.equal(stripSgr(degradedLines[degradedHeaderIndex] ?? ""), "Context Injections · [Latest Request]");
	assert.equal(degradedLines[degradedHeaderIndex + 1], "");
	assert.match(stripSgr(degradedLines[degradedHeaderIndex + 2] ?? ""), /No model is selected/);

	const descriptionIndex = degradedLines.findIndex((line) =>
		stripSgr(line).includes("Injections into the model context"),
	);
	assert.ok(descriptionIndex >= 0);
	const degradedDescription = degradedLines[descriptionIndex + 1] ?? "";
	assert.equal(stripSgr(degradedDescription), "  Degraded: pi-native fallback used");
	assert.match(degradedDescription, /\u001b\[38;2;170;187;204mDegraded/);
	assert.match(degradedDescription, /\u001b\[38;2;16;17;18m: pi-native fallback used/);

	const narrowLines = degraded.render(24).map(stripSgr);
	const degradedStart = narrowLines.findIndex((line) => line.includes("Degraded:"));
	const hintsIndex = narrowLines.findIndex((line) => line.includes("↑↓/jk Navigate"));
	assert.ok(degradedStart >= 0 && hintsIndex > degradedStart);
	const wrappedDegradedLines = narrowLines.slice(degradedStart, hintsIndex - 1);
	assert.ok(wrappedDegradedLines.length > 1);
	assert.equal(
		wrappedDegradedLines.map((line) => line.trim()).join(" "),
		"Degraded: pi-native fallback used",
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
	assert.ok(initial.some((line) => stripSgr(line).includes("Context Injections · [Latest Request]")));
	assert.ok(!initial.some((line) => stripSgr(line).includes("RUNTIME")));
});

test("InjectionsView keeps title and label on one line down to 37 columns", () => {
	const at = (width: number) => createView(4).render(width).map(stripSgr);
	assert.ok(at(37).includes("Context Injections · [Latest Request]"));
	const split = at(36);
	const titleIndex = split.indexOf("Context Injections");
	assert.ok(titleIndex >= 0);
	assert.deepEqual(split.slice(titleIndex, titleIndex + 4), ["Context Injections", "", "[Latest Request]", ""]);
});

test("InjectionsView keeps every rendered line within the width", () => {
	for (const width of [24, 40, 60, 80, 120]) {
		const view = createView(8, "No model is selected.");
		const listLines = view.render(width);
		for (const line of listLines) {
			assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
		}
		if (width === 24) {
			const plain = listLines.map(stripSgr);
			const titleIndex = plain.indexOf("Context Injections");
			const tabsIndex = plain.indexOf("[Latest Request]");
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
	const reason = "No model is selected.";
	const view = createView(30, reason, () => terminalRows);

	const tall = view.render(40);
	assert.equal(tall.length, 30);
	assert.ok(tall.some((line) => stripSgr(line).includes("No model is selected")));

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

test("preview subsections use two blank rows regardless of captured trailing whitespace", () => {
	for (const trailing of ["", "\n", "\n\n", "\n \n\t\n\n"]) {
		const content = {
			text: "unchanged aggregate",
			sections: [
				{ label: "Preamble", text: `First paragraph\n\nLast paragraph${trailing}`, tokens: 8 },
				{ label: "Guidelines", text: "\n\n- Native rule", tokens: 3 },
			],
		};
		const original = structuredClone(content);
		const lines = previewBodyLines(
			createTheme(), content, 78,
			(text) => text.split("\n").map((line) => `  ${line}`),
		).map(stripSgr);
		assert.deepEqual(lines, [
			"  Preamble · 8 tokens",
			"  First paragraph", "  ", "  Last paragraph",
			"", "",
			"  Guidelines · 3 tokens", "  - Native rule",
		]);
		assert.deepEqual(content, original, "spacing is preview-only");
	}
});

test("preview drops a pi block header its part label already shows", () => {
	const documentation = "\nPi documentation (read only when the user asks about pi itself):\n- Main docs: /pi/README.md";
	const content = {
		text: "unchanged part text",
		sections: [
			{ label: "Available Tools", text: "\nAvailable tools:\n- read: Read file contents", tokens: 11 },
			{ label: "Guidelines", text: "\nGuidelines:\n- Be concise in your responses", tokens: 10 },
			{ label: "Documentation", text: documentation, tokens: 27 },
		],
	};
	const original = structuredClone(content);
	const lines = previewBodyLines(
		createTheme(), content, 78,
		(text) => text.split("\n").map((line) => `  ${line}`),
	).map(stripSgr);

	assert.deepEqual(lines, [
		"  Available Tools · 11 tokens",
		"  - read: Read file contents",
		"", "",
		"  Guidelines · 10 tokens",
		"  - Be concise in your responses",
		"", "",
		"  Documentation · 27 tokens",
		// A header carrying more than its label is content, not a repetition.
		"  Pi documentation (read only when the user asks about pi itself):",
		"  - Main docs: /pi/README.md",
	]);
	assert.deepEqual(content, original, "dropped headers stay part of the measured text");
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
			{ label: "Available Tools", text: snippet, tokens: 6 },
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
		assert.match(rendered.map((line) => stripSgr(line)).join("\n"), /Available Tools · 6 tokens/);
	}
	const lines = view.render(80);
	const plainLines = lines.map((line) => stripSgr(line));
	const snippetIndex = plainLines.indexOf("  Available Tools · 6 tokens");
	const guidelinesIndex = plainLines.indexOf("  Guidelines · 17 tokens");
	const definitionIndex = plainLines.indexOf("  Definition · 7 tokens");
	assert.ok(snippetIndex > 0, "missing Available Tools subheader");
	assert.ok(guidelinesIndex > snippetIndex, "Guidelines does not follow Available Tools");
	assert.ok(definitionIndex > guidelinesIndex, "Definition does not follow Guidelines");
	// Parts use syntaxKeyword, leaving mdHeading to the headings they nest under.
	assert.ok((lines[guidelinesIndex] ?? "").includes(theme.fg("syntaxKeyword", theme.bold("Guidelines"))));
	assert.ok((lines[guidelinesIndex] ?? "").includes(theme.fg("muted", " · 17 tokens")));
	// Section bodies start directly below their subheader, separated only between sections.
	assert.equal(plainLines[snippetIndex + 1], "  - search: Search the web");
	assert.equal(plainLines[guidelinesIndex + 1], "  - Use search when the user asks for current information");
	assert.equal(plainLines[guidelinesIndex + 2], "  - Cite sources");
	assert.deepEqual(plainLines.slice(guidelinesIndex - 2, guidelinesIndex), ["", ""]);
	assert.equal(plainLines[guidelinesIndex - 3], "  - search: Search the web");
	assert.deepEqual(plainLines.slice(definitionIndex - 2, definitionIndex), ["", ""]);
	assert.equal(plainLines[definitionIndex - 3], "  - Cite sources");
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
	// Exactly two blank rows separate children, including expanded JSON bodies
	assert.deepEqual(lines.slice(readIndex - 2, readIndex), ["", ""]);
	assert.equal(lines[readIndex - 3], "  }");
});

test("InjectionsView omits a skill name its heading already shows", () => {
	const skill = (name: string, tokens: number): InjectionItem => ({
		...item(name, "pi", true, tokens),
		kind: "skills",
		label: name,
		text: `${name}\nDo ${name} things\n/skills/${name}/SKILL.md`,
	});
	const codeStyle = skill("code-style", 30);
	const commit = skill("commit", 12);
	const skills: InjectionItem = {
		...item("skills", "pi", true, 42),
		kind: "skills",
		label: "Skills (2)",
		text: `${codeStyle.text}\n${commit.text}`,
		sections: [
			{ label: "code-style", text: codeStyle.text, tokens: 30 },
			{ label: "commit", text: `\n${commit.text}`, tokens: 12 },
		],
		children: [codeStyle, commit],
	};
	const piGroup = group("pi", true, [skills]);
	const view = new InjectionsView(createTheme(), {
		snapshot: {
			groups: [piGroup],
			totalTokens: piGroup.totalTokens,
		},
	}, () => {}, () => 40);

	// Each part of the aggregate preview opens with the description, not the name above it.
	view.handleInput("\u001b[B");
	view.handleInput("\r");
	const aggregate = view.render(80).map((line) => stripSgr(line));
	const styleIndex = aggregate.indexOf("  code-style · 30 tokens");
	const commitIndex = aggregate.indexOf("  commit · 12 tokens");
	assert.ok(styleIndex > 0 && commitIndex > styleIndex, "missing per-child subheaders");
	assert.equal(aggregate[styleIndex + 1], "  Do code-style things");
	assert.equal(aggregate[commitIndex + 1], "  Do commit things");
	assert.deepEqual(aggregate.slice(commitIndex - 2, commitIndex), ["", ""]);
	assert.equal(aggregate[commitIndex - 3], "  /skills/code-style/SKILL.md");

	// The child preview keeps its whole estimate while dropping the same repeated line.
	view.handleInput("\u001b");
	view.handleInput("\u001b[B");
	view.handleInput("\r");
	const child = view.render(80).map((line) => stripSgr(line));
	const headerIndex = child.findIndex((line) => line.includes("30 tokens"));
	assert.ok(headerIndex >= 0 && child[headerIndex]?.includes("code-style"));
	assert.equal(child[headerIndex + 2], "  Do code-style things");
	assert.equal(child[headerIndex + 3], "  /skills/code-style/SKILL.md");
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

test("InjectionsView navigation skips the fixed total and Escape closes", () => {
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
	assert.match(stripSgr(atEnd), /TOTAL \(Prompt, Tools, Injections\)/);
	assert.doesNotMatch(stripSgr(atEnd), /→ TOTAL/);

	view.handleInput("\u001b[B");
	assert.equal(view.render(80).join("\n"), atEnd);
	view.handleInput("r");
	assert.equal(view.render(80).join("\n"), atEnd);

	view.handleInput("\u001b");
	assert.equal(closed, true);
});

/** A snapshot whose items carry each request-only change, one of them with Request and Session parts. */
function changedSnapshot(): InjectionSnapshot {
	const base = (id: string, tokens: number) => ({
		...item(id, "unattributed", false, tokens), text: `${id} text`, requestOnly: true,
	});
	const items: InjectionItem[] = [
		{ ...base("added", 4), label: "added message", change: "added", diff: { added: 4, removed: 0 } },
		{
			...base("modified", 5),
			label: "modified message",
			change: "modified",
			diff: { added: 3, removed: 1_234 },
			sections: [
				{ label: "Request", text: "request version", tokens: 5 },
				{ label: "Session", text: "session original", tokens: 0 },
			],
		},
		{
			...base("deleted", 0), label: "deleted message", text: "deleted original", change: "deleted",
			diff: { added: 0, removed: 6 },
		},
	];
	const changes = { ...group("unattributed", false, items), diff: { added: 7, removed: 1_240 } };
	return { groups: [changes], totalTokens: 9 };
}

test("InjectionsView shows token diffs in right-aligned columns and marks request-only rows", () => {
	const theme = createTheme();
	const saved: InjectionItem = {
		...item("saved", "pi", true, 2), label: "saved section", diff: { added: 2, removed: 0 },
	};
	const changed = changedSnapshot();
	const snapshot: InjectionSnapshot = {
		groups: [{ ...group("pi", true, [saved]), diff: saved.diff }, ...changed.groups],
		totalTokens: changed.totalTokens + saved.tokens,
	};
	const view = new InjectionsView(theme, { snapshot }, () => {}, () => 40);
	const lines = view.render(100);
	const plain = lines.map(stripSgr);
	const row = (label: string) => plain.find((line) => line.includes(label)) ?? "";

	assert.match(row("unattributed"), / 9 {2}\+7 {2}-1,240$/, "a group row is never request-only");
	assert.match(row("saved section"), / 2 {2}\+2$/, "saved text has a diff but no marker");
	assert.match(row("added message"), / 4 {2}\+4 {8} · Request-Only$/, "an added row reads its value as added");
	assert.match(row("modified message"), / 5 {2}\+3 {2}-1,234 · Request-Only$/);
	assert.match(row("deleted message"), / 0 {10}-6 · Request-Only$/, "a deleted row reads 0 with a blank +N column");
	for (const label of ["added message", "modified message", "deleted message"]) {
		assert.equal(row(label).length - " · Request-Only".length, row("unattributed").length,
			`${label}: the columns keep their right edges, and the marker follows them`);
	}
	assert.equal(row("saved section").length, row("unattributed").length - "  -1,240".length,
		"a blank -N column leaves no trailing spaces");
	assert.match(row("TOTAL"), / 11$/, "TOTAL has no diff");
	assert.ok(lines.some((line) => line.includes(theme.fg("toolDiffAdded", "+3"))));
	assert.ok(lines.some((line) => line.includes(theme.fg("toolDiffRemoved", "-1,234"))));
	const marker = `${theme.fg("dim", " · ")}${theme.fg("dim", "Request-Only")}`;
	assert.ok(lines.find((line) => line.includes("deleted message"))?.endsWith(marker), "the marker is dim");
	const selected = lines.find((line) => stripSgr(line).startsWith("→ pi")) ?? "";
	assert.ok(selected.includes(theme.fg("toolDiffAdded", "+2")), "the selected row keeps the diff colors");
	assert.ok(!plain.some((line) => /Added|Modified|Deleted/.test(line)), "rows name no change marker");
	assert.ok(!plain.some((line) => line.startsWith("  - ")), "the status bar, not a legend, explains the rows");
});

test("InjectionsView drops the diff columns whole at narrow widths and keeps markers after them", () => {
	const theme = createTheme();
	const prompt: InjectionItem = {
		...item("base-prompt", "pi", true, 7), label: "System Prompt", change: "forced", diff: { added: 5, removed: 12 },
	};
	const moved: InjectionItem = {
		...item("moved", "pi", true, 3), label: "moved part", moved: true, requestOnly: true,
	};
	const piGroup = { ...group("pi", true, [prompt, moved]), diff: { added: 5, removed: 12 } };
	const view = new InjectionsView(theme, { snapshot: { groups: [piGroup], totalTokens: 10 } }, () => {}, () => 40);

	const wide = view.render(120).map(stripSgr);
	const forced = wide.find((line) => line.includes("System Prompt")) ?? "";
	assert.match(forced, / 7 {2}\+5 {2}-12 · Forced$/);
	assert.match(wide.find((line) => line.includes("moved part")) ?? "", / 3 {10}· Moved · Request-Only$/,
		"blank diff columns keep markers aligned, in legend order");
	assert.ok(!wide.some((line) => line.startsWith("  - ")), "the list has no marker legend");

	for (const width of [24, 40]) {
		const narrow = view.render(width).map(stripSgr);
		assert.ok(narrow.every((line) => visibleWidth(line) <= width));
		assert.ok(!narrow.some((line) => /[+-]\d/.test(line) && !line.startsWith("  ")), `${width}: no diff column`);
		const row = narrow.find((line) => line.includes("System")) ?? "";
		assert.doesNotMatch(row, /\+5|-12/, `${width}: the diff columns drop whole`);
	}
	view.handleInput("j");
	assert.deepEqual(statusBar(view.render(120)), [
		"Change: +5 -12 only in this request; the session keeps the original",
		"Changed By: Unknown",
		"Forced: an extension’s prompt replaced pi’s system prompt for this request",
	]);
	assert.match(statusBar(view.render(40)).join(" "), /^Change: \+5 -12 only/,
		"the bar keeps the diff the row drops at narrow widths");
	view.handleInput("j");
	assert.deepEqual(statusBar(view.render(120)), [
		"Change: only in this request; the session keeps the original",
		"Changed By: Unknown",
		"Moved: in a different position in the system prompt than usual",
	]);
});

test("InjectionsView explains a forced System Prompt in its status bar and preview legend", () => {
	const theme = createTheme();
	const prompt = { ...item("base-prompt", "pi", false, 7), label: "System Prompt", text: "forced text", change: "forced" as const };
	const forced: InjectionSnapshot = {
		groups: [group("pi", false, [prompt])], totalTokens: 7,
	};
	const view = new InjectionsView(theme, { snapshot: forced }, () => {}, () => 40);
	const lines = view.render(100);
	const plain = lines.map(stripSgr);
	assert.match(plain.find((line) => line.includes("System Prompt")) ?? "", /7 · Forced$/);
	assert.ok(lines.some((line) => line.includes(theme.fg("warning", "Forced"))));
	assert.ok(!plain.some((line) => line.startsWith("  - ")), "the list has no marker legend");
	const bullet = "  - Forced prompts replace pi’s system prompt for this request.";

	view.handleInput("\u001b[B");
	const forcedStatus = view.render(100);
	assert.ok(statusBar(forcedStatus).includes("Forced: an extension’s prompt replaced pi’s system prompt for this request"),
		"the status bar explains the selected row's marker");
	assert.ok(forcedStatus.some((line) => line.includes(`${theme.fg("warning", "Forced")}${theme.getFgAnsi("dim")}: an`)));
	view.handleInput("\r");
	const preview = view.render(100).map(stripSgr);
	assert.match(preview.find((line) => line.includes("System Prompt")) ?? "", /7 tokens · Forced/);
	assert.ok(preview.includes(bullet), "the preview legend explains the marker");
});

test("InjectionsView previews counted and zero-token reference parts with responsive diff headers", () => {
	const view = new InjectionsView(createTheme(), { snapshot: changedSnapshot() }, () => {}, () => 40);
	view.handleInput("\u001b[B");
	view.handleInput("\u001b[B");
	view.handleInput("\r");
	const plain = view.render(100).map(stripSgr);

	assert.match(plain.find((line) => line.includes("modified message")) ?? "",
		/5 tokens · \+3 -1,234 · Request-Only $/);
	const request = plain.findIndex((line) => line.trim() === "Request · 5 tokens");
	const session = plain.findIndex((line) => line.trim() === "Session · 0 tokens");
	assert.ok(request >= 0 && session > request);
	assert.equal(plain[request + 1]?.trim(), "request version");
	assert.equal(plain[session + 1]?.trim(), "session original");
	const bullets = plain.filter((line) => line.startsWith("  - ")).map((line) => line.slice(4));
	assert.equal(bullets[0], "+N -N Tokens extensions added or removed, compared with the session.",
		"the preview's diff bullet names its base");
	assert.equal(bullets[1], "Request-Only Includes changes made only in this request, not saved in the session.");
	assert.equal(bullets.length, 2);
	assert.ok(!plain.some((line) => /Added|Modified|Deleted/.test(line)), "Request-Only replaces the change markers");

	// A narrow header drops the marker first, then the diff
	const header = (width: number) => view.render(width).map(stripSgr).find((line) => line.includes("modified")) ?? "";
	assert.match(header(54), /5 tokens · \+3 -1,234 $/);
	assert.match(header(44), /5 tokens $/);
});

test("InjectionsView previews System Prompt parts with their diffs against pi's default prompt", () => {
	const theme = createTheme();
	const part = (id: string, label: string, tokens: number, diff?: InjectionItem["diff"]): InjectionItem => ({
		...item(id, "pi", true, tokens), label, text: `${label} text`, ...(diff === undefined ? {} : { diff }),
	});
	const children: InjectionItem[] = [
		part("preamble", "Preamble", 6),
		part("tools", "Available Tools", 9, { added: 4, removed: 0 }),
		{ ...part("docs", "Documentation", 0, { added: 0, removed: 7 }), change: "deleted", requestOnly: true },
	];
	const prompt: InjectionItem = {
		...part("base-prompt", "System Prompt", 15, { added: 4, removed: 7 }),
		children,
		sections: children.map((child) => ({
			label: child.label, text: child.text, tokens: child.tokens, diff: child.diff,
			change: child.change, requestOnly: child.requestOnly,
		})),
	};
	const piGroup = { ...group("pi", true, [prompt]), diff: { added: 4, removed: 7 } };
	const view = new InjectionsView(theme, { snapshot: { groups: [piGroup], totalTokens: 15 } }, () => {}, () => 40);
	view.handleInput("\u001b[B");
	view.handleInput("\r");
	const lines = view.render(100);
	const plain = lines.map(stripSgr);

	assert.match(plain.find((line) => line.startsWith("System Prompt")) ?? "", /pi · 15 tokens · \+4 -7 $/);
	assert.ok(plain.includes("  Preamble · 6 tokens"), "an unchanged part shows no diff");
	assert.ok(plain.includes("  Available Tools · 9 tokens · +4"), "saved extension text has no marker");
	assert.ok(plain.includes("  Documentation · 0 tokens · -7 · Request-Only"));
	const subheader = lines.find((line) => stripSgr(line).startsWith("  Documentation")) ?? "";
	assert.ok(subheader.includes(`${theme.fg("dim", " · ")}${theme.fg("toolDiffRemoved", "-7")}`));
	assert.deepEqual(plain.filter((line) => line.startsWith("  - ")), [
		"  - +N -N Tokens extensions added or removed, compared with pi’s default prompt.",
		"  - Request-Only Includes changes made only in this request, not saved in the session.",
	]);
});

test("InjectionsView shows a system prompt row's diff without a value and previews its parts", () => {
	const theme = createTheme();
	const tool: InjectionItem = { ...item("tool", "npm:web", false, 1_000), label: "search" };
	const row: InjectionItem = {
		...item("system-prompt:npm:web", "npm:web", false, 0),
		kind: "prompt-addition",
		label: "system prompt",
		diffOnly: true,
		diff: { added: 27, removed: 0 },
		sections: [
			{ label: "Available Tools", text: "\n- search: Search the web", tokens: 0, diffOnly: true,
				diff: { added: 7, removed: 0 } },
			{ label: "Extension Additions", text: "\n\nSearch tips.", tokens: 0, diffOnly: true,
				diff: { added: 20, removed: 0 }, attribution: "guess" },
		],
	};
	const snapshot: InjectionSnapshot = { groups: [group("npm:web", false, [tool, row])], totalTokens: 1_000 };
	let height = 40;
	const view = new InjectionsView(theme, { snapshot }, () => {}, () => height);
	const plain = view.render(100).map(stripSgr);
	const line = (label: string) => plain.find((candidate) => candidate.includes(label)) ?? "";

	assert.match(line("system prompt"), /└─ system prompt \.+ {3}\+27$/, "dots run through the empty value column");
	assert.equal(line("system prompt").length, line("search").length + "  +27".length,
		"the diff column follows the shared value column");
	assert.match(line("TOTAL"), / 1,000$/);
	assert.doesNotMatch(plain.join("\n"), /Search tips/, "raw text stays behind Enter");
	assert.doesNotMatch(view.render(40).map(stripSgr).find((candidate) => candidate.includes("system prompt")) ?? "",
		/\+27|\b0\b/, "a narrow row drops the diff whole without inventing a zero value");

	view.handleInput("\u001b[B");
	view.handleInput("\u001b[B");
	const selected = view.render(100).find((candidate) => stripSgr(candidate).startsWith("→")) ?? "";
	assert.ok(selected.includes(theme.fg("toolDiffAdded", "+27")), "the selected row keeps its diff color");
	view.handleInput("\r");
	const lines = view.render(100);
	const preview = lines.map(stripSgr);
	assert.match(preview.find((candidate) => candidate.startsWith("system prompt")) ?? "",
		/npm:web · \+27 · counted in System Prompt $/, "the header names where the tokens count instead of a value");
	assert.ok(preview.includes("  Available Tools · +7"), "a part shows its diff without a token share");
	assert.ok(preview.includes("  Extension Additions · +20 (guess)"));
	assert.ok(lines.some((candidate) => candidate.includes(theme.fg("dim", " (guess)"))));
	assert.deepEqual(preview.filter((candidate) => candidate.startsWith("  - ") && !candidate.includes("search:")), [
		"  - (guess) sources are inferred from the injected text itself.",
		"  - +N -N Tokens extensions added or removed, compared with pi’s default prompt.",
	]);
	for (const width of [24, 40, 60, 80, 120]) {
		for (height of [12, 24, 40]) {
			const frame = view.render(width);
			assert.ok(frame.length <= height, `${width}x${height}: preview stays within the height`);
			assert.ok(frame.every((candidate) => visibleWidth(candidate) <= width), `${width}x${height}: width`);
		}
	}
	view.handleInput("\u001b");
	assert.match(view.render(100).map(stripSgr).find((candidate) => candidate.startsWith("→")) ?? "",
		/system prompt/, "Escape returns to the same diff-only row");
	for (const width of [24, 40, 60, 80, 120]) {
		for (height of [12, 24, 40]) {
			const frame = view.render(width);
			assert.ok(frame.length <= height, `${width}x${height}: list stays within the height`);
			assert.ok(frame.every((candidate) => visibleWidth(candidate) <= width), `${width}x${height}: width`);
		}
	}
});

test("InjectionsView previews an unattributed system prompt deletion without a token estimate", () => {
	const theme = createTheme();
	const row: InjectionItem = {
		...item("system-prompt:unattributed", "unattributed", false, 0), label: "system prompt", kind: "prompt-addition",
		diffOnly: true, diff: { added: 0, removed: 7 }, requestOnly: true,
		sections: [{ label: "Documentation", text: "Deleted\u001b[2J documentation", tokens: 0, diffOnly: true,
			diff: { added: 0, removed: 7 }, requestOnly: true }],
	};
	const snapshot: InjectionSnapshot = { groups: [group("unattributed", false, [row])], totalTokens: 0 };
	const view = new InjectionsView(theme, { snapshot }, () => {}, () => 40);
	const list = view.render(100).map(stripSgr);
	assert.match(list.find((candidate) => candidate.includes("system prompt")) ?? "",
		/system prompt \.+ {3}-7 · Request-Only$/);
	assert.doesNotMatch(list.join("\n"), /Deleted|documentation/);
	view.handleInput("j");
	view.handleInput("\r");
	const preview = view.render(100).map(stripSgr);
	assert.match(preview.find((candidate) => candidate.startsWith("system prompt")) ?? "",
		/unattributed · -7 · counted in System Prompt · Request-Only $/);
	assert.ok(preview.includes("  Documentation · -7 · Request-Only"));
	assert.ok(preview.includes("  Deleted documentation"), "the removed text is terminal-sanitized");
	assert.doesNotMatch(preview.join("\n"), /0 tokens/);
	assert.match(view.render(70).map(stripSgr)[2] ?? "", /counted in System Prompt $/,
		"a narrow header drops the marker before the accounting note");
	const originalFg = theme.fg.bind(theme);
	theme.fg = (color, text) => originalFg(color === "syntaxKeyword" ? "success" : color, text);
	view.invalidate();
	assert.ok(view.render(100).some((candidate) => candidate.includes(theme.fg("syntaxKeyword", theme.bold("Documentation")))),
		"theme invalidation rebuilds diff-only part subheaders");
});

test("InjectionsView describes a probe snapshot and notes an unavailable payload comparison", () => {
	const theme = createTheme();
	const input = {
		snapshot: snapshot(2),
		probe: true,
		guard: { status: "incomplete", reason: "No provider payload was observed for this request." },
	} as const;
	const lines = new InjectionsView(theme, input, () => {}, () => 40).render(120);
	const plain = lines.map(stripSgr);

	const header = plain.findIndex((line) => line.startsWith("Context Injections · [Request Probe]"));
	assert.match(plain[header] ?? "", /Payload: not checked$/);
	assert.match(plain[header + 2] ?? "", /^→ pi/);
	const description = plain.findIndex((line) => line.includes("Injections into the model context"));
	const probeNote = lines[description + 1] ?? "";
	assert.equal(stripSgr(probeNote),
		"  - Captured by a request probe with an empty prompt. Prompt-dependent injections may be missing.");
	assert.ok(probeNote.includes(theme.fg("warning", "request probe")));
	assert.ok(probeNote.includes(`${theme.getFgAnsi("dim")}Captured by a `));
	assert.ok(probeNote.includes(`${theme.getFgAnsi("dim")} with an empty prompt.`));
	assert.equal(probeNote.split(theme.getFgAnsi("warning")).length, 2);
	assert.ok(plain.some((line) =>
		line === "  - Payload changes were not checked: No provider payload was observed for this request."));

	const pending = new InjectionsView(theme, { snapshot: snapshot(2), guard: { status: "pending" } }, () => {}, () => 40);
	const pendingLines = pending.render(120).map(stripSgr);
	assert.ok(pendingLines.some((line) => line.includes("Payload changes are not checked yet")));
	assert.ok(!pendingLines.some((line) => line.includes("request probe")));

	// Detailed notes collapse with the description, but compact capture status stays
	const short = new InjectionsView(theme, input, () => {}, () => 16).render(120).map(stripSgr);
	assert.ok(!short.some((line) => line.includes("Payload changes")));
	assert.ok(!short.some((line) => line.includes("request probe")));
	assert.ok(short.some((line) => line.includes("[Request Probe]") && line.endsWith("Payload: not checked")));
});

test("InjectionsView wraps the probe bullet and collapses and restores it with the description", () => {
	let height = 40;
	const view = new InjectionsView(createTheme(), { snapshot: snapshot(2), probe: true }, () => {}, () => height);
	for (const width of [24, 60, 80, 120]) {
		for (height = 12; height <= 40; height++) {
			const lines = view.render(width);
			assert.ok(lines.length <= height);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			const plain = lines.map(stripSgr);
			const description = plain.findIndex((line) => line.includes("Injections into"));
			const note = plain.findIndex((line) => line.startsWith("  - Captured by a"));
			assert.equal(note >= 0, description >= 0);
			if (note < 0) continue;
			const hints = plain.findIndex((line) => line.includes("↑↓/jk Navigate"));
			const bullet = plain.slice(note, hints - 1);
			assert.ok(bullet.slice(1).every((line) => line.startsWith("    ")));
			assert.equal(bullet.map((line) => line.trim()).join(" "),
				"- Captured by a request probe with an empty prompt. Prompt-dependent injections may be missing.");
		}
		assert.ok(view.render(width).map(stripSgr).some((line) => line.startsWith("  - Captured by a")));
	}
});

test("changed Injections frames reflow without raw text leaks or partial descriptions", () => {
	let height = 70;
	const view = new InjectionsView(createTheme(), {
		snapshot: changedSnapshot(), probe: true,
		guard: { status: "incomplete", reason: "No payload.\u001b[2J" },
	}, () => {}, () => height);
	for (const width of [1, 24, 60, 80, 120]) {
		for (height of [1, 16, 24, 45, 70]) {
			const frame = view.render(width);
			assert.ok(frame.length <= height, `${width}x${height}: height`);
			assert.ok(frame.every((line) => visibleWidth(line) <= width), `${width}x${height}: width`);
			const plain = frame.map(stripSgr).join("\n");
			assert.doesNotMatch(plain, /session original|deleted original|\u001b\[2J/);
		}
	}
	height = 70;
	const expanded = view.render(120).map(stripSgr).join("\n");
	assert.match(expanded, /Payload changes were not checked/);
	assert.match(expanded, /Change: \+7 -1,240 only in this request/);
	view.handleInput("\u001b[F");
	view.handleInput("\r");
	assert.match(view.render(120).map(stripSgr).join("\n"), /deleted original/);
	view.handleInput("\u001b");
	const returned = view.render(120).map(stripSgr).join("\n");
	assert.match(returned, /→ .*deleted message/);
	assert.doesNotMatch(returned, /deleted original/);
});

/** A snapshot with one built-in tool, two tools Pi hid and the tree leaves out, and a payload-change row. */
function guardedSnapshot(): InjectionSnapshot {
	const base = (id: string, tokens: number): InjectionItem => ({ ...item(id, "pi", true, tokens), kind: "tool" });
	const read: InjectionItem = { ...base("tool:builtin:read", 12), label: "read" };
	const builtin: InjectionItem = {
		...base("tool:builtin", 12), label: "Built-in Tools (1)", children: [read],
		sections: [{ label: "read", text: read.text, tokens: 12 }],
	};
	const payload: InjectionItem = {
		...item("payload-changes", AGGREGATE_SOURCE.id, false, 8), kind: "payload-change", source: AGGREGATE_SOURCE,
		label: "payload changes (3)", diff: { added: 7, removed: 5 },
		sections: [
			{ label: "user message", text: `after the edit ${"long ".repeat(30)}end`, tokens: 4,
				diff: { added: 3, removed: 2 }, changedLines: [
					{ type: "removed", text: "before the edit" },
					{ type: "added", text: `after the edit ${"long ".repeat(30)}end` },
				] },
			{ label: "system message", text: "edit rule\u001b[2J", tokens: 4, diff: { added: 4, removed: 0 },
				changedLines: [{ type: "added", text: "edit rule\u001b[2J" }] },
			{ label: "write", text: "", tokens: 0, diff: { added: 0, removed: 3 }, toolDeclaration: true,
				changedLines: [{ type: "removed", text: "Write files" }] },
		],
	};
	const groups = [
		group("pi", true, [builtin]),
		{ ...group(AGGREGATE_SOURCE.id, false, [payload]), source: AGGREGATE_SOURCE, diff: payload.diff },
	];
	return {
		groups,
		totalTokens: groups.reduce((sum, entry) => sum + entry.totalTokens, 0), hiddenTools: ["write", "bash"],
	};
}

test("InjectionsView counts hidden tools and explains payload changes in its description", () => {
	const view = new InjectionsView(createTheme(), { snapshot: guardedSnapshot() }, () => {}, () => 60);
	const plain = view.render(200).map(stripSgr);

	assert.ok(!plain.some((line) => line.includes("Hidden")), "hidden tools carry no marker");
	const unattributed = plain.findIndex((line) => line.trim().startsWith("unattributed"));
	assert.match(plain[unattributed + 1] ?? "", /^ {2}└─ payload changes \(3\) \.+ +8 {2}\+7 {2}-5$/,
		"payload changes are one unattributed row");
	const bullets = plain.filter((line) => line.startsWith("  - ")).map((line) => line.slice(4));
	assert.deepEqual(bullets, [
		"2 tools hidden by pi: bash, write.",
		"Payload changes appear only in the provider payload. Their sources are unknown.",
	], "a complete guard adds no status bullet");
});

test("InjectionsView counts one hidden tool in the singular and none without a hidden tool", () => {
	const bullets = (hiddenTools: readonly string[] | undefined): string[] => {
		const snapshot = { ...guardedSnapshot(), hiddenTools };
		const view = new InjectionsView(createTheme(), { snapshot }, () => {}, () => 60);
		return view.render(200).map(stripSgr).filter((line) => line.startsWith("  - ")).map((line) => line.slice(4));
	};
	assert.equal(bullets(["bash"])[0], "1 tool hidden by pi: bash.");
	for (const names of [[], undefined]) {
		assert.ok(!bullets(names).some((line) => line.includes("hidden by pi")));
	}
});

test("InjectionsView lists every hidden tool alphabetically without changing the snapshot", () => {
	const hiddenTools = ["write", "search", "read", "grep", "edit", "bash"];
	const snapshot = { ...guardedSnapshot(), hiddenTools };
	const view = new InjectionsView(createTheme(), { snapshot }, () => {}, () => 60);
	for (const width of [24, 60, 200]) {
		const lines = view.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		const plain = lines.map(stripSgr).join(" ").replace(/\s+/g, " ");
		assert.ok(plain.includes("- 6 tools hidden by pi: bash, edit, grep, read, search, write."));
	}
	assert.deepEqual(hiddenTools, ["write", "search", "read", "grep", "edit", "bash"]);
});

test("InjectionsView sanitizes hidden tool names before rendering", () => {
	const snapshot = { ...guardedSnapshot(), hiddenTools: ["bash\u001b[2J\nname"] };
	const view = new InjectionsView(createTheme(), { snapshot }, () => {}, () => 60);
	const lines = view.render(200);
	assert.ok(lines.map(stripSgr).includes("  - 1 tool hidden by pi: bash name."));
	assert.ok(lines.every((line) => !line.includes("\u001b[2J")));
});

test("InjectionsView reports a partial payload comparison", () => {
	const view = new InjectionsView(createTheme(), {
		snapshot: guardedSnapshot(),
		guard: {
			status: "incomplete", reason: "The captured request could not be converted for comparison.", findings: [],
		},
	}, () => {}, () => 60);
	const plain = view.render(200).map(stripSgr);
	assert.ok(plain.includes(
		"  - Payload changes were checked only in part: The captured request could not be converted for comparison."));
	assert.ok(!plain.some((line) => line.includes("were not checked")));
});

test("InjectionsView previews payload changes as one part per finding with colored changed lines", () => {
	const theme = createTheme();
	const view = new InjectionsView(theme, { snapshot: guardedSnapshot() }, () => {}, () => 60);
	view.handleInput("\u001b[F");
	view.handleInput("\r");
	const lines = view.render(60);
	const plain = lines.map(stripSgr);

	assert.match(plain[2] ?? "", /^payload changes \(3\) +unattributed · 8 tokens · \+7 -5 $/,
		"payload changes carry no change marker");
	assert.deepEqual(plain.filter((line) => / · \d+ tokens/.test(line)).slice(1), [
		"  user message · 4 tokens · +3 -2", "  system message · 4 tokens · +4", "  tool:write · 0 tokens · -3",
	], "one part per finding, in payload order");
	const tool = lines.find((line) => stripSgr(line).startsWith("  tool:write")) ?? "";
	assert.ok(tool.includes(theme.fg("dim", "tool:") + theme.fg("syntaxKeyword", theme.bold("write"))),
		"a tool declaration reads apart from a tool call");
	assert.match(plain[plain.indexOf("  tool:write · 0 tokens · -3") + 1] ?? "", /^ {2}- Write files$/);
	const removed = plain.findIndex((line) => line === "  - before the edit");
	assert.ok(removed >= 0);
	assert.ok(lines[removed]?.includes(theme.getFgAnsi("toolDiffRemoved")));
	assert.ok(lines[removed]?.includes(theme.inverse("before")), "only the changed word is inverse");
	assert.match(plain[removed + 1] ?? "", /^ {2}\+ after the edit long/);
	assert.ok(lines[removed + 1]?.includes(theme.getFgAnsi("toolDiffAdded")));
	assert.match(plain[removed + 2] ?? "", /^ {4}long/, "continuation lines hang under the text");
	// Wrapping merges the carried inverse and color into one SGR sequence
	assert.ok(lines[removed + 2]?.includes(theme.getFgAnsi("toolDiffAdded").slice(2, -1)));
	assert.ok(lines[removed + 2]?.includes("\u001b[7;"), "inverse words stay inverse after wrapping");
	assert.ok(plain.every((line) => visibleWidth(line) <= 60));
	assert.ok(plain.join(" ").replace(/\s+/g, " ")
		.includes("- +N -N Tokens added or removed, compared with the captured request."));
	assert.ok(!plain.some((line) => /Added|Modified|Deleted|Request-Only/.test(line)));
	assert.ok(plain.some((line) => line.startsWith("  - Payload changes appear only")));
	assert.ok(!plain.some((line) => line.includes("hidden by pi")), "the hidden-tools note stays in the list");
	assert.ok(plain.includes("  + edit rule"));
	assert.doesNotMatch(lines.join("\n"), /\u001b\[2J/);
});

test("payload-change and hidden-tool frames reflow without partial descriptions", () => {
	let height = 70;
	const view = new InjectionsView(createTheme(), { snapshot: guardedSnapshot() }, () => {}, () => height);
	const frames = (widths: readonly number[], firstBullet: RegExp, lastBullet: RegExp): void => {
		for (const width of widths) {
			for (height of [1, 16, 24, 45, 70]) {
				const frame = view.render(width);
				assert.ok(frame.length <= height, `${width}x${height}: height`);
				assert.ok(frame.every((line) => visibleWidth(line) <= width), `${width}x${height}: width`);
				const plain = frame.map(stripSgr).join("\n").replace(/\s+/g, " ");
				// The description renders whole or not at all: its first and last bullets come together
				assert.equal(firstBullet.test(plain), lastBullet.test(plain), `${width}x${height}: description`);
			}
		}
	};
	frames([1, 24, 60, 80, 120], /- 2 tools hidden by pi/, /Their sources are unknown\./);
	height = 70;
	view.handleInput("\u001b[F");
	view.handleInput("\r");
	// Preview bodies keep a minimum wrap width, as for every other item
	frames([24, 60, 80, 120], /- \+N -N Tokens added/, /Their sources are unknown\./);
});

test("InjectionsView pins selected-row details above the description, separate from capture status", () => {
	const theme = createTheme();
	const view = new InjectionsView(theme, {
		snapshot: changedSnapshot(), probe: true, guard: { status: "pending" },
	}, () => {}, () => 40);
	view.handleInput("j");
	const lines = view.render(120);
	const plain = lines.map(stripSgr);
	assert.deepEqual(statusBar(lines), ["Change: +4 only in this request; not in the session", "Changed By: Unknown"]);
	const change = plain.findIndex((line) => line.startsWith("    Change:"));
	const description = plain.findIndex((line) => line.startsWith("  Injections into"));
	const total = plain.findIndex((line) => line.startsWith("  TOTAL"));
	assert.ok(total >= 0 && change > total && description > change);
	assert.equal(plain[change - 1], "");
	assert.equal(plain[description - 1], "");
	assert.ok(plain.slice(description).some((line) => line.includes("comparison is pending")));
	assert.ok(plain.slice(description).some((line) => line.includes("request probe")));
	assert.doesNotMatch(statusBar(lines).join(" "), /request probe|Payload|unattributed|added message/);
	assert.doesNotMatch(plain.join("\n"), /request version|session original|deleted original/);
	assert.ok(lines[change]?.includes(theme.fg("muted", "Change")));

	view.handleInput("j");
	assert.deepEqual(statusBar(view.render(120)), [
		"Change: +3 -1,234 only in this request; the session keeps the original", "Changed By: Unknown",
	]);
	view.handleInput("\r");
	assert.match(view.render(120).map(stripSgr).join("\n"), /request version/);
	view.handleInput("\u001b");
	assert.deepEqual(statusBar(view.render(120)), [
		"Change: +3 -1,234 only in this request; the session keeps the original", "Changed By: Unknown",
	], "return from preview restores the same selection and bar");
});

test("InjectionsView separates the fixed total from the list counter and selected-row bar", () => {
	let height = 40;
	const view = new InjectionsView(createTheme(), { snapshot: changedSnapshot() }, () => {}, () => height);
	view.handleInput("j");
	for (const width of [60, 80, 120]) {
		for (height of [40, 16, 40]) {
			const plain = view.render(width).map(stripSgr);
			const change = plain.findIndex((line) => line.startsWith("    Change:"));
			const counter = plain.findIndex((line) => /^  \(\d+\/\d+\)$/.test(line));
			const total = plain.findIndex((line) => line.startsWith("  TOTAL"));
			assert.ok(change >= 0, `${width}x${height}: the selected row's bar is visible`);
			assert.equal(counter >= 0, height === 16, `${width}x${height}: counter only when the list overflows`);
			assert.ok(total >= 0, `${width}x${height}: TOTAL stays visible even when the list overflows`);
			if (counter >= 0) assert.equal(total, counter + 2, "one blank row separates the counter and TOTAL");
			assert.equal(plain[total - 1], "");
			assert.equal(change, total + 2, `${width}x${height}: exactly one blank row after TOTAL`);
			assert.equal(plain[change - 1], "");
		}
	}
});

test("InjectionsView fills the terminal height with empty rows between the bar and the description", () => {
	let height = 50;
	const view = new InjectionsView(createTheme(), { snapshot: changedSnapshot() }, () => {}, () => height);
	view.handleInput("j");
	for (const width of [60, 80, 120]) {
		for (height of [50, 40, 16, 50]) {
			const plain = view.render(width).map(stripSgr);
			assert.equal(plain.length, height, `${width}x${height}: the frame fills the terminal`);
			const hints = plain.findIndex((line) => line.includes("Navigate · Enter Preview"));
			assert.equal(hints, height - 3, `${width}x${height}: hints and the border stay at the bottom`);
			if (height === 16) continue;
			const description = plain.findIndex((line) => line.startsWith("  Injections into"));
			assert.ok(description >= 0 && plain.slice(description, hints - 1).every((line) => line !== ""),
				`${width}x${height}: the description ends one blank row above the hints`);
			let barEnd = plain.findIndex((line) => line.startsWith("    Change:"));
			while (plain[barEnd + 1]?.startsWith("    ")) barEnd++;
			assert.ok(description - barEnd > 2, `${width}x${height}: a short list leaves filler rows`);
			assert.ok(plain.slice(barEnd + 1, description).every((line) => line === ""),
				`${width}x${height}: only empty rows separate the bar and the description`);
		}
	}
});

test("InjectionsView keeps the full wrapped bar when descriptions collapse or the frame must compact", () => {
	let height = 50;
	const view = new InjectionsView(createTheme(), {
		snapshot: changedSnapshot(), guard: { status: "pending" },
	}, () => {}, () => height);
	view.handleInput("j");
	view.handleInput("j");
	const expected = "Change: +3 -1,234 only in this request; the session keeps the original Changed By: Unknown";
	for (const width of [24, 60, 80, 120]) {
		// At 24 columns the compact header, selected row, fixed total, and full bar need 13 rows
		for (height of [13, 16, 24, 50]) {
			const frame = view.render(width);
			const plain = frame.map(stripSgr);
			assert.equal(frame.length, height, `${width}x${height}: height`);
			assert.ok(frame.every((line) => visibleWidth(line) <= width), `${width}x${height}: width`);
			assert.equal(statusBar(frame).join(" "), expected, `${width}x${height}: the bar never collapses or clips`);
			assert.ok(plain.some((line) => line.startsWith("→")), "the selected row stays visible");
			assert.ok(plain.some((line) => line.startsWith("  TOTAL")), "the fixed total stays visible");
			assert.match(plain[0] ?? "", /^─+$/);
			assert.match(plain.at(-1) ?? "", /^─+$/);
			const text = plain.join(" ").replace(/\s+/g, " ");
			assert.equal(text.includes("Injections into"), text.includes("comparison is pending"),
				"the description still collapses whole");
		}
		height = 50;
		assert.ok(view.render(width).map(stripSgr).some((line) => line.includes("Injections into")));
	}
});

test("InjectionsView reserves only the selected bar's height, with an empty line on unchanged rows", () => {
	const data = snapshot(16);
	const first = data.groups[0]?.items[0];
	assert.ok(first !== undefined);
	const changed = { ...first, requestOnly: true, change: "modified" as const, diff: { added: 3, removed: 1 } };
	const view = new InjectionsView(createTheme(), { snapshot: {
		...data, groups: [{ ...data.groups[0], items: [changed, ...(data.groups[0]?.items.slice(1) ?? [])] },
			...data.groups.slice(1)],
	} }, () => {}, () => 30);
	// The group has a request-only change, but no Changed By field; an unchanged row has an empty bar
	view.handleInput("j");
	view.handleInput("j");
	const unchanged = view.render(120).map(stripSgr);
	assert.deepEqual(statusBar(unchanged), []);
	const hints = unchanged.findIndex((line) => line.includes("↑↓/jk Navigate"));
	assert.deepEqual(unchanged.slice(hints - 3, hints), ["", "", ""], "one empty line between the bar's spacers");
	const visibleCount = (lines: readonly string[]) =>
		lines.filter((line) => /^(?:→ |  )(?:├─|└─|pi\b|npm:web\b)/.test(line)).length;
	view.handleInput("k");
	const changedFrame = view.render(120).map(stripSgr);
	assert.equal(statusBar(changedFrame).length, 2);
	assert.equal(visibleCount(unchanged) - visibleCount(changedFrame), 1, "the extra field takes one list row");
	view.handleInput("j");
	assert.equal(visibleCount(view.render(120).map(stripSgr)), visibleCount(unchanged));
});

test("InjectionsView explains saved and guessed editors, mixed changes, and diff-only accounting", () => {
	const source = { id: "ext", label: "npm:web", native: false };
	const exact: InjectionItem = { ...item("exact", "pi", true, 10), label: "Available Tools",
		diff: { added: 4, removed: 0 }, editors: [{ type: "extension", source }] };
	const guessed: InjectionItem = { ...item("guess", "pi", true, 10), label: "Extension Additions",
		diff: { added: 10, removed: 0 }, editors: [{ type: "extension", source, attribution: "guess" }] };
	const mixed: InjectionItem = { ...item("mixed", "pi", true, 10), label: "custom section",
		diff: { added: 10, removed: 0 }, requestOnly: true, savedChange: true };
	const prompt: InjectionItem = { ...item("base-prompt", "pi", true, 30), label: "System Prompt",
		children: [exact, guessed, mixed], diff: { added: 24, removed: 0 } };
	const repeated: InjectionItem = { ...item("prompt:ext", "ext", false, 0), label: "system prompt",
		source, diffOnly: true, diff: { added: 14, removed: 0 }, savedChange: true };
	const snapshot: InjectionSnapshot = {
		groups: [{ ...group("pi", true, [prompt]), diff: prompt.diff },
			{ source, items: [repeated], totalTokens: 0 }], totalTokens: 30,
	};
	const theme = createTheme();
	const view = new InjectionsView(theme, { snapshot }, () => {}, () => 40);
	assert.deepEqual(statusBar(view.render(120)), ["Change: +24, some saved in the session, some only in this request"]);
	view.handleInput("j");
	assert.deepEqual(statusBar(view.render(120)), ["Change: +24, some saved in the session, some only in this request"]);
	view.handleInput("j");
	assert.deepEqual(statusBar(view.render(120)), ["Change: +4 saved in the session", "Changed By: npm:web"]);
	view.handleInput("j");
	assert.deepEqual(statusBar(view.render(120)), ["Change: +10 saved in the session", "Changed By: npm:web (guess)"]);
	view.handleInput("j");
	assert.deepEqual(statusBar(view.render(120)), [
		"Change: +10 saved in the session, with an edit only in this request", "Changed By: Unknown",
	]);
	view.handleInput("\u001b[F");
	assert.deepEqual(statusBar(view.render(120)), ["Change: +14 saved in the session", "Already counted in System Prompt"]);

	const originalFg = theme.fg.bind(theme);
	theme.fg = (color, text) => originalFg(color === "muted" ? "success" : color, text);
	view.invalidate();
	assert.ok(view.render(120).some((line) => line.includes(theme.fg("muted", "Change"))),
		"invalidation rebuilds field-name colors");
});

test("InjectionsView describes payload findings as payload-only changes, with unknown editors", () => {
	const view = new InjectionsView(createTheme(), { snapshot: guardedSnapshot() }, () => {}, () => 40);
	view.handleInput("\u001b[F");
	assert.deepEqual(statusBar(view.render(120)), ["Change: +7 -5 only in the provider payload", "Changed By: Unknown"]);
	view.handleInput("k");
	assert.deepEqual(statusBar(view.render(120)), ["Change: +7 -5 only in the provider payload"],
		"a group of payload changes alone keeps their phrase and names no editor");
});

test("InjectionsView prefixes tool rows outside Built-in Tools with a dim tool:", () => {
	const theme = createTheme();
	const source = { id: "tool-source:npm:web", label: "npm:web", native: false };
	const search: InjectionItem = { ...item("tool:npm:web:web_search", source.id, false, 1_418), kind: "tool", source,
		label: "web_search" };
	const read: InjectionItem = { ...item("tool:builtin:read", "pi", true, 12), kind: "tool", label: "read" };
	const builtin: InjectionItem = { ...item("tool:builtin", "pi", true, 12), kind: "tool", label: "Built-in Tools (1)",
		children: [read] };
	const snapshot: InjectionSnapshot = {
		groups: [group("pi", true, [builtin]), { ...group(source.id, false, [search]), source }], totalTokens: 1_430,
	};
	const view = new InjectionsView(theme, { snapshot }, () => {}, () => 40);
	const lines = view.render(80);
	const plain = lines.map(stripSgr);

	assert.ok(plain.some((line) => /^ {2}\u2514\u2500 tool:web_search \.+ 1,418$/.test(line)));
	assert.ok(plain.some((line) => /^ {5}\u2514\u2500 read \.+ +12$/.test(line)), "built-in tools keep plain names");
	const valueEdges = new Set(plain.filter((line) => /\d$/.test(line)).map((line) => line.length));
	assert.equal(valueEdges.size, 1, "the prefix keeps the shared value column");
	assert.ok(lines.some((line) =>
		line.includes(theme.fg("dim", "\u2514\u2500 tool:") + theme.fg("muted", "web_search"))));
	view.handleInput("\u001b[F");
	const selected = view.render(80).find((line) => stripSgr(line).startsWith("\u2192")) ?? "";
	assert.ok(selected.includes(theme.fg("dim", "\u2514\u2500 tool:") + theme.fg("accent", "web_search")),
		"the prefix stays dim on selection, like the connectors");
	for (const width of [12, 24, 60, 120]) {
		assert.ok(view.render(width).every((line) => visibleWidth(line) <= width), `${width}: width`);
	}
});

test("InjectionsView lists messages in one unattributed row and previews one part per message", () => {
	const theme = createTheme();
	const messages: InjectionItem = {
		...item("messages", AGGREGATE_SOURCE.id, false, 12), kind: "message", source: AGGREGATE_SOURCE,
		label: "messages (3)", requestOnly: true, diff: { added: 8, removed: 4 },
		sections: [
			{ label: "fixture-notes", text: "stored note", tokens: 3, message: {} },
			{ label: "user", text: "edited prompt", tokens: 5, diff: { added: 4, removed: 1 }, change: "modified",
				requestOnly: true, message: { userPrompt: 1, original: { text: "original prompt" } } },
			{ label: "user", text: "deleted prompt", tokens: 0, diff: { added: 0, removed: 3 }, change: "deleted",
				requestOnly: true, message: { userPrompt: 2 } },
			{ label: "fixture-add", text: "added note", tokens: 4, diff: { added: 4, removed: 0 }, change: "added",
				requestOnly: true, message: { userPrompt: 2 } },
		],
	};
	const snapshot: InjectionSnapshot = {
		groups: [{ ...group(AGGREGATE_SOURCE.id, false, [messages]), source: AGGREGATE_SOURCE, diff: messages.diff }],
		totalTokens: 12,
	};
	const view = new InjectionsView(theme, { snapshot }, () => {}, () => 40);
	view.handleInput("j");
	const list = view.render(100);
	const plain = list.map(stripSgr);
	assert.ok(plain.some((line) =>
		/^\u2192 \u2514\u2500 messages \(3\) \.+ 12 {2}\+8 {2}-4 \u00b7 Request-Only$/.test(line)));
	assert.deepEqual(statusBar(list), ["Change: +8 -4 only in this request", "Changed By: Unknown"],
		"every message change is only in this request; none names its editor");
	assert.doesNotMatch(plain.join("\n"), /stored note|edited prompt|fixture-notes/,
		"raw text and customTypes wait for Enter");

	view.handleInput("\r");
	const preview = view.render(100).map(stripSgr);
	assert.match(preview[2] ?? "", /^messages \(3\) +unattributed \u00b7 12 tokens \u00b7 \+8 -4 \u00b7 Request-Only $/);
	assert.deepEqual(preview.filter((line) => / \u00b7 \d+ tokens/.test(line)).slice(1), [
		"  fixture-notes \u00b7 3 tokens",
		"  user · user prompt #1 · 5 tokens · +4 -1 · Request-Only",
		"  user · user prompt #2 · 0 tokens · -3 · Request-Only",
		"  fixture-add · user prompt #2 · 4 tokens · +4 · Request-Only",
	], "customType or role labels each part; a modification diffs its session original in the same part");
	assert.ok(preview.includes("    stored note"));
	assert.ok(preview.includes("  - original prompt"));
	assert.ok(preview.includes("  + edited prompt"));
	assert.ok(preview.includes("  - deleted prompt"));
	assert.ok(preview.includes("  + added note"));
	const styled = view.render(100);
	assert.ok(styled.some((line) => line.includes(theme.fg("muted", " · user prompt #1"))));
	assert.ok(styled.some((line) => line.includes(theme.inverse("original"))));
	assert.ok(styled.some((line) => line.includes(theme.inverse("edited"))));
	assert.doesNotMatch(preview.join("\n"), /· session|#0/);
	const legend = preview.join(" ").replace(/\s+/g, " ");
	assert.ok(legend.includes("- +N -N Tokens extensions added or removed, compared with the session."));
	assert.ok(legend.includes("- Request-Only Includes changes made only in this request"));
	view.handleInput("\u001b");
	assert.deepEqual(view.render(100), list, "Escape returns to the same row");
});

test("InjectionsView keeps payload attention states visible without the description", () => {
	const dispatch = { provider: "fixture", api: "fixture", model: "fixture" };
	const finding = { type: "payload-change", change: "added", part: "user", lines: [] } as const;
	const cases: [GuardResult | undefined, string | undefined][] = [
		[{ status: "pending" }, "pending"],
		[{ status: "incomplete", reason: "No payload." }, "not checked"],
		[{ status: "incomplete", reason: "One channel failed.", findings: [] }, "partly checked"],
		[{ status: "incomplete", reason: "One channel failed.", findings: [finding] }, "partly checked"],
		[{ status: "complete", dispatch, findings: [] }, undefined],
		[{ status: "complete", dispatch, findings: [finding] }, undefined],
		[undefined, undefined],
	];
	for (const [guard, state] of cases) {
		const theme = createTheme();
		const view = new InjectionsView(theme, { snapshot: guardedSnapshot(), guard }, () => {}, () => 14);
		const lines = view.render(120);
		const header = lines.find((line) => stripSgr(line).startsWith("Context Injections")) ?? "";
		assert.ok(header.includes(theme.fg("mdHeading", theme.bold("[Latest Request]"))));
		assert.doesNotMatch(lines.map(stripSgr).join("\n"), /Injections into|hidden by pi|No payload|channel failed/);
		if (state === undefined) {
			assert.equal(stripSgr(header), "Context Injections · [Latest Request]");
		} else {
			assert.ok(header.endsWith(theme.fg("muted", "Payload") + theme.fg("dim", `: ${state}`)));
			assert.equal(visibleWidth(header), 120, "payload status is right-aligned");
		}
		assert.doesNotMatch(stripSgr(header), /Hidden|hidden|bash|write/);
	}
});

test("InjectionsView keeps request origins bold mdHeading and complete payload status quiet", () => {
	const theme = createTheme();
	for (const probe of [true, false]) {
		let height = 16;
		const view = new InjectionsView(theme, {
			snapshot: snapshot(2), probe,
			guard: { status: "complete", dispatch: { provider: "fixture", api: "fixture", model: "fixture" }, findings: [] },
		}, () => {}, () => height);
		const header = view.render(90)[2] ?? "";
		const label = probe ? "[Request Probe]" : "[Latest Request]";
		const styledLabel = theme.fg("mdHeading", theme.bold(label));
		assert.equal(stripSgr(header), `Context Injections · ${label}`);
		assert.ok(header.includes(styledLabel));
		assert.ok(header.includes(theme.fg("dim", " · ")));
		assert.doesNotMatch(stripSgr(header), /Payload/);
		assert.ok(view.render(24).some((line) => line.includes(styledLabel)), "split header keeps label styling");
		height = 6;
		assert.ok(view.render(90).some((line) => line.includes(styledLabel)), "compact header keeps label styling");
	}
});

test("InjectionsView moves payload status below a narrow header and wraps instead of dropping it", () => {
	const theme = createTheme();
	const view = new InjectionsView(theme, {
		snapshot: snapshot(2), probe: true,
		guard: { status: "incomplete", reason: "One channel failed.", findings: [] },
	}, () => {}, () => 120);
	const at = (width: number) => view.render(width).map(stripSgr);
	const wide = at(90);
	assert.equal(wide[2], "Context Injections · [Request Probe]".padEnd(90 - "Payload: partly checked".length)
		+ "Payload: partly checked");
	const inline = "Context Injections · [Request Probe] Payload: partly checked";
	assert.equal(at(visibleWidth(inline))[2], inline, "one separating space is enough for an inline status");
	assert.equal(at(visibleWidth(inline) - 1)[3], "  Payload: partly checked",
		"an exact overlap moves status below the header");
	const below = at(50);
	assert.deepEqual(below.slice(2, 5), [
		"Context Injections · [Request Probe]", "  Payload: partly checked", "",
	]);
	const split = at(24);
	assert.deepEqual(split.slice(2, 7), [
		"Context Injections", "", "[Request Probe]", "  Payload: partly", "  checked",
	]);
	for (const width of [1, 8, 16, 24, 36, 37, 50, 60, 80, 120]) {
		const lines = at(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}: width`);
		const selected = lines.findIndex((line) => line.startsWith("→"));
		const heading = lines.slice(2, selected).filter((line) => line.trim().length > 0);
		const headingText = heading.join("").replace(/\s+/g, "");
		assert.ok(headingText.includes("[RequestProbe]"), `${width}: origin is not omitted`);
		assert.ok(headingText.includes("Payload:partlychecked"), `${width}: payload status is not omitted`);
	}
});

test("InjectionsView preserves capture status through scrolling, preview return, and height-only resize", () => {
	let height = 60;
	const view = new InjectionsView(createTheme(), {
		snapshot: snapshot(16), probe: true,
		guard: { status: "incomplete", reason: "No provider payload was observed for this request." },
	}, () => {}, () => height);
	for (const width of [24, 60, 80, 120]) {
		view.handleInput("\u001b[H");
		height = 120;
		const full = view.render(width).map(stripSgr);
		assert.ok(full.some((line) => line.includes("Injections into")));
		assert.match(full.join(" ").replace(/\s+/g, " "), /Captured by a request probe/);
		const selected = full.findIndex((line) => line.startsWith("→"));
		const header = full.slice(2, selected);
		for (height of [12, 16, 24]) {
			view.handleInput("\u001b[H");
			const collapsed = view.render(width).map(stripSgr);
			assert.ok(!collapsed.some((line) => line.includes("Injections into")));
			view.handleInput("\u001b[F");
			const scrolled = view.render(width).map(stripSgr);
			for (const frame of [collapsed, scrolled]) {
				const selected = frame.findIndex((line) => line.startsWith("→"));
				assert.ok(selected >= 0);
				assert.match(frame.slice(1, selected).join(" ").replace(/\s+/g, " "),
					/\[Request Probe\].*Payload: not checked/);
				if (frame[2]?.startsWith("Context Injections")) {
					assert.deepEqual(frame.slice(2, 2 + header.length), header);
				}
				assert.ok(frame.length <= height);
			}
		}
		height = 120;
		view.handleInput("\u001b[H");
		assert.deepEqual(view.render(width).map(stripSgr), full);
		view.handleInput("j");
		const beforePreview = view.render(width);
		view.handleInput("\r");
		assert.doesNotMatch(view.render(width).map(stripSgr).join("\n"), /Request Probe|Payload: not checked/);
		view.handleInput("\u001b");
		assert.deepEqual(view.render(width), beforePreview);
	}
});

test("InjectionsView keeps compact capture status and the selected bar when the frame compacts", () => {
	let height = 50;
	const view = new InjectionsView(createTheme(), {
		snapshot: changedSnapshot(), probe: true, guard: { status: "pending" },
	}, () => {}, () => height);
	view.handleInput("j");
	view.handleInput("j");
	for (const width of [24, 60, 80, 120]) {
		for (height of [14, 16, 24, 50]) {
			const lines = view.render(width);
			const plain = lines.map(stripSgr);
			assert.ok(lines.length <= height);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.match(plain.join(" ").replace(/\s+/g, " "), /\[Request Probe\].*Payload: pending/);
			assert.ok(plain.some((line) => line.startsWith("→")));
			assert.equal(statusBar(lines).join(" "),
				"Change: +3 -1,234 only in this request; the session keeps the original Changed By: Unknown");
		}
	}
});

test("InjectionsView retains the sanitized degraded reason in a compact descriptionless frame", () => {
	let height = 60;
	const reason = "No model is selected.";
	const view = createView(16, `${reason}\u001b[2J`, () => height);
	for (const width of [24, 60, 80, 120]) {
		for (height of [12, 16, 24]) {
			const lines = view.render(width);
			const plain = lines.map(stripSgr);
			assert.ok(lines.length <= height);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.doesNotMatch(lines.join("\n"), /\u001b\[2J/);
			assert.ok(!plain.some((line) => line.includes("Injections into")));
			assert.ok(plain.join(" ").replace(/\s+/g, " ").includes(reason));
			assert.ok(plain.some((line) => line.includes("[Latest Request]")));
			assert.ok(plain.some((line) => line.startsWith("→")));
			assert.ok(plain.some((line) => line.startsWith("  TOTAL")));
		}
	}
});

test("InjectionsView rebuilds persistent capture colors after theme invalidation", () => {
	const theme = createTheme();
	const view = new InjectionsView(theme, {
		snapshot: snapshot(16), probe: true, guard: { status: "pending" },
	}, () => {}, () => 16);
	const before = view.render(80);
	assert.strictEqual(view.render(80), before, "unchanged renders reuse the cache");
	const originalFg = theme.fg.bind(theme);
	theme.fg = (color, text) => originalFg(
		color === "mdHeading" || color === "muted" || color === "dim" ? "syntaxFunction" : color, text,
	);
	view.invalidate();
	const header = view.render(80)[2] ?? "";
	assert.ok(header.includes(theme.fg("mdHeading", theme.bold("[Request Probe]"))));
	assert.ok(header.endsWith(theme.fg("muted", "Payload") + theme.fg("dim", ": pending")));
	assert.notEqual(header, before[2]);
});
