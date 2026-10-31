import assert from "node:assert/strict";
import { test } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
	COPY_HINT,
	CopyNotices,
	copyableJoin,
	copyableText,
	copiedNotice,
	copyFailureNotice,
} from "../src/ui/copy.ts";
import { BODY_INDENT, fitHintRow } from "../src/ui/layout.ts";
import { SearchPrompt, searchHints } from "../src/ui/search.ts";
import { createTheme, stripSgr } from "./harness/frame.ts";

test("copyableText strips terminal controls but keeps tabs and spacing", () => {
	assert.equal(
		copyableText("\n\n- A\u001b[2JB\u001b]52;c;secret\u0007\n  continuation\t界  \n"),
		"- AB\n  continuation\t界",
	);
	assert.equal(copyableText("  leading spaces stay\nsecond line"), "  leading spaces stay\nsecond line");
	assert.equal(copyableText("target:\n\techo hi\nother:\n\techo bye"), "target:\n\techo hi\nother:\n\techo bye");
	assert.equal(copyableText("\n\u001b[31m\n"), "");
});

test("copyableJoin keeps one blank line between non-empty pieces", () => {
	assert.equal(copyableJoin(["first\n", "", "  ", "second\nthird"]), "first\n\nsecond\nthird");
	assert.equal(copyableJoin([]), "");
});

test("copy notices count characters and sanitize failures", () => {
	assert.deepEqual(copiedNotice("hello\nworld"), { text: "Copied 11 chars", kind: "success" });
	// An emoji, a combined accent, and a ZWJ family each count as one character
	assert.equal(copiedNotice("\u{1F600}e\u0301\u{1F468}\u200D\u{1F469}\u200D\u{1F467}").text, "Copied 3 chars");
	assert.deepEqual(copyFailureNotice(new Error("failed\u001b]52;c;secret\u0007")), {
		text: "Copy failed: failed",
		kind: "error",
	});
});

/** Let a resolved clipboard promise publish its result. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

test("CopyNotices keeps the latest result and drops stale ones", async () => {
	const writes: Array<{ text: string; resolve: () => void }> = [];
	const notices = new CopyNotices((text) => new Promise<void>((resolve) => writes.push({ text, resolve })));
	const current = () => notices.current;

	// Pending, then the next key clears it; the late result must not restore it
	notices.copy("first");
	assert.deepEqual(current(), { text: "Copying…", kind: "pending" });
	notices.clear();
	assert.equal(current(), undefined);
	writes[0]?.resolve();
	await settle();
	assert.equal(current(), undefined);

	// Two quick copies resolving out of order: the newest request wins
	notices.copy("second");
	notices.copy("third");
	writes[2]?.resolve();
	await settle();
	assert.equal(current()?.text, copiedNotice("third").text);
	writes[1]?.resolve();
	await settle();
	assert.equal(current()?.text, copiedNotice("third").text);

	// A closed overlay stops publishing results
	notices.copy("fourth");
	notices.dispose();
	writes[3]?.resolve();
	await settle();
	assert.equal(current()?.kind, "pending");
});

test("CopyNotices reports empty text without writing and sanitizes failures", async () => {
	const writes: string[] = [];
	const notices = new CopyNotices(async (text) => {
		writes.push(text);
		throw new Error("no clipboard\u001b]52;c;secret\u0007");
	});

	notices.copy("");
	assert.deepEqual(writes, []);
	assert.deepEqual(notices.current, { text: "Nothing to copy", kind: "error" });

	notices.copy("payload");
	await settle();
	assert.deepEqual(writes, ["payload"]);
	assert.deepEqual(notices.current, { text: "Copy failed: no clipboard", kind: "error" });
});

test("CopyNotices.line renders a width-fitted footer notice", async () => {
	const theme = createTheme();
	const notices = new CopyNotices(async () => {});
	assert.equal(notices.line(theme, 80), "");

	notices.copy("hello\nworld");
	assert.equal(notices.line(theme, 80), theme.fg("muted", `${BODY_INDENT}Copying…`));
	await settle();
	assert.equal(notices.line(theme, 80), theme.fg("success", `${BODY_INDENT}Copied 11 chars`));
	const narrow = notices.line(theme, 12);
	assert.ok(visibleWidth(narrow) <= 12);
	assert.ok(visibleWidth(narrow) > 0);

	const failing = new CopyNotices(async () => { throw new Error("no clipboard"); });
	failing.copy("x");
	await settle();
	assert.equal(failing.line(theme, 80), theme.fg("error", `${BODY_INDENT}Copy failed: no clipboard`));
});

test("CopyNotices refuses a copy after dispose", () => {
	const writes: string[] = [];
	const notices = new CopyNotices(async (text) => { writes.push(text); });
	notices.dispose();
	notices.copy("payload");
	assert.deepEqual(writes, []);
	assert.equal(notices.current, undefined);
});

test("COPY_HINT is optional, so a narrow hint row keeps the required hints", () => {
	const theme = createTheme();
	const hints = searchHints(new SearchPrompt(), "Scroll", COPY_HINT);
	assert.match(stripSgr(fitHintRow(theme, hints, 120)), /c Copy/);
	const narrow = stripSgr(fitHintRow(theme, hints, 55));
	assert.match(narrow, /Esc Back/);
	assert.doesNotMatch(narrow, /c Copy/);
});
