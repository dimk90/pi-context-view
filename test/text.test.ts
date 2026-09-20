import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { normalizeInlineText, normalizePreviewText } from "../src/text.ts";

test("normalizePreviewText normalizes whitespace and removes terminal controls", () => {
	assert.equal(normalizePreviewText("a\r\nb\rc\td"), "a\nb\nc    d");
	assert.equal(normalizePreviewText("plain \u001b[31mansi\u001b[0m"), "plain ansi");
	assert.equal(normalizePreviewText("before\u001b]0;owned\u0007after\u0008!"), "beforeafter!");
	assert.equal(normalizePreviewText("before\u001bPpayload\u001b\\after\u009B2J"), "beforeafter");
});

test("normalizePreviewText strips every terminal string form and preserves incomplete payloads", () => {
	const starts = ["\u001b]", "\u001bP", "\u001bX", "\u001b^", "\u001b_", "\u0090", "\u0098", "\u009d", "\u009e", "\u009f"];
	for (const start of starts) {
		for (const end of ["\u0007", "\u001b\\", "\u009c"]) {
			assert.equal(normalizePreviewText(`before${start}hidden${start}nested${end}after`), "beforeafter");
			assert.equal(normalizePreviewText(`${start}first${end}between${start}second${end}`), "between");
			assert.equal(normalizePreviewText(`${start}complete${end}${start}incomplete`), "incomplete");
		}
		assert.equal(normalizePreviewText(`before${start}incomplete`), "beforeincomplete");
	}
	assert.equal(normalizePreviewText("\u001b]unfinished\r\ntext\t\u001b[31mred\u001b[0m"), "unfinished\ntext    red");
});

test("normalizePreviewText handles long unterminated terminal strings without quadratic rescanning", () => {
	// Bound a regression in a child process: a synchronous regex cannot be interrupted by node:test.
	const moduleUrl = new URL("../src/text.ts", import.meta.url).href;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import { normalizePreviewText } from ${JSON.stringify(moduleUrl)};
		for (const start of ["\\u001b]", "\\u001bP", "\\u009d", "\\u0090"]) {
			assert.equal(normalizePreviewText(start.repeat(128_000) + "visible"), "visible");
		}
	`], { timeout: 10_000, encoding: "utf8" });
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
});

test("normalizeInlineText removes terminal controls and embedded line breaks", () => {
	assert.equal(normalizeInlineText("tool\tname\nnext\u001b]0;owned\u0007"), "tool name next");
});
