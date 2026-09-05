import assert from "node:assert/strict";
import { test } from "node:test";

import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULT_CATEGORY_COLORS, THEME_COLOR_NAMES } from "../src/config.ts";
import { analyzeSystemPrompt } from "../src/measure.ts";
import { buildSnapshot, type InitialSnapshot } from "../src/model.ts";
import { InjectionsView } from "../src/ui/injections-view.ts";
import { guidelineDescriptionLines, previewBodyLines } from "../src/ui/section-preview.ts";
import { UsageView } from "../src/ui/usage-view.ts";
import { collectPreviewEntries, computeUsage } from "../src/usage.ts";

const GUIDELINE = "Use search to verify claims";
const SOURCE = "npm:web";
const DESCRIPTION = "Highlighted parts are injected by extensions into pi’s system prompt. " +
	"They are excluded from the System Prompt token count and included in the injecting extension’s count.";

/** Distinct colors make attribution and theme invalidation observable without a terminal. */
function createTheme(): Theme {
	const foreground = Object.fromEntries(THEME_COLOR_NAMES.map((name, index) => [name, index + 16]));
	return new Theme(foreground as Record<ThemeColor, number>, {
		selectedBg: "", userMessageBg: "", customMessageBg: "",
		toolPendingBg: "", toolSuccessBg: "", toolErrorBg: "",
	}, "256color");
}

/** Measured prompt with a short attributed bullet and enough native lines to exercise caps. */
function createSnapshot(nativeLineCount = 16): InitialSnapshot {
	const nativeLines = Array.from({ length: nativeLineCount }, (_, index) => `- Native rule ${index}`).join("\n");
	const prompt = `Preamble\n\nGuidelines:\n- ${GUIDELINE}\n${nativeLines}`;
	const items = analyzeSystemPrompt(prompt, { cwd: "/fixture" }, [{
		name: "search", description: "Search", parametersJson: "{}",
		guidelines: [GUIDELINE], source: SOURCE,
	}]);
	return buildSnapshot(items, "real-turn", new Date("2026-07-10T12:00:00Z"));
}

