import assert from "node:assert/strict";
import { test } from "node:test";

import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULT_CATEGORY_COLORS, THEME_COLOR_NAMES } from "../src/config.ts";
import { analyzeSystemPrompt } from "../src/measure.ts";
import { buildSnapshot, type InitialSnapshot } from "../src/model.ts";
import { InjectionsView } from "../src/ui/injections-view.ts";
import { injectedDescriptionLines, previewBodyLines } from "../src/ui/section-preview.ts";
import { UsageView } from "../src/ui/usage-view.ts";
import { collectPreviewEntries, computeUsage } from "../src/usage.ts";

const GUIDELINE = "Use search to verify claims";
const SNIPPET = "Search the web";
/** Line pi renders for the extension tool under "Available tools:". */
const SNIPPET_LINE = `search: ${SNIPPET}`;
const SOURCE = "npm:web";
/** Arrow and label form one wrapping unit, joined by a non-breaking space. */
const ARROW = " <-\u00A0";
/** Carved lines name the tool pi reported for them, qualifying their source label. */
const TOOL = "search";
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

/** Measured prompt with short attributed lines and enough native lines to exercise caps. */
function createSnapshot(nativeLineCount = 16, withSnippet = false): InitialSnapshot {
	const nativeLines = Array.from({ length: nativeLineCount }, (_, index) => `- Native rule ${index}`).join("\n");
	const toolsBlock = withSnippet ? `\nAvailable tools:\n- ${SNIPPET_LINE}\n- read: Read files\n` : "";
	const prompt = `Preamble\n${toolsBlock}\nGuidelines:\n- ${GUIDELINE}\n${nativeLines}`;
	const items = analyzeSystemPrompt(prompt, { cwd: "/fixture" }, [{
		name: "search", description: "Search", parametersJson: "{}",
		snippet: withSnippet ? SNIPPET : undefined,
		guidelines: [GUIDELINE], source: SOURCE,
	}]);
	return buildSnapshot(items, "real-turn", new Date("2026-07-10T12:00:00Z"));
}

/** Drop only our SGR styling, leaving any unsafe control sequences visible to assertions. */
function plain(lines: readonly string[]): string {
	return lines.join("\n").replace(/\u001b\[[\d;]*m/g, "");
}

/** Parent and standalone previews share these semantic colors and a single fixed accounting footer. */
function assertAttribution(lines: readonly string[], theme: Theme, text = GUIDELINE): void {
	assertFooter(lines, theme);
	assert.ok(plain(lines).includes(`- ${text}${ARROW}${SOURCE}:${TOOL}`));
	const rendered = lines.find((line) => line.includes(text));
	assert.ok(rendered?.includes(theme.fg("syntaxNumber", `- ${text}`)));
	assert.ok(rendered?.includes(theme.fg("borderMuted", ARROW)));
	assert.ok(rendered?.includes(theme.fg("mdLink", SOURCE)));
	// The tool is a distinct span, so a themed label never swallows its qualifier.
	assert.ok(rendered?.includes(theme.fg("mdLinkUrl", `:${TOOL}`)));
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
	assert.match(plain(view.render(120)), /- Use search to verify claims/);
	assert.doesNotMatch(plain(view.render(120)), /Highlighted parts|<-\u00A0npm:web/);
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
	assert.equal(plain(parent).match(/Highlighted parts/g)?.length, 1);
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
	const view = new UsageView(theme, { usage, categoryColors: DEFAULT_CATEGORY_COLORS }, () => {}, () => height);
	const dashboard = view.render(120);
	assert.doesNotMatch(plain(dashboard), /verify claims|Highlighted parts/);
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
	assert.doesNotMatch(plain(body), /Highlighted parts|Arrow-marked/);
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
	const prompt = `Preamble\n\nGuidelines:\n- Native rule\nCurrent working directory: /fixture${addition}`;
	const snapshot = buildSnapshot(
		analyzeSystemPrompt(prompt, { cwd: "/fixture" }, [], {
			sources: [{ source: "npm:web", path: "/pkgs/web/index.ts" }],
		}),
		"real-turn",
		new Date("2026-07-10T12:00:00Z"),
	);
	const view = new InjectionsView(theme, { snapshot }, () => {}, () => 40);
	// The addition is owned by its extension, never by pi's own prompt.
	assert.match(plain(view.render(120)), /npm:web \.+ 9\n\s+└─ system prompt additions \.+ 9/);
	view.handleInput("j"); // System Prompt
	view.handleInput("\r");

	const parent = view.render(120);
	assert.ok(plain(parent).includes(`${addition.trim()}${ARROW}npm:web (guess)`));
	const rendered = parent.find((line) => line.includes("(guess)"));
	assert.ok(rendered?.includes(theme.fg("mdLink", "npm:web")));
	// One marker covers a guessed extension and any tool guessed inside it.
	assert.ok(rendered?.includes(theme.fg("dim", " (guess)")));
	assert.match(plain(parent).replace(/\s+/g, " "), /Sources marked \(guess\) are inferred from the injected text itself\./);

	view.handleInput("\u001b");
	for (let step = 0; step < 4; step++) view.handleInput("j"); // Extension Additions
	view.handleInput("\r");
	const child = view.render(120);
	assert.ok(plain(child).includes(`${addition.trim()}${ARROW}npm:web (guess)`));
	assert.match(plain(child).replace(/\s+/g, " "), /Sources marked \(guess\) are inferred/);

	// Usage counts it under the contributing extension, not under System Prompt.
	const usage = computeUsage({ snapshot, messages: [] });
	const extensions = usage.categories.find((category) => category.id === "extensions");
	assert.deepEqual(extensions?.children?.map((entry) => entry.label), ["npm:web"]);
	assert.equal(extensions?.tokens, collectPreviewEntries(extensions).reduce((sum, e) => sum + e.tokens, 0));
});

