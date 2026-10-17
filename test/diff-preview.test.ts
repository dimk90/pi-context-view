/** Word-highlighted preview bodies: exact sides, physical-line context, sanitation, and responsive styling. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import type { InjectionSection } from "../src/model.ts";
import { messageDiffLines, payloadDiffLines } from "../src/ui/diff-preview.ts";
import { createTheme, stripSgr } from "./harness/frame.ts";

/** Remove renderer-owned styling for exact body assertions. */
function plain(lines: readonly string[]): string[] {
	return lines.map(stripSgr);
}

/** One modified string message, with both versions kept in the same part. */
function section(before: string, after: string): InjectionSection {
	return { label: "user", text: after, tokens: 1, change: "modified", message: { original: { text: before } } };
}

test("message diffs keep context once and highlight words across multiple changed lines", () => {
	const theme = createTheme();
	const part = section("context\nfirst old rule\nsecond old rule\nend", "context\nfirst new rule\nsecond new rule\nend");
	const rows = messageDiffLines(theme, part, 100);
	assert.deepEqual(plain(rows), [
		"    context", "  - first old rule", "  + first new rule", "  - second old rule", "  + second new rule", "    end",
	]);
	assert.equal(rows.filter((line) => line.includes(theme.inverse("old"))).length, 2);
	assert.equal(rows.filter((line) => line.includes(theme.inverse("new"))).length, 2);
	assert.ok(rows.every((line) => !line.includes(theme.inverse("rule"))));
	assert.ok(rows[0]?.includes(theme.fg("toolDiffContext", "context")));
});

test("whole-line message additions and deletions do not invert words or duplicate context", () => {
	const theme = createTheme();
	const cases: Array<[string, string, string[]]> = [
		["keep\nlast", "keep\ninsert\nlast", ["    keep", "  + insert", "    last"]],
		["keep\nremove\nlast", "keep\nlast", ["    keep", "  - remove", "    last"]],
		["", "one\ntwo", ["  + one", "  + two"]],
		["one\ntwo", "", ["  - one", "  - two"]],
		["\nkeep\n\nlast\n", "\nkeep\n\nlast\n", ["    ", "    keep", "    ", "    last"]],
		["", "", []],
	];
	for (const [before, after, expected] of cases) {
		const rows = messageDiffLines(theme, section(before, after), 100);
		assert.deepEqual(plain(rows), expected);
		assert.ok(rows.every((row) => !row.includes("\u001b[7m")));
	}
});

test("message diff bodies expand both marked JSON versions without changing the estimate or source", () => {
	const theme = createTheme();
	const before = JSON.stringify([{ type: "text", text: "old word" }]);
	const after = JSON.stringify([{ type: "text", text: "new word" }]);
	const part: InjectionSection = { ...section(before, after), tokens: 2,
		jsonSpan: { start: 0, end: after.length },
		message: { original: { text: before, jsonSpan: { start: 0, end: before.length } } } };
	const copy = structuredClone(part);
	const rows = messageDiffLines(theme, part, 100);
	assert.deepEqual(plain(rows), [
		"    [", "      {", '        "type": "text",', '  -     "text": "old word"', '  +     "text": "new word"',
		"      }", "    ]",
	]);
	assert.ok(rows.some((line) => line.includes(theme.inverse("new"))));
	assert.deepEqual(part, copy);
	const rawJson = messageDiffLines(theme, section(before, after), 100);
	assert.equal(rawJson.length, 2, "unmarked JSON-looking strings stay plain");
});

test("payload word highlighting compares all retained lines and preserves their guard order", () => {
	const theme = createTheme();
	const lines = [
		{ type: "removed" as const, text: "first old rule" }, { type: "removed" as const, text: "second old rule" },
		{ type: "added" as const, text: "first new rule" }, { type: "added" as const, text: "second new rule" },
		{ type: "removed" as const, text: "final old rule" }, { type: "added" as const, text: "final new rule" },
	];
	const rows = payloadDiffLines(theme, lines, 100);
	assert.deepEqual(plain(rows), lines.map((line) => `  ${line.type === "added" ? "+" : "-"} ${line.text}`));
	assert.equal(rows.filter((line) => line.includes(theme.inverse("old"))).length, 3);
	assert.equal(rows.filter((line) => line.includes(theme.inverse("new"))).length, 3);
});

test("diffs sanitize each whole side before inserting styles, and preserve Unicode through wrapping", () => {
	const theme = createTheme();
	const before = `keep\u001b[2J\t旧🙂 ${"old ".repeat(30)}end`;
	const after = `keep\u001b]8;;https://example.test\u0007\t新🙃 ${"new ".repeat(30)}end`;
	for (const width of [12, 24, 58, 78, 118]) {
		const rows = messageDiffLines(theme, section(before, after), width);
		assert.ok(rows.every((line) => visibleWidth(line) <= width + 2), `${width}: body indent plus available width`);
		assert.doesNotMatch(rows.join("\n"), /\u001b\[2J|https:|\u0007|\t|\uFFFD/);
		assert.ok(rows.some((line) => line.includes("\u001b[7m")));
		assert.ok(plain(rows).some((line) => line.startsWith("    ")), "continuations hang after the gutter");
	}
	const payload = payloadDiffLines(theme, [{ type: "added", text: "a\rb\u001b[2J" }], 100);
	assert.deepEqual(plain(payload), ["  + a b"]);
});

test("added, deleted, unchanged, and empty message sections all keep the diff body contract", () => {
	const theme = createTheme();
	const base = { label: "note", text: "body", tokens: 1, message: {} };
	assert.deepEqual(plain(messageDiffLines(theme, base, 100)), ["    body"]);
	assert.deepEqual(plain(messageDiffLines(theme, { ...base, change: "added" }, 100)), ["  + body"]);
	assert.deepEqual(plain(messageDiffLines(theme, { ...base, change: "deleted", tokens: 0 }, 100)), ["  - body"]);
	assert.deepEqual(messageDiffLines(theme, { ...base, text: "", tokens: 0 }, 100), []);
});
