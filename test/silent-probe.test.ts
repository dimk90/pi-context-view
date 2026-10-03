import assert from "node:assert/strict";
import { test } from "node:test";

import { type ContextEvent, SessionManager } from "@earendil-works/pi-coding-agent";

import { type PersistedIdentities, ProbeFilter } from "../src/probe/filter.ts";
import { SilentProbe } from "../src/probe/silent-probe.ts";

/** A SilentProbe recording into its own ProbeFilter. */
function createProbe(): { filter: ProbeFilter; probe: SilentProbe } {
	const filter = new ProbeFilter();
	return { filter, probe: new SilentProbe(filter) };
}

/** Assistant fixture for probe stop-reason tests. */
function assistantMessage(
	stopReason: "aborted" | "error",
	timestamp: number,
	errorMessage?: string,
): Extract<ContextEvent["messages"][number], { role: "assistant" }> {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp,
	};
}

test("SilentProbe sanitizes and filters only exact probe identities", async () => {
	const { filter, probe } = createProbe();
	const attempt = probe.start(1_000);
	const concurrentAttempt = probe.start();
	assert.equal(concurrentAttempt.started, false);
	assert.strictEqual(concurrentAttempt.completion, attempt.completion);
	assert.strictEqual(concurrentAttempt.token, attempt.token);
	assert.equal(probe.isProbeInput("extension", attempt.token), true);
	assert.equal(probe.beginRun(attempt.token), true);

	const probeUser = { role: "user", content: [], timestamp: 10 } satisfies ContextEvent["messages"][number];
	const realUser = { role: "user", content: [], timestamp: 11 } satisfies ContextEvent["messages"][number];
	const probeAssistant = assistantMessage("error", 12, "This operation was aborted");

	probe.recordMessage(probeUser);
	probe.recordMessage(probeAssistant);
	// An already empty prompt needs no replacement.
	assert.equal(probe.sanitizeMessage(probeUser), undefined);
	const sanitized = probe.sanitizeMessage(probeAssistant);
	assert.equal(sanitized?.role, "assistant");
	if (sanitized?.role === "assistant") {
		assert.equal(sanitized.stopReason, "stop");
		assert.deepEqual(sanitized.content, []);
	}
	assert.deepEqual(filter.filterMessages([probeUser, realUser, probeAssistant]), [realUser]);
	assert.deepEqual(filter.syntheticMessages, [
		{ role: "user", timestamp: 10 },
		{ role: "assistant", timestamp: 12 },
	]);

	assert.equal(probe.settle(true), true);
	assert.deepEqual(await attempt.completion, { status: "captured" });
	assert.equal(probe.start().started, false);
	assert.equal(probe.sanitizeMessage(probeAssistant), undefined);
});

test("SilentProbe omissions persist without the extension and retain branch-safe filtering", () => {
	const { filter, probe } = createProbe();
	const attempt = probe.start(1_000);
	probe.beginRun(attempt.token);
	const manager = SessionManager.inMemory("/tmp");
	const genuineUser = { role: "user", content: [], timestamp: 1 } satisfies ContextEvent["messages"][number];
	const genuineAbort = assistantMessage("aborted", 2);
	const probeUser = { role: "user", content: [], timestamp: 3 } satisfies ContextEvent["messages"][number];
	const probeAssistant = assistantMessage("error", 4, "This operation was aborted");
	manager.appendMessage(genuineUser);
	manager.appendMessage(genuineAbort);
	probe.recordMessage(probeUser);
	probe.recordMessage(probeAssistant);
	const userId = manager.appendMessage(probeUser);
	const sanitized = probe.sanitizeMessage(probeAssistant);
	assert.ok(sanitized?.role === "assistant");
	const assistantId = manager.appendMessage(sanitized);
	manager.appendCustomMessageEntry("other-extension", "keep", false);
	const beforeEdits = manager.getLeafId();
	assert.ok(beforeEdits);
	const projectedEntries = () => manager.buildSessionProjection().entries;
	const drafts = probe.createContextEdits(projectedEntries());
	assert.deepEqual(drafts, [
		{ type: "context_edit", targetId: userId, replacement: null },
		{ type: "context_edit", targetId: assistantId, replacement: null },
	]);
	for (const draft of drafts) manager.appendContextEdit(draft.targetId, draft.replacement);
	assert.deepEqual(manager.buildSessionProjection().messages.slice(0, 2), [genuineUser, genuineAbort]);
	assert.equal(manager.buildSessionProjection().messages.length, 3, "only the two probe messages are omitted");
	assert.deepEqual(probe.createContextEdits(projectedEntries()), [], "do not append duplicate omissions");
	assert.equal(manager.getBranch().filter((entry) => entry.type === "message").length, 4, "raw history stays intact");
	const header = manager.getHeader();
	assert.ok(header);
	const reloaded = SessionManager.inMemory("/tmp", undefined, [header, ...manager.getEntries()]);
	assert.deepEqual(reloaded.buildSessionProjection().messages, manager.buildSessionProjection().messages);

	manager.appendContextEdit(userId, { content: "replacement" });
	const replacedEntries = projectedEntries();
	assert.deepEqual(probe.createContextEdits(replacedEntries), [
		{ type: "context_edit", targetId: userId, replacement: null },
	], "a later replacement restores a target until omitted again");
	manager.appendCompaction("summary", null, 0);
	assert.deepEqual(probe.createContextEdits(projectedEntries()), [], "compacted-away probes need no omission");
	probe.settle(true);
	assert.deepEqual(probe.createContextEdits(replacedEntries), [], "foreign runs cannot append edits");

	manager.branch(beforeEdits);
	const restored = new ProbeFilter();
	restored.restoreIdentities(filter.syntheticMessages);
	assert.equal(manager.buildSessionProjection().messages.length, 5);
	assert.equal(restored.filterMessages(manager.buildSessionProjection().messages).length, 3);
});

