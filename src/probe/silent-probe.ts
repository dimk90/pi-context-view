/**
 * SilentProbe: the one on-demand probe run of an extension runtime. It claims
 * the run by token, aborts it before the provider, blanks and omits its
 * messages, and records and persists their identities through ProbeFilter.
 */
import type {
	BeforeAgentStartEvent,
	ContextEditEntryDraft,
	ContextEvent,
	ExtensionAPI,
	InputEvent,
	ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";

import { probeFailure, type ProbeFailure, type ProbeFailureCause } from "./failure.ts";
import { type PersistedIdentities, PROBE_IDENTITIES_CUSTOM_TYPE, type ProbeFilter } from "./filter.ts";
import { createProbeToken, type ProbeToken, readProbeToken } from "./token.ts";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
/** `AbortError` text of the JavaScript runtime that runs pi, for the probe's `turn_start` abort. */
const SETUP_ABORT_ERROR_MESSAGES = new Set([
	"This operation was aborted", // Node.js
	"The operation was aborted.", // Bun
]);
/** Reported once for a wrong claim; names no message, since raw content never reaches notifications. */
const WRONG_CLAIM_WARNING = "Silent probe may have stopped another extension's message instead of its own; " +
	"its empty prompt may reach the model.";

/**
 * Result of the one allowed silent-probe attempt. A settled run says nothing
 * about capture; ProbeTrigger reads the probe's snapshot from the store.
 */
export type ProbeOutcome =
	| { readonly status: "settled" }
	| ProbeFailure;

/** A probe start request; concurrent callers share `token` and `completion`. */
export interface ProbeAttempt {
	readonly started: boolean;
	/** Correlation token to send the synthetic prompt under. */
	readonly token: ProbeToken;
	readonly completion: Promise<ProbeOutcome>;
}

/**
 * How SilentProbe treats a starting run:
 *   claimed       the probe's own run: aborted before the provider, blanked, and omitted
 *   wrong-claim   the first user-message run with the token after the claim: a nested send
 *                 took the probe's identity, and this run is likely the probe prompt
 *   foreign       any other run
 * Only a claimed run is changed; the others run untouched.
 */
export type RunClaim = "claimed" | "wrong-claim" | "foreign";

/**
 * Lifecycle of the single probe attempt. Ownership outlives the attempt's own
 * completion, so a probe run arriving after a timeout or after an unattributed
 * run is still claimed, aborted, and sanitized. A second idle input with the
 * token ends ownership without a claim: the attempt becomes `ambiguous`.
 */
type ProbePhase = "idle" | "waiting" | "running" | "settled" | "ambiguous";

/**
 * Progress of the owned run's prompt, its first user message, through its
 * message events. A message sent while the run started follows the prompt and
 * can share its millisecond timestamp, so only this order tells them apart.
 */
type PromptProgress = "pending" | "started" | "ended";

/**
 * State for one on-demand silent probe. It owns the correlation token and the
 * timeout, and records the exact synthetic message identities in ProbeFilter.
 * Pi API calls stay in `registerSilentProbe()` and ProbeTrigger.
 */
export class SilentProbe {
	private readonly filter: ProbeFilter;
	private phase: ProbePhase = "idle";
	private attempt: ProbeAttempt | undefined;
	private resolveCompletion: ((outcome: ProbeOutcome) => void) | undefined;
	private outcome: ProbeOutcome | undefined;
	private timeout: NodeJS.Timeout | undefined;
	private promptProgress: PromptProgress = "pending";
	/** Whether an idle input with the token was claimed; a second one makes ownership ambiguous. */
	private inputClaimed = false;
	/** Whether a wrong claim was reported; runs started from the probe's handlers inherit the token too. */
	private wrongClaimReported = false;
	/** Identities this runtime recorded since its last persisted entry. */
	private unpersistedCount = 0;

	/** Record probe identities in `filter`, which also holds those of earlier runtimes. */
	public constructor(filter: ProbeFilter) {
		this.filter = filter;
	}

	/** True while the probe owns the in-flight agent run (including after a timeout). */
	public get isCurrentRun(): boolean {
		return this.phase === "running";
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
		const { promise: completion, resolve } = Promise.withResolvers<ProbeOutcome>();
		this.resolveCompletion = resolve;
		this.timeout = setTimeout(() => {
			this.resolve(probeFailure("timeout"));
		}, timeoutMs);
		this.attempt = { started: true, token: createProbeToken(), completion };
		return this.attempt;
	}

	/**
	 * Claim the probe's own synthetic prompt among idle inputs. Recognition is
	 * causal rather than textual: the token is visible only inside the async
	 * context of this extension's own `sendUserMessage()` call. The probe sends
	 * while idle, so queued input is never its own, even with the token another
	 * extension's send from `before_agent_start` inherits. A second idle input
	 * with the token comes from a nested send in another extension's `input`
	 * handler, and either may be the probe's. Ownership is then ambiguous: reset
	 * no later input, claim no run, and fail the attempt.
	 */
	public claimInput(
		input: Pick<InputEvent, "source" | "streamingBehavior">,
		token: ProbeToken | undefined,
	): boolean {
		const isIdleInputWithToken = this.phase === "waiting"
			&& input.source === "extension"
			&& input.streamingBehavior === undefined
			&& this.ownsToken(token);
		if (!isIdleInputWithToken) return false;
		if (!this.inputClaimed) {
			this.inputClaimed = true;
			return true;
		}
		this.phase = "ambiguous";
		this.fail("nested-send");
		return false;
	}

	/**
	 * Claim the run this probe started: a user-message run carrying the token.
	 * Any other run is not provably ours, so it fails the attempt instead of
	 * activating the abort guard: it may belong to the user or to another
	 * extension and must run untouched. A custom-message run is foreign even
	 * with the token, which another extension's nested `sendMessage()` inherits.
	 * Ownership stays open afterwards so a delayed probe run is still claimed.
	 * The first user-message run with the token after the claim is a wrong
	 * claim: a nested send likely took the probe's identity. It runs untouched
	 * too, since a later send of another extension inherits the token as well.
	 */
	public beginRun(messageType: BeforeAgentStartEvent["messageType"], token: ProbeToken | undefined): RunClaim {
		const isUserRunWithToken = messageType === "user" && this.ownsToken(token);
		if (this.phase === "waiting") {
			if (!isUserRunWithToken) {
				this.fail("foreign-run");
				return "foreign";
			}
			this.phase = "running";
			return "claimed";
		}
		const hasClaimed = this.phase === "running" || this.phase === "settled";
		if (!isUserRunWithToken || !hasClaimed || this.wrongClaimReported) return "foreign";
		this.wrongClaimReported = true;
		return "wrong-claim";
	}

	/**
	 * Record the owned run's prompt and abort identities as their message events
	 * arrive. Pi emits the run's starting messages before queued ones, so only
	 * the first user message is the probe's; later ones were sent while the run
	 * started. Every assistant message is a probe abort: the probe aborts each
	 * turn at `turn_start`, including the extra turns Pi runs for queued messages.
	 */
	public recordMessage(message: ContextEvent["messages"][number]): void {
		if (!this.isCurrentRun) return;
		if (message.role === "user") {
			if (this.promptProgress !== "pending") return;
			this.promptProgress = "started";
		} else if (message.role !== "assistant") {
			return;
		}
		if (this.filter.record({ role: message.role, timestamp: message.timestamp })) this.unpersistedCount++;
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

	/**
	 * Omit known probe entries still visible in Pi's boundary projection at an
	 * owned run's `turn_end`. The projection already applies compaction, earlier
	 * edits, and earlier handlers' drafts, so each target is omitted once. Each
	 * entry is matched by its stored message, which a replacement does not change.
	 */
	public createContextEdits(contextEntries: readonly ProjectedSessionEntry[]): ContextEditEntryDraft[] {
		if (!this.isCurrentRun) return [];
		const edits: ContextEditEntryDraft[] = [];
		for (const { sourceEntry, messages } of contextEntries) {
			if (messages.length > 0 && sourceEntry.type === "message" && this.filter.matches(sourceEntry.message)) {
				edits.push({ type: "context_edit", targetId: sourceEntry.id, replacement: null });
			}
		}
		return edits;
	}

	/** Resolve a running attempt from `agent_settled`. */
	public settle(): boolean {
		if (!this.isCurrentRun) return false;
		this.phase = "settled";
		this.resolve({ status: "settled" });
		return true;
	}

	/**
	 * End a pending attempt during shutdown or a synchronous startup failure.
	 * Ownership is untouched: only the attempt's own completion is resolved.
	 */
	public fail(cause: ProbeFailureCause, detail?: string): void {
		if (this.attempt === undefined) return;
		this.resolve(probeFailure(cause, detail));
	}

	/**
	 * Write every known identity, restored ones included, once this runtime
	 * recorded new ones since its last write. Records never contain content.
	 */
	public persistIdentities(write: (data: PersistedIdentities) => void): void {
		if (this.unpersistedCount === 0) return;
		write({ messages: this.filter.syntheticMessages });
		this.unpersistedCount = 0;
	}

	/**
	 * Empty the synthetic prompt so no stored message keeps text another
	 * extension's input transform added to it. Only the first user message of
	 * the run is the prompt, even when a later one has the same timestamp.
	 */
	private blankProbePrompt(
		message: Extract<ContextEvent["messages"][number], { role: "user" }>,
	): ContextEvent["messages"][number] | undefined {
		if (this.promptProgress !== "started") return undefined;
		this.promptProgress = "ended";
		if (message.content.length === 0 || !this.filter.has(message)) return undefined;
		return { ...message, content: [] };
	}

	/**
	 * Replace a recorded probe abort with an empty successful message so pi does
	 * not render an abort transcript row. Pi reports the `turn_start` abort,
	 * which authentication rejects before streaming, as an error.
	 */
	private blankProbeAbort(
		message: Extract<ContextEvent["messages"][number], { role: "assistant" }>,
	): ContextEvent["messages"][number] | undefined {
		const isProbeAbort = message.stopReason === "error"
			&& message.errorMessage !== undefined
			&& SETUP_ABORT_ERROR_MESSAGES.has(message.errorMessage);
		if (!isProbeAbort || !this.filter.has(message)) return undefined;
		return { ...message, content: [], stopReason: "stop", errorMessage: undefined };
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

/** Register the probe run's lifecycle handlers; SilentProbe imports no capture code. */
export function registerSilentProbe(pi: ExtensionAPI, probe: SilentProbe): void {
	/** Append the identities entry when this runtime recorded new probe messages. */
	function persistIdentities(): void {
		probe.persistIdentities((data) => pi.appendEntry(PROBE_IDENTITIES_CUSTOM_TYPE, data));
	}

	pi.on("input", (event) => {
		// Reset text earlier input transforms added to our own synthetic prompt:
		// the probe carries no instructions, and its run is identified by token.
		// Claim an empty prompt too, so that a later nested send is recognized.
		if (!probe.claimInput(event, readProbeToken()) || event.text === "") return undefined;
		return { action: "transform", text: "" } as const;
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (probe.beginRun(event.messageType, readProbeToken()) === "wrong-claim") {
			ctx.ui.notify(WRONG_CLAIM_WARNING, "warning");
		}
	});

	pi.on("turn_start", (_event, ctx) => {
		if (probe.isCurrentRun) ctx.abort();
	});

	pi.on("message_start", (event) => {
		probe.recordMessage(event.message);
	});

	pi.on("message_end", (event) => {
		const message = probe.sanitizeMessage(event.message);
		return message === undefined ? undefined : { message };
	});

	pi.on("turn_end", (event) => {
		if (!probe.isCurrentRun) return;
		const entries = probe.createContextEdits(event.context.contextEntries);
		return entries.length === 0 ? undefined : { entries: [...event.entries, ...entries] };
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!probe.isCurrentRun) return;
		if (ctx.mode === "tui") ctx.ui.setWorkingVisible(true);
		probe.settle();
		persistIdentities();
	});

	pi.on("session_shutdown", () => {
		// A shutdown mid-probe can leave probe messages already persisted in the
		// session; write their identities so the next runtime keeps filtering them
		persistIdentities();
		probe.fail("shutdown");
	});
}
