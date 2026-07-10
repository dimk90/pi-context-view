import assert from "node:assert/strict";
import { test } from "node:test";

import {
	getContextArgumentCompletions,
	parseContextCommand,
} from "../src/command.ts";

test("parseContextCommand defaults to Injections (until Usage lands) and accepts the explicit grammar", () => {
	// Temporary default; becomes "usage" in PLAN.md step 6.
	assert.deepEqual(parseContextCommand(""), { type: "view", view: "injections" });
	assert.deepEqual(parseContextCommand(" Usage "), { type: "view", view: "usage" });
	assert.deepEqual(parseContextCommand("injections"), { type: "view", view: "injections" });
	assert.deepEqual(parseContextCommand("runtime on"), { type: "runtime", enabled: true });
	assert.deepEqual(parseContextCommand("runtime off"), { type: "runtime", enabled: false });
	assert.equal(parseContextCommand("runtime").type, "invalid");
	assert.equal(parseContextCommand("usage extra").type, "invalid");
});

test("getContextArgumentCompletions returns complete argument values", () => {
	assert.deepEqual(
		getContextArgumentCompletions("run")?.map((item) => item.value),
		["runtime on", "runtime off"],
	);
	assert.deepEqual(
		getContextArgumentCompletions("runtime o")?.map((item) => item.value),
		["runtime on", "runtime off"],
	);
	assert.deepEqual(
		getContextArgumentCompletions("inj")?.map((item) => item.value),
		["injections"],
	);
	assert.equal(getContextArgumentCompletions("unknown"), null);
});
