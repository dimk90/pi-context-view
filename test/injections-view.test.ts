import assert from "node:assert/strict";
import { test } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { AGGREGATE_SOURCE, type InjectionSnapshot, type InjectionGroup, type InjectionItem } from "../src/model.ts";
import type { GuardResult } from "../src/snapshot.ts";
import { InjectionsView } from "../src/ui/injections-view.ts";
import { type CopyActions, copiedNotice } from "../src/ui/copy.ts";
import { previewBodyLines } from "../src/ui/section-preview.ts";
import { buildInjectionRows } from "../src/ui/injections-model.ts";
import { statusBarLines } from "../src/ui/status-bar.ts";
import { markerLegendLines, markerStatusField } from "../src/ui/markers.ts";
import {
	descriptionNoteLines, injectionsNotes, requestOriginLabel,
	type DescriptionNote, type InjectionsNotesInput,
} from "../src/ui/notes.ts";
import { assertFrame, containsBlock, createTheme, frameText, stripSgr, stripStyle, wholeOrAbsent } from "./harness/frame.ts";
import { mouseEvent, wheelEvent } from "./harness/mouse.ts";

/** Expected note selected by semantic kind, never by an English sentence. */
function noteLines(kind: DescriptionNote["kind"], width = 1_000, input: Partial<InjectionsNotesInput> = {}): string[] {
	const theme = createTheme();
	const note = injectionsNotes(theme, { items: [], ...input }).find((note) => note.kind === kind);
	assert.ok(note, `missing ${kind} note`);
	return descriptionNoteLines(theme, note, width);
}

/** Find a note's first wrapped line without freezing its wording or indentation. */
function noteIndex(lines: readonly string[], kind: DescriptionNote["kind"] = "overview",
	input: Partial<InjectionsNotesInput> = {}): number {
	const first = stripSgr(noteLines(kind, visibleWidth(lines[0] ?? ""), input)[0] ?? "").trim();
	return lines.findIndex((line) => stripSgr(line).trim() === first);
}

/** Expected selected-row details come from the component; scope/editor decisions have separate model tests. */
function expectedStatus(data: InjectionSnapshot, index: number): string[] {
	const row = buildInjectionRows(data)[index];
	assert.ok(row);
	return statusBarLines(createTheme(), row, 1_000).map(stripSgr).map((line) => line.trim());
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
	actions?: CopyActions,
): InjectionsView {
	return new InjectionsView(
		createTheme(),
		{ snapshot: snapshot(itemsPerGroup), degradedReason },
		() => {},
		getTerminalRows,
		actions,
	);
}