test("a guessed addition names the extension tool its text mentions", () => {
	const theme = createTheme();
	const addition = "\n\nCall web_search before answering; npm:web docs explain why.";
	const prompt = `Preamble\n\nGuidelines:\n- Native rule\nCurrent working directory: /fixture${addition}`;
	const snapshot = buildSnapshot(
		analyzeSystemPrompt(prompt, { cwd: "/fixture" }, [], {
			sources: [{ source: "npm:web", path: "/pkgs/web/index.ts", names: ["web_search", "/web"] }],
		}),
		"real-turn",
		new Date("2026-07-10T12:00:00Z"),
	);
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
	const lines = previewBodyLines(theme, {
		text: "Guidelines:\n- Native rule",
		injectedReferences: [{
			offset: "Guidelines:".length,
			text: "\n- A\u001b[2JB\u001b]52;c;clipboard-secret\u0007\n  continuation\t界",
			itemId: "tool:unsafe",
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
	assert.doesNotMatch(plain(lines), /Highlighted parts|Arrow-marked/);
});

test("the arrow stays attached to its label at every wrap width", () => {
	const theme = createTheme();
	const label = "npm:@eko24ive/pi-ask";
	const content = {
		text: "Guidelines:",
		injectedReferences: [{
			offset: "Guidelines:".length,
			text: "\n- Ask the user before choosing between valid directions",
			itemId: "tool:ask",
			source: { id: "ask", label, native: false },
			tool: "ask_user",
		}],
	};
	for (let width = 12; width <= 90; width++) {
		const lines = plain(previewBodyLines(theme, content, width, () => [])).split("\n");
		const annotation = `<-\u00A0${label}:ask_user`;
		// Only a line too narrow for the whole annotation may break it, and never right after the arrow.
		if (width >= visibleWidth(annotation) + 2) {
			assert.ok(lines.some((line) => line.includes(annotation)), `annotation kept whole at width ${width}`);
		}
		assert.ok(lines.every((line) => !/<-\u00A0?$/.test(line)), `no wrap after the arrow at width ${width}`);
	}
});

/** All preview levels that can render attributed System Prompt text. */
type PreviewTarget = "injections-parent" | "injections-child" | "usage-single" | "usage-stream" | "usage-full";

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
		injectedReferences: [{
			offset: 11, text: "\n- Use search", itemId: "tool:search",
			source: { id: "web", label: SOURCE, native: false },
		}],
	};
	// At 120 columns the footer occupies two wrapped lines and its preceding blank row
	for (const contentLineCount of [1, 2, 21, 22, 23, 80]) {
		const required = 3 + Math.min(22, contentLineCount) + (contentLineCount > 22 ? 1 : 0);
		const layout = { width: 120, contentLineCount, availableRows: required };
		assert.equal(plain(injectedDescriptionLines(theme, [content], layout)).replace(/\s+/g, " ").trim(), DESCRIPTION);
		for (let availableRows = -5; availableRows < required; availableRows++) {
			assert.deepEqual(injectedDescriptionLines(theme, [content], { ...layout, availableRows }), []);
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
