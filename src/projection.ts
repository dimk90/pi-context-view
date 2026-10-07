/**
 * Session projections for the views: the filtered projection at a leaf with
 * each message's source entry, and the latest request snapshot, forced prompt
 * and declared tool names included, applied to the current projection for
 * Usage (D9 and D11 in REQUEST-ONLY-INJECTIONS.md). Reads snapshots and Pi
 * data only; imports no capture or probe module.
 */
import { declarationsEqual, getCurrentSystemMessage, getCurrentTools, type SystemMessage } from "@earendil-works/pi-ai";
import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";

import type {
	ConversationChange,
	DeclaredTools,
	RequestMessage,
	RequestSnapshot,
	SnapshotReader,
	SystemChange,
} from "./snapshot.ts";

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
	/** Tool names of the latest snapshot that records them; see `latestDeclaredTools()`. */
	readonly declaredTools?: DeclaredTools;
}

/** Current messages with the request's changes applied, and the system changes that still apply. */
export interface AppliedRequest {
	/** Current branch messages, system messages included, with the request's conversation changes. */
	readonly messages: RequestMessage[];
	/** Request-only system changes; empty unless the recorded system state is unchanged since capture. */
	readonly systemChanges: readonly SystemChange[];
	/** The request's forced prompt, under the same freshness rule as `systemChanges`. */
	readonly forcedPrompt?: string;
	/**
	 * Tool names the request declared to the model, only while the current
	 * replayed tool names equal its baseline names. Undefined means every
	 * replayed tool counts.
	 */
	readonly declaredToolNames?: ReadonlySet<string>;
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
 * Declared tool names from the latest retained snapshot of either origin that
 * records them. A standard probe has no payload and records none, so it does
 * not replace the names of an earlier real turn; a later real turn with an
 * incomplete tool channel does, leaving none.
 */
export function latestDeclaredTools(snapshots: SnapshotReader): DeclaredTools | undefined {
	let source: RequestSnapshot | undefined;
	for (const snapshot of [snapshots.latest("real-turn"), snapshots.latest("synthetic-probe")]) {
		if (snapshot?.declaredTools === undefined) continue;
		if (source === undefined || snapshot.id > source.id) source = snapshot;
	}
	return source?.declaredTools;
}

/**
 * Apply a request snapshot to the current projection. Conversation changes
 * apply by baseline entry: additions are appended, a modification replaces its
 * entry's message, and a deletion removes it. A change whose entry has left the
 * projection is stale and dropped. System changes are deltas against the
 * snapshot's replayed system state, and a forced prompt is a rendering of it,
 * so both apply only while the current replayed state still equals it.
 * Declared tool names apply while the replayed tool names are unchanged.
 */
export function applyRequestSnapshot(input: SnapshotApplicationInput): AppliedRequest {
	const current = readProjection(input.entries, input.leafId, input.filterMessages);
	const declaredToolNames = freshDeclaredNames(input.declaredTools, current);
	const names = declaredToolNames === undefined ? {} : { declaredToolNames };
	if (input.snapshot === undefined) {
		return { messages: current.map(({ message }) => message), systemChanges: [], ...names };
	}
	const messages = applyConversationChanges(current, input.snapshot.changes.conversation);
	return { messages, ...freshSystemState(input.snapshot, input.entries, messages), ...names };
}

/**
 * The declared names, or none once the current replayed tool names differ
 * from the snapshot's baseline names: an active-tool change, branch
 * navigation, or resume can change which tools the next request declares.
 */
function freshDeclaredNames(
	declaredTools: DeclaredTools | undefined,
	current: readonly ProjectedMessage[],
): ReadonlySet<string> | undefined {
	if (declaredTools === undefined) return undefined;
	const replayed = new Set(getCurrentTools(current.map(({ message }) => message)).map((tool) => tool.name));
	const baseline = new Set(declaredTools.baseline);
	const unchanged = replayed.size === baseline.size && [...replayed].every((name) => baseline.has(name));
	return unchanged ? new Set(declaredTools.declared) : undefined;
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

/** The snapshot's system changes and forced prompt, or neither once the replayed state changed since capture. */
function freshSystemState(
	snapshot: RequestSnapshot,
	entries: SessionEntry[],
	messages: readonly RequestMessage[],
): Omit<AppliedRequest, "messages"> {
	const { changes: { system }, forcedPrompt } = snapshot;
	if (system.length === 0 && forcedPrompt === undefined) return { systemChanges: [] };
	const baseline = getCurrentSystemMessage(buildSessionProjection(entries, snapshot.leafId).messages);
	if (!sameSystemState(baseline, getCurrentSystemMessage(messages))) return { systemChanges: [] };
	return { systemChanges: system, forcedPrompt };
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