/** Drop only our SGR styling, leaving any unsafe control sequences visible to assertions. */
function plain(lines: readonly string[]): string {
	return lines.join("\n").replace(/\u001b\[[\d;]*m/g, "");
}

/** Parent and standalone previews share these semantic colors and a single fixed accounting footer. */
function assertAttribution(lines: readonly string[], theme: Theme): void {
	assertFooter(lines, theme);
	assert.match(plain(lines), /- Use search to verify claims -> npm:web/);
	const bullet = lines.find((line) => line.includes(GUIDELINE));
	assert.ok(bullet?.includes(theme.fg("customMessageLabel", `- ${GUIDELINE}`)));
	assert.ok(bullet?.includes(theme.fg("dim", " -> ")));
	assert.ok(bullet?.includes(theme.fg("mdLink", SOURCE)));
}

/** The complete dim explanation sits outside the content/gutter and directly above hints. */
function assertFooter(lines: readonly string[], theme: Theme): void {
	const rendered = plain(lines).split("\n");
	const start = rendered.findIndex((line) => line.includes("Highlighted parts"));
	const hints = rendered.findIndex((line) => line.includes("↑↓/jk"));
	assert.ok(start > 0 && hints > start);
	assert.equal(hints, lines.length - 3);
	assert.equal(rendered[start - 1], "");
	assert.equal(rendered[hints - 1], "");
	assert.equal(rendered.filter((line) => line.includes("Highlighted parts")).length, 1);
	const footer = rendered.slice(start, hints - 1);
	assert.equal(footer.map((line) => line.trim()).join(" "), DESCRIPTION);
	assert.ok(footer.every((line) => line.startsWith("  ")));
	for (let index = start; index < hints - 1; index++) {
		assert.equal(lines[index], theme.fg("dim", rendered[index] ?? ""));
	}
}

/** Assert a whole frame stays within the live terminal dimensions. */
function assertFrame(lines: readonly string[], width: number, height: number): void {
	assert.ok(lines.length <= height);
	assert.ok(lines.every((line) => visibleWidth(line) <= width));
}

test("Injections shows attributed guidelines only after Enter, for parent and child previews", () => {
	let height = 40;
	const theme = createTheme();
	const view = new InjectionsView(theme, { snapshot: createSnapshot() }, () => {}, () => height);
	assert.doesNotMatch(plain(view.render(120)), /verify claims|Highlighted parts/);
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
	theme.fg = (color, text) => originalFg(color === "customMessageLabel" ? "warning" : color, text);
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
	assert.match(plain(view.render(120)), /- Use search to verify claims/);
	assert.doesNotMatch(plain(view.render(120)), /Highlighted parts|-> npm:web/);
});

test("Usage retains attribution inside one capped block and its full-content level", () => {
	let height = 40;
	const theme = createTheme();
	const usage = computeUsage({ snapshot: createSnapshot(), messages: [] });
	const view = new UsageView(theme, { usage, categoryColors: DEFAULT_CATEGORY_COLORS }, () => {}, () => height);
	const dashboard = view.render(120);
	assert.doesNotMatch(plain(dashboard), /verify claims|Highlighted parts/);
	view.handleInput("\r");
	const stream = view.render(120);
	assertAttribution(stream, theme);
	assert.match(plain(stream), /… \+\d+ lines · Enter - View Content/);
	assert.equal(plain(stream).match(/\[System Prompt\]/g)?.length, 1);
	const category = usage.categories.find((category) => category.id === "system-prompt");
	assert.ok(category);
	const entry = collectPreviewEntries(category)[0];
	assert.ok(entry);
	const body = previewBodyLines(theme, entry, 115, (text) => text.split("\n"), "System Prompt");
	assert.doesNotMatch(plain(body), /Highlighted parts|Arrow-marked/);
	assert.equal(Number(plain(stream).match(/… \+(\d+) lines/)?.[1]), body.length - 10);
	view.handleInput("\r");
	assertAttribution(view.render(120), theme);
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
	assertAttribution(view.render(120), theme);
	assert.equal(plain(view.render(120)), plain(stream));
	view.handleInput("\u001b");
	assert.deepEqual(view.render(120), dashboard);
});

test("reference text and source are sanitized before coloring and wrapping", () => {
	const theme = createTheme();
	const lines = previewBodyLines(theme, {
		text: "Guidelines:\n- Native rule",
		guidelineReferences: [{
			offset: "Guidelines:".length,
			text: "\n- A\u001b[2JB\u001b]52;c;clipboard-secret\u0007\n  continuation\t界",
			itemId: "tool:unsafe",
			source: { id: "unsafe", label: "npm:\u001b[31mweb\u001b[0m\r\nowner", native: false },
		}],
	}, 28, () => { throw new Error("Referenced content must sanitize before adding theme colors"); });
	assert.doesNotMatch(plain(lines), /\u001b|clipboard-secret|\t|\r/);
	assert.match(plain(lines), /- AB/);
	assert.match(plain(lines), /npm:web owner/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 30));
	const continuation = lines.find((line) => line.includes("continuation"));
	assert.ok(continuation?.includes(theme.getFgAnsi("customMessageLabel")), "multiline guidelines keep their color");
	assert.doesNotMatch(plain(lines), /Highlighted parts|Arrow-marked/);
});

/** All preview levels that can render attributed System Prompt text. */
type PreviewTarget = "injections-parent" | "injections-child" | "usage-stream" | "usage-full";

/** Open a synthetic long preview through the same Enter gates as a user. */
function createPreview(target: PreviewTarget, theme: Theme, getRows: () => number): InjectionsView | UsageView {
	const snapshot = createSnapshot(80);
	if (target === "injections-parent" || target === "injections-child") {
		const view = new InjectionsView(theme, { snapshot }, () => {}, getRows);
		view.render(120);
		for (let step = 0; step < (target === "injections-child" ? 3 : 1); step++) view.handleInput("j");
		view.handleInput("\r");
		return view;
	}
	const view = new UsageView(theme, {
		usage: computeUsage({ snapshot, messages: [] }),
		categoryColors: new Map(DEFAULT_CATEGORY_COLORS).set("system-prompt", "error"),
	}, () => {}, getRows);
	view.render(120);
	view.handleInput("\r");
	view.render(120);
	if (target === "usage-full") view.handleInput("\r");
	return view;
}

