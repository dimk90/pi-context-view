/** Failure causes are a stable contract; explanations are presentation with preserved diagnostic details. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { probeFailure, type ProbeFailureCause } from "../src/probe/failure.ts";

const CAUSES = {
	compaction: true, "pending-messages": true, "missing-model": true, "virtual-model": true, "missing-auth": true,
	"idle-warming": true, "context-limit": true, settings: true, timeout: true, "foreign-run": true,
	"nested-send": true, shutdown: true, startup: true, "missing-snapshot": true,
} satisfies Record<ProbeFailureCause, true>;

test("every probe failure cause has a distinct nonempty explanation", () => {
	const reasons = new Set<string>();
	for (const cause of Object.keys(CAUSES) as ProbeFailureCause[]) {
		const failure = probeFailure(cause, "fixture-provider-or-error");
		assert.equal(failure.status, "failed");
		assert.equal(failure.cause, cause);
		assert.ok(failure.reason.trim().length > 0);
		reasons.add(failure.reason);
	}
	assert.equal(reasons.size, Object.keys(CAUSES).length);
});

test("authentication and startup explanations preserve supplied details", () => {
	assert.ok(probeFailure("missing-auth", "fixture-provider").reason.includes("fixture-provider"));
	assert.equal(probeFailure("startup", "fixture startup error").reason, "fixture startup error");
});
