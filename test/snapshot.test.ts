import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { type CaptureOrigin, type GuardResult, type RequestSnapshot, SnapshotStore } from "../src/snapshot.ts";

const COMPLETE: GuardResult = {
	status: "complete", dispatch: { provider: "mock", api: "openai-completions", model: "m" }, findings: [],
};

/** A snapshot with no changes; only ID, origin, and guard vary between cases. */
function snapshot(id: number, origin: CaptureOrigin, guard: GuardResult = { status: "pending" }): RequestSnapshot {
	return {
		id,
		origin,
		leafId: `leaf-${id}`,
		changes: { conversation: [], system: [] },
		guard,
	};
}

test("SnapshotStore is empty until the first publication", () => {
	const store = new SnapshotStore();
	assert.equal(store.latest(), undefined);
});

test("SnapshotStore keeps only the snapshot with the highest ID, of either origin", () => {
	const store = new SnapshotStore();
	const turns = [snapshot(1, "real-turn"), snapshot(2, "real-turn")];
	for (const turn of turns) {
		store.publish(turn);
		assert.equal(store.latest(), turn);
	}
	const probe = snapshot(3, "synthetic-probe");
	store.publish(probe);
	assert.equal(store.latest(), probe);
});

test("SnapshotStore releases the probe snapshot once a real request's snapshot is published", () => {
	const store = new SnapshotStore();
	const probe = snapshot(1, "synthetic-probe", { status: "incomplete", reason: "No payload was observed." });
	store.publish(probe);
	assert.equal(store.latest(), probe);

	const real = snapshot(2, "real-turn");
	store.publish(real);
	assert.equal(store.latest(), real, "a pending real-turn snapshot replaces the settled probe snapshot");
	const settled = snapshot(2, "real-turn", COMPLETE);
	store.publish(settled);
	assert.equal(store.latest(), settled);
});

test("SnapshotStore replaces the kept snapshot with a guard update of the same ID", () => {
	const store = new SnapshotStore();
	store.publish(snapshot(1, "real-turn"));
	const settled = snapshot(1, "real-turn", { status: "incomplete", reason: "No payload was observed." });
	store.publish(settled);
	assert.equal(store.latest(), settled);
});

test("SnapshotStore keeps a newer snapshot when an older one's guard settles", () => {
	const store = new SnapshotStore();
	const seen: RequestSnapshot[] = [];
	store.subscribe((published) => seen.push(published));
	store.publish(snapshot(1, "real-turn"));
	const newer = snapshot(2, "real-turn");
	store.publish(newer);
	const olderUpdate = snapshot(1, "real-turn", { status: "incomplete", reason: "No payload was observed." });
	store.publish(olderUpdate);
	assert.equal(store.latest(), newer);
	assert.equal(seen.at(-1), olderUpdate, "the older update still reaches subscribers");
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

test("SnapshotStore clear drops the kept snapshot but keeps subscriptions", () => {
	const store = new SnapshotStore();
	const seen: number[] = [];
	store.subscribe((published) => seen.push(published.id));
	store.publish(snapshot(5, "real-turn"));
	store.clear();
	assert.equal(store.latest(), undefined);

	// Nothing is kept after clear(), so even a lower ID is kept next
	const next = snapshot(1, "real-turn");
	store.publish(next);
	assert.equal(store.latest(), next);
	assert.deepEqual(seen, [5, 1]);
});

test("src/snapshot.ts has no runtime imports", () => {
	const source = readFileSync(new URL("../src/snapshot.ts", import.meta.url), "utf8");
	const imports = source.split("\n").filter((line) => /^import\b/.test(line));
	assert.ok(imports.length > 0);
	for (const line of imports) assert.match(line, /^import type /);
});
