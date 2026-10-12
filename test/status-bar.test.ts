/** Selected-row explanations, fixed semantic colors, sanitized metadata, and wrapping. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { THEME_COLOR_NAMES } from "../src/config.ts";
import type { ChangeScope, InjectionRow } from "../src/ui/injections-model.ts";
import { statusBarLines } from "../src/ui/status-bar.ts";

/** Distinct theme colors expose the field names, diff sides, and marker colors. */
function createTheme(): Theme {
	const colors = Object.fromEntries(THEME_COLOR_NAMES.map((name, index) => [name, index + 16]));
	return new Theme(colors as Record<ThemeColor, number>, {
		selectedBg: "", userMessageBg: "", customMessageBg: "",
		toolPendingBg: "", toolSuccessBg: "", toolErrorBg: "",
	}, "256color");
}

/** One changed leaf row; neither its label nor its id belongs in the bar. */
function row(scope?: ChangeScope): Extract<InjectionRow, { kind: "item" }> {
	return {
		kind: "item", label: "Do not repeat this label", tokens: 10, depth: 1, isLast: true,
		itemId: "Do not repeat this id", scope,
		...(scope === undefined ? {} : { diff: { added: 14, removed: 5 }, editors: [{ type: "unknown" as const }] }),
	};
}

/** Remove only SGR so unsafe controls remain visible to assertions. */
function plain(lines: readonly string[]): string[] {
	return lines.map((line) => line.replace(/\u001b\[[\d;]*m/g, ""));
}

test("status bar distinguishes saved, request-only, mixed, and payload changes", () => {
	const phrases: Record<ChangeScope, string> = {
		saved: "saved in the session",
		"saved-and-edit": "saved in the session, with an edit only in this request",
		partly: ", some saved in the session, some only in this request",
		request: "only in this request",
		"request-edit": "only in this request; the session keeps the original",
		"request-new": "only in this request; not in the session",
		payload: "only in the provider payload",
	};
	for (const [scope, phrase] of Object.entries(phrases)) {
		const lines = plain(statusBarLines(createTheme(), row(scope as ChangeScope), 120));
		assert.deepEqual(lines, [
			`    Change: +14 -5${scope === "partly" ? "" : " "}${phrase}`,
			"    Changed By: Unknown",
		]);
	}
});

test("status bar explains a request-only change even without a token diff", () => {
	const lines = plain(statusBarLines(createTheme(), { ...row("request-edit"), diff: undefined }, 120));
	assert.deepEqual(lines, [
		"    Change: only in this request; the session keeps the original",
		"    Changed By: Unknown",
	]);
});

test("status bar uses diff colors and brighter field names, never the selected row's accent", () => {
	const theme = createTheme();
	const lines = statusBarLines(theme, row("request-edit"), 120);
	assert.ok(lines[0]?.includes(theme.fg("muted", "Change")));
	assert.ok(lines[1]?.includes(theme.fg("muted", "Changed By")));
	assert.ok(lines[0]?.includes(theme.fg("toolDiffAdded", "+14")));
	assert.ok(lines[0]?.includes(theme.fg("toolDiffRemoved", "-5")));
	assert.ok(lines.every((line) => !line.includes(theme.getFgAnsi("accent"))));
	assert.ok(lines[1]?.includes(theme.fg("dim", "Unknown")));
});

test("status bar sanitizes editor names and marks guessed attribution without repeating source or location", () => {
	const entry: InjectionRow = {
		...row("saved"), editors: [
			{ type: "extension", source: { id: "ext:1", label: "npm:web\u001b[2J\n docs", native: false },
				attribution: "guess" },
			{ type: "extension", source: { id: "ext:2", label: "review.ts", native: false } },
			{ type: "unknown" },
		],
	};
	const lines = plain(statusBarLines(createTheme(), entry, 120));
	assert.equal(lines[1], "    Changed By: npm:web docs (guess), review.ts, Unknown");
	assert.doesNotMatch(lines.join("\n"), /Do not repeat|\u001b\[2J|ext:1|ext:2/);
});

test("system prompt rows explain the missing value without repeating an editor from their source", () => {
	const lines = plain(statusBarLines(createTheme(), { ...row("saved"), diffOnly: true }, 120));
	assert.deepEqual(lines, ["    Change: +14 -5 saved in the session", "    Already counted in System Prompt"]);
});

test("status bar explains state markers in their fixed colors, after change details", () => {
	const theme = createTheme();
	const moved = statusBarLines(theme, { ...row("request-edit"), moved: true, change: "forced" }, 120);
	assert.deepEqual(plain(moved).slice(2), [
		"    Moved: in a different position in the system prompt than usual",
		"    Forced: an extension’s prompt replaced pi’s system prompt for this request",
	]);
	assert.ok(moved[2]?.includes(theme.fg("warning", "Moved")));
	assert.ok(moved[3]?.includes(theme.fg("warning", "Forced")));
	const dropped = statusBarLines(theme, { ...row(), dropped: true }, 120);
	assert.deepEqual(plain(dropped), ["    Dropped: a custom system prompt replaced this part; counted nowhere"]);
	assert.ok(dropped[0]?.includes(theme.fg("toolDiffRemoved", "Dropped")));
});

test("status bar wraps fields with hanging indents without truncation, including narrow widths and Unicode", () => {
	const theme = createTheme();
	const entry: InjectionRow = {
		...row("partly"), diff: { added: 12_345, removed: 1_234 },
		editors: [{ type: "extension", source: { id: "ext", label: "npm:日本語-review", native: false } }],
	};
	const whole = plain(statusBarLines(theme, entry, 120)).map((line) => line.trim()).join(" ");
	for (const width of [12, 24, 60, 80, 120]) {
		const lines = statusBarLines(theme, entry, width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}: width`);
		const wrapped = plain(lines);
		assert.equal(wrapped.join("").replace(/\s/g, ""), whole.replace(/\s/g, ""));
		assert.ok(wrapped.every((line) => line.startsWith("    ")));
		assert.ok(!wrapped.some((line) => line.includes("…")));
	}
	for (const width of [1, 2, 4, 6]) {
		assert.ok(statusBarLines(theme, row("request-edit"), width).every((line) => visibleWidth(line) <= width));
	}
});

test("unchanged rows and non-selectable rows have no status text", () => {
	const theme = createTheme();
	assert.deepEqual(statusBarLines(theme, row(), 120), []);
	assert.deepEqual(statusBarLines(theme, { kind: "group", label: "pi", tokens: 10, depth: 0 }, 120), []);
	assert.deepEqual(statusBarLines(theme, { kind: "separator", label: "", tokens: 0, depth: 0 }, 120), []);
	assert.deepEqual(statusBarLines(theme, {
		kind: "total", label: "TOTAL (Prompt, Tools, Injections)", tokens: 10, depth: 0,
	}, 120), []);
});
