/**
 * Injections composition from a request snapshot: the session projection at
 * the snapshot's leaf, rebuilt when the view opens, with the snapshot's
 * request-only changes applied and marked. Reads the snapshot and current Pi
 * data only; imports no capture or probe module.
 */
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
	type BuildSystemPromptOptions,
	estimateTokens,
	type SessionEntry,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import { analyzeSystemPrompt, type ToolSlice } from "./measure.ts";
import { messagePreview } from "./message-preview.ts";
import {
	AGGREGATE_SOURCE,
	buildSnapshot,
	type InitialSnapshot,
	type InjectionItem,
	type InjectionSource,
	messageTypeSource,
	type RequestChange,
} from "./model.ts";
import { type MessageFilter, type ProjectedMessage, readProjection } from "./projection.ts";
import type { PromptSourceSlice } from "./prompt-additions.ts";
import { applySystemChanges, buildNativeSnapshot, markForcedPrompt, replayedToolSlices } from "./replay.ts";
import type { ConversationChange, RequestMessage, RequestSnapshot } from "./snapshot.ts";
import { systemMessageText } from "./transcript.ts";

/** Everything the composition reads besides the snapshot itself. */
export interface InjectionsInput {
	readonly snapshot: RequestSnapshot;
	/** Current session entries; they are append-only, so the snapshot's leaf still rebuilds its baseline. */
	readonly entries: SessionEntry[];
	/** Removes recorded probe messages, as capture did for the baseline. */
	readonly filterMessages: MessageFilter;
	/** Live prompt options; only `customPrompt` is used, to mark dropped blocks. */
	readonly options: BuildSystemPromptOptions;
	readonly allTools: readonly ToolInfo[];
	/** Loaded extension provenance, used only to guess who appended prompt text. */
	readonly promptSources?: readonly PromptSourceSlice[];
	/** Live prompt and active tools, used only when the branch recorded no system state. */
	readonly systemPrompt: string;
	readonly activeToolNames: readonly string[];
}

/** Build the Injections tree of one request: its replayed prompt and tools, custom messages, and changes. */
export function buildInjectionsSnapshot(input: InjectionsInput): InitialSnapshot {
	const baseline = readProjection(input.entries, input.snapshot.leafId, input.filterMessages);
	const items = [
		...measureRequestPrompt(input, baseline.map(({ message }) => message)),
		...measureMessages(input.snapshot.changes.conversation, baseline),
	];
	return buildSnapshot(items, input.snapshot.origin, new Date(input.snapshot.capturedAt));
}

// ============================================================================
// Prompt and tools
// ============================================================================

/**
 * Measure the replayed prompt and tools with the request's system changes
 * applied. A forced prompt replaces every section, so only tool changes reach
 * it. A branch with no recorded system state uses the live prompt and tools.
 */
function measureRequestPrompt(input: InjectionsInput, baseline: readonly RequestMessage[]): InjectionItem[] {
	const base = getCurrentSystemMessage(baseline);
	if (base === undefined) {
		const native = buildNativeSnapshot({ ...input, forcedPrompt: input.snapshot.forcedPrompt });
		return native.groups.flatMap((group) => group.items);
	}
	const request = applySystemChanges(base, input.snapshot.changes.system);
	const forced = input.snapshot.forcedPrompt;
	const tools: ToolSlice[] = [
		...replayedToolSlices(request.state, request.declarations, input.allTools)
			.map((tool) => withToolChange(tool, request.tools.get(tool.name))),
		...replayedToolSlices(base, request.deletedTools, input.allTools)
			.map((tool) => withToolChange(tool, "deleted")),
	];
	return markForcedPrompt(analyzeSystemPrompt(
		forced ?? systemMessageText(request.state),
		{ homeDir: process.env.HOME, customPrompt: input.options.customPrompt },
		tools,
		{ sources: input.promptSources },
		forced === undefined ? request.prompt : {},
	), forced);
}

/** The slice with a request-only change, or unchanged when there is none. */
function withToolChange(tool: ToolSlice, change: RequestChange | undefined): ToolSlice {
	return change === undefined ? tool : { ...tool, change };
}

// ============================================================================
// Messages
// ============================================================================

/**
 * Items for the session's custom messages and every conversation change. A
 * modified or deleted message takes the place of its unchanged session row.
 */
function measureMessages(
	changes: readonly ConversationChange[],
	baseline: readonly ProjectedMessage[],
): InjectionItem[] {
	const consumed = new Set<ProjectedMessage>();
	/** The first unconsumed conversation message of an entry; an entry rarely holds more than one. */
	const take = (entryId: string): RequestMessage | undefined => {
		const found = baseline.find((candidate) => candidate.entryId === entryId
			&& candidate.message.role !== "system" && !consumed.has(candidate));
		if (found !== undefined) consumed.add(found);
		return found?.message;
	};
	const changed = changes.map((change, index) => changeItem(`change:${index}`, change, take));

	const occurrences = new Map<string, number>();
	const unchanged: InjectionItem[] = [];
	for (const entry of baseline) {
		if (consumed.has(entry) || entry.message.role !== "custom") continue;
		const customType = entry.message.customType;
		const occurrence = occurrences.get(customType) ?? 0;
		occurrences.set(customType, occurrence + 1);
		unchanged.push(messageItem(`message:${customType}:${occurrence}`, entry.message, messageTypeSource(customType)));
	}
	return [...unchanged, ...changed];
}

/** One conversation change as a marked item; deletions read 0 tokens and preview the session original. */
function changeItem(
	id: string,
	change: ConversationChange,
	take: (entryId: string) => RequestMessage | undefined,
): InjectionItem {
	const source = change.attribution.customType === undefined
		? AGGREGATE_SOURCE
		: messageTypeSource(change.attribution.customType);
	switch (change.type) {
		case "added":
			return { ...messageItem(id, change.message, source, true), change: "added" };
		case "modified": {
			const item = messageItem(id, change.message, source, true);
			const original = take(change.entryId);
			if (original === undefined) return { ...item, change: "modified" };
			const session = messagePreview(original);
			return {
				...item,
				change: "modified",
				sections: [
					{ label: "Request", text: item.text, tokens: item.tokens, jsonSpan: item.jsonSpan },
					{ label: "Session", text: session.text, tokens: 0, jsonSpan: session.jsonSpan },
				],
			};
		}
		case "deleted": {
			const original = take(change.entryId);
			if (original === undefined) {
				return { id, phase: "initial", kind: "message", source, label: "message", chars: 0, tokens: 0, text: "",
					change: "deleted" };
			}
			return { ...messageItem(id, original, source), chars: 0, tokens: 0, change: "deleted" };
		}
	}
}

/** A measured message with its content-only preview. */
function messageItem(id: string, message: RequestMessage, source: InjectionSource, redacted = false): InjectionItem {
	const { text, jsonSpan } = messagePreview(message, redacted);
	return {
		id,
		phase: "initial",
		kind: "message",
		source,
		label: message.role === "custom" ? "message" : `${message.role} message`,
		chars: text.length,
		tokens: estimateTokens(message),
		text,
		jsonSpan,
	};
}
