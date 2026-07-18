/**
 * Initial capture state and conversion from pi event data to the semantic
 * model. Event registration remains in index.ts; this module is independently
 * unit-testable.
 */
import {
	type BuildSystemPromptOptions,
	type ContextEvent,
	estimateTokens,
	type InputSource,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import { analyzeSystemPrompt, type PromptOptionsSlice, type ToolSlice } from "./measure.ts";
import {
	AGGREGATE_SOURCE_ID,
	buildSnapshot,
	type CaptureOrigin,
	type InitialSnapshot,
	type InjectionItem,
	type InjectionSource,
} from "./model.ts";

/** Session custom-entry type persisting probe message identities across extension runtimes. */
export const PROBE_IDENTITIES_CUSTOM_TYPE = "pi-context-view:probe-identities";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const AGGREGATE_SOURCE: InjectionSource = {
	id: AGGREGATE_SOURCE_ID,
	label: "extensions (aggregate)",
	native: false,
};

/** Everything available when the first context event finalizes a snapshot. */
export interface CaptureFinalization {
	systemPrompt: string;
	messages: ContextEvent["messages"];
	baselineMessages: ContextEvent["messages"];
	allTools: readonly ToolInfo[];
	activeToolNames: readonly string[];
	origin: CaptureOrigin;
	capturedAt?: Date;
}

/** Inputs for an on-demand pi-native prompt/tool snapshot. */
export interface NativeSnapshotInput {
	systemPrompt: string;
	options: BuildSystemPromptOptions;
	allTools: readonly ToolInfo[];
	activeToolNames: readonly string[];
	capturedAt?: Date;
}

/** Result of the one allowed silent-probe attempt. */
export type ProbeOutcome =
	| { readonly status: "captured" }
	| { readonly status: "failed"; readonly reason: string };

/** A probe start request; concurrent callers share `completion`. */
export interface ProbeAttempt {
	readonly started: boolean;
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
}

/** Lifecycle of the single probe attempt, including ownership retained after its completion times out. */
type ProbePhase =
	| "idle"
	| "waiting"
	| "waiting-after-timeout"
	| "running"
	| "running-after-timeout"
	| "failed"
	| "settled";

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

	/** Own the structured prompt inputs from `before_agent_start`; no-op once frozen. */
	public prepare(options: BuildSystemPromptOptions): void {
		if (this.initialSnapshot !== undefined) return;
		this.pendingPreparation = {
			promptOptions: copyPromptOptions(options),
			toolSnippets: options.toolSnippets === undefined ? undefined : { ...options.toolSnippets },
		};
	}

	/**
	 * Freeze the Initial snapshot from the first context event. Returns the
	 * existing snapshot on repeat calls, or undefined when `prepare()` never ran.
	 */
	public finalize(input: CaptureFinalization): InitialSnapshot | undefined {
		if (this.initialSnapshot !== undefined) return this.initialSnapshot;
		if (this.pendingPreparation === undefined) return undefined;

		const preparation = this.pendingPreparation;
		const tools = captureActiveTools(input.allTools, input.activeToolNames, {
			toolSnippets: preparation.toolSnippets,
		});
		const items = [
			...analyzeSystemPrompt(input.systemPrompt, preparation.promptOptions, tools),
			...measureInjectedMessages(input.messages, input.baselineMessages),
		];
		this.initialSnapshot = buildSnapshot(items, input.origin, input.capturedAt ?? new Date());
		this.pendingPreparation = undefined;
		return this.initialSnapshot;
	}
}

/**
 * State for one on-demand silent probe. It owns the timeout and exact synthetic
 * message identities, but leaves pi API calls and UI restoration to index.ts.
 */
export class SilentProbeState {
	private phase: ProbePhase = "idle";
	private inputObserved = false;
	private readonly identities = new Map<string, SyntheticMessageIdentity>();
	private completion: Promise<ProbeOutcome> | undefined;
	private resolveCompletion: ((outcome: ProbeOutcome) => void) | undefined;
	private outcome: ProbeOutcome | undefined;
	private timeout: NodeJS.Timeout | undefined;

	/** True while the probe owns the in-flight agent run (including after a timeout). */
	public get isCurrentRun(): boolean {
		return this.phase === "running" || this.phase === "running-after-timeout";
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
		if (this.completion !== undefined) {
			return { started: false, completion: this.completion };
		}

		this.phase = "waiting";
		this.completion = new Promise<ProbeOutcome>((resolve) => {
			this.resolveCompletion = resolve;
		});
		this.timeout = setTimeout(() => {
			if (this.phase === "waiting") {
				this.phase = "waiting-after-timeout";
			} else if (this.phase === "running") {
				this.phase = "running-after-timeout";
			}
			this.resolve({ status: "failed", reason: "Silent probe timed out." });
		}, timeoutMs);
		return { started: true, completion: this.completion };
	}

