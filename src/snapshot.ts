/**
 * Request snapshots and the SnapshotStore that decouples capture from its
 * consumers (doc/architecture/capture.md). Capture publishes; views read.
 * Imports Pi types only, so the store runs and is tested without a Pi runtime.
 */
import type { Tool } from "@earendil-works/pi-ai";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";

/** What produced the captured request: a real agent run or the silent probe. */
export type CaptureOrigin = "real-turn" | "synthetic-probe";

/** One message as Pi passes it to context handlers. */
export type RequestMessage = ContextEvent["messages"][number];

/**
 * Best-effort source of a conversation change. Neither field proves
 * ownership: any extension can reuse them. Both absent means unattributed.
 * For a modification or deletion they describe the affected message, which
 * names its owner, not the extension that edited it.
 */
export interface ChangeAttribution {
	/** `customType` of a custom message. */
	readonly customType?: string;
	/** Cooperative provenance from a custom message's `details`, which is never sent to the model. */
	readonly provenance?: { readonly source: string; readonly reason?: string };
}

/**
 * A request-only conversation edit. Modifications and deletions reference the
 * source entry of their baseline message, so consumers can apply them to a later
 * projection and drop them once the entry is gone. Retained messages are
 * redacted: image data holds only a size marker, `textSignature` is removed, and
 * thinking and tool-call signatures keep only their length.
 */
export type ConversationChange =
	| { readonly type: "added"; readonly message: RequestMessage; readonly attribution: ChangeAttribution }
	| {
		readonly type: "modified";
		readonly entryId: string;
		readonly message: RequestMessage;
		readonly attribution: ChangeAttribution;
	}
	| { readonly type: "deleted"; readonly entryId: string; readonly attribution: ChangeAttribution };

/**
 * A request-only change of the replayed system state:
 *   content   the replayed plain content differs; `text` is the request's whole content
 *   section   a section was added or changed; `null` text removes it
 *   tool      a declaration was added or redefined; `null` removes it
 */
export type SystemChange =
	| { readonly type: "content"; readonly text: string }
	| { readonly type: "section"; readonly name: string; readonly text: string | null }
	| { readonly type: "tool"; readonly name: string; readonly declaration: Tool | null };

/** Structured request-only edits between the session projection and the captured request. */
export interface StructuredChanges {
	readonly conversation: readonly ConversationChange[];
	readonly system: readonly SystemChange[];
}

/** Provider, API, and model that a paired request was dispatched to. */
export interface Dispatch {
	readonly provider: string;
	readonly api: string;
	readonly model: string;
}

/**
 * Part of a provider message that the payload guard compares as one text unit:
 *   system        system prompt or later system message text
 *   user          user text, including converted custom messages and summaries
 *   assistant     assistant text
 *   tool-call     one tool call: its name and arguments
 *   tool-result   one tool result's text
 */
export type MessagePart = "system" | "user" | "assistant" | "tool-call" | "tool-result";

/** One changed line of a late edit: only in the payload (`added`) or only in the captured request (`removed`). */
export interface LateEditLine {
	readonly type: "added" | "removed";
	readonly text: string;
}

/**
 * A payload difference the structured capture cannot explain:
 *   late-edit        message text added, changed, or removed after the monitor,
 *                    without structure or attribution
 *   late-tool-edit   a declaration the payload adds, removes, or describes differently
 *                    after the monitor; tools Pi hid are not removals
 */
export type GuardFinding =
	| {
		readonly type: "late-edit";
		readonly change: "added" | "modified" | "deleted";
		readonly part: MessagePart;
		/** Changed lines; a modification lists only the lines that differ, ignoring whitespace. */
		readonly lines: readonly LateEditLine[];
	}
	| {
		readonly type: "late-tool-edit";
		readonly change: "added" | "modified" | "deleted";
		readonly name: string;
		/**
		 * Changed description lines: every line the payload declares for an addition,
		 * every captured line for a deletion, and only the lines that differ for a
		 * modification, ignoring whitespace.
		 */
		readonly lines: readonly LateEditLine[];
	};

/**
 * Payload comparison state. Pending and incomplete mean the comparison is
 * unavailable, never that the request had no late edits. An incomplete result
 * with `findings` compared only some channels: the findings hold, and `reason`
 * names what was not compared.
 */
export type GuardResult =
	| { readonly status: "pending" }
	| { readonly status: "complete"; readonly dispatch: Dispatch; readonly findings: readonly GuardFinding[] }
	| {
		readonly status: "incomplete";
		readonly reason: string;
		readonly dispatch?: Dispatch;
		readonly findings?: readonly GuardFinding[];
	};

/** One captured request. Raw message content is process-local; never log or persist it. */
export interface RequestSnapshot {
	/** Local capture number; later captures have larger IDs. A guard update keeps its ID. */
	readonly id: number;
	readonly origin: CaptureOrigin;
	/** Session leaf at capture; `buildSessionProjection(entries, leafId)` rebuilds the baseline. */
	readonly leafId: string | null;
	readonly changes: StructuredChanges;
	/** Effective forced prompt text, present only when it differs from the replayed prompt. */
	readonly forcedPrompt?: string;
	readonly guard: GuardResult;
	/**
	 * Active tools Pi left out of the request for a tool's `prepareLoadout()`, as
	 * the run's `before_agent_start` reported them; absent when Pi hid none.
	 */
	readonly hiddenTools?: readonly string[];
}

/** Read access for consumers. */
export interface SnapshotReader {
	/** The kept snapshot: the one with the highest ID published so far, of either origin. */
	latest(): RequestSnapshot | undefined;
	/** Report every publication, including guard updates; returns the unsubscribe function. */
	subscribe(listener: (snapshot: RequestSnapshot) => void): () => void;
}

/**
 * Keeps one snapshot: the latest by ID. A publication with the same or a
 * higher ID replaces it, so a guard update replaces its own snapshot and the
 * first real request's snapshot releases a probe snapshot. A publication with
 * an older ID only notifies subscribers.
 */
export class SnapshotStore implements SnapshotReader {
	private kept: RequestSnapshot | undefined;
	private readonly listeners = new Set<(snapshot: RequestSnapshot) => void>();

	/** Read the kept snapshot without transferring ownership. */
	public latest(): RequestSnapshot | undefined {
		return this.kept;
	}

	/** Observe every publication, even when a newer snapshot is already kept. */
	public subscribe(listener: (snapshot: RequestSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Keep a snapshot unless the kept one is newer, then notify subscribers. */
	public publish(snapshot: RequestSnapshot): void {
		if (this.kept === undefined || this.kept.id <= snapshot.id) this.kept = snapshot;
		// Copy: a listener may unsubscribe while being notified
		for (const listener of [...this.listeners]) listener(snapshot);
	}

	/** Drop the kept snapshot at session shutdown; subscriptions stay. */
	public clear(): void {
		this.kept = undefined;
	}
}
