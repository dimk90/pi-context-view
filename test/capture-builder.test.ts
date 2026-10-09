import assert from "node:assert/strict";
import { test } from "node:test";

import { attributeMessage } from "../src/capture/attribution.ts";
import { buildRequestSnapshot, SnapshotBuilder } from "../src/capture/builder.ts";
import { redactMessage } from "../src/capture/redact.ts";
import { type BaselineMessage, type CapturedRequest, copyRequest, detectForcedPrompt } from "../src/capture/request.ts";
import type { RequestMessage, RequestSnapshot } from "../src/snapshot.ts";

const IMAGE_DATA = "A".repeat(2_048);
const SIGNATURE = "OPAQUE_SIGNATURE_BYTES";

/** A capture with one user baseline message and the given request messages. */
function request(id: number, messages: RequestMessage[]): CapturedRequest {
	const baseline: BaselineMessage[] = [{ entryId: "u1", message: { role: "user", content: "hello", timestamp: 1 } }];
	return {
		id, origin: "real-turn", capturedAt: 1_000,
		baseline: { leafId: "leaf", messages: baseline },
		...copyRequest(baseline, messages),
	};
}

/** Resolve after already scheduled immediates ran. */
function flushImmediates(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

test("attribution names custom types and cooperative provenance only", () => {
	assert.deepEqual(attributeMessage({ role: "user", content: "x", timestamp: 1 }), {});
	assert.deepEqual(attributeMessage({
		role: "custom", customType: "note", content: "x", display: false, timestamp: 1,
	}), { customType: "note" });
	assert.deepEqual(attributeMessage({
		role: "custom", customType: "note", content: "x", display: false, timestamp: 1,
		details: { source: "npm:helper", reason: "reminder", extra: true },
	}), { customType: "note", provenance: { source: "npm:helper", reason: "reminder" } });
	assert.deepEqual(attributeMessage({
		role: "custom", customType: "note", content: "x", display: false, timestamp: 1, details: { source: 3 },
	}), { customType: "note" });
	assert.deepEqual(attributeMessage({
		role: "toolResult", toolCallId: "c", toolName: "web", content: [], isError: false, timestamp: 1,
		details: { source: "https://example.com" },
	}), {}, "a tool's own details never name an extension");
});

test("redaction removes image payloads and signature bytes without changing estimates", () => {
	const image = { type: "image" as const, data: IMAGE_DATA, mimeType: "image/png" };
	const user = redactMessage({ role: "user", content: [{ type: "text", text: "look" }, image], timestamp: 1 });
	assert.ok(user.role === "user" && Array.isArray(user.content));
	assert.deepEqual(user.content[1], { type: "image", data: "<2.0KB omitted>", mimeType: "image/png" });

	const original: RequestMessage = {
		role: "assistant", api: "anthropic-messages", provider: "mock", model: "m", stopReason: "stop", timestamp: 2,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content: [
			{ type: "thinking", thinking: "plan", thinkingSignature: SIGNATURE },
			{ type: "text", text: "answer", textSignature: SIGNATURE },
			{ type: "toolCall", id: "c", name: "read", arguments: { thoughtSignature: "kept" }, thoughtSignature: SIGNATURE },
		],
	};
	const assistant = redactMessage(original);
	assert.doesNotMatch(JSON.stringify(assistant), /OPAQUE/);
	assert.ok(assistant.role === "assistant");
	const [thinking, text, call] = assistant.content;
	assert.ok(thinking.type === "thinking" && text.type === "text" && call.type === "toolCall");
	assert.equal(thinking.thinkingSignature?.length, SIGNATURE.length, "the reasoning proxy keeps the length");
	assert.equal("textSignature" in text, false);
	assert.equal(call.thoughtSignature?.length, SIGNATURE.length);
	assert.deepEqual(call.arguments, { thoughtSignature: "kept" }, "tool arguments are not signatures");
	assert.match(JSON.stringify(original), /OPAQUE/, "the captured original is not changed");
});

test("a snapshot keeps redacted, attributed changes and entry references", () => {
	const added: RequestMessage = {
		role: "custom", customType: "note", content: [{ type: "image", data: IMAGE_DATA, mimeType: "image/png" }],
		display: false, timestamp: 2,
	};
	const snapshot = buildRequestSnapshot({
		...request(1, [{ role: "user", content: "hello, edited", timestamp: 1 }, added]),
		forcedPrompt: "forced",
	}, { status: "pending" });
	assert.equal(snapshot.leafId, "leaf");
	assert.equal(snapshot.forcedPrompt, "forced");
	assert.deepEqual(snapshot.changes.system, []);
	assert.deepEqual(snapshot.changes.conversation.map((change) => [change.type, change.attribution]), [
		["modified", {}],
		["added", { customType: "note" }],
	]);
	const [modified] = snapshot.changes.conversation;
	assert.ok(modified.type === "modified");
	assert.equal(modified.entryId, "u1");
	assert.doesNotMatch(JSON.stringify(snapshot), /AAAA/);
});

test("a request copy keeps only the differing messages and the replayed system state, as owned copies", () => {
	const tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };
	const system: RequestMessage = {
		role: "system", content: "Prompt", sections: { cwd: "<cwd>/a</cwd>" }, toolsAdded: [tool], timestamp: 0,
	};
	const baseline: BaselineMessage[] = [
		{ entryId: "s", message: system },
		{ entryId: "u1", message: { role: "user", content: "one", timestamp: 1 } },
		{ entryId: "u2", message: { role: "user", content: "two", timestamp: 2 } },
	];
	const unchanged = copyRequest(baseline, structuredClone(baseline.map(({ message }) => message)));
	assert.deepEqual(unchanged.conversation, { prefix: 2, baseline: [], request: [] }, "an unchanged request copies no message");

	const messages: RequestMessage[] = [
		structuredClone(system),
		{ role: "user", content: "one", timestamp: 1 },
		{ role: "user", content: "two, edited", timestamp: 2 },
	];
	const copy = copyRequest(baseline, messages);
	assert.deepEqual(copy.conversation.baseline.map(({ entryId }) => entryId), ["u2"]);
	assert.deepEqual(copy.conversation.request, [messages[2]]);
	assert.equal(copy.conversation.prefix, 1);

	// Later handlers may edit the shared request objects in place
	const [requestSystem, , edited] = messages;
	assert.ok(requestSystem.role === "system" && edited.role === "user");
	edited.content = "changed after capture";
	const schema = requestSystem.toolsAdded?.[0].parameters as { properties: Record<string, unknown> } | undefined;
	assert.ok(schema);
	schema.properties.path = { type: "string" };
	if (requestSystem.sections) requestSystem.sections.cwd = "<cwd>/changed</cwd>";
	assert.deepEqual(copy.systemTexts, [{ position: 0, content: "Prompt", sections: { cwd: "<cwd>/a</cwd>" } }],
		"system texts are owned copies");
	const snapshot = buildRequestSnapshot({
		id: 1, origin: "real-turn", capturedAt: 1, baseline: { leafId: "leaf", messages: baseline }, ...copy,
	}, { status: "pending" });
	assert.deepEqual(snapshot.changes.system, [], "the copied tool schema is unchanged");
	const [modified] = snapshot.changes.conversation;
	assert.ok(modified.type === "modified" && modified.message.role === "user");
	assert.equal(modified.message.content, "two, edited");
});

