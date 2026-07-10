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
	buildSnapshot,
	type CaptureOrigin,
	type InitialSnapshot,
	type InjectionItem,
	type InjectionSource,
} from "./model.ts";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** Everything available when the first context event finalizes a snapshot. */
export interface CaptureFinalization {
	systemPrompt: string;
	messages: ContextEvent["messages"];
	allTools: readonly ToolInfo[];
	activeToolNames: readonly string[];
	origin: CaptureOrigin;
	capturedAt?: Date;
}

/** Inputs available for a degraded pi-native snapshot when probing cannot run. */
export interface NativeFallbackInput {
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

type ProbePhase = "idle" | "waiting" | "running" | "timed-out" | "failed" | "settled";

/**
 * Capture-once state machine. `prepare()` refreshes the structured options on
 * every run until `finalize()` succeeds; subsequent finalizations return the
 * original snapshot unchanged.
 */
export class InitialCaptureState {
	private pendingOptions: BuildSystemPromptOptions | undefined;
	private initialSnapshot: InitialSnapshot | undefined;

	public get snapshot(): InitialSnapshot | undefined {
		return this.initialSnapshot;
	}

	public prepare(options: BuildSystemPromptOptions): void {
		if (this.initialSnapshot !== undefined) return;
		this.pendingOptions = options;
	}

	public finalize(input: CaptureFinalization): InitialSnapshot | undefined {
		if (this.initialSnapshot !== undefined) return this.initialSnapshot;
		if (this.pendingOptions === undefined) return undefined;

		const options = copyPromptOptions(this.pendingOptions);
		const tools = captureActiveTools(input.allTools, input.activeToolNames, this.pendingOptions);
		const items = [
			...analyzeSystemPrompt(input.systemPrompt, options, tools),
			...measureInjectedMessages(input.messages),
		];
		this.initialSnapshot = buildSnapshot(items, input.origin, input.capturedAt ?? new Date());
		this.pendingOptions = undefined;
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

	public get isCurrentRun(): boolean {
		return this.phase === "running" || this.phase === "timed-out";
	}

	public get syntheticMessages(): readonly SyntheticMessageIdentity[] {
		return [...this.identities.values()].map((identity) => ({ ...identity }));
	}

	public start(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): ProbeAttempt {
		if (this.completion !== undefined) {
			return { started: false, completion: this.completion };
		}

		this.phase = "waiting";
		this.completion = new Promise<ProbeOutcome>((resolve) => {
			this.resolveCompletion = resolve;
		});
		this.timeout = setTimeout(() => {
			this.phase = this.phase === "running" ? "timed-out" : "failed";
			this.resolve({ status: "failed", reason: "Silent probe timed out." });
		}, timeoutMs);
		return { started: true, completion: this.completion };
	}

	/** Mark the exact extension-originated empty input that starts the probe. */
	public observeInput(source: InputSource, text: string): void {
		if (this.phase === "waiting" && source === "extension" && text === "") {
			this.inputObserved = true;
		}
	}

	/** Associate the next matching lifecycle with the probe, not a real turn. */
	public beginRun(prompt: string): boolean {
		if (this.phase !== "waiting" || !this.inputObserved || prompt !== "") return false;
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
		if (this.completion === undefined || this.outcome !== undefined) return;
		this.phase = "failed";
		this.resolve({ status: "failed", reason });
	}

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

/** Build a view-local pi-native snapshot without freezing the main capture state. */
export function buildNativeFallbackSnapshot(input: NativeFallbackInput): InitialSnapshot {
	const options = copyPromptOptions(input.options);
	const tools = captureActiveTools(input.allTools, input.activeToolNames, input.options);
	const items = analyzeSystemPrompt(input.systemPrompt, options, tools);
	return buildSnapshot(items, "synthetic-probe", input.capturedAt ?? new Date());
}

/** Copy the prompt-options slice used by measurement, without shared nested references. */
export function copyPromptOptions(options: BuildSystemPromptOptions): PromptOptionsSlice {
	return {
		cwd: options.cwd,
		customPrompt: options.customPrompt,
		appendSystemPrompt: options.appendSystemPrompt,
		contextFiles: options.contextFiles?.map((file) => ({ path: file.path, content: file.content })),
		skills: options.skills?.map((skill) => ({ name: skill.name })),
	};
}

/** Snapshot the final active tool set with provenance and payload definitions. */
export function captureActiveTools(
	allTools: readonly ToolInfo[],
	activeToolNames: readonly string[],
	options: BuildSystemPromptOptions,
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

/** Measure custom-role messages, the reliable public marker for extension messages. */
export function measureInjectedMessages(messages: ContextEvent["messages"]): InjectionItem[] {
	const occurrences = new Map<string, number>();
	const items: InjectionItem[] = [];
	for (const message of messages) {
		if (message.role !== "custom") continue;
		const occurrence = occurrences.get(message.customType) ?? 0;
		occurrences.set(message.customType, occurrence + 1);
		const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		const source = messageSource(message.customType);
		items.push({
			id: `message:${message.customType}:${occurrence}`,
			phase: "initial",
			kind: "message",
			source,
			label: "message",
			chars: text.length,
			tokens: estimateTokens(message),
			text,
		});
	}
	return items;
}

function identityKey(identity: SyntheticMessageIdentity): string {
	return `${identity.role}:${identity.timestamp}`;
}

function messageSource(customType: string): InjectionSource {
	return { id: `message-type:${customType}`, label: customType, native: false };
}

function normalizeGuidelines(guidelines: string | string[] | undefined): string[] {
	if (guidelines === undefined) return [];
	return Array.isArray(guidelines) ? [...guidelines] : [guidelines];
}
