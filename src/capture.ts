/**
 * Initial capture state and conversion from pi event data to the semantic
 * model. Event registration remains in index.ts; this module is independently
 * unit-testable.
 */
import {
	type BuildSystemPromptOptions,
	type ContextEvent,
	estimateTokens,
	type SlashCommandInfo,
	type SourceInfo,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";

import { analyzeSystemPrompt, type PromptOptionsSlice, textTokens } from "./measure.ts";
import { messagePreview } from "./message-preview.ts";
import { copySystemMessage, systemMessageText } from "./transcript.ts";
import {
	AGGREGATE_SOURCE,
	buildSnapshot,
	type InitialSnapshot,
	type InjectionItem,
	messageTypeSource,
} from "./model.ts";
import type { PromptSourceSlice } from "./prompt-additions.ts";
import {
	buildNativeSnapshot,
	captureActiveTools,
	copyPromptOptions,
	type NativeSnapshotInput,
	replayedToolSlices,
} from "./replay.ts";
import type { CaptureOrigin } from "./snapshot.ts";

/** Everything available when the first context event finalizes a snapshot. */
export interface CaptureFinalization {
	systemPrompt: string;
	messages: ContextEvent["messages"];
	baselineMessages: ContextEvent["messages"];
	allTools: readonly ToolInfo[];
	activeToolNames: readonly string[];
	/** Loaded extension provenance, used only to guess who appended prompt text. */
	promptSources?: readonly PromptSourceSlice[];
	origin: CaptureOrigin;
	capturedAt?: Date;
}

/** Owned structured inputs prepared before later extension handlers can mutate shared event data. */
interface CapturePreparation {
	readonly promptOptions: PromptOptionsSlice;
	readonly toolSnippets?: Readonly<Record<string, string>>;
	/** Prompt as of this extension's own handler, bounding later extensions' additions. */
	readonly promptAtHandler?: string;
}

/**
 * Capture-once state machine. `prepare()` refreshes the structured options on
 * every run until `finalize()` succeeds; subsequent finalizations return the
 * original snapshot unchanged.
 */
export class InitialCaptureState {
	private pendingPreparation: CapturePreparation | undefined;
	private initialSnapshot: InitialSnapshot | undefined;

	/** The frozen Initial snapshot, or undefined until `finalize()` succeeds. */
	public get snapshot(): InitialSnapshot | undefined {
		return this.initialSnapshot;
	}

	/**
	 * Own the structured prompt inputs from `before_agent_start`; no-op once
	 * frozen. `promptAtHandler` is the chained prompt as this extension observed
	 * it, which separates additions made before this extension loaded from those
	 * made after it.
	 */
	public prepare(options: BuildSystemPromptOptions, promptAtHandler?: string): void {
		if (this.initialSnapshot !== undefined) return;
		this.pendingPreparation = {
			promptOptions: copyPromptOptions(options),
			toolSnippets: options.toolSnippets === undefined ? undefined : { ...options.toolSnippets },
			promptAtHandler,
		};
	}

	/**
	 * Freeze the Initial snapshot from the first context event. Returns the
	 * existing snapshot on repeat calls, or undefined when `prepare()` never ran.
	 * `buildInput` runs only on the call that freezes, so callers may collect
	 * expensive inputs there without paying for them once per later event.
	 */
	public finalize(buildInput: () => CaptureFinalization): InitialSnapshot | undefined {
		if (this.initialSnapshot !== undefined) return this.initialSnapshot;
		if (this.pendingPreparation === undefined) return undefined;

		const input = buildInput();
		const preparation = this.pendingPreparation;
		const tools = captureActiveTools(input.allTools, input.activeToolNames, {
			toolSnippets: preparation.toolSnippets,
		});
		const items = [
			...analyzeSystemPrompt(input.systemPrompt, preparation.promptOptions, tools, {
				sources: input.promptSources,
				promptAtHandler: preparation.promptAtHandler,
			}),
			...measureInjectedMessages(input.messages, input.baselineMessages),
		];
		this.initialSnapshot = buildSnapshot(items, input.origin, input.capturedAt ?? new Date());
		this.pendingPreparation = undefined;
		return this.initialSnapshot;
	}
}

/** Inputs for Usage's branch-local prompt/tool estimate and frozen request-only patches. */
export interface UsageSnapshotInput extends NativeSnapshotInput {
	messages: ContextEvent["messages"];
	initial: InitialSnapshot;
}

/**
 * Use replayed transcript state instead of today's loader prompt/tools when available.
 * Request-only system patches remain frozen like other Initial injections; they are
 * applied once here and never counted again as ordinary messages.
 */
export function buildUsageSnapshot(input: UsageSnapshotInput): InitialSnapshot {
	const patches = input.initial.groups.flatMap((group) => group.items)
		.filter((item) => item.requestOnly === true && item.systemMessage !== undefined)
		.flatMap((item) => item.systemMessage === undefined ? [] : [item.systemMessage])
		.sort((a, b) => a.index - b.index).map((entry) => entry.message);
	// Undefined means a branch with no recorded system message yet, not an explicitly empty state
	const state = getCurrentSystemMessage([...input.messages, ...patches]);
	if (state === undefined) return mergeRequestOnlyMessages(buildNativeSnapshot(input), input.initial);
	const tools = replayedToolSlices(state, state.toolsAdded ?? [], input.allTools);
	const options = copyPromptOptions(input.options);
	const items = analyzeSystemPrompt(systemMessageText(state), {
		...options,
		// Current loader overrides are not evidence of what this branch recorded.
		customPrompt: undefined, sections: undefined,
	}, tools, { sources: input.promptSources });
	const snapshot = buildSnapshot(items, "synthetic-probe", input.capturedAt ?? new Date());
	return mergeRequestOnlyMessages(snapshot, input.initial);
}

/** Add frozen non-system request-only messages to a current prompt/tool snapshot for Usage. */
export function mergeRequestOnlyMessages(
	snapshot: InitialSnapshot,
	initial: InitialSnapshot,
): InitialSnapshot {
	const requestOnly = initial.groups.flatMap((group) =>
		group.items.filter((item) => item.kind === "message" && item.requestOnly === true && item.systemMessage === undefined)
	);
	if (requestOnly.length === 0) return snapshot;
	const items = [
		...snapshot.groups.flatMap((group) => group.items),
		...requestOnly,
	];
	return buildSnapshot(items, snapshot.origin, snapshot.capturedAt);
}

/**
 * Collect the provenance of every loaded extension that registered a tool or a
 * command, together with the names it registered. It is the only extension
 * roster pi exposes, and it feeds attribution guesses alone: extensions
 * registering neither are invisible here.
 */
export function collectPromptSources(
	allTools: readonly ToolInfo[],
	commands: readonly SlashCommandInfo[],
): PromptSourceSlice[] {
	const sources = new Map<string, CollectedPromptSource>();
	for (const tool of allTools) addPromptSource(sources, tool.sourceInfo, tool.name);
	// Prompt text refers to a command the way a user types it, so keep its slash.
	for (const command of commands) {
		addPromptSource(sources, command.sourceInfo, command.name.startsWith("/") ? command.name : `/${command.name}`);
	}
	return [...sources.values()];
}

/** Slice under construction: its names arrive one tool or command at a time. */
interface CollectedPromptSource extends Omit<PromptSourceSlice, "names"> {
	readonly names: string[];
}

/** Record one registered name under its extension's provenance, skipping pi's own sources. */
function addPromptSource(
	sources: Map<string, CollectedPromptSource>,
	sourceInfo: SourceInfo,
	name: string,
): void {
	if (sourceInfo.source === "builtin" || sourceInfo.source === "sdk") return;
	const key = `${sourceInfo.source}\n${sourceInfo.path}`;
	let collected = sources.get(key);
	if (collected === undefined) {
		collected = {
			source: sourceInfo.source,
			path: sourceInfo.path,
			// A top-level extension's baseDir is a shared directory, not its own root.
			baseDir: sourceInfo.origin === "package" ? sourceInfo.baseDir : undefined,
			names: [],
		};
		sources.set(key, collected);
	}
	if (!collected.names.includes(name)) collected.names.push(name);
}

/**
 * Measure extension messages while excluding ordinary session history. Custom
 * messages remain attributable by customType; other roles are captured only
 * when they differ from the session-branch baseline.
 */
export function measureInjectedMessages(
	messages: ContextEvent["messages"],
	baselineMessages: ContextEvent["messages"],
): InjectionItem[] {
	const baseline = messageSignatureCounts(baselineMessages);
	const occurrences = new Map<string, number>();
	const items: InjectionItem[] = [];
	for (const [index, message] of messages.entries()) {
		const requestOnly = !consumeMessageSignature(baseline, message);
		if (message.role !== "custom" && !requestOnly) continue;

		const identity = message.role === "custom" ? message.customType : message.role;
		const occurrence = occurrences.get(identity) ?? 0;
		occurrences.set(identity, occurrence + 1);
		const { text, jsonSpan } = messagePreview(message);
		items.push({
			id: message.role === "custom"
				? `message:${message.customType}:${occurrence}`
				: `message:context:${message.role}:${occurrence}`,
			phase: "initial",
			kind: "message",
			source: message.role === "custom" ? messageTypeSource(message.customType) : AGGREGATE_SOURCE,
			label: message.role === "custom" ? "message" : `${message.role} message`,
			chars: text.length,
			tokens: message.role === "system" ? textTokens(systemMessageText(message)) : estimateTokens(message),
			text,
			jsonSpan,
			requestOnly: requestOnly || undefined,
			systemMessage: message.role === "system" ? { message: copySystemMessage(message), index } : undefined,
		});
	}
	return items;
}

/** Count structurally identical baseline messages for order-independent diffing. */
function messageSignatureCounts(messages: ContextEvent["messages"]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const message of messages) {
		const signature = JSON.stringify(message);
		counts.set(signature, (counts.get(signature) ?? 0) + 1);
	}
	return counts;
}

/** Consume one matching baseline occurrence, returning false for a request-only message. */
function consumeMessageSignature(
	counts: Map<string, number>,
	message: ContextEvent["messages"][number],
): boolean {
	const signature = JSON.stringify(message);
	const count = counts.get(signature) ?? 0;
	if (count === 0) return false;
	if (count === 1) counts.delete(signature);
	else counts.set(signature, count - 1);
	return true;
}
