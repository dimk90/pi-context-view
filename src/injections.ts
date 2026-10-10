/**
 * Injections composition from a request snapshot: the session projection at
 * the snapshot's leaf, rebuilt when the view opens, with the snapshot's
 * request-only changes marked and hidden tools left out, plus the payload
 * guard's payload changes. Reads the snapshot and current Pi data only; imports no
 * capture or probe module.
 */
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
	type BuildSystemPromptOptions,
	estimateTokens,
	type SessionEntry,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import { analyzeSystemPrompt, textTokens, type ToolSlice } from "./measure.ts";
import { messagePreview } from "./message-preview.ts";
import {
	AGGREGATE_SOURCE,
	buildSnapshot,
	type InjectionItem,
	type InjectionSnapshot,
	type InjectionSource,
	messageTypeSource,
	PAYLOAD_CHANGES_SOURCE,
	type RequestChange,
} from "./model.ts";
import { type MessageFilter, type ProjectedMessage, readProjection } from "./projection.ts";
import type { PromptSourceSlice } from "./prompt-additions.ts";
import {
	applySystemChanges,
	buildNativeSnapshot,
	markForcedPrompt,
	replayedToolSlices,
	splitHiddenTools,
} from "./replay.ts";
import type {
	ConversationChange,
	GuardFinding,
	GuardResult,
	MessagePart,
	RequestMessage,
	RequestSnapshot,
} from "./snapshot.ts";
import { systemMessageText } from "./transcript.ts";

/** Row label of a payload change, by the message part it changed. */
const PAYLOAD_CHANGE_LABELS: Readonly<Record<MessagePart, string>> = {
	system: "system message",
	user: "user message",
	assistant: "assistant message",
	"tool-call": "tool call",
	"tool-result": "tool result",
};

/** Everything the composition reads besides the snapshot itself. */
export interface InjectionsInput {
	readonly snapshot: RequestSnapshot;
	/** Current session entries; they are append-only, so the snapshot's leaf still rebuilds its baseline. */
	readonly entries: SessionEntry[];
	/** Removes recorded probe messages, as capture did for the baseline. */
	readonly filterMessages: MessageFilter;
	/**
	 * Live prompt options; only `customPrompt` is used, to mark dropped blocks.
	 * The snapshot's hidden tools replace `hiddenTools`.
	 */
	readonly options: BuildSystemPromptOptions;
	readonly allTools: readonly ToolInfo[];
	/** Loaded extension provenance: labels path extensions and guesses who appended prompt text. */
	readonly promptSources?: readonly PromptSourceSlice[];
	/** Live prompt and active tools, used only when the branch recorded no system state. */
	readonly systemPrompt: string;
	readonly activeToolNames: readonly string[];
}

/**
 * Build the Injections tree of one request: its replayed prompt and tools,
 * custom messages, and changes, with the guard's payload changes in their own
 * group. The tools Pi hid are left out; their names supply the description note.
 */
export function buildInjectionsSnapshot(input: InjectionsInput): InjectionSnapshot {
	const baseline = readProjection(input.entries, input.snapshot.leafId, input.filterMessages);
	const findings = guardFindings(input.snapshot.guard);
	const prompt = measureRequestPrompt(input, baseline.map(({ message }) => message));
	const items = [
		...prompt.items,
		...measureMessages(input.snapshot.changes.conversation, baseline),
		...measurePayloadChanges(findings),
	];
	return { ...buildSnapshot(items), hiddenTools: prompt.hiddenTools };
}

/** Findings of every compared channel; a pending guard has none yet. */
function guardFindings(guard: GuardResult): readonly GuardFinding[] {
	return guard.status === "pending" ? [] : guard.findings ?? [];
}

// ============================================================================
// Prompt and tools
// ============================================================================

/** Measured prompt and tool items, and names of the tools Pi hid from the model and the items leave out. */
interface RequestPrompt {
	readonly items: readonly InjectionItem[];
	readonly hiddenTools: readonly string[];
}

/**
 * Measure the replayed prompt and tools with the request's system changes
 * applied. A forced prompt replaces every section, so only tool changes reach
 * it. A tool Pi hid is left out, whatever structured change it had. A branch
 * with no recorded system state uses the live prompt and tools.
 */
function measureRequestPrompt(input: InjectionsInput, baseline: readonly RequestMessage[]): RequestPrompt {
	const hiddenTools = input.snapshot.hiddenTools ?? [];
	const base = getCurrentSystemMessage(baseline);
	if (base === undefined) {
		const native = buildNativeSnapshot({
			...input, options: { ...input.options, hiddenTools: [...hiddenTools] }, forcedPrompt: input.snapshot.forcedPrompt,
		});
		return { items: native.groups.flatMap((group) => group.items), hiddenTools: native.hiddenTools ?? [] };
	}
	const request = applySystemChanges(base, input.snapshot.changes.system);
	const declarations = splitHiddenTools(request.declarations, hiddenTools);
	const forced = input.snapshot.forcedPrompt;
	const tools: ToolSlice[] = [
		...replayedToolSlices(request.state, declarations.declared, input.allTools)
			.map((tool) => withToolChange(tool, request.tools.get(tool.name))),
		...replayedToolSlices(base, request.deletedTools, input.allTools)
			.map((tool) => withToolChange(tool, "deleted")),
	];
	const items = markForcedPrompt(analyzeSystemPrompt(
		forced ?? systemMessageText(request.state),
		{ homeDir: process.env.HOME, customPrompt: input.options.customPrompt },
		tools,
		{ sources: input.promptSources },
		forced === undefined ? request.prompt : {},
	), forced);
	return { items, hiddenTools: declarations.hiddenNames };
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
				return { id, kind: "message", source, label: "message", chars: 0, tokens: 0, text: "", change: "deleted" };
			}
			return { ...messageItem(id, original, source), chars: 0, tokens: 0, change: "deleted" };
		}
	}
}

// ============================================================================
// Payload changes
// ============================================================================

/**
 * One item per payload change, in the payload-changes group. The guard keeps only the
 * changed lines, so each item counts the lines the payload added; a deletion
 * reads 0 tokens.
 */
function measurePayloadChanges(findings: readonly GuardFinding[]): InjectionItem[] {
	return findings.map((finding, index): InjectionItem => {
		const text = finding.lines.filter((line) => line.type === "added").map((line) => line.text).join("\n");
		return {
			id: `payload:${index}`,
			kind: finding.type === "payload-change" ? "message" : "tool",
			source: PAYLOAD_CHANGES_SOURCE,
			label: finding.type === "payload-change" ? PAYLOAD_CHANGE_LABELS[finding.part] : finding.name,
			chars: text.length,
			tokens: textTokens(text),
			text,
			change: finding.change,
			changedLines: finding.lines,
		};
	});
}

/** A measured message with its content-only preview. */
function messageItem(id: string, message: RequestMessage, source: InjectionSource, redacted = false): InjectionItem {
	const { text, jsonSpan } = messagePreview(message, redacted);
	return {
		id,
		kind: "message",
		source,
		label: message.role === "custom" ? "message" : `${message.role} message`,
		chars: text.length,
		tokens: estimateTokens(message),
		text,
		jsonSpan,
	};
}