test("the builder publishes after the handler returns, then publishes the settled guard", async () => {
	const published: RequestSnapshot[] = [];
	const builder = new SnapshotBuilder({ publish: (snapshot) => published.push(snapshot) });
	builder.build(request(1, [{ role: "user", content: "hello", timestamp: 1 }]));
	assert.equal(published.length, 0, "the diff is deferred");
	await flushImmediates();
	assert.deepEqual(published.map((snapshot) => [snapshot.id, snapshot.guard.status]), [[1, "pending"]]);
	assert.deepEqual(published[0].changes, { conversation: [], system: [] });

	builder.settleGuard(1, { status: "incomplete", reason: "none" });
	builder.release(1);
	builder.settleGuard(1, { status: "incomplete", reason: "again" });
	builder.settleGuard(7, { status: "incomplete", reason: "unknown" });
	assert.deepEqual(published.map((snapshot) => [snapshot.id, snapshot.guard.status]),
		[[1, "pending"], [1, "incomplete"]], "released captures accept no later updates");
	assert.equal(published[1].changes, published[0].changes);
});

test("a guard settled before the diff ran is published with the snapshot", async () => {
	const published: RequestSnapshot[] = [];
	const builder = new SnapshotBuilder({ publish: (snapshot) => published.push(snapshot) });
	builder.build(request(1, []));
	builder.settleGuard(1, { status: "incomplete", reason: "none" });
	await flushImmediates();
	assert.deepEqual(published.map((snapshot) => snapshot.guard), [{ status: "incomplete", reason: "none" }]);
	assert.deepEqual(published[0].changes.conversation.map((change) => change.type), ["deleted"]);
});

test("clear cancels scheduled diffs and pending guards", async () => {
	const published: RequestSnapshot[] = [];
	const builder = new SnapshotBuilder({ publish: (snapshot) => published.push(snapshot) });
	builder.build(request(1, []));
	await flushImmediates();
	builder.build(request(2, []));
	builder.clear();
	await flushImmediates();
	builder.settleGuard(1, { status: "incomplete", reason: "none" });
	assert.deepEqual(published.map((snapshot) => snapshot.id), [1]);
});

test("a dispatch mismatch replaces an already settled guard", async () => {
	const published: RequestSnapshot[] = [];
	const builder = new SnapshotBuilder({ publish: (snapshot) => published.push(snapshot) });
	builder.build({ ...request(1, []), hiddenTools: ["read"] });
	await flushImmediates();
	builder.settleGuard(1, { status: "complete", dispatch: { provider: "mock", api: "api", model: "m" }, findings: [] });
	assert.equal(published.at(-1)?.guard.status, "complete");
	builder.settleGuard(1, { status: "incomplete", reason: "Dispatch mismatch." });
	builder.release(1);
	assert.deepEqual(published.at(-1)?.guard, { status: "incomplete", reason: "Dispatch mismatch." });
	assert.deepEqual(published.at(-1)?.hiddenTools, ["read"], "a guard update keeps the hidden tools");
});

test("release before a scheduled build keeps its final guard but ignores later updates", async () => {
	const published: RequestSnapshot[] = [];
	const builder = new SnapshotBuilder({ publish: (snapshot) => published.push(snapshot) });
	builder.build(request(1, []));
	builder.settleGuard(1, { status: "incomplete", reason: "Only tools." });
	builder.release(1);
	builder.settleGuard(1, { status: "incomplete", reason: "Too late." });
	await flushImmediates();
	assert.deepEqual(published[0].guard, { status: "incomplete", reason: "Only tools." });
	assert.equal(published[0].hiddenTools, undefined);
});

test("a forced prompt is the effective prompt only when it differs from the replay", () => {
	const head: BaselineMessage = {
		entryId: "s", message: { role: "system", content: "", sections: { a: "Alpha", b: "Beta" }, timestamp: 1 },
	};
	assert.equal(detectForcedPrompt("Alpha\n\nBeta", [head]), undefined);
	assert.equal(detectForcedPrompt("Replacement", [head]), "Replacement");
});