for (const target of ["injections-parent", "injections-child", "usage-stream", "usage-full"] as const) {
	test(`${target} footer stays pinned, collapses whole, and returns on height-only resize`, () => {
		let height = 40;
		const theme = createTheme();
		const view = createPreview(target, theme, () => height);
		const initial = view.render(120);
		assertAttribution(initial, theme);
		const footerStart = initial.findIndex((line) => line.includes("Highlighted parts"));
		for (const key of ["j", "\u001b[6~", "\u001b[F", "\u001b[<65;1;1M", "\u001b[5~", "\u001b[H"]) {
			view.handleInput(key);
			assert.deepEqual(view.render(120).slice(footerStart), initial.slice(footerStart));
		}
		for (const width of [30, 51, 60, 80, 120]) {
			let sawCollapsed = false;
			let sawVisible = false;
			for (height = 1; height <= 45; height++) {
				const lines = view.render(width);
				assertFrame(lines, width, height);
				if (plain(lines).includes("Highlighted parts")) {
					assertFooter(lines, theme);
					sawVisible = true;
				} else {
					sawCollapsed = true;
					assert.doesNotMatch(plain(lines), /injecting extension’s count/);
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

test("attribution footer gives short content every row and never truncates on tiny terminals", () => {
	const theme = createTheme();
	const content = {
		text: "Guidelines:",
		guidelineReferences: [{
			offset: 11, text: "\n- Use search", itemId: "tool:search",
			source: { id: "web", label: SOURCE, native: false },
		}],
	};
	// At 120 columns the footer occupies two wrapped lines and its preceding blank row
	for (const contentLineCount of [1, 2, 9, 10, 11, 80]) {
		const required = 3 + Math.min(10, contentLineCount) + (contentLineCount > 10 ? 1 : 0);
		const layout = { width: 120, contentLineCount, availableRows: required };
		assert.equal(plain(guidelineDescriptionLines(theme, [content], layout)).replace(/\s+/g, " ").trim(), DESCRIPTION);
		for (let availableRows = -5; availableRows < required; availableRows++) {
			assert.deepEqual(guidelineDescriptionLines(theme, [content], { ...layout, availableRows }), []);
		}
	}
});

test("native-only System Prompt and sibling previews do not claim extension injection", () => {
	const snapshot = buildSnapshot(analyzeSystemPrompt(
		"Preamble\n\nGuidelines:\n- Native rule -> npm:web", { cwd: "/fixture" }, [],
	), "real-turn", new Date());
	const theme = createTheme();
	const view = new InjectionsView(theme, { snapshot }, () => {}, () => 40);
	view.handleInput("j"); // System Prompt
	view.handleInput("\r");
	assert.doesNotMatch(plain(view.render(120)), /Highlighted parts|Arrow-marked/);
	view.handleInput("\u001b");
	view.handleInput("j"); // Preamble
	view.handleInput("j"); // Guidelines
	view.handleInput("\r");
	assert.doesNotMatch(plain(view.render(120)), /Highlighted parts|Arrow-marked/);

	const usage = new UsageView(theme, {
		usage: computeUsage({ snapshot, messages: [] }), categoryColors: DEFAULT_CATEGORY_COLORS,
	}, () => {}, () => 40);
	usage.handleInput("\r");
	assert.doesNotMatch(plain(usage.render(120)), /Highlighted parts|Arrow-marked/);

	const injected = new InjectionsView(theme, { snapshot: createSnapshot() }, () => {}, () => 40);
	injected.handleInput("j"); // System Prompt
	injected.handleInput("j"); // Preamble sibling of attributed Guidelines
	injected.handleInput("\r");
	assert.doesNotMatch(plain(injected.render(120)), /Highlighted parts|Arrow-marked/);
});
