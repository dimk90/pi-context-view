import assert from "node:assert/strict";
import { test } from "node:test";

import { createProbeToken, readProbeToken, runWithProbeToken } from "../src/probe-token.ts";

test("createProbeToken issues a distinct token per attempt", () => {
	assert.notEqual(createProbeToken(), createProbeToken());
});

test("readProbeToken sees the token only inside its own call scope", async () => {
	const token = createProbeToken();
	assert.equal(readProbeToken(), undefined);

	// Pi awaits the `input` and `before_agent_start` handlers from inside the
	// sendUserMessage() call, so the token has to survive intervening awaits.
	const observed = await runWithProbeToken(token, async () => {
		const beforeAwait = readProbeToken();
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 1));
		return { beforeAwait, afterAwait: readProbeToken() };
	});

	assert.deepEqual(observed, { beforeAwait: token, afterAwait: token });
	assert.equal(readProbeToken(), undefined, "a genuine turn must never observe a probe token");
});