test("SilentProbe claims its run by token when an input transform rewrites the prompt", () => {
	const { filter, probe } = createProbe();
	const attempt = probe.start(1_000);

	// Another extension prepends instructions to the synthetic empty prompt.
	const transformed = "Additional instructions\n";
	assert.equal(probe.isProbeInput("extension", attempt.token), true);
	assert.equal(probe.beginRun(attempt.token), true, "rewritten text must not hide the probe run");

	const probePrompt = { role: "user", content: transformed, timestamp: 30 } satisfies ContextEvent["messages"][number];
	probe.recordMessage(probePrompt);

	// Blanked for the transcript, filtered out of every later model context.
	assert.deepEqual(probe.sanitizeMessage(probePrompt), { role: "user", content: [], timestamp: 30 });
	assert.deepEqual(filter.filterMessages([probePrompt]), []);
	probe.settle(true);
});

test("SilentProbe leaves an unattributed run untouched and fails the attempt", async () => {
	const { probe } = createProbe();
	const attempt = probe.start(1_000);

	// A run without the token may belong to the user or to another extension.
	assert.equal(probe.beginRun(undefined), false);
	assert.equal(probe.isCurrentRun, false, "an unattributed run must not arm the abort guard");
	assert.deepEqual(await attempt.completion, {
		status: "failed",
		reason: "Another agent run started before the silent probe was recognized.",
	});

	// A delayed probe run is still claimed, so it is aborted and sanitized.
	assert.equal(probe.beginRun(attempt.token), true);
	assert.equal(probe.isCurrentRun, true);
	assert.equal(probe.settle(false), true);
});

test("SilentProbe recognizes probe input only for its own token and source", () => {
	const { probe } = createProbe();
	assert.equal(probe.isProbeInput("extension", "any-token"), false, "no attempt is pending");

	const attempt = probe.start(1_000);
	assert.equal(probe.isProbeInput("extension", undefined), false);
	assert.equal(probe.isProbeInput("extension", `${attempt.token}-other`), false);
	assert.equal(probe.isProbeInput("interactive", attempt.token), false);
	assert.equal(probe.isProbeInput("rpc", attempt.token), false);

	assert.equal(probe.beginRun(attempt.token), true);
	assert.equal(probe.isProbeInput("extension", attempt.token), false, "the token is single-use");
	probe.settle(true);
});