/** First line of a component-rendered status block, found without freezing field names. */
function statusIndex(lines: readonly string[], expected: readonly string[]): number {
	const first = stripSgr(expected[0] ?? "").trim();
	assert.notEqual(first, "", "a selected change must have status text");
	return lines.findIndex((line) => stripSgr(line).trim() === first);
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
	const view = new InjectionsView(theme, { snapshot: styledSnapshot }, () => {}, () => 24);

	let lines = view.render(80);
	assert.equal(lines[1], "");
	assert.equal(lines.at(-2), "");
	const headerIndex = lines.findIndex((line) => stripSgr(line).includes("Context Injections"));
	const tabIndex = lines.findIndex((line) => stripSgr(line).includes(requestOriginLabel()));
	assert.ok(headerIndex >= 0 && tabIndex === headerIndex);
	assert.equal(lines[headerIndex + 1], "");
	assert.equal(stripSgr(lines[headerIndex] ?? "").indexOf("Context Injections"), 0);
	assert.ok((lines[tabIndex] ?? "").includes(theme.fg("mdHeading", theme.bold(requestOriginLabel()))));
	// Runtime stays hidden until the runtime-inspection roadmap step
	assert.ok(!lines.some((line) => stripSgr(line).includes("RUNTIME")));
	assert.ok(!lines.some((line) => stripSgr(line).includes("Runtime Logging:")));
	const selectedGroup = lines.find((line) => stripSgr(line).includes("→ pi"));
	assert.ok(selectedGroup !== undefined);
	assert.equal(stripSgr(selectedGroup).indexOf("→"), 0);
	assert.ok(selectedGroup.includes(theme.fg("accent", "→ ")));
	assert.ok(selectedGroup.includes(theme.fg("accent", "60")));
	assert.match(stripSgr(selectedGroup), /→ pi \.{2,}\s+60/);
	assert.doesNotMatch(selectedGroup, /\u001b\[48;/);
	const parentLine = lines.find((line) => stripSgr(line).includes("parent with a moderately"));
	const childLine = lines.find((line) => stripSgr(line).includes("child with a moderately"));
	assert.match(stripSgr(parentLine ?? ""), /^  ├─ parent/);
	assert.ok(parentLine?.includes(theme.fg("dim", "├─ ")));
	assert.ok(parentLine?.includes(theme.getFgAnsi("muted") + "parent"));
	assert.ok(parentLine?.includes(theme.fg("muted", "50")));
	assert.match(stripSgr(childLine ?? ""), /^  │  └─ child/);
	assert.ok(childLine?.includes(theme.fg("dim", "│  └─ ")));
	assert.ok(childLine?.includes(theme.getFgAnsi("dim") + "child"));
	assert.ok(childLine?.includes(theme.fg("muted", "20")));
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

	// TOTAL is the final table row and sums the snapshot without double-counting children
	const totalRowIndex = lines.findIndex((line) => stripSgr(line).includes("TOTAL (Prompt, Tools, Injections)"));
	const descIndex = noteIndex(lines);
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
	assert.ok(selectedChild.includes(theme.fg("dim", "│  └─ ")));
	assert.ok(selectedChild.includes(theme.getFgAnsi("accent") + "child"));
	assert.ok(selectedChild.includes(theme.fg("accent", "20")));

	const descriptionIndex = noteIndex(lines);
	const hintsIndex = lines.findIndex((line) => stripSgr(line).includes("↑↓/jk"));
	assert.ok(descriptionIndex > 0 && hintsIndex > descriptionIndex);
	assert.ok(containsBlock(lines, noteLines("overview", 80)));
	assert.ok(lines[descriptionIndex]?.includes(theme.getFgAnsi("dim")));
	assert.ok(lines[hintsIndex]?.includes(theme.getFgAnsi("dim")));
	assert.ok(lines[hintsIndex]?.includes(theme.getFgAnsi("muted")));
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
			for (const input of ["", "j", "\u001b[6~", "\u001b[F", wheelEvent(1), "\u001b[H"]) {
				if (typeof input === "string") view.handleInput(input);
				else view.handleMouse(input);
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

test("InjectionsView wraps complete descriptions and restores them after collapse", () => {
	for (const count of [2, 16]) {
		let height = 100;
		const view = createView(count, undefined, () => height);
		for (const width of [24, 40, 60, 80, 120]) {
			height = 100;
			const full = view.render(width);
			const expected = noteLines("overview", width);
			assert.ok(containsBlock(full, expected));
			let collapsed = false;
			let scrollingWithDescription = false;
			for (height = 12; height <= 100; height++) {
				const lines = view.render(width);
				assertFrame(lines, width, height);
				const visible = wholeOrAbsent(lines, expected);
				collapsed ||= !visible;
				scrollingWithDescription ||= visible && /\(\d+\/\d+\)/.test(frameText(lines));
				assert.ok(lines.some((line) => stripSgr(line).startsWith("→")));
			}
			assert.ok(collapsed);
			if (count === 16) assert.ok(scrollingWithDescription, "overflow alone must not hide descriptions");
			height = 100;
			assert.deepEqual(view.render(width), full);
		}
	}
});

test("InjectionsView keeps the precise degraded reason and wraps its optional explanation", () => {
	const reason = "fixture-degraded-reason with enough words to wrap";
	const view = createView(4, `${reason}\u001b[2J`, () => 100);
	for (const width of [24, 40, 80, 120]) {
		const lines = view.render(width);
		assertFrame(lines, width, 100);
		assert.ok(containsBlock(lines, [reason]));
		assert.ok(containsBlock(lines, noteLines("degraded", width, { degradedReason: reason })));
		assert.doesNotMatch(lines.join("\n"), /\u001b\[2J/);
	}
	assert.ok(!containsBlock(createView(4, undefined, () => 100).render(120),
		noteLines("degraded", 120, { degradedReason: reason })));
});

test("InjectionsView shows sanitized configuration notices after the degraded reason and caps them", () => {
	const reason = "fixture-degraded-reason";
	const view = new InjectionsView(
		createTheme(),
		{
			snapshot: snapshot(4),
			degradedReason: reason,
			notices: [
				"fixture-notice-1 \u001b[31mred\u001b[0m",
				"fixture-notice-2",
				"fixture-notice-3",
				"fixture-notice-4",
			],
		},
		() => {},
		() => 40,
	);
	const lines = view.render(80);
	const plain = lines.map((line) => stripSgr(line).trim());
	assertFrame(lines, 80, 40);

	const reasonIndex = plain.indexOf(reason);
	assert.notEqual(reasonIndex, -1);
	assert.deepEqual(plain.slice(reasonIndex + 1, reasonIndex + 3), ["fixture-notice-1 red", "fixture-notice-2"]);
	// The third notice row reports the overflow instead of a notice; a blank row closes the block
	assert.notEqual(plain[reasonIndex + 3], "");
	assert.ok(!plain.some((line) => line.includes("fixture-notice-3") || line.includes("fixture-notice-4")));
	assert.equal(plain[reasonIndex + 4], "");
	assert.doesNotMatch(lines.join("\n"), /\u001b\[31m/);
});

test("InjectionsView separates top warnings from the list with a blank row", () => {
	const view = createView(4, "fixture-degraded-reason", () => 40);
	const plain = view.render(80).map((line) => stripSgr(line).trim());
	const reasonIndex = plain.indexOf("fixture-degraded-reason");
	assert.notEqual(reasonIndex, -1);
	assert.equal(plain[reasonIndex + 1], "");
	assert.notEqual(plain[reasonIndex + 2], "");
});

test("InjectionsView explains disabled probing only as a description note, without top warnings", () => {
	const view = new InjectionsView(createTheme(), { snapshot: snapshot(4), probingDisabled: true }, () => {}, () => 40);
	const lines = view.render(80);
	const plain = lines.map((line) => stripSgr(line).trim());
	assertFrame(lines, 80, 40);
	assert.ok(containsBlock(lines, noteLines("probing-disabled", 80, { probingDisabled: true })));
	// No warning block: the list starts right after the header's blank row
	const unwarned = createView(4, undefined, () => 40).render(80).map((line) => stripSgr(line).trim());
	assert.deepEqual(plain.slice(0, 6), unwarned.slice(0, 6));
});

test("InjectionsView keeps Runtime inactive when label-switch keys are pressed", () => {
	const view = createView(4);
	const initial = view.render(80);

	for (const key of ["\u001b[C", "\u001b[D", "\t", "\u001b[Z"]) {
		view.handleInput(key);
		assert.equal(view.render(80), initial);
	}
	assert.ok(containsBlock(initial, [requestOriginLabel()]));
	assert.ok(!initial.some((line) => stripSgr(line).includes("RUNTIME")));
});

test("InjectionsView preserves the request origin as its header reflows", () => {
	for (const width of [16, 24, 36, 37, 60, 120]) {
		const lines = createView(4, undefined, () => 60).render(width);
		assertFrame(lines, width, 60);
		assert.ok(frameText(lines).replace(/\s/g, "").includes(requestOriginLabel().replace(/\s/g, "")));
	}
});

test("InjectionsView keeps every rendered line within the width", () => {
	for (const width of [24, 40, 60, 80, 120]) {
		const view = createView(8, "Silent probe unavailable: no model is selected. Extension additions were not observed.");
		const listLines = view.render(width);
		for (const line of listLines) {
			assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
		}
		assert.ok(containsBlock(listLines, [requestOriginLabel()]));
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
	}, () => 24);

	// Enter on a group row does nothing
	view.handleInput("\r");
	assert.doesNotMatch(view.render(80).join("\n"), /pi-0 preview line/);

	// Select the second item row and open its preview
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
	// Preview content is indented two spaces
	assert.equal(stripSgr(previewLines[firstContentIndex] ?? "").indexOf("pi-1"), 2);
	assert.equal(previewLines[previewHeaderIndex + 1], "");
	const hintIndex = previewLines.findIndex((line) => stripSgr(line).includes("↑↓/jk Scroll"));
	assert.ok(hintIndex > 0);
	assert.equal(previewLines[hintIndex - 1], "");

	// Scrolling changes the visible window; Escape returns to the unchanged list
	view.handleInput("\u001b[6~"); // PgDn
	const scrolled = view.render(80).join("\n");
	assert.notEqual(scrolled, preview);
	assert.doesNotMatch(scrolled, /preview line 0 /);
	view.handleInput("\u001b[4~"); // End
	assert.match(stripSgr(view.render(80).join("\n")), /\((\d+)\/\1\)/);

	view.handleInput("\u001b");
	assert.equal(closed, false);
	assert.equal(view.render(80).join("\n"), listBefore);

	// A fresh preview starts back at the top
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
		// A header carrying more than its label is content, not a repetition
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
	}, () => {}, () => 24);

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
	// Parts use syntaxKeyword, leaving mdHeading to the headings they nest under
	assert.ok((lines[guidelinesIndex] ?? "").includes(theme.fg("syntaxKeyword", theme.bold("Guidelines"))));
	assert.ok((lines[guidelinesIndex] ?? "").includes(theme.fg("muted", " · 17 tokens")));
	// Section bodies start directly below their subheader, separated only between sections
	assert.equal(plainLines[snippetIndex + 1], "  - search: Search the web");
	assert.equal(plainLines[guidelinesIndex + 1], "  - Use search when the user asks for current information");
	assert.equal(plainLines[guidelinesIndex + 2], "  - Cite sources");
	assert.deepEqual(plainLines.slice(guidelinesIndex - 2, guidelinesIndex), ["", ""]);
	assert.equal(plainLines[guidelinesIndex - 3], "  - search: Search the web");
	assert.deepEqual(plainLines.slice(definitionIndex - 2, definitionIndex), ["", ""]);
	assert.equal(plainLines[definitionIndex - 3], "  - Cite sources");
	assert.equal(plainLines[definitionIndex + 1], "  search: Search");

	// A single known section retains the same labeled structure
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
	}, () => {}, () => 24);

	// The item preview is full content, so a labeled part expands its marked schema
	view.handleInput("\u001b[B");
	view.handleInput("\r");
	const sectionLines = view.render(80).map((line) => stripSgr(line));
	const definitionIndex = sectionLines.indexOf("  Definition · 30 tokens");
	assert.ok(definitionIndex > 0, "missing Definition subheader");
	assert.equal(sectionLines[definitionIndex + 1], "  search: Search");
	assert.equal(sectionLines[definitionIndex + 2], "  {");
	assert.equal(sectionLines[definitionIndex + 3], '    "type": "object",');

	// An item without parts expands the whole marked text
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

	// Every child keeps its own subheader, token share, and expanded schema
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

	// Each part of the aggregate preview opens with the description, not the name above it
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

	// The child preview keeps its whole estimate while dropping the same repeated line
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
	}, () => {}, () => 24);

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

	// Both views must render once so the viewport size is known before any input
	const start = frame(vim);
	assert.equal(frame(arrows), start);

	// List navigation: j and k move exactly like Down and Up
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

	// Preview scrolling: j and k move the wrapped text, and neither key closes the view
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

	// Both views must render once so the viewport size is known before any input
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

