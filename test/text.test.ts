import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeInlineText, normalizePreviewText } from "../src/text.ts";

test("normalizePreviewText normalizes whitespace and removes terminal controls", () => {
	assert.equal(normalizePreviewText("a\r\nb\rc\td"), "a\nb\nc    d");
	assert.equal(normalizePreviewText("plain \u001b[31mansi\u001b[0m"), "plain ansi");
	assert.equal(normalizePreviewText("before\u001b]0;owned\u0007after\u0008!"), "beforeafter!");
	assert.equal(normalizePreviewText("before\u001bPpayload\u001b\\after\u009B2J"), "beforeafter");
});

test("normalizeInlineText removes terminal controls and embedded line breaks", () => {
	assert.equal(normalizeInlineText("tool\tname\nnext\u001b]0;owned\u0007"), "tool name next");
});
