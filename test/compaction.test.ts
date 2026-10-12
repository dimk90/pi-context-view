import assert from "node:assert/strict";
import { test } from "node:test";

import { CompactionState } from "../src/compaction.ts";

test("CompactionState follows the current lifecycle signal", () => {
	const state = new CompactionState();
	const first = new AbortController();
	const second = new AbortController();

	state.begin(first.signal);
	assert.equal(state.isActive, true);
	state.begin(second.signal);
	first.abort();
	assert.equal(state.isActive, true, "an obsolete signal cannot clear the current compaction");
	second.abort();
	assert.equal(state.isActive, false);

	const completed = new AbortController();
	state.begin(completed.signal);
	state.finish();
	assert.equal(state.isActive, false);

	const alreadyAborted = new AbortController();
	alreadyAborted.abort();
	state.begin(alreadyAborted.signal);
	assert.equal(state.isActive, false);
});
