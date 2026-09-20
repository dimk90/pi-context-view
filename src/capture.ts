/**
 * Initial capture state and conversion from pi event data to the semantic
 * model. Event registration remains in index.ts; this module is independently
 * unit-testable.
 */
import {
	type BuildSystemPromptOptions,
	type ContextEvent,
	convertToLlm,
	estimateTokens,
	formatSize,
	type InputSource,
	type SlashCommandInfo,
	type SourceInfo,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import { analyzeSystemPrompt, type PromptOptionsSlice, textTokens, type ToolSlice } from "./measure.ts";
import { copySystemMessage, replaySystemMessages, systemMessageText } from "./transcript.ts";
import {
	AGGREGATE_SOURCE,
	buildSnapshot,
	type CaptureOrigin,
	type InitialSnapshot,
	type InjectionItem,
	type InjectionSource,
	type JsonSpan,
} from "./model.ts";
import { createProbeToken, type ProbeToken } from "./probe-token.ts";
import type { PromptSourceSlice } from "./prompt-additions.ts";

/** Session custom-entry type persisting probe message identities across extension runtimes. */
export const PROBE_IDENTITIES_CUSTOM_TYPE = "pi-context-view:probe-identities";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const SETUP_ABORT_ERROR_MESSAGE = "This operation was aborted";

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

/** Inputs for an on-demand pi-native prompt/tool snapshot. */
export interface NativeSnapshotInput {
	systemPrompt: string;
	options: BuildSystemPromptOptions;
	allTools: readonly ToolInfo[];
	activeToolNames: readonly string[];
	/** Loaded extension provenance, used only to guess who appended prompt text. */
	promptSources?: readonly PromptSourceSlice[];
	capturedAt?: Date;
}

/** Result of the one allowed silent-probe attempt. */
export type ProbeOutcome =
	| { readonly status: "captured" }
	| { readonly status: "failed"; readonly reason: string };

/** A probe start request; concurrent callers share `token` and `completion`. */
export interface ProbeAttempt {
	readonly started: boolean;
	/** Correlation token to send the synthetic prompt under. */
	readonly token: ProbeToken;
	readonly completion: Promise<ProbeOutcome>;
}

/** Exact identity used to remove only synthetic probe messages. */
export interface SyntheticMessageIdentity {
	readonly role: "user" | "assistant";
	readonly timestamp: number;
}

/** Owned structured inputs prepared before later extension handlers can mutate shared event data. */
interface CapturePreparation {
	readonly promptOptions: PromptOptionsSlice;
	readonly toolSnippets?: Readonly<Record<string, string>>;
	/** Prompt as of this extension's own handler, bounding later extensions' additions. */
	readonly promptAtHandler?: string;
}

/**
 * Lifecycle of the single probe attempt. Ownership outlives the attempt's own
 * completion, so a probe run arriving after a timeout or after an unattributed
 * run is still claimed, aborted, and sanitized.
 */
type ProbePhase = "idle" | "waiting" | "running" | "settled";

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

/** Tracks the observable compaction lifecycle that makes a silent probe unsafe. */
export class CompactionState {
	private currentSignal: AbortSignal | undefined;

	/** Whether a compaction observed through `session_before_compact` is still active. */
	public get isActive(): boolean {
		return this.currentSignal !== undefined && !this.currentSignal.aborted;
	}

	/** Track the current compaction until success, abort, or agent settlement. */
	public begin(signal: AbortSignal): void {
		if (signal.aborted) {
			this.currentSignal = undefined;
			return;
		}
		this.currentSignal = signal;
		signal.addEventListener("abort", () => {
			if (this.currentSignal === signal) this.currentSignal = undefined;
		}, { once: true });
	}

	/** Clear the current lifecycle after compaction can no longer reject prompts. */
	public finish(): void {
		this.currentSignal = undefined;
	}
}

/**
 * State for one on-demand silent probe. It owns the correlation token, the
 * timeout, and the exact synthetic message identities, but leaves pi API calls
 * and UI restoration to index.ts.
 */
export class SilentProbeState {
	private phase: ProbePhase = "idle";
	private readonly identities = new Map<string, SyntheticMessageIdentity>();
	private attempt: ProbeAttempt | undefined;
	private resolveCompletion: ((outcome: ProbeOutcome) => void) | undefined;
	private outcome: ProbeOutcome | undefined;
	private timeout: NodeJS.Timeout | undefined;

	/** True while the probe owns the in-flight agent run (including after a timeout). */
	public get isCurrentRun(): boolean {
		return this.phase === "running";
	}

	/** Defensive copies of the recorded probe message identities. */
	public get syntheticMessages(): readonly SyntheticMessageIdentity[] {
		return [...this.identities.values()].map((identity) => ({ ...identity }));
	}

	/**
	 * Merge probe identities persisted by an earlier extension runtime so prior
	 * probe messages stay excluded after resume/reload/fork. Restoration only
	 * seeds the identity map; it neither consumes this runtime's single probe
	 * attempt nor associates any run with the probe.
	 */
	public restoreIdentities(identities: readonly SyntheticMessageIdentity[]): void {
		for (const identity of identities) {
			this.identities.set(identityKey(identity), { role: identity.role, timestamp: identity.timestamp });
		}
	}

	/**
	 * Begin the one allowed probe attempt with a failure timeout. Repeat calls
	 * return the original attempt's completion with `started: false`.
	 */
	public start(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): ProbeAttempt {
		if (this.attempt !== undefined) {
			return { ...this.attempt, started: false };
		}

		this.phase = "waiting";
		const completion = new Promise<ProbeOutcome>((resolve) => {
			this.resolveCompletion = resolve;
		});
		this.timeout = setTimeout(() => {
			this.resolve({ status: "failed", reason: "Silent probe timed out." });
		}, timeoutMs);
		this.attempt = { started: true, token: createProbeToken(), completion };
		return this.attempt;
	}

	/**
	 * Whether this input event is the probe's own synthetic prompt. Recognition
	 * is causal rather than textual: the token is visible only inside the async
	 * context of this extension's own `sendUserMessage()` call.
	 */
	public isProbeInput(source: InputSource, token: ProbeToken | undefined): boolean {
		return this.phase === "waiting" && source === "extension" && this.ownsToken(token);
	}

	/**
	 * Claim the run this probe started, identified by the token it carries. A run
	 * without the token is not provably ours, so it fails the attempt instead of
	 * activating the abort guard: it may belong to the user or to another
	 * extension and must run untouched. Ownership stays open afterwards so a
	 * delayed probe run is still claimed.
	 */
	public beginRun(token: ProbeToken | undefined): boolean {
		if (this.phase !== "waiting") return false;
		if (!this.ownsToken(token)) {
			this.fail("Another agent run started before the silent probe was recognized.");
			return false;
		}
		this.phase = "running";
		return true;
	}

	/** Record probe user/assistant identities as their message events arrive. */
	public recordMessage(message: ContextEvent["messages"][number]): void {
		if (!this.isCurrentRun || (message.role !== "user" && message.role !== "assistant")) return;
		const identity = { role: message.role, timestamp: message.timestamp } satisfies SyntheticMessageIdentity;
		this.identities.set(identityKey(identity), identity);
	}

	/**
	 * Replace a recorded probe message with an artifact-free version, or return
	 * undefined to keep pi's own. Filtering keeps probe messages out of later
	 * model contexts; blanking keeps them out of the transcript.
	 */
	public sanitizeMessage(
		message: ContextEvent["messages"][number],
	): ContextEvent["messages"][number] | undefined {
		if (!this.isCurrentRun) return undefined;
		if (message.role === "user") return this.blankProbePrompt(message);
		if (message.role === "assistant") return this.blankProbeAbort(message);
		return undefined;
	}

	/** Remove only messages whose exact role+timestamp identity belongs to the probe. */
	public filterMessages(messages: ContextEvent["messages"]): ContextEvent["messages"] {
		if (this.identities.size === 0) return messages;
		return messages.filter((message) => {
			if (message.role !== "user" && message.role !== "assistant") return true;
			return !this.identities.has(identityKey(message));
		});
	}

	/** Resolve a running attempt from `agent_settled`. */
	public settle(captured: boolean): boolean {
		if (!this.isCurrentRun) return false;
		this.phase = "settled";
		this.resolve(
			captured
				? { status: "captured" }
				: { status: "failed", reason: "Silent probe settled without a context snapshot." },
		);
		return true;
	}

	/**
	 * End a pending attempt during shutdown or a synchronous startup failure.
	 * Ownership is untouched: only the attempt's own completion is resolved.
	 */
	public fail(reason: string): void {
		if (this.attempt === undefined) return;
		this.resolve({ status: "failed", reason });
	}

	/**
	 * Empty the synthetic prompt so no stored message keeps text another
	 * extension's input transform added to it.
	 */
	private blankProbePrompt(
		message: Extract<ContextEvent["messages"][number], { role: "user" }>,
	): ContextEvent["messages"][number] | undefined {
		if (message.content.length === 0 || !this.ownsMessage(message)) return undefined;
		return { ...message, content: [] };
	}

	/**
	 * Replace a recorded probe abort with an empty successful message so pi does
	 * not render an abort transcript row. Pi 0.84 reports an abort during stream
	 * setup as an error instead of the legacy aborted stop reason.
	 */
	private blankProbeAbort(
		message: Extract<ContextEvent["messages"][number], { role: "assistant" }>,
	): ContextEvent["messages"][number] | undefined {
		const isProbeAbort = message.stopReason === "aborted"
			|| (message.stopReason === "error" && message.errorMessage === SETUP_ABORT_ERROR_MESSAGE);
		if (!isProbeAbort || !this.ownsMessage(message)) return undefined;
		return { ...message, content: [], stopReason: "stop", errorMessage: undefined };
	}

	/** Whether this exact role and timestamp was recorded for the probe. */
	private ownsMessage(message: { role: "user" | "assistant"; timestamp: number }): boolean {
		return this.identities.has(identityKey({ role: message.role, timestamp: message.timestamp }));
	}

	/** Whether `token` identifies the current attempt. */
	private ownsToken(token: ProbeToken | undefined): boolean {
		return token !== undefined && token === this.attempt?.token;
	}

	/** Settle the completion promise exactly once and clear the timeout. */
	private resolve(outcome: ProbeOutcome): void {
		if (this.outcome !== undefined) return;
		if (this.timeout !== undefined) clearTimeout(this.timeout);
		this.timeout = undefined;
		this.outcome = outcome;
		const resolve = this.resolveCompletion;
		this.resolveCompletion = undefined;
		resolve?.(outcome);
	}
}

/**
 * Parse one persisted probe-identities entry payload. Malformed or foreign
 * records are ignored so a corrupt entry can never suppress genuine messages.
 */
export function parsePersistedIdentities(data: unknown): SyntheticMessageIdentity[] {
	if (typeof data !== "object" || data === null) return [];
	const messages = (data as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return [];
	const identities: SyntheticMessageIdentity[] = [];
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const { role, timestamp } = message as { role?: unknown; timestamp?: unknown };
		if ((role === "user" || role === "assistant") && typeof timestamp === "number" && Number.isFinite(timestamp)) {
			identities.push({ role, timestamp });
		}
	}
	return identities;
}

/** Build a view-local pi-native snapshot without freezing the main capture state. */
export function buildNativeSnapshot(input: NativeSnapshotInput): InitialSnapshot {
	const options = copyPromptOptions(input.options);
	const tools = captureActiveTools(input.allTools, input.activeToolNames, input.options);
	const items = analyzeSystemPrompt(input.systemPrompt, options, tools, { sources: input.promptSources });
	return buildSnapshot(items, "synthetic-probe", input.capturedAt ?? new Date());
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
	const state = replaySystemMessages([...input.messages, ...patches]);
	if (state === undefined) return mergeRequestOnlyMessages(buildNativeSnapshot(input), input.initial);
	const registered = new Map(input.allTools.map((tool) => [tool.name, tool]));
	const tools: ToolSlice[] = state.tools.map((tool) => {
		const metadata = registered.get(tool.name);
		const snippetLine = state.sections.tools?.split("\n").find((line) => line.startsWith(`- ${tool.name}: `));
		return {
			name: tool.name,
			description: tool.description,
			parametersJson: JSON.stringify(tool.parameters),
			snippet: snippetLine?.slice(`- ${tool.name}: `.length),
			guidelines: normalizeGuidelines(metadata?.promptGuidelines),
			source: metadata?.sourceInfo.source ?? "unattributed",
		};
	});
	const options = copyPromptOptions(input.options);
	const items = analyzeSystemPrompt(systemMessageText(state), {
		...options,
		// Current loader overrides are not evidence of what this branch recorded.
		customPrompt: undefined, appendSystemPrompt: undefined, sections: undefined,
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

/** Copy the prompt-options slice used by measurement, without shared nested references. */
export function copyPromptOptions(options: BuildSystemPromptOptions): PromptOptionsSlice {
	return {
		cwd: options.cwd,
		homeDir: process.env.HOME,
		customPrompt: options.customPrompt,
		appendSystemPrompt: options.appendSystemPrompt,
		sections: options.sections === undefined ? undefined : { ...options.sections },
		contextFilePaths: options.contextFiles?.map((file) => file.path),
		skills: options.skills
			?.filter((skill) => !skill.disableModelInvocation)
			.map((skill) => ({
				name: skill.name,
				description: skill.description,
				filePath: skill.filePath,
			})),
	};
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
 * Snapshot the final active tool set with provenance and payload definitions.
 * Keep pi's active-tool order: it decides which tool owns a guideline bullet
 * that several tools declare.
 */
export function captureActiveTools(
	allTools: readonly ToolInfo[],
	activeToolNames: readonly string[],
	options: { readonly toolSnippets?: Readonly<Record<string, string>> },
): ToolSlice[] {
	const byName = new Map(allTools.map((tool) => [tool.name, tool]));
	return [...new Set(activeToolNames)]
		.map((name) => byName.get(name))
		.filter((tool) => tool !== undefined)
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parametersJson: JSON.stringify(tool.parameters ?? {}),
			snippet: options.toolSnippets?.[tool.name],
			guidelines: normalizeGuidelines(tool.promptGuidelines),
			source: tool.sourceInfo.source,
		}));
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
			source: message.role === "custom" ? messageSource(message.customType) : AGGREGATE_SOURCE,
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

/** Provider-bound message content for raw preview, with any serialization marked as JSON. */
interface MessagePreview {
	readonly text: string;
	readonly jsonSpan?: JsonSpan;
}

/** Extract content-only previews without raw image payloads or opaque assistant signatures. */
function messagePreview(message: ContextEvent["messages"][number]): MessagePreview {
	if (message.role === "system") return { text: systemMessageText(message) };
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		return { text: message.summary };
	}
	if (message.role === "bashExecution") {
		const content = convertToLlm([message])[0]?.content ?? "";
		return {
			text: typeof content === "string"
				? content
				: content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n"),
		};
	}
	if (typeof message.content === "string") return { text: message.content };
	if (message.role === "assistant") {
		const content = message.content.map((block) => {
			if (block.type === "text") {
				const { textSignature, ...preview } = block;
				return preview;
			}
			if (block.type === "thinking") {
				const { thinkingSignature, ...preview } = block;
				return preview;
			}
			if (block.type === "toolCall") {
				const { thoughtSignature, ...preview } = block;
				return preview;
			}
			return block;
		});
		return serializedPreview(JSON.stringify(content));
	}
	return serializedPreview(JSON.stringify(message.content.map(imagePreviewBlock)));
}

/**
 * Replace a captured image payload with the size it occupied, so a preview
 * reports what the message carried without retaining or rendering its bytes.
 * Sizes measure the base64 text as captured, not the decoded image.
 */
function imagePreviewBlock<Block extends { readonly type: string }>(block: Block): Block {
	if (block.type !== "image") return block;
	const data = (block as { readonly data?: unknown }).data;
	if (typeof data !== "string") return block;
	return { ...block, data: `<${formatSize(data.length)} omitted>` };
}

/** Preview whose whole text is one serialized JSON document. */
function serializedPreview(text: string): MessagePreview {
	return { text, jsonSpan: { start: 0, end: text.length } };
}

/** Map key uniquely identifying one probe message by role and timestamp. */
function identityKey(identity: SyntheticMessageIdentity): string {
	return `${identity.role}:${identity.timestamp}`;
}

/** Attribute a custom-role message to its customType; the actual injector is unknowable. */
function messageSource(customType: string): InjectionSource {
	return { id: `message-type:${customType}`, label: customType, native: false };
}

/** Normalize the string-or-array promptGuidelines field to an owned array. */
function normalizeGuidelines(guidelines: string | string[] | undefined): string[] {
	if (guidelines === undefined) return [];
	return Array.isArray(guidelines) ? [...guidelines] : [guidelines];
}
