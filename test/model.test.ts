import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSnapshot, groupInjections, type InjectionItem } from "../src/model.ts";

function item(
	id: string,
	sourceId: string,
	sourceLabel: string,
	native: boolean,
	tokens: number,
): InjectionItem {
	return {
		id,
		phase: "initial",
		kind: "message",
		source: { id: sourceId, label: sourceLabel, native },
		label: id,
		chars: tokens * 4,
		tokens,
		text: id.repeat(tokens),
	};
}

test("groupInjections creates hierarchy and totals in display order", () => {
	const groups = groupInjections([
		item("small", "tool-source:small", "small", false, 2),
		item("pi-small", "pi", "pi", true, 1),
		item("large-b", "tool-source:large", "large", false, 5),
		item("aggregate", "aggregate:extensions", "extensions (aggregate)", false, 20),
		item("large-a", "tool-source:large", "large", false, 8),
	]);

	assert.deepEqual(
		groups.map((group) => group.source.id),
		["pi", "tool-source:large", "tool-source:small", "aggregate:extensions"],
	);
	assert.deepEqual(
		groups[1]?.items.map((entry) => entry.id),
		["large-a", "large-b"],
	);
	assert.equal(groups[1]?.totalTokens, 13);
});

test("buildSnapshot owns nested input data and computes the total", () => {
	const source = { id: "message-type:test", label: "test", native: false };
	const input: InjectionItem = {
		id: "message:test:0",
		phase: "initial",
		kind: "message",
		source,
		label: "message",
		chars: 12,
		tokens: 3,
		text: "hello world!",
	};
	const capturedAt = new Date("2026-07-10T12:00:00Z");
	const snapshot = buildSnapshot([input], "real-turn", capturedAt);

	source.label = "changed";
	capturedAt.setFullYear(2000);

	assert.equal(snapshot.groups[0]?.source.label, "test");
	assert.equal(snapshot.capturedAt.toISOString(), "2026-07-10T12:00:00.000Z");
	assert.equal(snapshot.totalTokens, 3);
});
