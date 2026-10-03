import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { type CaptureOrigin, type GuardResult, type RequestSnapshot, SnapshotStore } from "../src/snapshot.ts";

/** A snapshot with no changes; only ID, origin, and guard vary between cases. */
function snapshot(id: number, origin: CaptureOrigin, guard: GuardResult = { status: "pending" }): RequestSnapshot {
	return {
		id,
		origin,
		capturedAt: 1_000 + id,
		leafId: `leaf-${id}`,
		changes: { conversation: [], system: [] },
		guard,
	};
}

test("SnapshotStore is empty until the first publication", () => {
	const store = new SnapshotStore();
	assert.equal(store.first(), undefined);
	assert.equal(store.latest(), undefined);
	assert.equal(store.first("real-turn"), undefined);
	assert.equal(store.latest("synthetic-probe"), undefined);
});

test("SnapshotStore retains the first and latest snapshot per origin", () => {
	const store = new SnapshotStore();
	const probe = snapshot(1, "synthetic-probe");
	const turns = [snapshot(2, "real-turn"), snapshot(3, "real-turn"), snapshot(4, "real-turn")];
	store.publish(probe);
	for (const turn of turns) store.publish(turn);

	assert.equal(store.first("real-turn"), turns[0]);
	assert.equal(store.latest("real-turn"), turns[2]);
	assert.equal(store.first("synthetic-probe"), probe);
	assert.equal(store.latest("synthetic-probe"), probe);
});

test("SnapshotStore selects by ID across origins without an origin", () => {
	const store = new SnapshotStore();
	const firstTurn = snapshot(1, "real-turn");
	const probe = snapshot(2, "synthetic-probe");
	store.publish(firstTurn);
	store.publish(probe);
	assert.equal(store.first(), firstTurn);
	assert.equal(store.latest(), probe);

	const laterTurn = snapshot(3, "real-turn");
	store.publish(laterTurn);
	assert.equal(store.first(), firstTurn);
	assert.equal(store.latest(), laterTurn);
});

test("SnapshotStore replaces the retained copy with the same ID on a guard update", () => {
	const store = new SnapshotStore();
	store.publish(snapshot(1, "real-turn"));
	const settled = snapshot(1, "real-turn", { status: "incomplete", reason: "No payload was observed." });
	store.publish(settled);
	assert.equal(store.first("real-turn"), settled);
	assert.equal(store.latest("real-turn"), settled);

	store.publish(snapshot(2, "real-turn"));
	const settledLatest = snapshot(2, "real-turn", { status: "complete", dispatch: {
		provider: "mock", api: "openai-completions", model: "m",
	}, findings: [] });
	store.publish(settledLatest);
	assert.equal(store.first("real-turn"), settled, "the first snapshot keeps its own ID");
	assert.equal(store.latest("real-turn"), settledLatest);
});

test("SnapshotStore ignores an update for a snapshot it no longer retains", () => {
	const store = new SnapshotStore();
	const first = snapshot(1, "real-turn");
	const latest = snapshot(3, "real-turn");
	store.publish(first);
	store.publish(snapshot(2, "real-turn"));
	store.publish(latest);
	store.publish(snapshot(2, "real-turn", { status: "incomplete", reason: "late" }));
	assert.equal(store.first("real-turn"), first);
	assert.equal(store.latest("real-turn"), latest);
});

test("SnapshotStore reports every publication until unsubscribed", () => {
	const store = new SnapshotStore();
	const seen: RequestSnapshot[] = [];
	const unsubscribe = store.subscribe((published) => seen.push(published));
	const pending = snapshot(1, "synthetic-probe");
	const settled = snapshot(1, "synthetic-probe", { status: "incomplete", reason: "No payload was observed." });
	const stale = snapshot(0, "synthetic-probe");
	store.publish(pending);
	store.publish(settled);
	store.publish(stale);
	assert.deepEqual(seen, [pending, settled, stale]);

	unsubscribe();
	store.publish(snapshot(2, "real-turn"));
	assert.equal(seen.length, 3);
});

test("SnapshotStore lets a listener unsubscribe while being notified", () => {
	const store = new SnapshotStore();
	const calls: string[] = [];
	const unsubscribeFirst = store.subscribe(() => {
		calls.push("first");
		unsubscribeFirst();
	});
	store.subscribe(() => calls.push("second"));
	store.publish(snapshot(1, "real-turn"));
	store.publish(snapshot(2, "real-turn"));
	assert.deepEqual(calls, ["first", "second", "second"]);
});

test("SnapshotStore clear drops retained snapshots but keeps subscriptions", () => {
	const store = new SnapshotStore();
	const seen: number[] = [];
	store.subscribe((published) => seen.push(published.id));
	store.publish(snapshot(1, "real-turn"));
	store.publish(snapshot(2, "synthetic-probe"));
	store.clear();
	assert.equal(store.first(), undefined);
	assert.equal(store.latest(), undefined);

	const next = snapshot(3, "real-turn");
	store.publish(next);
	assert.equal(store.first("real-turn"), next);
	assert.deepEqual(seen, [1, 2, 3]);
});

test("src/snapshot.ts has no runtime imports", () => {
	const source = readFileSync(new URL("../src/snapshot.ts", import.meta.url), "utf8");
	const imports = source.split("\n").filter((line) => /^import\b/.test(line));
	assert.ok(imports.length > 0);
	for (const line of imports) assert.match(line, /^import type /);
});
