import assert from "node:assert/strict";
import { test } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import {
	findMatches,
	highlightLine,
	labelMatches,
	matchStatus,
	PreviewSearch,
	searchableContent,
	searchPattern,
	SearchPrompt,
} from "../src/ui/search.ts";

/**
 * Theme stand-in with fixed zero-width styles, including the bold, inverse,
 * and underline that chalk omits without a capable terminal, so tests can
 * tell current matches apart.
 */
const sgrTheme = {
	fg: (_color: string, text: string) => `\u001b[38;5;1m${text}\u001b[39m`,
	bg: (_color: string, text: string) => `\u001b[48;5;2m${text}\u001b[49m`,
	bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
	inverse: (text: string) => `\u001b[7m${text}\u001b[27m`,
	underline: (text: string) => `\u001b[4m${text}\u001b[24m`,
} as unknown as Theme;

/** The stand-in's style for an ordinary match. */
function matchStyle(text: string): string {
	return sgrTheme.underline(sgrTheme.bg("searchMatchBg", sgrTheme.fg("searchMatchText", text)));
}

/** The stand-in's style for the current match. */
function currentStyle(text: string): string {
	return sgrTheme.bold(sgrTheme.inverse(sgrTheme.bg("searchMatchBg", sgrTheme.fg("searchMatchText", text))));
}

function pattern(query: string): RegExp {
	const result = searchPattern(query);
	assert.ok(result !== undefined);
	return result;
}

test("searchPattern ignores blank queries and escapes regular-expression syntax", () => {
	assert.equal(searchPattern(""), undefined);
	assert.equal(searchPattern("   "), undefined);
	assert.ok(pattern("a.b").test("A.B"));
	assert.ok(!pattern("a.b").test("axb"));
	assert.ok(pattern("  web   search ").test("Web Search"));
});

test("labelMatches compares a label as it renders on one line", () => {
	assert.ok(labelMatches("web\n\tsearch", pattern("web search")));
	assert.ok(!labelMatches("websearch", pattern("web search")));
});

test("searchableContent sanitizes and collapses whitespace so phrases match across lines", () => {
	assert.equal(searchableContent("Use\n\tthe \u001b[31mtree\u001b[0m-sitter"), "Use the tree-sitter");
});

test("findMatches finds case-insensitive matches and splits a phrase wrapped across rows", () => {
	const lines = ["  Use the Tree-", "  sitter tree-sitter", "  index"];
	const matches = findMatches(lines, pattern("tree-sitter"));
	assert.deepEqual(matches.map((match) => match.segments), [[{ row: 1, start: 9, end: 20 }]]);

	const wrapped = findMatches(["  navigate with", "  tree-sitter"], pattern("with tree"));
	assert.deepEqual(wrapped[0]?.segments, [{ row: 0, start: 11, end: 15 }, { row: 1, start: 2, end: 6 }]);
});

test("findMatches maps columns through escape sequences and wide characters", () => {
	const lines = ["\u001b[38;2;1;2;3m  名前 cymbal\u001b[39m"];
	const matches = findMatches(lines, pattern("cymbal"));
	// The two CJK characters occupy two columns each.
	assert.deepEqual(matches[0]?.segments, [{ row: 0, start: 7, end: 13 }]);
	assert.deepEqual(findMatches(lines, pattern("名前"))[0]?.segments, [{ row: 0, start: 2, end: 6 }]);
});

test("highlightLine styles only the matched columns and keeps the visible text", () => {
	const line = "\u001b[38;2;1;2;3m  the cymbal skill\u001b[39m";
	const highlighted = highlightLine(sgrTheme, line, [
		{ start: 6, end: 12, current: true },
		{ start: 13, end: 18, current: false },
	]);
	assert.equal(stripTerminalSequences(highlighted), "  the cymbal skill");
	assert.ok(highlighted.includes(currentStyle("cymbal")));
	assert.ok(highlighted.includes(matchStyle("skill")));
	assert.ok(highlighted.startsWith("\u001b[38;2;1;2;3m  the "), "text before a match keeps its own style");
});

test("matchStatus reports blank, none, an ordinal, or a counted noun", () => {
	assert.equal(matchStatus(false, 3, undefined), "");
	assert.equal(matchStatus(true, 0, undefined), "No matches");
	assert.equal(matchStatus(true, 4, 1), "2/4");
	assert.equal(matchStatus(true, 1, undefined), "1 match");
	assert.equal(matchStatus(true, 5, undefined), "5 matches");
});

test("PreviewSearch selects from the anchor while typing, then wraps through matches", () => {
	const lines = ["alpha", "beta needle", "gamma", "needle delta", "epsilon needle"];
	const search = new PreviewSearch();
	search.edit(2);
	for (const key of "needle") search.type(key);
	assert.equal(search.sync(lines), 3, "the first match at or after the anchor row");
	assert.equal(search.status, "2/3");

	search.prompt.submit();
	assert.ok(search.step(1));
	assert.equal(search.sync(lines), 4);
	assert.ok(search.step(1));
	assert.equal(search.sync(lines), 1, "wraps to the first match");
	assert.ok(search.step(-1));
	assert.equal(search.sync(lines), 4, "wraps back to the last match");
	assert.equal(search.sync(lines), undefined, "nothing moves without a pending step");

	search.clear();
	assert.equal(search.status, "");
	assert.ok(!search.step(1));
});

test("PreviewSearch recomputes matches for rewrapped lines and restarts from a row", () => {
	const search = new PreviewSearch();
	search.prompt.set("needle");
	search.restart(0);
	assert.equal(search.sync(["needle one", "needle two"]), 0);
	assert.equal(search.sync(["one", "two"]), undefined);
	assert.equal(search.status, "No matches");

	search.restart(1);
	assert.equal(search.sync(["needle", "x", "needle"]), 2);
	assert.equal(search.current, 1);
});

test("SearchPrompt edits through pi's Input and renders a read-only query once submitted", () => {
	const prompt = new SearchPrompt();
	assert.ok(!prompt.active);
	prompt.edit();
	assert.ok(prompt.type("w"));
	assert.ok(prompt.type("e"));
	assert.ok(prompt.type("b"));
	assert.ok(prompt.type("\u007f"), "backspace edits the query");
	assert.equal(prompt.query, "we");
	assert.ok(prompt.editing && prompt.active);

	prompt.submit();
	assert.ok(!prompt.editing);
	const line = stripTerminalSequences(prompt.render(sgrTheme, 40, "Search", "1/2"));
	assert.equal(line.length, 40);
	assert.match(line, /^ {2}Search: we {2,}1\/2 $/);

	prompt.set("cymbal");
	prompt.edit();
	prompt.type("s");
	assert.equal(prompt.query, "cymbals", "a carried query keeps the cursor at its end");
	prompt.clear();
	assert.ok(!prompt.editing && !prompt.active);
});

test("highlightLine closes every highlight and keeps the line's own trailing resets", () => {
	const line = "\u001b[38;2;1;2;3mneedle and needle\u001b[39m";
	const highlighted = highlightLine(sgrTheme, line, [
		{ start: 11, end: 17, current: false },
		{ start: 0, end: 6, current: true },
	]);
	assert.equal(stripTerminalSequences(highlighted), "needle and needle");
	assert.ok(highlighted.endsWith(`${matchStyle("needle")}\u001b[39m`), "the last match closes before the line's reset");
	assert.equal(highlightLine(sgrTheme, line, []), line);
});
