/**
 * Word-level comparison and the token diff it implies: changed characters
 * round up to tokens, and the result reconciles exactly with both estimates.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { textTokens } from "../src/measure.ts";
import { countWordChanges, type DiffSide, diffWords, measureTokenDiff } from "../src/token-diff.ts";

/** A side whose estimate is the plain character heuristic. */
function side(text: string): DiffSide {
	return { text, tokens: textTokens(text) };
}

test("countWordChanges counts only the characters one side has", () => {
	assert.deepEqual(countWordChanges("same text", "same text"), { addedChars: 0, removedChars: 0 });
	assert.deepEqual(countWordChanges("", "added"), { addedChars: 5, removedChars: 0 });
	assert.deepEqual(countWordChanges("removed", ""), { addedChars: 0, removedChars: 7 });
	const line = "\n- search: Search the web";
	assert.deepEqual(countWordChanges("- read: Read files\n- write: Write", `- read: Read files${line}\n- write: Write`),
		{ addedChars: line.length, removedChars: 0 }, "an inserted line counts exactly");
	assert.deepEqual(countWordChanges("Summarize the latest test results.", "Summarize XYZZY_PAYLOAD results."),
		{ addedChars: "XYZZY_PAYLOAD".length, removedChars: "the latest test".length });
});

test("countWordChanges aligns words, not characters, and keeps whole code points", () => {
	assert.deepEqual(countWordChanges("cat", "cart"), { addedChars: 4, removedChars: 3 }, "a changed word is replaced");
	assert.deepEqual(countWordChanges("keep 🙂 here", "keep 🙃 here"), { addedChars: 2, removedChars: 2 });
	assert.deepEqual(countWordChanges("a b c d", "a x c y"), { addedChars: 2, removedChars: 2 });
});

test("countWordChanges counts an unaligned middle as replaced, keeping the common ends", () => {
	const before = Array.from({ length: 3_000 }, (_, index) => `old${index}`).join(" ");
	const after = Array.from({ length: 3_000 }, (_, index) => `new${index}`).join(" ");
	const changes = countWordChanges(`start ${before} end`, `start ${after} end`);
	// Too many edits to align: the whole middle is replaced, while the shared ends stay matched
	assert.deepEqual(changes, { addedChars: after.length, removedChars: before.length });
});

test("diffWords reconstructs both sides on the same alignment as counts", () => {
	const texts = ["", "a", "b", "a b", "b a", "a b a", "a\nb", "a b\n", "  a\n  b", "a 🙂 中", "b 🙃 中"];
	for (const before of texts) {
		for (const after of texts) {
			const parts = diffWords(before, after);
			assert.equal(parts.filter((part) => part.type !== "added").map((part) => part.text).join(""), before);
			assert.equal(parts.filter((part) => part.type !== "removed").map((part) => part.text).join(""), after);
			assert.deepEqual({
				addedChars: parts.filter((part) => part.type === "added").reduce((sum, part) => sum + part.text.length, 0),
				removedChars: parts.filter((part) => part.type === "removed").reduce((sum, part) => sum + part.text.length, 0),
			}, countWordChanges(before, after));
		}
	}
	assert.deepEqual(diffWords("Summarize the latest test results.", "Summarize XYZZY_PAYLOAD results."), [
		{ type: "unchanged", text: "Summarize " }, { type: "removed", text: "the latest test" },
		{ type: "added", text: "XYZZY_PAYLOAD" }, { type: "unchanged", text: " results." },
	]);
});

test("diffWords bounds the preview trace and retains matching ends on fallback", () => {
	const before = Array.from({ length: 3_000 }, (_, index) => `old${index}`).join(" ");
	const after = Array.from({ length: 3_000 }, (_, index) => `new${index}`).join(" ");
	assert.deepEqual(diffWords(`start ${before} end`, `start ${after} end`), [
		{ type: "unchanged", text: "start " }, { type: "removed", text: before },
		{ type: "added", text: after }, { type: "unchanged", text: " end" },
	]);
});

test("measureTokenDiff counts a missing base as added and an empty request as removed", () => {
	assert.deepEqual(measureTokenDiff(undefined, { text: "abc", tokens: 7 }), { added: 7, removed: 0 });
	assert.equal(measureTokenDiff(undefined, { text: "", tokens: 0 }), undefined);
	assert.deepEqual(measureTokenDiff({ text: "session text", tokens: 5 }, { text: "", tokens: 0 }),
		{ added: 0, removed: 5 }, "a deletion removes the whole base estimate");
	assert.equal(measureTokenDiff({ text: "same", tokens: 1 }, { text: "same", tokens: 2 }), undefined,
		"equal texts are unchanged even when a share rounds differently");
});

test("measureTokenDiff reconciles exactly with the base and request estimates", () => {
	const cases: Array<[DiffSide, DiffSide]> = [
		[side("old rule"), side("new rule!")],
		[side("second prompt"), { text: "edited second prompt", tokens: 5 }],
		[side("- read: Read files"), { text: "- read: Read files\n- search: Search the web", tokens: 10 }],
		[{ text: "with [image]", tokens: 1_203 }, { text: "with text", tokens: 3 }],
		[side("x".repeat(9)), { text: "x".repeat(9) + "y", tokens: 2 }],
	];
	for (const [base, request] of cases) {
		const diff = measureTokenDiff(base, request);
		assert.ok(diff !== undefined);
		assert.ok(diff.added >= 0 && diff.removed >= 0, `${request.text}: no negative side`);
		assert.equal(base.tokens + diff.added - diff.removed, request.tokens, `${request.text}: reconciles`);
	}
	assert.deepEqual(measureTokenDiff({ text: "with [image]", tokens: 1_203 }, { text: "with text", tokens: 3 }),
		{ added: 1, removed: 1_201 }, "a removed image counts as removed, not as a smaller addition");
	const json = '[{"type":"text","text":"XYZZY_CONTEXT_DELETE: reply with one word: ok"}]';
	const replacement = { text: "A replacement note for the request.", tokens: 9 };
	assert.deepEqual(measureTokenDiff({ text: json, tokens: 12 }, replacement), { added: 9, removed: 12 },
		"text outside the estimates never removes more than the base has");
	const insertion = measureTokenDiff(side("- read"), { text: "- read\n- search", tokens: 3 });
	assert.deepEqual(insertion, { added: 1, removed: 0 }, "a pure insertion stays a pure addition");
});
