/**
 * SilentProbe: the one on-demand probe run of an extension runtime. It claims
 * the run by token, aborts it before the provider, blanks and omits its
 * messages, and records and persists their identities through ProbeFilter.
 */
import type {
	ContextEditEntryDraft,
	ContextEvent,
	ExtensionAPI,
	InputSource,
	ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";

import { type PersistedIdentities, PROBE_IDENTITIES_CUSTOM_TYPE, type ProbeFilter } from "./filter.ts";
import { createProbeToken, type ProbeToken, readProbeToken } from "./token.ts";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
/** `AbortError` text of the JavaScript runtime that runs pi, for the probe's `turn_start` abort. */
const SETUP_ABORT_ERROR_MESSAGES = new Set([
	"This operation was aborted", // Node.js
	"The operation was aborted.", // Bun
]);

/**
 * Result of the one allowed silent-probe attempt. A settled run says nothing
 * about capture; ProbeTrigger reads the probe's snapshot from the store.
 */
export type ProbeOutcome =
	| { readonly status: "settled" }
	| { readonly status: "failed"; readonly reason: string };

/** A probe start request; concurrent callers share `token` and `completion`. */
export interface ProbeAttempt {
	readonly started: boolean;
	/** Correlation token to send the synthetic prompt under. */
	readonly token: ProbeToken;
	readonly completion: Promise<ProbeOutcome>;
}

/**
 * Lifecycle of the single probe attempt. Ownership outlives the attempt's own
 * completion, so a probe run arriving after a timeout or after an unattributed
 * run is still claimed, aborted, and sanitized.
 */
type ProbePhase = "idle" | "waiting" | "running" | "settled";

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
	 * edits, and earlier handlers' drafts, so each target is omitted once.
	 */
	public createContextEdits(contextEntries: readonly ProjectedSessionEntry[]): ContextEditEntryDraft[] {
		if (!this.isCurrentRun) return [];
		const edits: ContextEditEntryDraft[] = [];
		for (const { sourceEntry, messages } of contextEntries) {
			if (messages.length > 0
				&& sourceEntry.type === "message"
				&& (sourceEntry.message.role === "user" || sourceEntry.message.role === "assistant")
				&& this.filter.has(sourceEntry.message)) {
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
	public fail(reason: string): void {
		if (this.attempt === undefined) return;
		this.resolve({ status: "failed", reason });
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
	 * extension's input transform added to it.
	 */
	private blankProbePrompt(
		message: Extract<ContextEvent["messages"][number], { role: "user" }>,
	): ContextEvent["messages"][number] | undefined {
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
		if (event.text === "" || !probe.isProbeInput(event.source, readProbeToken())) return undefined;
		return { action: "transform", text: "" } as const;
	});

	pi.on("before_agent_start", () => {
		probe.beginRun(readProbeToken());
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
		// session; write their identities so the next runtime keeps filtering them.
		persistIdentities();
		probe.fail("Session ended before the silent probe completed.");
	});
}
