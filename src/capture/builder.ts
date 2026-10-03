/**
 * SnapshotBuilder: runs the deferred part of a capture off the request's
 * critical path (D5), then publishes the snapshot and its guard update (D11).
 */
import type { ConversationChange, GuardResult, RequestSnapshot, StructuredChanges } from "../snapshot.ts";
import { attributeMessage } from "./attribution.ts";
import { type ConversationEdit, diffConversation, diffSystemState } from "./diff.ts";
import { redactMessage } from "./redact.ts";
import type { CapturedRequest } from "./request.ts";

/** Where built snapshots go; SnapshotStore in production. */
export interface SnapshotPublisher {
	publish(snapshot: RequestSnapshot): void;
}

/** A capture whose diff has not run yet, with a guard that settled meanwhile. */
interface ScheduledBuild {
	readonly handle: NodeJS.Immediate;
	guard?: GuardResult;
}

/**
 * Defers each capture's diff, publishes its snapshot with guard `pending`, and
 * publishes a copy with the same ID once the guard settles. A guard that
 * settles before the diff ran is published with the snapshot instead. Captured
 * transcripts and baselines are released when their snapshot is built.
 */
export class SnapshotBuilder {
	private readonly publisher: SnapshotPublisher;
	private readonly scheduled = new Map<number, ScheduledBuild>();
	/** Published snapshots whose guard is still pending. */
	private readonly awaitingGuard = new Map<number, RequestSnapshot>();

	public constructor(publisher: SnapshotPublisher) {
		this.publisher = publisher;
	}

	/** Schedule the diff of one capture; the caller's handler returns at once. */
	public build(request: CapturedRequest): void {
		const handle = setImmediate(() => this.publishChanges(request));
		this.scheduled.set(request.id, { handle });
	}

	/** Settle the guard of a capture; unknown or already settled IDs are ignored. */
	public settleGuard(id: number, guard: GuardResult): void {
		const scheduled = this.scheduled.get(id);
		if (scheduled !== undefined) {
			scheduled.guard = guard;
			return;
		}
		const snapshot = this.awaitingGuard.get(id);
		if (snapshot === undefined) return;
		this.awaitingGuard.delete(id);
		this.publisher.publish({ ...snapshot, guard });
	}

	/** Cancel scheduled diffs and drop pending guards, as at session shutdown. */
	public clear(): void {
		for (const { handle } of this.scheduled.values()) clearImmediate(handle);
		this.scheduled.clear();
		this.awaitingGuard.clear();
	}

	/** Diff, attribute, and publish one capture. */
	private publishChanges(request: CapturedRequest): void {
		const guard = this.scheduled.get(request.id)?.guard ?? { status: "pending" };
		this.scheduled.delete(request.id);
		let snapshot: RequestSnapshot;
		try {
			snapshot = buildRequestSnapshot(request, guard);
		} catch {
			// Deferred work runs outside Pi's handler error reporting, where a throw
			// would end the host process; an unexpected message shape skips the snapshot
			return;
		}
		if (guard.status === "pending") this.awaitingGuard.set(snapshot.id, snapshot);
		this.publisher.publish(snapshot);
	}
}

/** Assemble an immutable snapshot whose retained messages are attributed and redacted. */
export function buildRequestSnapshot(request: CapturedRequest, guard: GuardResult): RequestSnapshot {
	const baseline = request.baseline.messages.map(({ message }) => message);
	const changes: StructuredChanges = {
		conversation: diffConversation(request.baseline.messages, request.messages).map(toConversationChange),
		system: diffSystemState(baseline, request.messages),
	};
	return {
		id: request.id,
		origin: request.origin,
		capturedAt: request.capturedAt,
		leafId: request.baseline.leafId,
		changes,
		...(request.forcedPrompt === undefined ? {} : { forcedPrompt: request.forcedPrompt }),
		guard,
	};
}

/** Retained form of one edit: entry references, attribution, and redacted request messages only. */
function toConversationChange(edit: ConversationEdit): ConversationChange {
	switch (edit.type) {
		case "added":
			return { type: "added", message: redactMessage(edit.message), attribution: attributeMessage(edit.message) };
		case "modified":
			return {
				type: "modified",
				entryId: edit.baseline.entryId,
				message: redactMessage(edit.message),
				attribution: attributeMessage(edit.message),
			};
		case "deleted":
			return { type: "deleted", entryId: edit.baseline.entryId, attribution: attributeMessage(edit.baseline.message) };
	}
}
