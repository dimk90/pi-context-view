import assert from "node:assert/strict";
import { test } from "node:test";

import { SnapshotBuilder } from "../src/capture/builder.ts";
import { DispatchConfirmer } from "../src/capture/dispatch.ts";
import { type GuardModel, PayloadGuard } from "../src/capture/guard.ts";
import { type CapturedRequest, copyRequest } from "../src/capture/request.ts";
import { RequestTracker } from "../src/capture/tracker.ts";
import { type CaptureOrigin, type RequestMessage, type RequestSnapshot, SnapshotStore } from "../src/snapshot.ts";

const MODEL: GuardModel = { provider: "mock", api: "openai-completions", id: "text", input: ["text"] };
const DISPATCH = { provider: MODEL.provider, api: MODEL.api, model: MODEL.id };
const TOOL = { name: "read", description: "Read a file.", parameters: { type: "object" } };

/** Request with a recorded tool and no structured change. */
function capture(model: GuardModel | undefined = MODEL, origin: CaptureOrigin = "real-turn"): CapturedRequest {
	const baseline = [{ entryId: "s", message: { role: "system" as const, content: "prompt", toolsAdded: [TOOL], timestamp: 1 } }];
	return {
		id: 1, origin, requestModel: model,
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
	const guard = new PayloadGuard({ publisher: builder, blockImages: () => false });
	builder.build(request);
	return { guard, builder, snapshots, published, request };
}

/** Both channels compared without findings. */
function assertCompared(snapshot: RequestSnapshot | undefined) {
	assert.ok(snapshot);
	assert.deepEqual(snapshot.guard, { status: "complete", dispatch: DISPATCH, findings: [] });
}

test("physical guard settles before any response, confirms once, and owns its payload copy", async () => {
	const h = harness();
	const body = payload();
	h.guard.accept(h.request, body);
	body.tools[0].function.description = "in-place payload mutation";
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
	test(`physical dispatch mismatch ${timing} comparison removes provisional findings without reparsing`, async () => {
		const h = harness();
		h.guard.accept(h.request, payload());
		if (timing === "after") await flush();
		h.guard.confirm(1, { ...DISPATCH, api: "anthropic-messages" }, () => { throw new Error("must not reparse"); });
		await flush();
		const snapshot = h.snapshots.latest();
		assert.ok(snapshot?.guard.status === "incomplete");
		assert.match(snapshot.guard.reason, /differs/);
		assert.equal(snapshot.guard.findings, undefined);
	});
}

test("virtual guard waits for dispatch and uses the catalog API, not the payload shape", async () => {
	const h = harness(capture({ ...MODEL, provider: "router", api: "pi-virtual", id: "auto" }));
	h.guard.accept(h.request, payload());
	await flush();
	assert.equal(h.snapshots.latest()?.guard.status, "pending");
	h.guard.confirm(1, DISPATCH, () => MODEL);
	await flush();
	assertCompared(h.snapshots.latest());

	const other = harness(capture({ ...MODEL, provider: "router", api: "pi-virtual", id: "auto" }));
	other.guard.accept(other.request, payload());
	other.guard.confirm(1, { ...DISPATCH, api: "openai-responses" }, () => ({ ...MODEL, api: "openai-responses" }));
	await flush();
	assert.ok(other.snapshots.latest()?.guard.status === "incomplete");
});

for (const api of ["pi-virtual", "openai-completions"]) {
	test(`${api}: settlement without dispatch invalidates the comparison`, async () => {
		const h = harness(capture({ ...MODEL, api }));
		h.guard.accept(h.request, payload());
		await flush();
		h.guard.finishUnconfirmed(1);
		await flush();
		assert.deepEqual(h.snapshots.latest()?.guard, { status: "incomplete", reason: "No dispatch identity was observed for this request." });
	});
}

test("unknown routed model and unsupported API settle incomplete", async () => {
	for (const request of [capture({ ...MODEL, api: "pi-virtual" }), capture({ ...MODEL, api: "other" })]) {
		const h = harness(request);
		h.guard.accept(request, payload());
		h.guard.confirm(1, { ...DISPATCH, api: request.requestModel?.api ?? "unknown" }, () => undefined);
		await flush();
		assert.equal(h.snapshots.latest()?.guard.status, "incomplete");
	}
});

test("a declaration Pi hid is expected to be missing; any other missing one is a payload removal", async () => {
	for (const hiddenTools of [["read"], undefined]) {
		const h = harness({ ...capture(), ...(hiddenTools === undefined ? {} : { hiddenTools }) });
		h.guard.accept(h.request, { ...payload(), tools: [] });
		await flush();
		assert.deepEqual(h.snapshots.latest()?.guard, {
			status: "complete", dispatch: DISPATCH, findings: hiddenTools === undefined
				? [{ type: "payload-tool-change", change: "deleted", name: "read", lines: [{ type: "removed", text: "Read a file." }] }]
				: [],
		});
	}
});

test("message payload changes complete the guard with their findings", async () => {
	const h = harness();
	const body = payload();
	h.guard.accept(h.request, { ...body, messages: [...body.messages, { role: "user", content: "edit" }] });
	await flush();
	assert.deepEqual(h.snapshots.latest()?.guard, {
		status: "complete", dispatch: DISPATCH,
		findings: [{ type: "payload-change", change: "added", part: "user", lines: [{ type: "added", text: "edit" }] }],
	});
});

/** Session prompt and editor context of the pi-ide simulation from #9; the selection keeps non-ASCII text. */
const IDE_PROMPT = "What is the text in my selection?";
const IDE_CONTEXT = ["<editor>todo.md</editor>", "<selection>Prompts and ACP — résumé notes</selection>"];

/** The simulation's payload in the representation of `api`: the session prompt, then the editor context. */
function idePayload(api: string): unknown {
	const text = IDE_CONTEXT.join("\n");
	if (api === "openai-responses") {
		return { input: [
			{ role: "developer", content: "you are pi" },
			{ role: "user", content: [{ type: "input_text", text: IDE_PROMPT }] },
			{ role: "user", content: [{ type: "input_text", text }] },
		] };
	}
	const messages = [{ role: "user", content: IDE_PROMPT }, { role: "user", content: [{ type: "text", text }] }];
	return api === "anthropic-messages"
		? { system: "you are pi", messages }
		: { messages: [{ role: "system", content: "you are pi" }, ...messages] };
}

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
	test(`#9 pi-ide: ${api} editor context added to the payload is a payload change with its text`, async () => {
		// pi-ide's custom message reached only the payload, where Pi had already converted it to a user message
		const model = { ...MODEL, api };
		const baseline = [
			{ entryId: "s", message: { role: "system" as const, content: "you are pi", timestamp: 1 } },
			{ entryId: "u", message: { role: "user" as const, content: IDE_PROMPT, timestamp: 2 } },
		];
		const request: CapturedRequest = {
			id: 1, origin: "real-turn", requestModel: model, baseline: { leafId: "u", messages: baseline },
			...copyRequest(baseline, baseline.map(({ message }) => message)),
		};
		const h = harness(request);
		h.guard.accept(request, idePayload(api));
		await flush();
		assert.deepEqual(h.snapshots.latest()?.guard, {
			status: "complete", dispatch: { ...DISPATCH, api },
			findings: [{
				type: "payload-change", change: "added", part: "user",
				lines: IDE_CONTEXT.map((text) => ({ type: "added", text })),
			}],
		});
	});
}

test("a request that cannot be converted keeps the tool channel's findings", async () => {
	const request = capture();
	// An earlier handler's malformed message reaches the copied middle of the request
	const malformed = { ...request, ...copyRequest(request.baseline.messages, [
		...request.baseline.messages.map(({ message }) => message),
		{ role: "toolResult", toolCallId: "a", toolName: "read", content: "not blocks", isError: false, timestamp: 2 } as
			unknown as RequestMessage,
	]) };
	const h = harness(malformed);
	h.guard.accept(malformed, { ...payload(), tools: [] });
	await flush();
	const snapshot = h.snapshots.latest();
	assert.deepEqual(snapshot?.guard, {
		status: "incomplete", reason: "The captured request could not be converted for comparison.", dispatch: DISPATCH,
		findings: [
			{ type: "payload-tool-change", change: "deleted", name: "read", lines: [{ type: "removed", text: "Read a file." }] },
		],
	});
});

test("an unsupported tool channel preserves compared message findings", async () => {
	for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
		const request = capture({ ...MODEL, api });
		const h = harness(request);
		const messages = [{ role: "system", content: "prompt" }, { role: "user", content: "edit" }];
		const body = api === "openai-responses" ? { input: messages } : { messages };
		h.guard.accept(request, { ...body, tools: [{ type: "unknown" }] });
		await flush();
		const snapshot = h.snapshots.latest();
		assert.ok(snapshot?.guard.status === "incomplete");
		assert.deepEqual(snapshot.guard.findings, [
			{ type: "payload-change", change: "added", part: "user", lines: [{ type: "added", text: "edit" }] },
		]);
	}
});

test("nonstandard probe payloads pair and compare just like real requests", async () => {
	const h = harness(capture(MODEL, "synthetic-probe"));
	h.guard.accept(h.request, payload());
	h.guard.confirm(1, DISPATCH, () => MODEL);
	await flush();
	const snapshot = h.snapshots.latest();
	assert.equal(snapshot?.origin, "synthetic-probe");
	assertCompared(snapshot);
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
