/** Semantic note selection is independent of prose; layout tests check that these notes reach the screen. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { InjectionItem } from "../src/model.ts";
import type { GuardResult } from "../src/snapshot.ts";
import {
	descriptionNoteLines, injectionsNotes, payloadCheck, requestOriginLabel,
	thinkingNote, usageNote, type PayloadCheck,
} from "../src/ui/notes.ts";
import { markerLegendLines, partMarkers, type ContextMarker } from "../src/ui/markers.ts";
import { assertFrame, createTheme, frameText } from "./harness/frame.ts";

test("payload attention distinguishes pending, unchecked, partial, complete, and absent comparisons", () => {
	const dispatch = { provider: "fixture", api: "fixture", model: "fixture" };
	const cases: Array<[GuardResult | undefined, PayloadCheck | undefined]> = [
		[undefined, undefined],
		[{ status: "pending" }, "pending"],
		[{ status: "incomplete", reason: "fixture-reason" }, "unchecked"],
		[{ status: "incomplete", reason: "fixture-reason", findings: [] }, "partial"],
		[{ status: "complete", dispatch, findings: [] }, undefined],
	];
	for (const [guard, expected] of cases) {
		assert.equal(payloadCheck(guard), expected);
		const notes = injectionsNotes(createTheme(), { guard, items: [] });
		assert.equal(notes.some((note) => note.kind === "payload-check"), expected !== undefined);
	}
	assert.notEqual(requestOriginLabel(true), requestOriginLabel(false));
});

test("notes select only applicable capture metadata and sanitize dynamic values", () => {
	const hiddenTools = ["zebra", "alpha\u001b[2J\nname"];
	const item: InjectionItem = {
		id: "payload", kind: "payload-change", label: "fixture", source: { id: "unknown", label: "unknown", native: false },
		chars: 0, tokens: 0, text: "private-payload-content",
	};
	const notes = injectionsNotes(createTheme(), {
		items: [item], probe: true, degradedReason: "fixture-degraded",
		guard: { status: "incomplete", reason: "fixture-reason\u001b[2J\ncontinued" }, hiddenTools,
	});
	assert.deepEqual(notes.map((note) => note.kind),
		["overview", "degraded", "probe", "payload-check", "hidden-tools", "payload-changes"]);
	const text = frameText(notes.map((note) => note.text));
	assert.ok(text.includes("fixture-reason continued"));
	assert.ok(text.includes("alpha name, zebra"));
	assert.match(notes.find((note) => note.kind === "hidden-tools")?.text ?? "", /2/);
	assert.doesNotMatch(text, /\u001b\[2J|private-payload-content/);
	assert.deepEqual(hiddenTools, ["zebra", "alpha\u001b[2J\nname"]);
	assert.deepEqual(injectionsNotes(createTheme(), { items: [], hiddenTools: [] }).map((note) => note.kind), ["overview"]);
});

test("disabled probing replaces the degraded note instead of adding to it", () => {
	const kinds = injectionsNotes(createTheme(), { items: [], probingDisabled: true }).map((note) => note.kind);
	assert.deepEqual(kinds, ["overview", "probing-disabled"]);
});

test("each note wraps completely rather than freezing a sentence or line count", () => {
	const theme = createTheme();
	const notes = [...injectionsNotes(theme, { items: [], probe: true, guard: { status: "pending" } }),
		usageNote(), thinkingNote()];
	assert.equal(usageNote().kind, "overview");
	assert.equal(thinkingNote().kind, "thinking");
	for (const note of notes) {
		assert.ok(note.text.trim().length > 0);
		for (const width of [24, 60, 80, 120]) {
			const lines = descriptionNoteLines(theme, note, width);
			assertFrame(lines, width, 100);
			const expected = frameText(descriptionNoteLines(theme, note, 1_000)).replace(/\s/g, "");
			assert.equal(frameText(lines).replace(/\s/g, ""), expected);
		}
	}
});

test("marker selection uses state, while every legend has distinct nonempty text and semantic colors", () => {
	assert.deepEqual(partMarkers({}), []);
	assert.deepEqual(partMarkers({ dropped: true, moved: true, change: "forced", requestOnly: true,
		diff: { added: 1, removed: 2 } }), ["dropped", "moved", "forced", "diff", "request-only"]);
	const theme = createTheme();
	const markers: ContextMarker[] = ["highlighted", "guess", "dropped", "moved", "forced", "diff", "request-only"];
	const colors = ["syntaxNumber", "dim", "toolDiffRemoved", "warning", "warning", "toolDiffAdded", "dim"] as const;
	const texts = markers.map((marker, index) => {
		const lines = markerLegendLines(theme, [marker], 1_000);
		assert.ok(lines.join("").includes(theme.getFgAnsi(colors[index])));
		assert.ok(frameText(lines).length > 5);
		assert.deepEqual(markerLegendLines(theme, [marker, marker], 1_000), lines, "no duplicate legends");
		return frameText(lines);
	});
	assert.equal(new Set(texts).size, markers.length);
	assert.deepEqual(markerLegendLines(theme, [], 100), []);
	const bases = (["default-prompt", "session", "captured-request"] as const)
		.map((base) => frameText(markerLegendLines(theme, ["diff"], 1_000, base)));
	assert.equal(new Set(bases).size, 3, "different comparison bases need different explanations");
	for (const text of bases) assert.match(text, /\+N -N/);
});
