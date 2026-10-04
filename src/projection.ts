/**
 * Session projections for the views: the filtered projection at a leaf with
 * each message's source entry, and the latest request snapshot applied to the
 * current projection for Usage (D11 in REQUEST-ONLY-INJECTIONS.md). Reads
 * snapshots and Pi data only; imports no capture or probe module.
 */
import { declarationsEqual, getCurrentSystemMessage, type SystemMessage } from "@earendil-works/pi-ai";
import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";

import type { ConversationChange, RequestMessage, RequestSnapshot, SystemChange } from "./snapshot.ts";

/** A projected message with the session entry that owns it. */
export interface ProjectedMessage {
	readonly entryId: string;
	readonly message: RequestMessage;
}

/** Removes recorded probe messages, as capture did for its baseline. */
export type MessageFilter = (messages: RequestMessage[]) => RequestMessage[];

/** Inputs for applying a request snapshot to the current projection. */
export interface SnapshotApplicationInput {
	/** Latest request snapshot, or undefined when none was captured. */
	readonly snapshot: RequestSnapshot | undefined;
	/** Current session entries; they are append-only, so the snapshot's leaf still rebuilds its baseline. */
	readonly entries: SessionEntry[];
	/** Current session leaf. */
	readonly leafId: string | null;
	readonly filterMessages: MessageFilter;
}

/** Current messages with the request's changes applied, and the system changes that still apply. */
export interface AppliedRequest {
	/** Current branch messages, system messages included, with the request's conversation changes. */
	readonly messages: RequestMessage[];
	/** Request-only system changes; empty unless the recorded system state is unchanged since capture. */
	readonly systemChanges: readonly SystemChange[];
}

/** The filtered session projection at `leafId`, keeping each message's source entry. */
export function readProjection(
	entries: SessionEntry[],
	leafId: string | null,
	filterMessages: MessageFilter,
): ProjectedMessage[] {
	return buildSessionProjection(entries, leafId).entries.flatMap(({ sourceEntry, messages }) =>
		filterMessages(messages).map((message) => ({ entryId: sourceEntry.id, message })));
}

/**
 * Apply a request snapshot to the current projection. Conversation changes
 * apply by baseline entry: additions are appended, a modification replaces its
 * entry's message, and a deletion removes it. A change whose entry has left the
 * projection is stale and dropped. System changes are deltas against the
 * snapshot's replayed system state, so they apply only while the current
 * replayed state still equals it.
 */
export function applyRequestSnapshot(input: SnapshotApplicationInput): AppliedRequest {
	const current = readProjection(input.entries, input.leafId, input.filterMessages);
	if (input.snapshot === undefined) return { messages: current.map(({ message }) => message), systemChanges: [] };
	const messages = applyConversationChanges(current, input.snapshot.changes.conversation);
	return { messages, systemChanges: freshSystemChanges(input.snapshot, input.entries, messages) };
}

/** Current messages with modifications and deletions applied in place, then additions appended. */
function applyConversationChanges(
	current: readonly ProjectedMessage[],
	changes: readonly ConversationChange[],
): RequestMessage[] {
	// A deletion maps its target to undefined
	const replaced = new Map<ProjectedMessage, RequestMessage | undefined>();
	const additions: RequestMessage[] = [];
	for (const change of changes) {
		if (change.type === "added") {
			additions.push(change.message);
			continue;
		}
		// An entry rarely holds more than one conversation message; take the first one not yet changed
		const target = current.find((candidate) => candidate.entryId === change.entryId
			&& candidate.message.role !== "system" && !replaced.has(candidate));
		// Compaction or branch navigation removed the entry since capture
		if (target === undefined) continue;
		replaced.set(target, change.type === "modified" ? change.message : undefined);
	}
	const applied = current.flatMap((projected) => {
		if (!replaced.has(projected)) return [projected.message];
		const replacement = replaced.get(projected);
		return replacement === undefined ? [] : [replacement];
	});
	return [...applied, ...additions];
}

/** The snapshot's system changes, or none once the replayed system state changed since capture. */
function freshSystemChanges(
	snapshot: RequestSnapshot,
	entries: SessionEntry[],
	messages: readonly RequestMessage[],
): readonly SystemChange[] {
	if (snapshot.changes.system.length === 0) return [];
	const baseline = getCurrentSystemMessage(buildSessionProjection(entries, snapshot.leafId).messages);
	return sameSystemState(baseline, getCurrentSystemMessage(messages)) ? snapshot.changes.system : [];
}

/** Whether two replayed system states have the same content, sections in order, and declarations. */
function sameSystemState(a: SystemMessage | undefined, b: SystemMessage | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	if (JSON.stringify(a.content) !== JSON.stringify(b.content)) return false;
	if (JSON.stringify(Object.entries(a.sections ?? {})) !== JSON.stringify(Object.entries(b.sections ?? {}))) {
		return false;
	}
	const aTools = a.toolsAdded ?? [];
	const bTools = b.toolsAdded ?? [];
	return aTools.length === bTools.length && aTools.every((tool, index) => declarationsEqual(tool, bTools[index]));
}
