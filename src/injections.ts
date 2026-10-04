/**
 * Injections composition from a request snapshot: the session projection at
 * the snapshot's leaf, rebuilt when the view opens, with the snapshot's
 * request-only changes applied and marked. Reads the snapshot and current Pi
 * data only; imports no capture or probe module.
 */
import { getCurrentSystemMessage, type Tool } from "@earendil-works/pi-ai";
import {
	type BuildSystemPromptOptions,
	buildSessionProjection,
	estimateTokens,
	type SessionEntry,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import { analyzeSystemPrompt, type DeletedSection, type PromptChanges, type ToolSlice } from "./measure.ts";
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
import type { PromptSourceSlice } from "./prompt-additions.ts";
import { buildNativeSnapshot, replayedToolSlices } from "./replay.ts";
import type { ConversationChange, RequestMessage, RequestSnapshot, SystemChange } from "./snapshot.ts";
import { type SystemMessage, systemMessageText } from "./transcript.ts";

/** Everything the composition reads besides the snapshot itself. */
export interface InjectionsInput {
	readonly snapshot: RequestSnapshot;
	/** Current session entries; they are append-only, so the snapshot's leaf still rebuilds its baseline. */
	readonly entries: SessionEntry[];
	/** Removes recorded probe messages, as capture did for the baseline. */
	readonly filterMessages: (messages: RequestMessage[]) => RequestMessage[];
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
	const baseline = rebuildBaseline(input.entries, input.snapshot.leafId, input.filterMessages);
	const items = [
		...measureRequestPrompt(input, baseline.map(({ message }) => message)),
		...measureMessages(input.snapshot.changes.conversation, baseline),
	];
	return buildSnapshot(items, input.snapshot.origin, new Date(input.snapshot.capturedAt));
}

// ============================================================================
// Baseline
// ============================================================================

/** A baseline message with the session entry that owns it. */
interface BaselineMessage {
	readonly entryId: string;
	readonly message: RequestMessage;
}

/** The filtered session projection at `leafId`, keeping each message's source entry. */
function rebuildBaseline(
	entries: SessionEntry[],
	leafId: string | null,
	filterMessages: InjectionsInput["filterMessages"],
): BaselineMessage[] {
	return buildSessionProjection(entries, leafId).entries.flatMap(({ sourceEntry, messages }) =>
		filterMessages(messages).map((message) => ({ entryId: sourceEntry.id, message })));
}

// ============================================================================
// Prompt and tools
// ============================================================================

/** System state the request carried, with what its changes touched. */
interface RequestSystemState {
	readonly state: Pick<SystemMessage, "content" | "sections">;
	readonly declarations: readonly Tool[];
	readonly prompt: PromptChanges;
	readonly tools: ReadonlyMap<string, Exclude<RequestChange, "deleted">>;
	readonly deletedTools: readonly Tool[];
}

/**
 * Measure the replayed prompt and tools with the request's system changes
 * applied. A forced prompt replaces every section, so only tool changes reach
 * it. A branch with no recorded system state uses the live prompt and tools.
 */
function measureRequestPrompt(input: InjectionsInput, baseline: readonly RequestMessage[]): InjectionItem[] {
	const base = getCurrentSystemMessage(baseline);
	if (base === undefined) {
		const native = buildNativeSnapshot({ ...input, systemPrompt: input.snapshot.forcedPrompt ?? input.systemPrompt });
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
	return analyzeSystemPrompt(
		forced ?? systemMessageText(request.state),
		{ homeDir: process.env.HOME, customPrompt: input.options.customPrompt },
		tools,
		{ sources: input.promptSources },
		forced === undefined ? request.prompt : {},
	);
}

/** Apply content, section, and tool changes in capture order to the replayed session state. */
function applySystemChanges(base: SystemMessage, changes: readonly SystemChange[]): RequestSystemState {
	let content = contentText(base.content);
	const sections: Record<string, string | null> = { ...base.sections };
	const sectionChanges = new Map<string, Exclude<RequestChange, "deleted">>();
	const deletedSections: DeletedSection[] = [];
	const declarations = [...(base.toolsAdded ?? [])];
	const toolChanges = new Map<string, Exclude<RequestChange, "deleted">>();
	const deletedTools: Tool[] = [];
	for (const change of changes) {
		switch (change.type) {
			case "content":
				content = change.text;
				// Pi renders plain content before the first section, inside the measured Preamble
				sectionChanges.set("preamble", "modified");
				break;
			case "section": {
				const previous = sections[change.name];
				if (change.text === null) {
					if (typeof previous === "string") deletedSections.push({ name: change.name, text: previous });
					delete sections[change.name];
					break;
				}
				sectionChanges.set(change.name, typeof previous === "string" ? "modified" : "added");
				sections[change.name] = change.text;
				break;
			}
			case "tool": {
				const index = declarations.findIndex((tool) => tool.name === change.name);
				if (change.declaration === null) {
					if (index !== -1) deletedTools.push(...declarations.splice(index, 1));
				} else if (index === -1) {
					declarations.push(change.declaration);
					toolChanges.set(change.name, "added");
				} else {
					declarations[index] = change.declaration;
					toolChanges.set(change.name, "modified");
				}
				break;
			}
		}
	}
	return {
		state: { content, sections },
		declarations,
		prompt: { sections: sectionChanges, deleted: deletedSections, replayed: { content, sections } },
		tools: toolChanges,
		deletedTools,
	};
}

/** The slice with a request-only change, or unchanged when there is none. */
function withToolChange(tool: ToolSlice, change: RequestChange | undefined): ToolSlice {
	return change === undefined ? tool : { ...tool, change };
}

/** Plain text of system content; text blocks join with a newline, as Pi renders them. */
function contentText(content: SystemMessage["content"]): string {
	return typeof content === "string" ? content : content.map((block) => block.text).join("\n");
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
	baseline: readonly BaselineMessage[],
): InjectionItem[] {
	const consumed = new Set<BaselineMessage>();
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
