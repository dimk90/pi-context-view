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
	assert.equal(probe.claimInput({ source: "extension" }, attempt.token), true);
	assert.equal(probe.beginRun("user", attempt.token), "claimed");

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

	assert.equal(probe.settle(), true);
	assert.deepEqual(await attempt.completion, { status: "settled" });
	assert.equal(probe.start().started, false);
	assert.equal(probe.sanitizeMessage(probeAssistant), undefined);
});

test("SilentProbe omissions persist without the extension and retain branch-safe filtering", () => {
	const { filter, probe } = createProbe();
	const attempt = probe.start(1_000);
	probe.beginRun("user", attempt.token);
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
	probe.settle();
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
	assert.equal(probe.claimInput({ source: "extension" }, attempt.token), true);
	assert.equal(probe.beginRun("user", attempt.token), "claimed", "rewritten text must not hide the probe run");

	const probePrompt = { role: "user", content: transformed, timestamp: 30 } satisfies ContextEvent["messages"][number];
	probe.recordMessage(probePrompt);

	// Blanked for the transcript; Pi stores the blank prompt, which every later model context filters out
	const sanitized = probe.sanitizeMessage(probePrompt);
	assert.deepEqual(sanitized, { role: "user", content: [], timestamp: 30 });
	assert.deepEqual(filter.filterMessages([sanitized]), []);
	probe.settle();
});

test("SilentProbe leaves an unattributed run untouched and fails the attempt", async () => {
	const { probe } = createProbe();
	const attempt = probe.start(1_000);

	// A run without the token may belong to the user or to another extension.
	assert.equal(probe.beginRun("user", undefined), "foreign");
	assert.equal(probe.isCurrentRun, false, "an unattributed run must not arm the abort guard");
	const result = await attempt.completion;
	assert.equal(result.status === "failed" ? result.cause : undefined, "foreign-run");

	// A delayed probe run is still claimed, so it is aborted and sanitized.
	assert.equal(probe.beginRun("user", attempt.token), "claimed");
	assert.equal(probe.isCurrentRun, true);
	assert.equal(probe.settle(), true);
});

test("SilentProbe leaves a custom-message run with its token untouched and fails the attempt", async () => {
	const { probe } = createProbe();
	const attempt = probe.start(1_000);

	// Another extension's nested sendMessage() from an input handler inherits the token
	assert.equal(probe.beginRun("custom", attempt.token), "foreign");
	assert.equal(probe.isCurrentRun, false, "a custom-message run must not arm the abort guard");
	const result = await attempt.completion;
	assert.equal(result.status === "failed" ? result.cause : undefined, "foreign-run");

	// The probe's own user-message run that follows is still claimed
	assert.equal(probe.beginRun("user", attempt.token), "claimed");
	assert.equal(probe.isCurrentRun, true);
	assert.equal(probe.settle(), true);
});

test("SilentProbe claims no later input and no run after a second idle input with its token", async () => {
	const { filter, probe } = createProbe();
	const attempt = probe.start(1_000);

	// Another extension's input handler sends a user message that inherits the token; either input may be ours
	assert.equal(probe.claimInput({ source: "extension" }, attempt.token), true);
	assert.equal(probe.claimInput({ source: "extension" }, attempt.token), false, "the second input is not reset");
	const result = await attempt.completion;
	assert.equal(result.status === "failed" ? result.cause : undefined, "nested-send");

	assert.equal(probe.claimInput({ source: "extension" }, attempt.token), false);
	assert.equal(probe.beginRun("user", attempt.token), "foreign", "the nested run is not claimed");
	assert.equal(probe.beginRun("user", attempt.token), "foreign", "nor the probe's own run");
	assert.equal(probe.isCurrentRun, false);
	const nested = { role: "user", content: "nested", timestamp: 50 } satisfies ContextEvent["messages"][number];
	probe.recordMessage(nested);
	assert.equal(probe.sanitizeMessage(nested), undefined);
	assert.deepEqual(filter.syntheticMessages, []);
});

test("SilentProbe reports the first user-message run with its token after the claim as a wrong claim", () => {
	const { probe } = createProbe();
	const attempt = probe.start(1_000);

	// Another extension's input handler ran first, so its nested user message took the probe's identity
	assert.equal(probe.claimInput({ source: "extension" }, attempt.token), true);
	assert.equal(probe.beginRun("user", attempt.token), "claimed");
	assert.equal(probe.settle(), true);

	// The probe's own input and run follow once the nested run settled
	assert.equal(probe.claimInput({ source: "extension" }, attempt.token), false, "its input is not reset");
	assert.equal(probe.beginRun("custom", attempt.token), "foreign", "a custom-message run is no evidence");
	assert.equal(probe.beginRun("user", undefined), "foreign");
	assert.equal(probe.beginRun("user", attempt.token), "wrong-claim");
	assert.equal(probe.isCurrentRun, false, "the run is not aborted");
	assert.equal(probe.beginRun("user", attempt.token), "foreign", "a wrong claim is reported once");
});