for (const errorMessage of ["This operation was aborted", "The operation was aborted."]) {
	test(`SilentProbe sanitizes ${JSON.stringify(errorMessage)} only for a recorded probe assistant`, () => {
		const { probe } = createProbe();
		const attempt = probe.start(1_000);
		assert.equal(probe.beginRun(attempt.token), true);

		const setupAbort = assistantMessage("error", 20, errorMessage);
		const providerError = assistantMessage("error", 21, "Authentication failed");
		const unrecordedSetupAbort = assistantMessage("error", 22, errorMessage);
		// Pi reports the probe's abort only as an error, so another stop reason is not the probe's
		const abortedStop = assistantMessage("aborted", 23, errorMessage);
		probe.recordMessage(setupAbort);
		probe.recordMessage(providerError);
		probe.recordMessage(abortedStop);

		const sanitized = probe.sanitizeMessage(setupAbort);
		assert.equal(sanitized?.role, "assistant");
		if (sanitized?.role === "assistant") {
			assert.equal(sanitized.stopReason, "stop");
			assert.equal(sanitized.errorMessage, undefined);
			assert.deepEqual(sanitized.content, []);
		}
		assert.equal(probe.sanitizeMessage(providerError), undefined);
		assert.equal(probe.sanitizeMessage(unrecordedSetupAbort), undefined);
		assert.equal(probe.sanitizeMessage(abortedStop), undefined);
		probe.settle(true);
	});
}

test("SilentProbe filters restored identities without consuming the probe attempt", () => {
	const previousRuntime = createProbe();
	const previousAttempt = previousRuntime.probe.start(1_000);
	assert.equal(previousRuntime.probe.beginRun(previousAttempt.token), true);
	const probeUser = { role: "user", content: [], timestamp: 10 } satisfies ContextEvent["messages"][number];
	previousRuntime.probe.recordMessage(probeUser);
	previousRuntime.probe.settle(true);

	const { filter, probe } = createProbe();
	filter.restoreIdentities(previousRuntime.filter.syntheticMessages);

	const emptyRealUser = { role: "user", content: [], timestamp: 11 } satisfies ContextEvent["messages"][number];
	assert.deepEqual(filter.filterMessages([probeUser, emptyRealUser]), [emptyRealUser]);
	assert.deepEqual(filter.syntheticMessages, [{ role: "user", timestamp: 10 }]);

	// Restoration must not consume this runtime's single probe attempt.
	assert.equal(probe.isCurrentRun, false);
	const attempt = probe.start(1_000);
	assert.equal(attempt.started, true);
	probe.fail("cleanup");
});

test("SilentProbe persists every known identity only after recording new ones", () => {
	const { filter, probe } = createProbe();
	const written: PersistedIdentities[] = [];
	const write = (data: PersistedIdentities) => { written.push(data); };
	filter.restoreIdentities([{ role: "user", timestamp: 1 }]);
	probe.persistIdentities(write);
	assert.equal(written.length, 0, "restored identities are already persisted");

	const attempt = probe.start(1_000);
	assert.equal(probe.beginRun(attempt.token), true);
	const probeUser = { role: "user", content: [], timestamp: 10 } satisfies ContextEvent["messages"][number];
	probe.recordMessage(probeUser);
	probe.recordMessage(probeUser);
	probe.persistIdentities(write);
	probe.persistIdentities(write);
	assert.deepEqual(written, [{ messages: [{ role: "user", timestamp: 1 }, { role: "user", timestamp: 10 }] }],
		"one entry keeps restored identities beside the new one");

	probe.recordMessage(assistantMessage("error", 11, "This operation was aborted"));
	probe.persistIdentities(write);
	assert.equal(written.length, 2);
	assert.deepEqual(written[1].messages.at(-1), { role: "assistant", timestamp: 11 });
	probe.settle(true);
});

test("SilentProbe keeps a timed-out running probe abortable until settlement", async () => {
	const { probe } = createProbe();
	const attempt = probe.start(1);
	assert.equal(probe.beginRun(attempt.token), true);

	assert.deepEqual(await attempt.completion, { status: "failed", reason: "Silent probe timed out." });
	assert.equal(probe.isCurrentRun, true);
	assert.equal(probe.settle(false), true);
	assert.equal(probe.isCurrentRun, false);
});

test("SilentProbe retains a delayed synthetic turn after a pre-run timeout", async () => {
	const { probe } = createProbe();
	const attempt = probe.start(1);

	assert.deepEqual(await attempt.completion, { status: "failed", reason: "Silent probe timed out." });
	assert.equal(probe.isCurrentRun, false);

	assert.equal(probe.beginRun(undefined), false);
	assert.equal(probe.isCurrentRun, false);
	assert.equal(probe.beginRun(attempt.token), true);
	assert.equal(probe.isCurrentRun, true);
	assert.equal(probe.settle(false), true);
});
