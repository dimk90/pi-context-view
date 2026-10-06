import assert from "node:assert/strict";
import { test } from "node:test";

import { SnapshotBuilder } from "../src/capture/builder.ts";
import { DispatchConfirmer } from "../src/capture/dispatch.ts";
import { type GuardModel, MESSAGES_NOT_COMPARED_REASON, PayloadGuard } from "../src/capture/guard.ts";
import { type CapturedRequest, copyRequest } from "../src/capture/request.ts";
import { RequestTracker } from "../src/capture/tracker.ts";
import { type CaptureOrigin, type RequestSnapshot, SnapshotStore } from "../src/snapshot.ts";

const MODEL = { provider: "mock", api: "openai-completions", id: "text" };
const DISPATCH = { provider: MODEL.provider, api: MODEL.api, model: MODEL.id };
const TOOL = { name: "read", description: "Read a file.", parameters: { type: "object" } };

/** Request with a recorded tool and no structured change. */
function capture(model: GuardModel | undefined = MODEL, origin: CaptureOrigin = "real-turn"): CapturedRequest {
	const baseline = [{ entryId: "s", message: { role: "system" as const, content: "prompt", toolsAdded: [TOOL], timestamp: 1 } }];
	return {
		id: 1, capturedAt: 1, origin, requestModel: model,
		baseline: { leafId: "s", messages: baseline },
		...copyRequest(baseline, baseline.map(({ message }) => message)),
	};
}

/** Payload declaring the captured tool. */
function payload() {
	return { messages: [{ role: "system", content: "prompt" }], tools: [{ type: "function", function: { ...TOOL } }] };
}

/** Deferred builds and guard jobs queued before this call. */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Wire the real builder and store, retaining publications only for assertions. */
function harness(request = capture()) {
	const snapshots = new SnapshotStore();
	const published: RequestSnapshot[] = [];
	snapshots.subscribe((snapshot) => published.push(snapshot));
	const builder = new SnapshotBuilder(snapshots);
	const candidates = ["codemode"];
	const guard = new PayloadGuard({ publisher: builder, loadoutCandidates: () => candidates });
	builder.build(request);
	return { guard, builder, snapshots, published, candidates, request };
}

/** A settled tool channel, not a completed message comparison. */
function assertCompared(snapshot: RequestSnapshot | undefined) {
	assert.ok(snapshot);
	assert.equal(snapshot.guard.status, "incomplete");
	assert.ok(snapshot.guard.status === "incomplete");
	assert.equal(snapshot.guard.reason, MESSAGES_NOT_COMPARED_REASON);
	assert.deepEqual(snapshot.guard.findings, []);
	assert.deepEqual(snapshot.declaredTools, { declared: ["read"], baseline: ["read"] });
}

test("physical guard settles before any response, confirms once, and owns its payload copy", async () => {
	const h = harness();
	const body = payload();
	h.guard.accept(h.request, body);
	body.tools[0].function.description = "late in-place mutation";
	assert.equal(h.published.length, 0);
	await flush();
	assertCompared(h.snapshots.latest());
	const count = h.published.length;
	h.guard.confirm(1, DISPATCH, () => { throw new Error("physical path must not look up a model"); });
	await flush();
	h.guard.confirm(1, { ...DISPATCH, model: "other" }, () => undefined);
	await flush();
	assert.equal(h.published.length, count, "matching confirmation and repeated identity events publish nothing");
});

for (const timing of ["before", "after"]) {
	test(`physical dispatch mismatch ${timing} comparison removes provisional names without reparsing`, async () => {
		const h = harness();
		h.guard.accept(h.request, payload());
		if (timing === "after") await flush();
		h.guard.confirm(1, { ...DISPATCH, api: "anthropic-messages" }, () => { throw new Error("must not reparse"); });
		await flush();
		const snapshot = h.snapshots.latest();
		assert.ok(snapshot?.guard.status === "incomplete");
		assert.match(snapshot.guard.reason, /differs/);
		assert.equal(snapshot.guard.findings, undefined);
		assert.equal(snapshot.declaredTools, undefined);
	});
}

test("virtual guard waits for dispatch and uses the catalog API, not the payload shape", async () => {
	const h = harness(capture({ provider: "router", api: "pi-virtual", id: "auto" }));
	h.guard.accept(h.request, payload());
	await flush();
	assert.equal(h.snapshots.latest()?.guard.status, "pending");
	h.guard.confirm(1, DISPATCH, () => MODEL);
	await flush();
	assertCompared(h.snapshots.latest());

	const other = harness(capture({ provider: "router", api: "pi-virtual", id: "auto" }));
	other.guard.accept(other.request, payload());
	other.guard.confirm(1, { ...DISPATCH, api: "openai-responses" }, () => ({ ...MODEL, api: "openai-responses" }));
	await flush();
	assert.ok(other.snapshots.latest()?.guard.status === "incomplete");
	assert.equal(other.snapshots.latest()?.declaredTools, undefined);
});