test("InjectionsView scrolls with the mouse wheel and honors pi's wheel delta", () => {
	// Fullscreen pi parses wheel reports and passes them to the focused overlay as mouse events, with
	// `wheelDelta` already scaled by the user's step and acceleration
	const wheelUp = wheelEvent(-4);
	const wheelDown = wheelEvent(4);
	const arrows = createView(8);
	const wheel = createView(8);
	const frame = (view: InjectionsView) => view.render(80).join("\n");

	// Both views must render once so the viewport size is known before any input
	const start = frame(wheel);
	assert.equal(frame(arrows), start);

	// Other mouse events fall through to pi; a notch at the edge is handled but needs no redraw
	assert.equal(wheel.handleMouse(mouseEvent("click", { button: "left" })), undefined);
	assert.deepEqual(wheel.handleMouse(wheelUp), { handled: true, render: false });
	assert.equal(frame(wheel), start);

	// List: one notch selects one row, regardless of the wheel delta
	arrows.handleInput("\u001b[B");
	assert.deepEqual(wheel.handleMouse(wheelDown), { handled: true, render: true });
	assert.match(stripSgr(frame(wheel)), /→ ├─ pi-0/);
	assert.equal(frame(wheel), frame(arrows));

	// Preview: one notch scrolls by the wheel delta
	arrows.handleInput("\r");
	wheel.handleInput("\r");
	const previewTop = frame(wheel);
	assert.equal(frame(arrows), previewTop);
	for (let step = 0; step < 4; step++) arrows.handleInput("\u001b[B");
	wheel.handleMouse(wheelDown);
	assert.notEqual(frame(wheel), previewTop);
	assert.equal(frame(wheel), frame(arrows));
	for (let step = 0; step < 4; step++) arrows.handleInput("\u001b[A");
	wheel.handleMouse(wheelUp);
	assert.equal(frame(wheel), previewTop);
	assert.equal(frame(arrows), previewTop);
});

