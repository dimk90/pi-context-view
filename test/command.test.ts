import assert from "node:assert/strict";
import { test } from "node:test";

import {
	getContextArgumentCompletions,
	parseContextCommand,
} from "../src/command.ts";

test("parseContextCommand defaults to Usage and accepts the explicit grammar", () => {
	assert.deepEqual(parseContextCommand(""), { type: "view", view: "usage" });
	assert.deepEqual(parseContextCommand(" Usage "), { type: "view", view: "usage" });
	assert.deepEqual(parseContextCommand("injections"), { type: "view", view: "injections" });
	assert.equal(parseContextCommand("runtime").type, "invalid");
	assert.equal(parseContextCommand("runtime on").type, "invalid");
	assert.equal(parseContextCommand("runtime off").type, "invalid");
	assert.deepEqual(parseContextCommand("usage extra"), {
		type: "invalid",
		message: "Usage: /context [usage|injections]",
	});
});

test("getContextArgumentCompletions exposes only v0.2.0 views", () => {
	assert.deepEqual(
		getContextArgumentCompletions("")?.map((item) => item.value),
		["usage", "injections"],
	);
	assert.deepEqual(
		getContextArgumentCompletions("inj")?.map((item) => item.value),
		["injections"],
	);
	assert.equal(getContextArgumentCompletions("run"), null);
	assert.equal(getContextArgumentCompletions("unknown"), null);
});