test("SilentProbe records only the first user message of its run and every abort", () => {
	const { filter, probe } = createProbe();
	const attempt = probe.start(1_000);
	assert.equal(probe.beginRun("user", attempt.token), "claimed");

	// Pi emits the run's starting messages first. A message queued while the run started gets an extra
	// turn and usually shares the prompt's millisecond.
	const probePrompt = {
		role: "user", content: [{ type: "text", text: "" }], timestamp: 40,
	} satisfies ContextEvent["messages"][number];
	const firstAbort = assistantMessage("error", 41, "This operation was aborted");
	const queued = { role: "user", content: "queued", timestamp: 40 } satisfies ContextEvent["messages"][number];
	const extraAbort = assistantMessage("error", 42, "This operation was aborted");

	// Each message_start records, each message_end may replace the message Pi then stores
	const manager = SessionManager.inMemory("/tmp");
	const stored = [probePrompt, firstAbort, queued, extraAbort].map((message) => {
		probe.recordMessage(message);
		const sanitized = probe.sanitizeMessage(message) ?? message;
		assert.ok(sanitized.role === "user" || sanitized.role === "assistant");
		return sanitized;
	});
	const ids = stored.map((message) => manager.appendMessage(message));

	assert.deepEqual(filter.syntheticMessages, [
		{ role: "user", timestamp: 40 },
		{ role: "assistant", timestamp: 41 },
		{ role: "assistant", timestamp: 42 },
	]);
	assert.deepEqual(stored[0], { ...probePrompt, content: [] }, "the prompt is blanked");
	assert.strictEqual(stored[2], queued, "the queued message keeps its text");
	assert.equal(stored[3].role === "assistant" && stored[3].stopReason, "stop", "the extra turn's abort is blanked");
	assert.deepEqual(filter.filterMessages(stored), [queued]);
	assert.deepEqual(probe.createContextEdits(manager.buildSessionProjection().entries).map((edit) => edit.targetId),
		[ids[0], ids[1], ids[3]], "the queued message is not omitted");
	probe.settle();
});

test("SilentProbe claims probe input only for its own token and source", () => {
	const { probe } = createProbe();
	assert.equal(probe.claimInput({ source: "extension" }, "any-token"), false, "no attempt is pending");

	const attempt = probe.start(1_000);
	assert.equal(probe.claimInput({ source: "extension" }, undefined), false);
	assert.equal(probe.claimInput({ source: "extension" }, `${attempt.token}-other`), false);
	assert.equal(probe.claimInput({ source: "interactive" }, attempt.token), false);
	assert.equal(probe.claimInput({ source: "rpc" }, attempt.token), false);
	// Another extension's send from before_agent_start inherits the token but is queued into the starting run
	assert.equal(probe.claimInput({ source: "extension", streamingBehavior: "steer" }, attempt.token), false);
	assert.equal(probe.claimInput({ source: "extension", streamingBehavior: "followUp" }, attempt.token), false);

	assert.equal(probe.beginRun("user", attempt.token), "claimed");
	assert.equal(probe.claimInput({ source: "extension" }, attempt.token), false, "the token is single-use");
	probe.settle();
});

for (const errorMessage of ["This operation was aborted", "The operation was aborted."]) {
	test(`SilentProbe sanitizes ${JSON.stringify(errorMessage)} only for a recorded probe assistant`, () => {
		const { probe } = createProbe();
		const attempt = probe.start(1_000);
		assert.equal(probe.beginRun("user", attempt.token), "claimed");

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
		probe.settle();
	});
}

test("SilentProbe filters restored identities without consuming the probe attempt", () => {
	const previousRuntime = createProbe();
	const previousAttempt = previousRuntime.probe.start(1_000);
	assert.equal(previousRuntime.probe.beginRun("user", previousAttempt.token), "claimed");
	const probeUser = { role: "user", content: [], timestamp: 10 } satisfies ContextEvent["messages"][number];
	previousRuntime.probe.recordMessage(probeUser);
	previousRuntime.probe.settle();

	const { filter, probe } = createProbe();
	filter.restoreIdentities(previousRuntime.filter.syntheticMessages);

	const emptyRealUser = { role: "user", content: [], timestamp: 11 } satisfies ContextEvent["messages"][number];
	assert.deepEqual(filter.filterMessages([probeUser, emptyRealUser]), [emptyRealUser]);
	assert.deepEqual(filter.syntheticMessages, [{ role: "user", timestamp: 10 }]);

	// Restoration must not consume this runtime's single probe attempt.
	assert.equal(probe.isCurrentRun, false);
	const attempt = probe.start(1_000);
	assert.equal(attempt.started, true);
	probe.fail("shutdown");
});

test("SilentProbe persists every known identity only after recording new ones", () => {
	const { filter, probe } = createProbe();
	const written: PersistedIdentities[] = [];
	const write = (data: PersistedIdentities) => { written.push(data); };
	filter.restoreIdentities([{ role: "user", timestamp: 1 }]);
	probe.persistIdentities(write);
	assert.equal(written.length, 0, "restored identities are already persisted");

	const attempt = probe.start(1_000);
	assert.equal(probe.beginRun("user", attempt.token), "claimed");
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
	probe.settle();
});

test("SilentProbe keeps a timed-out running probe abortable until settlement", async () => {
	const { probe } = createProbe();
	const attempt = probe.start(1);
	assert.equal(probe.beginRun("user", attempt.token), "claimed");

	const result = await attempt.completion;
	assert.equal(result.status === "failed" ? result.cause : undefined, "timeout");
	assert.equal(probe.isCurrentRun, true);
	assert.equal(probe.settle(), true);
	assert.equal(probe.isCurrentRun, false);
});

test("SilentProbe retains a delayed synthetic turn after a pre-run timeout", async () => {
	const { probe } = createProbe();
	const attempt = probe.start(1);

	const result = await attempt.completion;
	assert.equal(result.status === "failed" ? result.cause : undefined, "timeout");
	assert.equal(probe.isCurrentRun, false);

	assert.equal(probe.beginRun("user", undefined), "foreign");
	assert.equal(probe.isCurrentRun, false);
	assert.equal(probe.beginRun("user", attempt.token), "claimed");
	assert.equal(probe.isCurrentRun, true);
	assert.equal(probe.settle(), true);
});