	/** Mark the exact extension-originated empty input that starts the probe. */
	public observeInput(source: InputSource, text: string): void {
		const awaitingInput = this.phase === "waiting" || this.phase === "waiting-after-timeout";
		if (awaitingInput && source === "extension" && text === "") this.inputObserved = true;
	}

	/** Associate the next matching lifecycle with the probe, not a real turn. */
	public beginRun(prompt: string): boolean {
		const ownsPendingInput = this.phase === "waiting" || this.phase === "waiting-after-timeout";
		if (!ownsPendingInput || !this.inputObserved || prompt !== "") return false;
		this.phase = this.phase === "waiting-after-timeout" ? "running-after-timeout" : "running";
		return true;
	}

	/** Record probe user/assistant identities as their message events arrive. */
	public recordMessage(message: ContextEvent["messages"][number]): void {
		if (!this.isCurrentRun || (message.role !== "user" && message.role !== "assistant")) return;
		const identity = { role: message.role, timestamp: message.timestamp } satisfies SyntheticMessageIdentity;
		this.identities.set(identityKey(identity), identity);
	}

	/**
	 * Replace only the probe's aborted assistant with an empty successful message
	 * so pi does not render an "Operation aborted" transcript row.
	 */
	public sanitizeAssistant(
		message: ContextEvent["messages"][number],
	): ContextEvent["messages"][number] | undefined {
		if (!this.isCurrentRun || message.role !== "assistant" || message.stopReason !== "aborted") {
			return undefined;
		}
		this.recordMessage(message);
		const identity = { role: "assistant", timestamp: message.timestamp } satisfies SyntheticMessageIdentity;
		if (!this.identities.has(identityKey(identity))) return undefined;
		return { ...message, content: [], stopReason: "stop", errorMessage: undefined };
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
		if (this.outcome === undefined) {
			this.resolve(
				captured
					? { status: "captured" }
					: { status: "failed", reason: "Silent probe settled without a context snapshot." },
			);
		}
		return true;
	}

	/** End a pending attempt during shutdown or a synchronous startup failure. */
	public fail(reason: string): void {
		if (this.completion === undefined || this.phase === "failed" || this.phase === "settled") return;
		this.phase = "failed";
		if (this.outcome === undefined) this.resolve({ status: "failed", reason });
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
	const items = analyzeSystemPrompt(input.systemPrompt, options, tools);
	return buildSnapshot(items, "synthetic-probe", input.capturedAt ?? new Date());
}

/** Add frozen context-only messages to a current prompt/tool snapshot for Usage. */
export function mergeContextOnlyMessages(
	snapshot: InitialSnapshot,
	initial: InitialSnapshot,
): InitialSnapshot {
	const contextOnly = initial.groups.flatMap((group) =>
		group.items.filter((item) => item.kind === "message" && item.contextOnly === true)
	);
	if (contextOnly.length === 0) return snapshot;
	const items = [
		...snapshot.groups.flatMap((group) => group.items),
		...contextOnly,
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

/** Snapshot the final active tool set with provenance and payload definitions. */
export function captureActiveTools(
	allTools: readonly ToolInfo[],
	activeToolNames: readonly string[],
	options: { readonly toolSnippets?: Readonly<Record<string, string>> },
): ToolSlice[] {
	const active = new Set(activeToolNames);
	return allTools
		.filter((tool) => active.has(tool.name))
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
	for (const message of messages) {
		const contextOnly = !consumeMessageSignature(baseline, message);
		if (message.role !== "custom" && !contextOnly) continue;

		const identity = message.role === "custom" ? message.customType : message.role;
		const occurrence = occurrences.get(identity) ?? 0;
		occurrences.set(identity, occurrence + 1);
		const text = messageText(message);
		items.push({
			id: message.role === "custom"
				? `message:${message.customType}:${occurrence}`
				: `message:context:${message.role}:${occurrence}`,
			phase: "initial",
			kind: "message",
			source: message.role === "custom" ? messageSource(message.customType) : AGGREGATE_SOURCE,
			label: message.role === "custom" ? "message" : `${message.role} message`,
			chars: text.length,
			tokens: estimateTokens(message),
			text,
			contextOnly: contextOnly || undefined,
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

/** Consume one matching baseline occurrence, returning false for a context-only message. */
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

/** Extract provider-bound message content for raw preview. */
function messageText(message: ContextEvent["messages"][number]): string {
	if (!("content" in message)) return JSON.stringify(message);
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
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
