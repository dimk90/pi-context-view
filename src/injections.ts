/**
 * Injections composition from a request snapshot: the session projection at
 * the snapshot's leaf, rebuilt when the view opens, with the snapshot's
 * request-only changes marked and hidden tools left out, plus the payload
 * guard's payload changes. Every contribution carries the tokens it gained and
 * lost against its base. Messages and payload changes each form one
 * `unattributed` row. Reads the snapshot and current Pi data only; imports no
 * capture or probe module.
 */
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
	type BuildSystemPromptOptions,
	estimateTokens,
	type SessionEntry,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import {
	analyzeSystemPrompt,
	isPiPromptPart,
	SYSTEM_PROMPT_ITEM_ID,
	textTokens,
	type ToolSlice,
} from "./measure.ts";
import { messagePreview } from "./message-preview.ts";
import {
	AGGREGATE_SOURCE,
	buildSnapshot,
	type InjectedReference,
	type InjectionItem,
	type InjectionSection,
	type InjectionSnapshot,
	type RequestChange,
	sumTokenDiffs,
	type TokenDiff,
} from "./model.ts";
import { type MessageFilter, type ProjectedMessage, readProjection } from "./projection.ts";
import type { PromptSourceSlice } from "./prompt-additions.ts";
import {
	applySystemChanges,
	buildNativeSnapshot,
	markForcedPrompt,
	type NativeSnapshotInput,
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
import { buildSystemPromptRows, partEditors } from "./system-prompt-rows.ts";
import { type DiffSide, measureTokenDiff } from "./token-diff.ts";
import { type SystemMessage, systemMessageText } from "./transcript.ts";

/** Row label of a payload change, by the message part it changed. */
const PAYLOAD_CHANGE_LABELS: Readonly<Record<MessagePart, string>> = {
	system: "system message",
	user: "user message",
	assistant: "assistant message",
	"tool-call": "tool call",
	"tool-result": "tool result",
};

/** Session aggregates backing prompt parts when a request replaces or deletes their generated sections. */
const GENERATED_RECORD_ITEMS: Readonly<Record<string, string>> = {
	"base-prompt:context-files": "context-files",
	"base-prompt:skills": "skills",
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
 * then one row for custom messages and message changes and one for the
 * guard's payload changes. The tools Pi hid are left out; their names supply
 * the description note.
 */
export function buildInjectionsSnapshot(input: InjectionsInput): InjectionSnapshot {
	const baseline = readProjection(input.entries, input.snapshot.leafId, input.filterMessages);
	const findings = guardFindings(input.snapshot.guard);
	const prompt = measureRequestPrompt(input, baseline.map(({ message }) => message));
	const items = [
		...prompt.items,
		...measureMessages(input, baseline),
		...measurePayloadChanges(findings),
	];
	return { ...buildSnapshot(items), hiddenTools: prompt.hiddenTools };
}

/**
 * The degraded fallback without a request snapshot: the live prompt and tools,
 * compared with pi's default prompt like a captured request.
 */
export function buildFallbackInjectionsSnapshot(input: NativeSnapshotInput): InjectionSnapshot {
	const native = measureNativePrompt(input);
	return { ...buildSnapshot(withPromptDiffs(native.items, native.items)), hiddenTools: native.hiddenTools };
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
	const forced = input.snapshot.forcedPrompt;
	if (base === undefined) {
		const live = { ...input, options: { ...input.options, hiddenTools: [...hiddenTools] } };
		const native = measureNativePrompt({ ...live, forcedPrompt: forced });
		const session = forced === undefined ? native : measureNativePrompt(live);
		return { items: withPromptDiffs(native.items, session.items), hiddenTools: native.hiddenTools };
	}
	const request = applySystemChanges(base, input.snapshot.changes.system);
	const declarations = splitHiddenTools(request.declarations, hiddenTools);
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
	return {
		items: withPromptDiffs(items, measureSessionPrompt(input, base, hiddenTools)),
		hiddenTools: declarations.hiddenNames,
	};
}

/**
 * The session's prompt and tools at the snapshot's leaf, measured like the
 * request but without its changes: the base the request's prompt and tool
 * rows compare with.
 */
function measureSessionPrompt(
	input: InjectionsInput,
	base: SystemMessage,
	hiddenTools: readonly string[],
): InjectionItem[] {
	const session = applySystemChanges(base, []);
	const declared = splitHiddenTools(session.declarations, hiddenTools).declared;
	return analyzeSystemPrompt(
		systemMessageText(session.state),
		{ homeDir: process.env.HOME, customPrompt: input.options.customPrompt },
		replayedToolSlices(session.state, declared, input.allTools),
		{ sources: input.promptSources },
		{ replayed: session.prompt.replayed },
	);
}

/** Live prompt and tool items without recorded system state, and the tools Pi hid. */
function measureNativePrompt(input: NativeSnapshotInput): RequestPrompt {
	const native = buildNativeSnapshot(input);
	return { items: native.groups.flatMap((group) => group.items), hiddenTools: native.hiddenTools ?? [] };
}

/** The slice with a request-only change, or unchanged when there is none. */
function withToolChange(tool: ToolSlice, change: RequestChange | undefined): ToolSlice {
	return change === undefined ? tool : { ...tool, change };
}

// ============================================================================
// Messages
// ============================================================================

/** A conversation change that references the session message it replaces or removes. */
type EntryChange = Extract<ConversationChange, { readonly type: "modified" | "deleted" }>;

/** One message's preview part and whether the request sent it. */
interface MeasuredMessage {
	readonly section: InjectionSection;
	readonly sent: boolean;
}

/**
 * One `messages (N)` row for the session's custom messages and every
 * conversation change, or none without either. Its parts follow the session's
 * order, a modified or deleted message in place of its session original, then
 * additions, which carry no position, in capture order. `N` counts the
 * messages the request sent, so deletions are left out.
 */
function measureMessages(input: InjectionsInput, baseline: readonly ProjectedMessage[]): InjectionItem[] {
	const changes = input.snapshot.changes.conversation;
	const prompts = userPromptNumbers(input);
	const requestPrompt = input.snapshot.leafId === null ? undefined : prompts.get(input.snapshot.leafId);
	const targets = new Map<ProjectedMessage, EntryChange>();
	const unplaced: ConversationChange[] = [];
	for (const change of changes) {
		// An entry rarely holds more than one conversation message; take the first one not yet changed
		const target = change.type === "added" ? undefined : baseline.find((candidate) =>
			candidate.entryId === change.entryId && candidate.message.role !== "system" && !targets.has(candidate));
		if (target === undefined || change.type === "added") unplaced.push(change);
		else targets.set(target, change);
	}
	const messages: MeasuredMessage[] = [];
	for (const entry of baseline) {
		const change = targets.get(entry);
		const userPrompt = prompts.get(entry.entryId);
		if (change !== undefined) messages.push(changedMessagePart(change, entry.message, userPrompt));
		else if (entry.message.role === "custom") {
			messages.push({ section: { ...messageSection(entry.message), message: { userPrompt } }, sent: true });
		}
	}
	messages.push(...unplaced.map((change) => changedMessagePart(change, undefined, requestPrompt)));
	return messages.length === 0 ? [] : [createMessagesItem(messages)];
}

/**
 * Prompt counts on the snapshot's whole root-to-leaf branch, before compaction
 * and context omissions. Probe identities are excluded. Walking parent links
 * leaves out abandoned branches and entries appended after capture.
 */
function userPromptNumbers(input: InjectionsInput): Map<string, number> {
	const byId = new Map(input.entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	let entry = input.snapshot.leafId === null ? undefined : byId.get(input.snapshot.leafId);
	while (entry !== undefined) {
		branch.push(entry);
		entry = entry.parentId === null ? undefined : byId.get(entry.parentId);
	}
	const numbers = new Map<string, number>();
	let count = 0;
	for (const entry of branch.reverse()) {
		if (entry.type === "message" && entry.message.role === "user"
			&& input.filterMessages([entry.message]).length > 0) count++;
		if (count > 0) numbers.set(entry.id, count);
	}
	return numbers;
}

/** The one messages row: the sent messages' estimates and diffs, and every message's part. */
function createMessagesItem(messages: readonly MeasuredMessage[]): InjectionItem {
	const sections = messages.map((message) => message.section);
	const text = messages.filter((message) => message.sent).map((message) => message.section.text).join("\n\n");
	const diff = sumTokenDiffs(sections.map((section) => section.diff));
	return {
		id: "messages",
		kind: "message",
		source: AGGREGATE_SOURCE,
		label: `messages (${messages.filter((message) => message.sent).length})`,
		chars: text.length,
		tokens: sections.reduce((sum, section) => sum + section.tokens, 0),
		text,
		sections,
		...diffField(diff),
		...(sections.some((section) => section.requestOnly === true) ? { requestOnly: true } : {}),
	};
}

/**
 * One request-only message part with its token diff against the session.
 * A modification keeps its redacted original for a preview-only word diff;
 * a deletion reads 0 tokens and shows its original as removed text.
 */
function changedMessagePart(
	change: ConversationChange,
	original: RequestMessage | undefined,
	userPrompt: number | undefined,
): MeasuredMessage {
	switch (change.type) {
		case "added": {
			const section = messageSection(change.message, true);
			const diff = measureTokenDiff(undefined, section);
			return {
				section: { ...section, change: "added", requestOnly: true, message: { userPrompt }, ...diffField(diff) },
				sent: true,
			};
		}
		case "modified": {
			const request = { ...messageSection(change.message, true), change: "modified" as const, requestOnly: true,
				message: { userPrompt } };
			if (original === undefined) return { section: request, sent: true };
			const session = messageSection(original);
			const diff = measureTokenDiff(session, request);
			return {
				section: { ...request, ...diffField(diff),
					message: { userPrompt, original: { text: session.text, jsonSpan: session.jsonSpan } } },
				sent: true,
			};
		}
		case "deleted": {
			const deleted = { change: "deleted" as const, requestOnly: true, message: { userPrompt } };
			if (original === undefined) {
				return { section: { label: change.attribution.customType ?? "message", text: "", tokens: 0, ...deleted },
					sent: false };
			}
			const session = messageSection(original);
			const diff = measureTokenDiff(session, { text: "", tokens: 0 });
			return { section: { ...session, tokens: 0, ...deleted, ...diffField(diff) }, sent: false };
		}
	}
}

/** One message as a preview part: labeled by its customType or role, with its content-only preview. */
function messageSection(message: RequestMessage, redacted = false): InjectionSection {
	const { text, jsonSpan } = messagePreview(message, redacted);
	return {
		label: message.role === "custom" ? message.customType : message.role,
		text,
		tokens: estimateTokens(message),
		...(jsonSpan === undefined ? {} : { jsonSpan }),
	};
}

// ============================================================================
// Payload changes
// ============================================================================

/**
 * One `payload changes (N)` row with one part per finding, in the guard's
 * order, or none without findings. `N` counts every finding, deletions
 * included. The guard keeps only the changed lines, so each part counts the
 * lines the payload added, and a deletion reads 0 tokens. Its token diff
 * compares the added lines with the removed ones, the lines of the captured
 * request.
 */
function measurePayloadChanges(findings: readonly GuardFinding[]): InjectionItem[] {
	if (findings.length === 0) return [];
	const sections = findings.map((finding): InjectionSection => {
		const text = finding.lines.filter((line) => line.type === "added").map((line) => line.text).join("\n");
		const removed = finding.lines.filter((line) => line.type === "removed").map((line) => line.text).join("\n");
		const base = removed.length === 0 ? undefined : { text: removed, tokens: textTokens(removed) };
		const tokens = textTokens(text);
		return {
			label: finding.type === "payload-change" ? PAYLOAD_CHANGE_LABELS[finding.part] : finding.name,
			text,
			tokens,
			...diffField(measureTokenDiff(base, { text, tokens })),
			...(finding.type === "payload-tool-change" ? { toolDeclaration: true } : {}),
			changedLines: finding.lines,
		};
	});
	const text = sections.map((section) => section.text).filter((part) => part.length > 0).join("\n");
	return [{
		id: "payload-changes",
		kind: "payload-change",
		source: AGGREGATE_SOURCE,
		label: `payload changes (${findings.length})`,
		chars: text.length,
		tokens: sections.reduce((sum, section) => sum + section.tokens, 0),
		text,
		sections,
		...diffField(sumTokenDiffs(sections.map((section) => section.diff))),
	}];
}

// ============================================================================
// Token diffs
// ============================================================================

/**
 * Prompt and tool items with the tokens each gained and lost against its base.
 * Rows under pi compare with pi's default prompt: the session's version of a
 * pi part without the extension lines measured in it, so saved and
 * request-only extension text both count as added. A custom section and
 * Extension Additions are extension text with no default; a deleted custom
 * section compares with the session instead, so its deletion stays visible.
 * Tools, instruction files, and skills compare with the session. A parent sums
 * its children, plus the removal of children only the session has. Each leaf
 * also learns whether it is request-only, and each System Prompt part whether
 * the session saves part of its diff and who made it. The `system prompt` rows
 * that split these prompt changes by source follow the items.
 */
function withPromptDiffs(items: readonly InjectionItem[], session: readonly InjectionItem[]): InjectionItem[] {
	const sessionById = new Map<string, InjectionItem>();
	for (const item of session) {
		sessionById.set(item.id, item);
		for (const child of item.children ?? []) sessionById.set(child.id, child);
	}
	const context: DiffContext = {
		sessionById,
		sessionItems: session,
		sentIds: new Set(items.map((item) => item.id)),
		forced: items.some((item) => item.id === SYSTEM_PROMPT_ITEM_ID && item.change === "forced"),
	};
	const diffed = items.map((item) => withItemDiff(item, context, false));
	return [...diffed, ...buildSystemPromptRows(diffed, session)];
}

/** The session's prompt and tool items that request items compare with. */
interface DiffContext {
	/** Session items and their children, by id. */
	readonly sessionById: ReadonlyMap<string, InjectionItem>;
	/** Top-level session items, which an undivided System Prompt compares with. */
	readonly sessionItems: readonly InjectionItem[];
	/** Ids of the request's top-level items. */
	readonly sentIds: ReadonlySet<string>;
	/** True when the request carried a forced prompt, whose text the session never keeps. */
	readonly forced: boolean;
}

/**
 * One item with its diff and, for a leaf, its request-only state; `promptPart`
 * marks a System Prompt part. Its sections mirror its children one to one, so
 * preview subheaders show the same diffs and markers as the rows.
 */
function withItemDiff(item: InjectionItem, context: DiffContext, promptPart: boolean): InjectionItem {
	if (item.dropped === true) return item;
	const children = item.children ?? [];
	if (children.length === 0) {
		const base = itemBase(item, context, promptPart);
		const request: DiffSide = item.change === "deleted" ? { text: "", tokens: 0 } : item;
		const requestOnly = isRequestOnly(item, context);
		const diffed: InjectionItem = {
			...item,
			...diffField(measureTokenDiff(base, request)),
			...(requestOnly ? {
				requestOnly: true,
				sessionOriginal: context.sessionById.has(item.id) || base !== undefined,
			} : {}),
		};
		if (!promptPart) return diffed;
		const editors = partEditors(diffed);
		return {
			...diffed,
			...(hasSavedChange(item, base, context) ? { savedChange: true } : {}),
			...(editors === undefined ? {} : { editors }),
		};
	}
	const parts = item.id === SYSTEM_PROMPT_ITEM_ID;
	const diffed = children.map((child) => withItemDiff(child, context, parts));
	const sent = new Set(children.map((child) => child.id));
	const sessionOnly = (context.sessionById.get(item.id)?.children ?? []).filter((child) => !sent.has(child.id));
	const diff = sumTokenDiffs([
		...diffed.map((child) => child.diff),
		...sessionOnly.map((child) => removedDiff(defaultSide(child, parts))),
	]);
	return {
		...item,
		...diffField(diff),
		children: diffed,
		sections: item.sections?.map((section, index) => ({
			...section,
			...diffField(diffed[index]?.diff),
			...(diffed[index]?.requestOnly === true ? { requestOnly: true } : {}),
		})),
	};
}

/**
 * Whether the request sent other content than the session keeps for one leaf:
 * a request-only addition, edit, or deletion, or forced prompt text that
 * differs from the session's version. Generated instruction files and skills
 * compare their child text with the session too: section changes mark the
 * aggregate, not its individual records. Tool changes reach a forced prompt
 * as usual, and the undivided System Prompt carries only its `forced` change.
 */
function isRequestOnly(item: InjectionItem, context: DiffContext): boolean {
	if (item.change !== undefined && item.change !== "forced") return true;
	if (item.kind === "tool" || item.id === SYSTEM_PROMPT_ITEM_ID) return false;
	if (!context.forced && item.kind !== "context-file" && item.kind !== "skills") return false;
	return context.sessionById.get(item.id)?.text !== item.text;
}

/**
 * Whether the session's own version of a System Prompt part already differs
 * from the part's base, so the session saves part of its diff: extension
 * lines in a pi part, or an extension's own part the session keeps. A
 * deletion compares with the session, so none of it is saved.
 */
function hasSavedChange(item: InjectionItem, base: DiffSide | undefined, context: DiffContext): boolean {
	if (item.change === "deleted") return false;
	const session = context.sessionById.get(item.id);
	if (session === undefined || session.dropped === true) return false;
	return base === undefined || base.text !== session.text;
}

/**
 * What one request item compares with: pi's default text of a pi part, no
 * base for an extension's own part unless the request deleted it, pi's whole
 * default prompt for an undivided System Prompt, or the session's version of
 * anything else. Undefined counts the whole item as added.
 */
function itemBase(item: InjectionItem, context: DiffContext, promptPart: boolean): DiffSide | undefined {
	if (item.id === SYSTEM_PROMPT_ITEM_ID) return defaultPromptSide(context);
	// A generated section changes into a prompt part when replaced or deleted
	const recordId = GENERATED_RECORD_ITEMS[item.id];
	const records = recordId === undefined ? undefined : context.sessionById.get(recordId);
	if (promptPart && records !== undefined) return records;
	const session = context.sessionById.get(item.id);
	if (promptPart && !isPiPromptPart(item.id)) {
		if (item.change !== "deleted") return undefined;
		return session ?? { text: item.text, tokens: textTokens(item.text) };
	}
	return session === undefined ? undefined : defaultSide(session, promptPart);
}

/**
 * What pi's default prompt holds of one session item: a pi part without the
 * extension lines in it, nothing of an extension's own part or of a part a
 * replacement dropped, and any other item whole.
 */
function defaultSide(item: InjectionItem, promptPart: boolean): DiffSide | undefined {
	if (item.dropped === true) return undefined;
	if (!promptPart) return item;
	if (!isPiPromptPart(item.id)) return undefined;
	const references = item.injectedReferences ?? [];
	if (references.length === 0) return item;
	const text = withoutReferences(item.text, references);
	return { text, tokens: textTokens(text) };
}

/**
 * Pi's whole default prompt, for a System Prompt without parts, such as a
 * forced prompt without sections: the default text of every session part, and
 * the instruction files and skills the request does not list separately.
 */
function defaultPromptSide(context: DiffContext): DiffSide | undefined {
	const prompt = context.sessionById.get(SYSTEM_PROMPT_ITEM_ID);
	if (prompt === undefined) return undefined;
	const parts = prompt.children?.map((part) => defaultSide(part, true)) ?? [prompt];
	const records = context.sessionItems.filter((item) =>
		(item.kind === "context-file" || item.kind === "skills") && !context.sentIds.has(item.id));
	const sides = [...parts, ...records].filter((side): side is DiffSide => side !== undefined && side.text.length > 0);
	return {
		text: sides.map((side) => side.text).join("\n"),
		tokens: sides.reduce((sum, side) => sum + side.tokens, 0),
	};
}

/** Text without the extension lines its references cover. */
function withoutReferences(text: string, references: readonly InjectedReference[]): string {
	let kept = "";
	let offset = 0;
	for (const reference of [...references].sort((a, b) => a.start - b.start)) {
		kept += text.slice(offset, reference.start);
		offset = Math.max(offset, reference.end);
	}
	return kept + text.slice(offset);
}

/** The removal of a whole base, or undefined when there is none. */
function removedDiff(base: DiffSide | undefined): TokenDiff | undefined {
	return base === undefined ? undefined : measureTokenDiff(base, { text: "", tokens: 0 });
}

/** `{ diff }` when there is one, so unchanged items carry no extra key. */
function diffField(diff: TokenDiff | undefined): { readonly diff?: TokenDiff } {
	return diff === undefined ? {} : { diff };
}