for (const api of ["pi-virtual", "openai-completions"]) {
	test(`${api}: settlement without dispatch invalidates the comparison`, async () => {
		const h = harness(capture({ ...MODEL, api }));
		h.guard.accept(h.request, payload());
		await flush();
		h.guard.finishUnconfirmed(1);
		await flush();
		assert.deepEqual(h.snapshots.latest()?.guard, { status: "incomplete", reason: "No dispatch identity was observed for this request." });
		assert.equal(h.snapshots.latest()?.declaredTools, undefined);
	});
}

test("unknown routed model and unsupported API settle incomplete, without declared names", async () => {
	for (const request of [capture({ ...MODEL, api: "pi-virtual" }), capture({ ...MODEL, api: "other" })]) {
		const h = harness(request);
		h.guard.accept(request, payload());
		h.guard.confirm(1, { ...DISPATCH, api: request.requestModel?.api ?? "unknown" }, () => undefined);
		await flush();
		assert.equal(h.snapshots.latest()?.guard.status, "incomplete");
		assert.equal(h.snapshots.latest()?.declaredTools, undefined);
	}
});

test("candidate attribution is frozen at payload time, not read when a virtual response arrives", async () => {
	const h = harness(capture({ ...MODEL, api: "pi-virtual" }));
	h.guard.accept(h.request, { messages: [] });
	h.candidates.splice(0);
	await flush();
	h.guard.confirm(1, DISPATCH, () => MODEL);
	await flush();
	const snapshot = h.snapshots.latest();
	assert.ok(snapshot?.guard.status === "incomplete");
	assert.deepEqual(snapshot.guard.findings, [{ type: "hidden-declaration", name: "read", candidates: ["codemode"] }]);
});

test("nonstandard probe payloads pair and compare just like real requests", async () => {
	const h = harness(capture(MODEL, "synthetic-probe"));
	h.guard.accept(h.request, payload());
	h.guard.confirm(1, DISPATCH, () => MODEL);
	await flush();
	assertCompared(h.snapshots.first("synthetic-probe"));
});

test("shutdown cancels physical and virtual deferred work, including confirmation already received", async () => {
	for (const api of ["pi-virtual", "openai-completions"]) {
		const h = harness(capture({ ...MODEL, api }));
		h.guard.accept(h.request, payload());
		h.guard.confirm(1, DISPATCH, () => MODEL);
		h.guard.clear();
		h.builder.clear();
		await flush();
		assert.deepEqual(h.published, []);
	}
});

test("RequestTracker pairs latest captures once, skips marked warm limits, and clears stale decisions", () => {
	const tracker = new RequestTracker<number>();
	tracker.track(tracker.nextId());
	assert.deepEqual(tracker.pair({ max_tokens: 1 }), { type: "paired", capture: 1 }, "a small real request is not a refresh");
	assert.deepEqual(tracker.pair({}), { type: "unpaired" });
	tracker.track(tracker.nextId());
	tracker.noteWarmDecision();
	assert.deepEqual(tracker.pair({ max_tokens: 1 }), { type: "warm-refresh" });
	assert.deepEqual(tracker.pair({ max_output_tokens: 16 }), { type: "warm-refresh" });
	assert.deepEqual(tracker.pair({ max_tokens: 128 }), { type: "paired", capture: 2 });
	tracker.track(tracker.nextId());
	assert.equal(tracker.takeUnpaired(), 3);
	tracker.track(tracker.nextId());
	assert.deepEqual(tracker.pair({ max_tokens: 1 }), { type: "paired", capture: 4 });
	tracker.noteWarmDecision();
	tracker.clear();
	assert.deepEqual(tracker.pair({ max_tokens: 1 }), { type: "unpaired" });
});

test("DispatchConfirmer accepts either event first, falls back to assistant end, and consumes warm streams", () => {
	const confirmer = new DispatchConfirmer<number>();
	for (const source of ["stream", "assistant"] as const) {
		assert.equal(confirmer.expect(1), undefined);
		assert.equal(confirmer.confirm(source), 1);
		assert.equal(confirmer.confirm(source), undefined);
	}
	confirmer.expect(2);
	confirmer.noteWarmRefresh();
	assert.equal(confirmer.confirm("stream"), undefined);
	assert.equal(confirmer.confirm("assistant"), 2);
	confirmer.expect(3);
	assert.equal(confirmer.expect(4), 3);
	assert.equal(confirmer.takeUnconfirmed(), 4);
	confirmer.expect(5);
	confirmer.clear();
	assert.equal(confirmer.confirm("stream"), undefined);
});
