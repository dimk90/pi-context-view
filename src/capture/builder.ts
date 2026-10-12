/**
 * SnapshotBuilder: runs the deferred part of a capture off the request's
 * critical path, then publishes the snapshot and its guard update.
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
	/** The guard will not change after `guard`. */
	released: boolean;
}

/**
 * Defers each capture's diff, publishes its snapshot with guard `pending`, and
 * publishes a copy with the same ID for every guard update until the guard is
 * released. A guard that settles before the diff ran is published with the
 * snapshot instead. Request copies and baselines are released when their
 * snapshot is built.
 */
export class SnapshotBuilder {
	private readonly publisher: SnapshotPublisher;
	private readonly scheduled = new Map<number, ScheduledBuild>();
	/** Published snapshots whose guard may still change. */
	private readonly open = new Map<number, RequestSnapshot>();

	public constructor(publisher: SnapshotPublisher) {
		this.publisher = publisher;
	}

	/** Schedule the diff of one capture; the caller's handler returns at once. */
	public build(request: CapturedRequest): void {
		const handle = setImmediate(() => this.publishChanges(request));
		this.scheduled.set(request.id, { handle, released: false });
	}

	/** Publish a capture's guard, replacing its earlier guard; unknown or released IDs are ignored. */
	public settleGuard(id: number, guard: GuardResult): void {
		const scheduled = this.scheduled.get(id);
		if (scheduled !== undefined) {
			if (!scheduled.released) scheduled.guard = guard;
			return;
		}
		const snapshot = this.open.get(id);
		if (snapshot === undefined) return;
		const updated = { ...snapshot, guard };
		this.open.set(id, updated);
		this.publisher.publish(updated);
	}

	/** Stop accepting guard updates for a capture: its guard is final. */
	public release(id: number): void {
		const scheduled = this.scheduled.get(id);
		if (scheduled !== undefined) scheduled.released = true;
		this.open.delete(id);
	}

	/** Cancel scheduled diffs and drop open guards, as at session shutdown. */
	public clear(): void {
		for (const { handle } of this.scheduled.values()) clearImmediate(handle);
		this.scheduled.clear();
		this.open.clear();
	}

	/** Diff, attribute, and publish one capture. */
	private publishChanges(request: CapturedRequest): void {
		const scheduled = this.scheduled.get(request.id);
		this.scheduled.delete(request.id);
		let snapshot: RequestSnapshot;
		try {
			snapshot = buildRequestSnapshot(request, scheduled?.guard ?? { status: "pending" });
		} catch {
			// Deferred work runs outside Pi's handler error reporting, where a throw
			// would end the host process; an unexpected message shape skips the snapshot
			return;
		}
		if (scheduled?.released !== true) this.open.set(snapshot.id, snapshot);
		this.publisher.publish(snapshot);
	}
}

/** Assemble an immutable snapshot whose retained messages are attributed and redacted. */
export function buildRequestSnapshot(request: CapturedRequest, guard: GuardResult): RequestSnapshot {
	const baseline = request.baseline.messages.map(({ message }) => message);
	const changes: StructuredChanges = {
		conversation: diffConversation(request.conversation.baseline, request.conversation.request)
			.map(toConversationChange),
		// Replaying an already replayed system state returns it unchanged
		system: diffSystemState(baseline, request.system === undefined ? [] : [request.system]),
	};
	return {
		id: request.id,
		origin: request.origin,
		leafId: request.baseline.leafId,
		changes,
		...(request.forcedPrompt === undefined ? {} : { forcedPrompt: request.forcedPrompt }),
		guard,
		...(request.hiddenTools === undefined ? {} : { hiddenTools: request.hiddenTools }),
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
