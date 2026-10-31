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
	type ScheduleTimeout,
} from "../src/ui/copy.ts";
import { fitHintRow } from "../src/ui/layout.ts";
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
	assert.deepEqual(copiedNotice("hello\nworld"), { text: "Copied: 11 chars", kind: "success" });
	// An emoji, a combined accent, and a ZWJ family each count as one character
	assert.equal(copiedNotice("\u{1F600}e\u0301\u{1F468}\u200D\u{1F469}\u200D\u{1F467}").text, "Copied: 3 chars");
	assert.deepEqual(copyFailureNotice(new Error("failed\u001b]52;c;secret\u0007")), {
		text: "Copy failed: failed",
		kind: "error",
	});
});

/** Let a resolved clipboard promise publish its result. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

/** A notice timer driven by the test instead of the clock. */
interface ManualTimers {
	readonly schedule: ScheduleTimeout;
	/** Durations of the timers still waiting, in scheduling order. */
	pendingDurations(): number[];
	/** Fire every waiting timer. */
	fireAll(): void;
}

/** Create timers that only fire when the test says so. */
function manualTimers(): ManualTimers {
	const timers: Array<{ callback: () => void; milliseconds: number; cancelled: boolean }> = [];
	const waiting = () => timers.filter((timer) => !timer.cancelled);
	return {
		schedule: (callback, milliseconds) => {
			const timer = { callback, milliseconds, cancelled: false };
			timers.push(timer);
			return () => { timer.cancelled = true; };
		},
		pendingDurations: () => waiting().map((timer) => timer.milliseconds),
		fireAll: () => {
			for (const timer of waiting()) {
				timer.cancelled = true;
				timer.callback();
			}
		},
	};
}

test("CopyNotices shows only the newest result once its write settles", async () => {
	const writes: Array<{ text: string; resolve: () => void }> = [];
	const timers = manualTimers();
	const notices = new CopyNotices({
		copyText: (text) => new Promise<void>((resolve) => writes.push({ text, resolve })),
		schedule: timers.schedule,
	});

	// Nothing shows while the write is pending
	notices.copy("first");
	assert.equal(notices.current, undefined);
	writes[0]?.resolve();
	await settle();
	assert.deepEqual(notices.current, copiedNotice("first"));

	// Two quick copies resolving out of order: the newest request wins
	notices.copy("second");
	notices.copy("third");
	writes[2]?.resolve();
	await settle();
	assert.deepEqual(notices.current, copiedNotice("third"));
	writes[1]?.resolve();
	await settle();
	assert.deepEqual(notices.current, copiedNotice("third"));

	// A closed overlay stops publishing results and cancels the expiry
	notices.copy("fourth");
	notices.dispose();
	writes[3]?.resolve();
	await settle();
	assert.deepEqual(notices.current, copiedNotice("third"));
	assert.deepEqual(timers.pendingDurations(), []);
});

test("CopyNotices expires a success after 3 s and an error after 5 s", async () => {
	const timers = manualTimers();
	let refreshes = 0;
	let fail = false;
	const notices = new CopyNotices({
		copyText: async () => { if (fail) throw new Error("no clipboard"); },
		refresh: () => { refreshes++; },
		schedule: timers.schedule,
	});
	// A getter call, so an earlier assertion cannot narrow later reads
	const current = () => notices.current;

	notices.copy("payload");
	await settle();
	assert.equal(current()?.kind, "success");
	assert.deepEqual(timers.pendingDurations(), [3_000]);
	const shown = refreshes;
	timers.fireAll();
	assert.equal(current(), undefined);
	assert.equal(refreshes, shown + 1);

	// A new result replaces the visible one and restarts its timer
	notices.copy("payload");
	await settle();
	fail = true;
	notices.copy("payload");
	await settle();
	assert.equal(current()?.kind, "error");
	assert.deepEqual(timers.pendingDurations(), [5_000]);
	timers.fireAll();
	assert.equal(current(), undefined);
});

test("CopyNotices reports empty text without writing and sanitizes failures", async () => {
	const writes: string[] = [];
	const notices = new CopyNotices({
		copyText: async (text) => {
			writes.push(text);
			throw new Error("no clipboard\u001b]52;c;secret\u0007");
		},
		schedule: manualTimers().schedule,
	});

	notices.copy("");
	assert.deepEqual(writes, []);
	assert.deepEqual(notices.current, { text: "Nothing to copy", kind: "error" });

	notices.copy("payload");
	await settle();
	assert.deepEqual(writes, ["payload"]);
	assert.deepEqual(notices.current, { text: "Copy failed: no clipboard", kind: "error" });
});

test("CopyNotices.topBorder carries the notice near the border's right end", async () => {
	const theme = createTheme();
	const plain = theme.fg("border", "─".repeat(40));
	const notices = new CopyNotices({ copyText: async () => {}, schedule: manualTimers().schedule });
	assert.equal(notices.topBorder(theme, 40), plain);

	notices.copy("hello\nworld");
	await settle();
	const border = notices.topBorder(theme, 40);
	assert.equal(visibleWidth(border), 40);
	assert.match(stripSgr(border), /^─+ \[ Copied: 11 chars \] ───$/);
	assert.ok(border.includes(theme.fg("dim", "Copied: 11 chars")));

	// A narrow border shortens the notice, then drops it
	const narrow = notices.topBorder(theme, 17);
	assert.equal(visibleWidth(narrow), 17);
	assert.match(stripSgr(narrow), /^─ \[ \S+… \] ───$/);
	assert.equal(notices.topBorder(theme, 13), theme.fg("border", "─".repeat(13)));

	const failing = new CopyNotices({
		copyText: async () => { throw new Error("no clipboard"); },
		schedule: manualTimers().schedule,
	});
	failing.copy("x");
	await settle();
	assert.ok(failing.topBorder(theme, 80).includes(theme.fg("dim", "Copy failed: no clipboard")));
});

test("CopyNotices refuses a copy after dispose", () => {
	const writes: string[] = [];
	const notices = new CopyNotices({ copyText: async (text) => { writes.push(text); } });
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
