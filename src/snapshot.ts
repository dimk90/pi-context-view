/**
 * Request snapshots and the SnapshotStore that decouples capture from its
 * consumers (D11 in REQUEST-ONLY-INJECTIONS.md). Capture publishes; views read.
 * Imports Pi types only, so the store runs and is tested without a Pi runtime.
 */
import type { ContextEvent } from "@earendil-works/pi-coding-agent";

/** What produced the captured request: a real agent run or the silent probe. */
export type CaptureOrigin = "real-turn" | "synthetic-probe";

/** One message as Pi passes it to context handlers. */
export type RequestMessage = ContextEvent["messages"][number];

/**
 * A request-only conversation edit. Modifications and deletions reference the
 * source entry of their baseline message, so consumers can apply them to a later
 * projection and drop them once the entry is gone.
 */
export type ConversationChange =
	| { readonly type: "added"; readonly message: RequestMessage }
	| { readonly type: "modified"; readonly entryId: string; readonly message: RequestMessage }
	| { readonly type: "deleted"; readonly entryId: string };

/** A request-only system-prompt section patch; `null` text removes the section. */
export interface SystemChange {
	readonly type: "section";
	readonly name: string;
	readonly text: string | null;
}

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
 * A payload difference the structured capture cannot explain:
 *   late-edit            text changed after the monitor, without structure or attribution
 *   hidden-declaration   a captured tool declaration missing from the payload, with
 *                        active `model-only` tools as candidate sources
 */
export type GuardFinding =
	| { readonly type: "late-edit"; readonly text: string }
	| { readonly type: "hidden-declaration"; readonly name: string; readonly candidates: readonly string[] };

/**
 * Payload comparison state. Pending and incomplete mean the comparison is
 * unavailable, never that the request had no late edits.
 */
export type GuardResult =
	| { readonly status: "pending" }
	| { readonly status: "complete"; readonly dispatch: Dispatch; readonly findings: readonly GuardFinding[] }
	| { readonly status: "incomplete"; readonly reason: string };

/** Tool names from a complete tool-declaration channel and from the capture's baseline replay. */
export interface DeclaredTools {
	readonly declared: readonly string[];
	readonly baseline: readonly string[];
}

/** One captured request. Raw message content is process-local; never log or persist it. */
export interface RequestSnapshot {
	/** Local capture number; later captures have larger IDs. A guard update keeps its ID. */
	readonly id: number;
	readonly origin: CaptureOrigin;
	/** Capture time in epoch milliseconds. */
	readonly capturedAt: number;
	/** Session leaf at capture; `buildSessionProjection(entries, leafId)` rebuilds the baseline. */
	readonly leafId: string | null;
	readonly changes: StructuredChanges;
	/** Effective forced prompt text, present only when it differs from the replayed prompt. */
	readonly forcedPrompt?: string;
	readonly guard: GuardResult;
	/** Present only when the paired payload had a complete tool-declaration channel. */
	readonly declaredTools?: DeclaredTools;
}

/** Read access for consumers. Without an origin, selection is by ID across both origins. */
export interface SnapshotReader {
	first(origin?: CaptureOrigin): RequestSnapshot | undefined;
	latest(origin?: CaptureOrigin): RequestSnapshot | undefined;
	/** Report every publication, including guard updates; returns the unsubscribe function. */
	subscribe(listener: (snapshot: RequestSnapshot) => void): () => void;
}

/** First and latest retained snapshot of one origin. */
interface RetainedPair {
	first?: RequestSnapshot;
	latest?: RequestSnapshot;
}

/**
 * Retains the first and latest snapshot per origin, so at most four. A
 * publication with a retained ID replaces that copy; the first snapshot of an
 * origin stays until `clear()`.
 */
export class SnapshotStore implements SnapshotReader {
	private readonly retained: Record<CaptureOrigin, RetainedPair> = {
		"real-turn": {},
		"synthetic-probe": {},
	};
	private readonly listeners = new Set<(snapshot: RequestSnapshot) => void>();

	public first(origin?: CaptureOrigin): RequestSnapshot | undefined {
		if (origin !== undefined) return this.retained[origin].first;
		return pickById(this.retained["real-turn"].first, this.retained["synthetic-probe"].first, "lowest");
	}

	public latest(origin?: CaptureOrigin): RequestSnapshot | undefined {
		if (origin !== undefined) return this.retained[origin].latest;
		return pickById(this.retained["real-turn"].latest, this.retained["synthetic-probe"].latest, "highest");
	}

	public subscribe(listener: (snapshot: RequestSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Retain a new snapshot or replace the retained copy with the same ID, then notify subscribers. */
	public publish(snapshot: RequestSnapshot): void {
		const pair = this.retained[snapshot.origin];
		if (pair.first === undefined || pair.first.id === snapshot.id) pair.first = snapshot;
		if (pair.latest === undefined || pair.latest.id <= snapshot.id) pair.latest = snapshot;
		// Copy: a listener may unsubscribe while being notified
		for (const listener of [...this.listeners]) listener(snapshot);
	}

	/** Drop every retained snapshot at session shutdown; subscriptions stay. */
	public clear(): void {
		this.retained["real-turn"] = {};
		this.retained["synthetic-probe"] = {};
	}
}

/** The snapshot with the lowest or highest ID among the defined candidates. */
function pickById(
	a: RequestSnapshot | undefined,
	b: RequestSnapshot | undefined,
	which: "lowest" | "highest",
): RequestSnapshot | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	const aFirst = which === "lowest" ? a.id < b.id : a.id > b.id;
	return aFirst ? a : b;
}
