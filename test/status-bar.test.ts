/** Selected-row explanations preserve semantic distinctions, safe metadata, and complete wrapping. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildInjectionRows, type ChangeScope, type InjectionRow } from "../src/ui/injections-model.ts";
import { markerStatusField } from "../src/ui/markers.ts";
import { statusBarLines } from "../src/ui/status-bar.ts";
import { assertFrame, containsBlock, createTheme, frameText, stripSgr } from "./harness/frame.ts";

/** Neither the selected label nor its internal identity belongs in the status bar. */
function row(scope?: ChangeScope): Extract<InjectionRow, { kind: "item" }> {
	return {
		kind: "item", label: "fixture-private-label", tokens: 10, depth: 1, isLast: true,
		itemId: "fixture-private-id", scope,
		...(scope === undefined ? {} : { diff: { added: 14, removed: 5 }, editors: [{ type: "unknown" as const }] }),
	};
}

test("every change scope has a distinct explanation with the same measured diff", () => {
	const scopes: ChangeScope[] = ["saved", "saved-and-edit", "partly", "request", "request-edit", "request-new", "payload"];
	const explanations = scopes.map((scope) => frameText(statusBarLines(createTheme(), row(scope), 200)));
	assert.equal(new Set(explanations).size, scopes.length);
	for (const explanation of explanations) {
		assert.match(explanation, /\+14 -5/);
		assert.match(explanation, /Unknown/);
		assert.ok(explanation.length > "+14 -5 Unknown".length);
		assert.doesNotMatch(explanation, /fixture-private/);
	}
});

test("request-only changes remain explained without a numeric diff", () => {
	const theme = createTheme();
	const withDiff = frameText(statusBarLines(theme, row("request-edit"), 200));
	const withoutDiff = frameText(statusBarLines(theme, { ...row("request-edit"), diff: undefined }, 200));
	assert.equal(withoutDiff, withDiff.replace("+14 -5 ", ""));
	assert.notEqual(withoutDiff, "");
});

test("status fields use semantic colors, not the selected row's accent", () => {
	const theme = createTheme();
	const lines = statusBarLines(theme, row("request-edit"), 200);
	assert.ok(lines[0]?.includes(theme.fg("toolDiffAdded", "+14")));
	assert.ok(lines[0]?.includes(theme.fg("toolDiffRemoved", "-5")));
	assert.ok(lines.every((line) => !line.includes(theme.getFgAnsi("accent"))));
	assert.ok(lines.every((line) => line.includes(theme.getFgAnsi("muted"))));
	assert.ok(lines[1]?.includes(theme.fg("dim", "Unknown")));
});

test("editor names are sanitized and inferred attribution stays qualified", () => {
	const entry: InjectionRow = {
		...row("saved"), editors: [
			{ type: "extension", source: { id: "ext:1", label: "npm:web\u001b[2J\n docs", native: false }, attribution: "guess" },
			{ type: "extension", source: { id: "ext:2", label: "review.ts", native: false } },
			{ type: "unknown" },
		],
	};
	const lines = statusBarLines(createTheme(), entry, 200);
	assert.ok(containsBlock(lines, ["npm:web docs (guess), review.ts, Unknown"]));
	assert.doesNotMatch(frameText(lines), /fixture-private|\u001b\[2J|ext:1|ext:2/);
});

test("diff-only accounting replaces editor attribution with its own explanation", () => {
	const theme = createTheme();
	const ordinary = statusBarLines(theme, row("saved"), 200);
	const reference = statusBarLines(theme, { ...row("saved"), diffOnly: true }, 200);
	assert.equal(reference[0], ordinary[0], "the counted diff is unchanged");
	assert.equal(reference.length, 2);
	assert.notEqual(reference[1], ordinary[1]);
	assert.ok(stripSgr(reference[1] ?? "").trim().length > 0);
	assert.doesNotMatch(frameText(reference), /Unknown/);
});

test("marker explanations follow change details with consistent semantic colors", () => {
	const theme = createTheme();
	const moved = statusBarLines(theme, { ...row("request-edit"), moved: true, change: "forced" }, 200);
	for (const marker of ["moved", "forced"] as const) {
		assert.ok(containsBlock(moved.slice(2), [markerStatusField(theme, marker)]));
	}
	assert.ok(moved.slice(2).every((line) => line.includes(theme.getFgAnsi("warning"))));
	const dropped = statusBarLines(theme, { ...row(), dropped: true, moved: true }, 200);
	assert.ok(containsBlock(dropped, [markerStatusField(theme, "dropped")]));
	assert.equal(dropped.length, 1, "dropped takes precedence over moved");
	assert.ok(dropped[0]?.includes(theme.getFgAnsi("toolDiffRemoved")));
});

test("a replaced edit explains whether the forced prompt still sent its part", () => {
	const theme = createTheme();
	const sent = statusBarLines(theme, { ...row(), forcedEdit: { sent: true } }, 200);
	const unsent = statusBarLines(theme, { ...row(), tokens: 0, forcedEdit: { sent: false } }, 200);
	assert.ok(containsBlock(sent, [markerStatusField(theme, "forced-edit-sent")]));
	assert.ok(containsBlock(unsent, [markerStatusField(theme, "forced-edit-unsent")]));
	assert.equal(sent.length, 1);
	assert.notEqual(frameText(sent), frameText(unsent));
	assert.ok(sent[0]?.includes(theme.fg("warning", "Forced")));
});

test("status wrapping preserves the entire explanation, including Unicode metadata", () => {
	const theme = createTheme();
	const entry: InjectionRow = {
		...row("partly"), diff: { added: 12_345, removed: 1_234 },
		editors: [{ type: "extension", source: { id: "ext", label: "npm:日本語-review", native: false } }],
	};
	const whole = frameText(statusBarLines(theme, entry, 500)).replace(/\s/g, "");
	for (const width of [12, 24, 60, 80, 120]) {
		const lines = statusBarLines(theme, entry, width);
		assertFrame(lines, width, 100);
		assert.equal(frameText(lines).replace(/\s/g, ""), whole);
		assert.doesNotMatch(frameText(lines), /…/);
	}
	for (const width of [1, 2, 4, 6]) assertFrame(statusBarLines(theme, row("request-edit"), width), width, 500);
});

test("unchanged and non-selectable rows have no status text", () => {
	const theme = createTheme();
	for (const entry of [row(),
		{ kind: "group", label: "pi", tokens: 10, depth: 0 },
		{ kind: "separator", label: "", tokens: 0, depth: 0 },
		...buildInjectionRows({ groups: [], totalTokens: 10 }).filter((row) => row.kind === "total"),
	] satisfies InjectionRow[]) assert.deepEqual(statusBarLines(theme, entry, 120), []);
});