test("InjectionsView navigation skips the fixed total and Escape closes", () => {
	let closed = false;
	const view = new InjectionsView(createTheme(), { snapshot: snapshot(30) }, () => {
		closed = true;
	}, () => 24);

	const initialLines = view.render(80);
	const scrollIndicator = initialLines.find((line) => /\(1\/\d+\)/.test(stripSgr(line)));
	assert.ok(scrollIndicator !== undefined);
	assert.match(stripSgr(scrollIndicator), /\(1\/62\)/);
	assert.ok(scrollIndicator.includes(createTheme().getFgAnsi("dim")));
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
	assert.ok(containsBlock(view.render(120), expectedStatus({ groups: [piGroup], totalTokens: 10 }, 1)));
	assert.ok(containsBlock(view.render(40), expectedStatus({ groups: [piGroup], totalTokens: 10 }, 1)),
		"the bar keeps the diff the row drops at narrow widths");
	view.handleInput("j");
	assert.ok(containsBlock(view.render(120), expectedStatus({ groups: [piGroup], totalTokens: 10 }, 2)));
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
	const legend = markerLegendLines(theme, ["forced"], 100);

	view.handleInput("\u001b[B");
	const forcedStatus = view.render(100);
	assert.ok(containsBlock(forcedStatus, [markerStatusField(theme, "forced")]),
		"the status bar explains the selected row's marker");
	assert.ok(forcedStatus.some((line) => line.includes(theme.fg("warning", "Forced"))));
	view.handleInput("\r");
	const preview = view.render(100).map(stripSgr);
	assert.match(preview.find((line) => line.includes("System Prompt")) ?? "", /7 tokens · Forced/);
	assert.ok(containsBlock(preview, legend), "the preview legend explains the marker");
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
	assert.ok(containsBlock(plain, markerLegendLines(createTheme(), ["diff", "request-only"], 100, "session")));
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
	assert.ok(containsBlock(plain, markerLegendLines(theme, ["diff", "request-only"], 100, "default-prompt")));
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

	assert.match(line("system prompt"), /└─ system prompt \.+ {2}\+27$/, "dots run through the empty value column");
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
	assert.ok(containsBlock(preview, markerLegendLines(theme, ["guess", "diff"], 100, "default-prompt")));
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
		/system prompt \.+ {2}-7 · Request-Only$/);
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

test("InjectionsView renders selected capture notes without conflating origin and payload status", () => {
	const theme = createTheme();
	const input = { snapshot: snapshot(2), probe: true,
		guard: { status: "incomplete", reason: "fixture-payload-reason" } } as const;
	const lines = new InjectionsView(theme, input, () => {}, () => 100).render(120);
	assert.ok(containsBlock(lines, [requestOriginLabel(true)]));
	for (const kind of ["probe", "payload-check"] as const) {
		assert.ok(containsBlock(lines, noteLines(kind, 120, input)));
	}
	const pendingInput = { guard: { status: "pending" } } as const;
	const pending = new InjectionsView(theme, { snapshot: snapshot(2), ...pendingInput }, () => {}, () => 100);
	assert.ok(containsBlock(pending.render(120), noteLines("payload-check", 120, pendingInput)));
	assert.ok(!containsBlock(pending.render(120), noteLines("probe", 120, { probe: true })));
	const short = new InjectionsView(theme, input, () => {}, () => 16).render(120);
	assert.ok(!containsBlock(short, noteLines("probe", 120, input)));
	assert.ok(!containsBlock(short, noteLines("payload-check", 120, input)));
	assert.ok(containsBlock(short, [requestOriginLabel(true)]));
});

test("InjectionsView collapses and restores all probe notes together", () => {
	let height = 100;
	const theme = createTheme();
	const input = { snapshot: snapshot(2), probe: true };
	const view = new InjectionsView(theme, input, () => {}, () => height);
	for (const width of [24, 60, 80, 120]) {
		const expected = injectionsNotes(theme, { ...input, items: [] })
			.flatMap((note) => descriptionNoteLines(theme, note, width));
		let collapsed = false;
		let visible = false;
		for (height = 12; height <= 100; height++) {
			const lines = view.render(width);
			assertFrame(lines, width, height);
			if (wholeOrAbsent(lines, expected)) visible = true;
			else collapsed = true;
		}
		assert.ok(collapsed && visible);
		assert.ok(containsBlock(view.render(width), expected));
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
	assert.ok(containsBlock([expanded], noteLines("payload-check", 120,
		{ guard: { status: "incomplete", reason: "No payload.\u001b[2J" } })));
	assert.ok(containsBlock([expanded], expectedStatus(changedSnapshot(), 0)));
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

test("InjectionsView explains hidden tools and payload findings outside the tree", () => {
	const data = guardedSnapshot();
	const view = new InjectionsView(createTheme(), { snapshot: data }, () => {}, () => 100);
	const lines = view.render(200);
	for (const kind of ["hidden-tools", "payload-changes"] as const) {
		assert.ok(containsBlock(lines, noteLines(kind, 200,
			{ hiddenTools: data.hiddenTools, items: data.groups.flatMap((group) => group.items) })));
	}
	assert.ok(!containsBlock(lines, noteLines("payload-check", 200, { guard: { status: "pending" } })));
	assert.match(frameText(lines), /payload changes \(3\).*8.*\+7.*-5/);
});

test("InjectionsView counts one hidden tool in the singular and none without a hidden tool", () => {
	const bullets = (hiddenTools: readonly string[] | undefined): string[] => {
		const snapshot = { ...guardedSnapshot(), hiddenTools };
		const view = new InjectionsView(createTheme(), { snapshot }, () => {}, () => 60);
		return view.render(200).map(stripSgr).filter((line) => line.startsWith("  - ")).map((line) => line.slice(4));
	};
	const single = frameText(noteLines("hidden-tools", 200, { hiddenTools: ["bash"] })).replace(/^- /, "");
	assert.ok(containsBlock(bullets(["bash"]), [single]));
	for (const names of [[], undefined]) {
		assert.ok(!containsBlock(bullets(names), [single]));
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
		assert.ok(containsBlock([plain], noteLines("hidden-tools", width, { hiddenTools })));
	}
	assert.deepEqual(hiddenTools, ["write", "search", "read", "grep", "edit", "bash"]);
});

test("InjectionsView sanitizes hidden tool names before rendering", () => {
	const snapshot = { ...guardedSnapshot(), hiddenTools: ["bash\u001b[2J\nname"] };
	const view = new InjectionsView(createTheme(), { snapshot }, () => {}, () => 60);
	const lines = view.render(200);
	assert.ok(containsBlock(lines, ["bash name"]));
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
	assert.ok(containsBlock(plain, noteLines("payload-check", 200, { guard: {
		status: "incomplete", reason: "The captured request could not be converted for comparison.", findings: [],
	} })));
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
	assert.ok(containsBlock(plain, markerLegendLines(theme, ["diff"], 60, "captured-request")));
	assert.ok(!plain.some((line) => /Added|Modified|Deleted|Request-Only/.test(line)));
	assert.ok(containsBlock(plain, noteLines("payload-changes", 60,
		{ items: guardedSnapshot().groups.flatMap((group) => group.items) })));
	assert.ok(!containsBlock(plain, noteLines("hidden-tools", 60, { hiddenTools: ["write", "bash"] })),
		"the hidden-tools note stays in the list");
	assert.ok(plain.includes("  + edit rule"));
	assert.doesNotMatch(lines.join("\n"), /\u001b\[2J/);
});

test("payload-change and hidden-tool frames reflow without partial descriptions", () => {
	let height = 70;
	const view = new InjectionsView(createTheme(), { snapshot: guardedSnapshot() }, () => {}, () => height);
	const data = guardedSnapshot();
	const input = { hiddenTools: data.hiddenTools, items: data.groups.flatMap((group) => group.items) };
	const theme = createTheme();
	const frames = (preview: boolean): void => {
		for (const width of [24, 60, 80, 120]) {
			const expected = preview
				? [...markerLegendLines(theme, ["diff"], width, "captured-request"),
					...noteLines("payload-changes", width, input)]
				: injectionsNotes(theme, input).flatMap((note) => descriptionNoteLines(theme, note, width));
			for (height of [1, 16, 24, 45, 100]) {
				const frame = view.render(width);
				assertFrame(frame, width, height);
				wholeOrAbsent(frame, expected);
				if (height === 100) assert.ok(containsBlock(frame, expected));
			}
		}
	};
	frames(false);
	height = 100;
	view.handleInput("\u001b[F");
	view.handleInput("\r");
	frames(true);
});

test("InjectionsView pins selected-row details above the description, separate from capture status", () => {
	const theme = createTheme();
	const view = new InjectionsView(theme, {
		snapshot: changedSnapshot(), probe: true, guard: { status: "pending" },
	}, () => {}, () => 40);
	view.handleInput("j");
	const lines = view.render(120);
	const plain = lines.map(stripSgr);
	assert.ok(containsBlock(lines, expectedStatus(changedSnapshot(), 1)));
	const change = statusIndex(lines, expectedStatus(changedSnapshot(), 1));
	const description = noteIndex(lines);
	const total = plain.findIndex((line) => line.startsWith("  TOTAL"));
	assert.ok(total >= 0 && change > total && description > change);
	assert.equal(plain[change - 1], "");
	assert.equal(plain[description - 1], "");
	assert.ok(containsBlock(plain.slice(description), noteLines("payload-check", 120, { guard: { status: "pending" } })));
	assert.ok(containsBlock(plain.slice(description), noteLines("probe", 120, { probe: true })));
	assert.ok(!containsBlock(plain.slice(change, description), noteLines("probe", 120, { probe: true })));
	assert.doesNotMatch(plain.join("\n"), /request version|session original|deleted original/);
	assert.ok(lines[change]?.includes(theme.getFgAnsi("muted")));

	view.handleInput("j");
	assert.ok(containsBlock(view.render(120), expectedStatus(changedSnapshot(), 2)));
	const beforePreview = view.render(120);
	view.handleInput("\r");
	assert.match(view.render(120).map(stripSgr).join("\n"), /request version/);
	view.handleInput("\u001b");
	assert.deepEqual(view.render(120), beforePreview, "return restores the same selection and bar");
});

test("InjectionsView separates the fixed total from the list counter and selected-row bar", () => {
	let height = 40;
	const view = new InjectionsView(createTheme(), { snapshot: changedSnapshot() }, () => {}, () => height);
	view.handleInput("j");
	for (const width of [60, 80, 120]) {
		for (height of [40, 16, 40]) {
			const plain = view.render(width).map(stripSgr);
			const change = statusIndex(plain, expectedStatus(changedSnapshot(), 1));
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
			const description = noteIndex(plain);
			assert.ok(description >= 0 && plain.slice(description, hints - 1).every((line) => line !== ""),
				`${width}x${height}: the description ends one blank row above the hints`);
			const status = expectedStatus(changedSnapshot(), 1);
			const barEnd = plain.findIndex((line) => line.trim() === status.at(-1));
			assert.ok(barEnd >= statusIndex(plain, status));
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
	const expected = frameText(expectedStatus(changedSnapshot(), 2));
	for (const width of [24, 60, 80, 120]) {
		// At 24 columns the compact header, selected row, fixed total, and full bar need 13 rows
		for (height of [13, 16, 24, 50]) {
			const frame = view.render(width);
			const plain = frame.map(stripSgr);
			assert.equal(frame.length, height, `${width}x${height}: height`);
			assert.ok(frame.every((line) => visibleWidth(line) <= width), `${width}x${height}: width`);
			assert.ok(containsBlock(frame, [expected]), `${width}x${height}: the bar never collapses or clips`);
			assert.ok(plain.some((line) => line.startsWith("→")), "the selected row stays visible");
			assert.ok(plain.some((line) => line.startsWith("  TOTAL")), "the fixed total stays visible");
			assert.match(plain[0] ?? "", /^─+$/);
			assert.match(plain.at(-1) ?? "", /^─+$/);
			wholeOrAbsent(frame, [...noteLines("overview", width),
				...noteLines("payload-check", width, { guard: { status: "pending" } })]);
		}
		height = 100;
		assert.ok(containsBlock(view.render(width), noteLines("overview", width)));
	}
});

test("InjectionsView reserves only the selected bar's height, with an empty line on unchanged rows", () => {
	const data = snapshot(16);
	const first = data.groups[0]?.items[0];
	assert.ok(first !== undefined);
	const changed = { ...first, requestOnly: true, change: "modified" as const, diff: { added: 3, removed: 1 } };
	const modified: InjectionSnapshot = {
		...data, groups: [{ ...data.groups[0], items: [changed, ...(data.groups[0]?.items.slice(1) ?? [])] },
			...data.groups.slice(1)],
	};
	const view = new InjectionsView(createTheme(), { snapshot: modified }, () => {}, () => 30);
	// The group has a request-only change, but no Changed By field; an unchanged row has an empty bar
	view.handleInput("j");
	view.handleInput("j");
	const unchanged = view.render(120).map(stripSgr);
	assert.deepEqual(expectedStatus(modified, 2), [], "an unchanged row has no status text");
	const hints = unchanged.findIndex((line) => line.includes("↑↓/jk Navigate"));
	assert.deepEqual(unchanged.slice(hints - 3, hints), ["", "", ""], "one empty line between the bar's spacers");
	const visibleCount = (lines: readonly string[]) =>
		lines.filter((line) => /^(?:→ |  )(?:├─|└─|pi\b|npm:web\b)/.test(line)).length;
	view.handleInput("k");
	const changedFrame = view.render(120).map(stripSgr);
	assert.equal(expectedStatus(modified, 1).length, 2);
	assert.ok(containsBlock(changedFrame, expectedStatus(modified, 1)));
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
	for (let index = 0; index <= 4; index++) {
		assert.ok(containsBlock(view.render(120), expectedStatus(snapshot, index)));
		view.handleInput("j");
	}
	view.handleInput("\u001b[F");
	assert.ok(containsBlock(view.render(120), expectedStatus(snapshot, 6)));

	const originalFg = theme.fg.bind(theme);
	theme.fg = (color, text) => originalFg(color === "muted" ? "success" : color, text);
	view.invalidate();
	assert.ok(view.render(120).some((line) => line.includes(theme.fg("muted", "Change"))),
		"invalidation rebuilds field-name colors");
});

test("InjectionsView describes payload findings as payload-only changes, with unknown editors", () => {
	const view = new InjectionsView(createTheme(), { snapshot: guardedSnapshot() }, () => {}, () => 40);
	view.handleInput("\u001b[F");
	assert.ok(containsBlock(view.render(120), expectedStatus(guardedSnapshot(), 4)));
	view.handleInput("k");
	assert.ok(containsBlock(view.render(120), expectedStatus(guardedSnapshot(), 3)),
		"a group of payload changes alone keeps their scope and names no editor");
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
	assert.ok(containsBlock(list, expectedStatus(snapshot, 1)),
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
	assert.ok(preview.includes("    added note"), "an addition reads like plain content, its +4 already says it is new");
	const styled = view.render(100);
	assert.ok(styled.some((line) => line.includes(theme.fg("muted", " · user prompt #1"))));
	assert.ok(styled.some((line) => line.includes(theme.inverse("original"))));
	assert.ok(styled.some((line) => line.includes(theme.inverse("edited"))));
	assert.doesNotMatch(preview.join("\n"), /· session|#0/);
	assert.ok(containsBlock(preview, markerLegendLines(theme, ["diff", "request-only"], 100, "session")));
	view.handleInput("\u001b");
	assert.deepEqual(view.render(100), list, "Escape returns to the same row");
});

test("InjectionsView keeps payload check states out of the header", () => {
	const dispatch = { provider: "fixture", api: "fixture", model: "fixture" };
	const finding = { type: "payload-change", change: "added", part: "user", lines: [] } as const;
	const guards: Array<GuardResult | undefined> = [
		{ status: "pending" },
		{ status: "incomplete", reason: "No payload." },
		{ status: "incomplete", reason: "One channel failed.", findings: [] },
		{ status: "incomplete", reason: "One channel failed.", findings: [finding] },
		{ status: "complete", dispatch, findings: [] },
		{ status: "complete", dispatch, findings: [finding] },
		undefined,
	];
	for (const guard of guards) {
		const theme = createTheme();
		const view = new InjectionsView(theme, { snapshot: guardedSnapshot(), guard }, () => {}, () => 14);
		const lines = view.render(120);
		const header = lines.find((line) => stripSgr(line).includes(requestOriginLabel())) ?? "";
		assert.ok(header.includes(theme.fg("mdHeading", theme.bold(requestOriginLabel()))));
		assert.ok(!containsBlock(lines, noteLines("overview", 120)));
		assert.doesNotMatch(frameText(lines), /No payload|channel failed/);
		assert.doesNotMatch(stripSgr(header), /Payload|Hidden|hidden|bash|write/);
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
		const label = requestOriginLabel(probe);
		const styledLabel = theme.fg("mdHeading", theme.bold(label));
		assert.ok(stripSgr(header).includes(label));
		assert.ok(header.includes(styledLabel));
		assert.ok(header.includes(theme.fg("dim", " · ")));
		assert.doesNotMatch(stripSgr(header), /Payload/);
		assert.ok(view.render(24).some((line) => line.includes(styledLabel)), "split header keeps label styling");
		height = 6;
		assert.ok(view.render(90).some((line) => line.includes(styledLabel)), "compact header keeps label styling");
	}
});

test("InjectionsView moves the request origin below a narrow header and wraps instead of dropping it", () => {
	const theme = createTheme();
	const view = new InjectionsView(theme, {
		snapshot: snapshot(2), probe: true,
		guard: { status: "incomplete", reason: "One channel failed.", findings: [] },
	}, () => {}, () => 120);
	for (let width = 1; width <= 120; width++) {
		const lines = view.render(width).map(stripSgr);
		assertFrame(lines, width, 120);
		const selected = lines.findIndex((line) => line.startsWith("→"));
		if (width >= 4) assert.ok(selected >= 0);
		const headingText = lines.slice(0, selected < 0 ? undefined : selected).join("").replace(/\s+/g, "");
		assert.ok(headingText.includes(requestOriginLabel(true).replace(/\s/g, "")), `${width}: origin`);
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
		assert.ok(containsBlock(full, noteLines("overview", width)));
		assert.ok(containsBlock(full, noteLines("probe", width, { probe: true })));
		const selected = full.findIndex((line) => line.startsWith("→"));
		const header = full.slice(2, selected);
		for (height of [12, 16, 24]) {
			view.handleInput("\u001b[H");
			const collapsed = view.render(width).map(stripSgr);
			assert.ok(!containsBlock(collapsed, noteLines("overview", width)));
			view.handleInput("\u001b[F");
			const scrolled = view.render(width).map(stripSgr);
			for (const frame of [collapsed, scrolled]) {
				const selected = frame.findIndex((line) => line.startsWith("→"));
				assert.ok(selected >= 0);
				assert.ok(containsBlock(frame.slice(1, selected), [requestOriginLabel(true)]));
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
		assert.ok(!containsBlock(view.render(width), [requestOriginLabel(true)]));
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
			assert.ok(containsBlock(plain, [requestOriginLabel(true)]));
			assert.ok(plain.some((line) => line.startsWith("→")));
			assert.ok(containsBlock(lines, expectedStatus(changedSnapshot(), 2)));
		}
	}
});

test("InjectionsView retains the sanitized degraded reason in a compact descriptionless frame", () => {
	let height = 60;
	const reason = "Silent probe unavailable: no model is selected. Extension additions were not observed.";
	const view = createView(16, `${reason}\u001b[2J`, () => height);
	for (const width of [24, 60, 80, 120]) {
		for (height of [12, 16, 24]) {
			const lines = view.render(width);
			const plain = lines.map(stripSgr);
			assert.ok(lines.length <= height);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.doesNotMatch(lines.join("\n"), /\u001b\[2J/);
			assert.ok(!containsBlock(plain, noteLines("overview", width)));
			assert.ok(containsBlock(plain, [reason]));
			assert.ok(containsBlock(plain, [requestOriginLabel()]));
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
	assert.ok(header.includes(theme.fg("mdHeading", theme.bold(requestOriginLabel(true)))));
	assert.notEqual(header, before[2]);
});

/** Background escape the test theme's `searchMatchBg` falls back to (`selectedBg`). */
const SEARCH_MATCH_BG = "\u001b[48;2;17;34;51m";

/** Skills and an extension tool, where only some text mentions tree-sitter. */
function searchSnapshot(): InjectionSnapshot {
	const skill = (name: string, text: string): InjectionItem => ({ ...item(`skill:${name}`, "pi", true, 50), label: name, text });
	const filler = Array.from({ length: 40 }, (_, line) => `filler line ${line}`).join("\n");
	const skills: InjectionItem = {
		...item("skills", "pi", true, 150),
		label: "Skills (3)",
		children: [
			skill("agent-browser", `Drive a browser.\n${filler}`),
			skill("cymbal", `Navigate code.\n${filler}\nBuilt on tree-sitter.\n${filler}\ntree-sitter again`),
			skill("sdd", `Plan features.\n${filler}`),
		],
	};
	const system: InjectionItem = { ...item("system", "pi", true, 20), label: "System Prompt", text: "You are pi." };
	const webSearch: InjectionItem = {
		...item("tool:web_search", "npm:pi-web-access", false, 10),
		label: "web_search",
		text: "Search the web, not tree-sitter grammars.",
	};
	const groups = [group("pi", true, [system, skills]), group("npm:pi-web-access", false, [webSearch])];
	return { groups, totalTokens: 180 };
}

/** Test theme whose bold stays observable when Chalk detects no terminal. */
function styledTheme(): Theme {
	const theme = createTheme();
	theme.bold = (text) => `\u001b[1m${text}\u001b[22m`;
	return theme;
}

function typeKeys(view: InjectionsView, text: string): void {
	for (const key of text) view.handleInput(key);
}

/** Plain list rows between the header block and the hint row. */
function plainFrame(view: InjectionsView, width = 80): string[] {
	return view.render(width).map((line) => stripStyle(line).trimEnd());
}

/** A plain list row with its dot leaders and value padding collapsed to one space. */
function withoutLeaders(line: string): string {
	return line.replace(/ \.+ +/, " ");
}

test("InjectionsView filters rows by name, keeps ancestors, and Escape steps back out", () => {
	let closed = false;
	const theme = styledTheme();
	const view = new InjectionsView(theme, { snapshot: searchSnapshot() }, () => {
		closed = true;
	}, () => 30);
	assert.match(plainFrame(view).join("\n"), /↑↓\/jk Navigate · Enter Preview · \/ Filter · c Copy · Esc Close/);

	view.handleInput("/");
	let plain = plainFrame(view);
	const promptIndex = plain.findIndex((line) => line.startsWith("  ◉ Name | ○ Content >"));
	assert.equal(promptIndex, 4, "the prompt sits below the header and its blank row");
	assert.equal(plain[promptIndex + 1], "");
	assert.match(plain.join("\n"), /↑↓ Navigate · Tab Mode · Enter Preview · Esc Clear/);

	typeKeys(view, "cym");
	const lines = view.render(80);
	plain = lines.map((line) => stripStyle(line).trimEnd());
	assert.match(plain[promptIndex] ?? "", /^ {2}◉ Name \| ○ Content > cym +1 match$/);
	assert.ok((lines[promptIndex] ?? "").includes(theme.bold(theme.fg("accent", "◉ Name"))), "the active mode is bold accent");
	assert.ok((lines[promptIndex] ?? "").includes(theme.fg("dim", "○ Content")), "the other mode is dim");
	const rows = plain.slice(promptIndex + 2, plain.indexOf("", promptIndex + 2));
	assert.deepEqual(rows.map(withoutLeaders), ["  pi 170", "  └─ Skills (3) 150", "→    └─ cymbal 50"]);
	assert.ok((lines[promptIndex + 4] ?? "").includes(SEARCH_MATCH_BG), "the matched label text is highlighted");
	assert.match(plain.join("\n"), /TOTAL \(Prompt, Tools, Injections\) \.+ 180/, "the snapshot total is unchanged");

	// Enter keeps the filter and opens the selected match; Escape returns to the filtered list
	view.handleInput("\r");
	assert.match(plainFrame(view)[2] ?? "", /^cymbal/);
	view.handleInput("\u001b");
	plain = plainFrame(view);
	assert.match(plain[promptIndex] ?? "", /^ {2}◉ Name \| ○ Content > cym +1 match$/);
	assert.match(plain.join("\n"), /↑↓\/jk Navigate · Enter Preview · \/ Filter · c Copy · Esc Clear/);

	// Escape drops the filter but keeps the selected row, then closes the view
	view.handleInput("\u001b");
	plain = plainFrame(view);
	assert.ok(!plain.some((line) => line.includes("Content >")));
	assert.ok(plain.map(withoutLeaders).includes("→    ├─ cymbal 50"));
	assert.equal(closed, false);
	view.handleInput("\u001b");
	assert.equal(closed, true);
});

test("InjectionsView shows an empty filter result and Escape while typing drops the query", () => {
	const view = new InjectionsView(createTheme(), { snapshot: searchSnapshot() }, () => {}, () => 30);
	view.handleInput("/");
	typeKeys(view, "zzz");
	let plain = plainFrame(view);
	assert.match(plain.join("\n"), /◉ Name \| ○ Content > zzz +No matches/);
	assert.ok(plain.includes("  No injections match the filter."));
	view.handleInput("\r");
	assert.match(plainFrame(view)[2] ?? "", /^Context Injections/, "Enter has no row to open");

	view.handleInput("/");
	view.handleInput("\u001b");
	plain = plainFrame(view);
	assert.ok(!plain.some((line) => line.includes("Content >")));
	assert.ok(plain.some((line) => line.includes("agent-browser")));
});

test("InjectionsView erasing or canceling a typed filter restores the selection from before it", () => {
	const view = new InjectionsView(createTheme(), { snapshot: snapshot(16) }, () => {}, () => 16);
	for (let step = 0; step < 10; step++) view.handleInput("j");
	const before = plainFrame(view);

	// Erasing the query restores the list exactly, selection and scroll included
	view.handleInput("/");
	const prompt = plainFrame(view);
	typeKeys(view, "pi");
	view.handleInput("\u007f");
	view.handleInput("\u007f");
	assert.deepEqual(plainFrame(view), prompt, "erasing the query returns to the pre-filter row");

	// Escape while typing, after moving through the matches, also restores it
	typeKeys(view, "pi");
	view.handleInput("\u001b[B");
	view.handleInput("\u001b");
	assert.deepEqual(plainFrame(view), before, "Escape returns to the pre-filter row");
});

test("InjectionsView clearing a filter keeps a selected group whose label another group shares", () => {
	const sameLabel = (sourceId: string, items: InjectionItem[]): InjectionGroup => {
		const base = group(sourceId, false, items);
		return { ...base, source: { ...base.source, label: "tools" } };
	};
	const alpha = { ...item("alpha", "local:a", false, 10), label: "alpha" };
	const beta = { ...item("beta", "local:b", false, 20), label: "beta" };
	const view = new InjectionsView(createTheme(), {
		snapshot: { groups: [sameLabel("local:a", [alpha]), sameLabel("local:b", [beta])], totalTokens: 30 },
	}, () => {}, () => 30);
	view.handleInput("/");
	typeKeys(view, "beta");
	view.handleInput("\r");
	view.handleInput("\u001b");
	view.handleInput("k");
	view.handleInput("\u001b");
	const groupRows = plainFrame(view).map(withoutLeaders).filter((line) => /^. {1,3}tools /.test(line));
	assert.deepEqual(groupRows, ["  tools 10", "\u2192 tools 20"]);
});

test("InjectionsView content filter carries its query into the preview search", () => {
	const theme = styledTheme();
	const view = new InjectionsView(theme, { snapshot: searchSnapshot() }, () => {}, () => 30);
	view.handleInput("/");
	view.handleInput("\t");
	typeKeys(view, "tree-sitter");
	const prompt = view.render(80).find((line) => stripStyle(line).startsWith("  ○ Name | ◉ Content >")) ?? "";
	assert.ok(prompt.includes(theme.bold(theme.fg("accent", "◉ Content"))), "Tab makes Content the active mode");
	assert.ok(prompt.includes(theme.fg("dim", "○ Name")));
	let plain = plainFrame(view);
	assert.match(plain.join("\n"), /○ Name \| ◉ Content > tree-sitter +2 matches/);
	assert.match(plain.join("\n"), /↑↓ Navigate · Tab Mode · Enter Preview · Esc Clear/);
	assert.ok(plain.some((line) => line.startsWith("→    └─ cymbal")));
	assert.ok(plain.some((line) => line.includes("└─ web_search")));
	assert.ok(!plain.some((line) => line.includes("agent-browser")));

	// The preview opens on the first match, far below the first page, with its query kept
	view.handleInput("\r");
	const lines = view.render(80);
	plain = lines.map((line) => stripStyle(line).trimEnd());
	assert.match(plain[4] ?? "", /^ {2}Search: tree-sitter +1\/2$/);
	const matchRow = plain.findIndex((line) => line.includes("Built on tree-sitter."));
	assert.ok(matchRow > 0);
	assert.ok((lines[matchRow] ?? "").includes(SEARCH_MATCH_BG));
	assert.ok(!plain.some((line) => line.includes("Navigate code.")), "scrolled to the match");
	assert.match(plain.join("\n"), /↑↓\/jk Scroll · n\/N Next\/Prev · \/ Search · c Copy · Esc Back/);

	view.handleInput("n");
	plain = plainFrame(view);
	assert.match(plain[4] ?? "", /2\/2$/);
	assert.ok(plain.some((line) => line.includes("tree-sitter again")));
	view.handleInput("n");
	assert.match(plainFrame(view)[4] ?? "", /1\/2$/, "n wraps to the first match");
	view.handleInput("N");
	assert.match(plainFrame(view)[4] ?? "", /2\/2$/, "N wraps back to the last match");

	// Escape leaves the preview, keeping the content filter on the list
	view.handleInput("\u001b");
	assert.match(plainFrame(view).join("\n"), /○ Name \| ◉ Content > tree-sitter +2 matches/);
});

test("InjectionsView preview search types live, keeps the query on Enter, and drops it on Escape", () => {
	const view = new InjectionsView(createTheme(), { snapshot: searchSnapshot() }, () => {}, () => 30);
	view.handleInput("/");
	typeKeys(view, "cymbal");
	view.handleInput("\r");
	assert.ok(!plainFrame(view).some((line) => line.includes("Search:")), "a name filter starts the preview unsearched");

	view.handleInput("/");
	assert.match(plainFrame(view).join("\n"), /↑↓ Scroll · Enter Done · Esc Clear/);
	typeKeys(view, "again");
	let plain = plainFrame(view);
	assert.match(plain[4] ?? "", /^ {2}Search: again +1\/1$/);
	assert.ok(plain.some((line) => line.includes("tree-sitter again")));
	// j and k type into the open prompt instead of scrolling
	typeKeys(view, "jk");
	assert.match(plainFrame(view)[4] ?? "", /Search: againjk +No matches$/);
	view.handleInput("\u007f");
	view.handleInput("\u007f");
	view.handleInput("\r");
	plain = plainFrame(view);
	assert.match(plain[4] ?? "", /^ {2}Search: again +1\/1$/);

	view.handleInput("/");
	view.handleInput("\u001b");
	plain = plainFrame(view);
	assert.ok(!plain.some((line) => line.includes("Search:")));
	assert.match(plain.join("\n"), /↑↓\/jk Scroll · PgUp\/PgDn Page · \/ Search · c Copy · Esc Back/);
});

test("InjectionsView search stays within the width and drops the filter hint before others", () => {
	const view = new InjectionsView(createTheme(), { snapshot: searchSnapshot() }, () => {}, () => 30);
	const narrow = plainFrame(view, 50);
	const hints = narrow.find((line) => line.includes("Navigate"));
	assert.equal(hints, "  ↑↓/jk Navigate · Enter Preview · Esc Close");

	view.handleInput("/");
	view.handleInput("\t");
	typeKeys(view, "a very long query that cannot fit the prompt row at all");
	for (const width of [20, 50, 80, 120]) {
		for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}`);
	}
	view.handleInput("\u001b");
	view.handleInput("\u001b[B");
	view.handleInput("\u001b[B");
	view.handleInput("\u001b[B");
	view.handleInput("\u001b[B");
	view.handleInput("\r");
	view.handleInput("/");
	typeKeys(view, "filler");
	for (const width of [20, 50, 80, 120]) {
		for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `preview width ${width}`);
	}
});

test("InjectionsView content filter matches JSON as its preview expands it", () => {
	const json = JSON.stringify({ type: "object", properties: { query: { type: "string" } } });
	const tool: InjectionItem = {
		...item("tool:web_search", "npm:web", false, 10),
		label: "web_search",
		text: `Definition\n${json}`,
		jsonSpan: { start: 11, end: 11 + json.length },
	};
	const groups = [group("npm:web", false, [tool])];
	const view = new InjectionsView(createTheme(), { snapshot: { groups, totalTokens: 10 } }, () => {}, () => 30);
	view.handleInput("/");
	view.handleInput("\t");
	typeKeys(view, '"type": "object"');
	assert.match(plainFrame(view).join("\n"), /○ Name \| ◉ Content > "type": "object" +1 match/);
	view.handleInput("\r");
	assert.match(plainFrame(view)[4] ?? "", /^ {2}Search: "type": "object" +1\/1$/);
});

/** Let a resolved clipboard promise update the view before the next render. */
async function settleCopy(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

test("InjectionsView copies a highlighted group, item, and open preview", async () => {
	const copied: string[] = [];
	const actions: CopyActions = { copyText: async (text) => { copied.push(text); }, schedule: () => () => {} };
	const view = createView(8, undefined, () => 24, actions);

	// The first highlighted row is the pi group; copy every item in it.
	assert.match(plainFrame(view).find((line) => line.includes("Navigate")) ?? "", /c Copy/);
	view.handleInput("c");
	await settleCopy();
	assert.equal(copied[0]?.split("\n\n").length, 8);
	assert.match(copied[0] ?? "", /^pi-0 preview line 0/);
	assert.match(copied[0] ?? "", /pi-7 preview line 39/);

	// One item row copies only that item.
	view.handleInput("j");
	const itemText = copied[0]?.split("\n\n")[0] ?? "";
	view.handleInput("c");
	await settleCopy();
	assert.equal(copied[1], itemText);

	// Its open preview copies the same item text.
	view.handleInput("\r");
	assert.match(plainFrame(view).join("\n"), /↑↓\/jk Scroll · PgUp\/PgDn Page · \/ Search · c Copy · Esc Back/);
	view.handleInput("c");
	await settleCopy();
	assert.equal(copied[2], itemText);
	// The notice sits on the top border
	assert.ok(plainFrame(view)[0]?.includes(copiedNotice(itemText).text));
});

test("InjectionsView reports an empty item without writing the clipboard", async () => {
	const copied: string[] = [];
	const empty: InjectionItem = {
		id: "empty", kind: "base-prompt", source: { id: "pi", label: "pi", native: true },
		label: "empty", chars: 0, tokens: 0, text: "",
	};
	const snap: InjectionSnapshot = { groups: [group("pi", true, [empty])], totalTokens: 0 };
	const view = new InjectionsView(createTheme(), { snapshot: snap }, () => {}, () => 24, {
		copyText: async (text) => { copied.push(text); },
	});
	view.handleInput("j");
	view.handleInput("c");
	await settleCopy();
	assert.deepEqual(copied, []);
	assert.match(plainFrame(view)[0] ?? "", /Nothing to copy/);
});

test("InjectionsView copies only the visible items of a filtered group", async () => {
	const copied: string[] = [];
	const view = createView(8, undefined, () => 24, { copyText: async (text) => { copied.push(text); } });

	// Submit a name filter that keeps one item, then return to the group row.
	view.handleInput("/");
	typeKeys(view, "pi-3");
	view.handleInput("\r");
	view.handleInput("\u001b");
	view.handleInput("k");
	view.handleInput("c");
	await settleCopy();

	assert.equal(copied[0]?.split("\n\n").length, 1);
	assert.match(copied[0] ?? "", /^pi-3 preview line 0/);
});

/** The frame's top border as plain text, where the copy notice appears. */
function topBorderText(view: InjectionsView): string {
	return plainFrame(view)[0] ?? "";
}

/** The plain top border the frame shows without a copy notice. */
function plainBorder(view: InjectionsView): string {
	return "─".repeat(visibleWidth(topBorderText(view)));
}

test("InjectionsView stops publishing a copy result after close", async () => {
	let closed = false;
	const pending: Array<() => void> = [];
	const view = new InjectionsView(createTheme(), { snapshot: snapshot(8) }, () => { closed = true; }, () => 24, {
		copyText: () => new Promise<void>((resolve) => pending.push(resolve)),
	});
	view.handleInput("c");
	view.handleInput("\u001b");
	assert.ok(closed);
	pending[0]?.();
	await settleCopy();
	assert.equal(topBorderText(view), plainBorder(view));
});

test("InjectionsView stops redrawing a copy result after the host disposes it", async () => {
	const pending: Array<() => void> = [];
	let refreshes = 0;
	const view = createView(8, undefined, () => 24, {
		copyText: () => new Promise<void>((resolve) => pending.push(resolve)),
		refresh: () => { refreshes++; },
	});
	view.handleInput("c");
	view.dispose();
	const refreshesAtDispose = refreshes;
	pending[0]?.();
	await settleCopy();
	assert.equal(refreshes, refreshesAtDispose);
	assert.equal(topBorderText(view), plainBorder(view));
});

test("InjectionsView keeps a late copy result across keys until it expires", async () => {
	const pending: Array<() => void> = [];
	const expiries: Array<() => void> = [];
	const view = createView(8, undefined, () => 24, {
		copyText: () => new Promise<void>((resolve) => pending.push(resolve)),
		schedule: (callback) => {
			expiries.push(callback);
			return () => {};
		},
	});
	view.handleInput("c");
	view.handleInput("j");
	pending[0]?.();
	await settleCopy();
	assert.notEqual(topBorderText(view), plainBorder(view));
	view.handleInput("j");
	assert.notEqual(topBorderText(view), plainBorder(view));
	expiries[0]?.();
	assert.equal(topBorderText(view), plainBorder(view));
});
