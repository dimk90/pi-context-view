/**
 * ProbeTrigger: the automatic probe policy (D10). It waits for idle, applies
 * the probe preconditions, starts the one SilentProbe attempt of this runtime,
 * and reads the result from SnapshotStore. It imports no capture module and
 * applies no run-mode guard; consumers decide when to ask for a probe.
 */
import { type ExtensionAPI, type ExtensionCommandContext, shouldCompact } from "@earendil-works/pi-coding-agent";

import type { CompactionState } from "../compaction.ts";
import { readGlobalCacheWarmingMode, readLiveSettings } from "../settings.ts";
import type { RequestSnapshot, SnapshotReader } from "../snapshot.ts";
import type { ProbeOutcome, SilentProbe } from "./silent-probe.ts";
import { runWithProbeToken } from "./token.ts";

/**
 * How long to wait for the probe snapshot after the probe settles. Capture
 * settles the probe's guard in its own `agent_settled` handler, which runs
 * after SilentProbe's, so the snapshot normally arrives at once.
 */
const DEFAULT_SNAPSHOT_GRACE_MS = 1_000;
const NO_SNAPSHOT_REASON = "Silent probe settled without a request snapshot.";

/** Result of asking for a probe: the probe's snapshot with a settled guard, or why there is none. */
export type ProbeResult =
	| { readonly status: "captured"; readonly snapshot: RequestSnapshot }
	| { readonly status: "failed"; readonly reason: string };

/** Dependencies and timing of a ProbeTrigger. */
export interface ProbeTriggerOptions {
	readonly pi: ExtensionAPI;
	readonly probe: SilentProbe;
	readonly snapshots: SnapshotReader;
	readonly compaction: CompactionState;
	/** Wait after the probe settles before reporting a missing snapshot; defaults to 1 s. */
	readonly snapshotGraceMs?: number;
}

/**
 * Starts at most one probe per extension runtime; concurrent and later callers
 * share its result. A skipped precondition does not consume the attempt.
 */
export class ProbeTrigger {
	private readonly pi: ExtensionAPI;
	private readonly probe: SilentProbe;
	private readonly snapshots: SnapshotReader;
	private readonly compaction: CompactionState;
	private readonly snapshotGraceMs: number;
	private attempt: Promise<ProbeResult> | undefined;

	public constructor(options: ProbeTriggerOptions) {
		this.pi = options.pi;
		this.probe = options.probe;
		this.snapshots = options.snapshots;
		this.compaction = options.compaction;
		this.snapshotGraceMs = options.snapshotGraceMs ?? DEFAULT_SNAPSHOT_GRACE_MS;
	}

	/**
	 * Wait for idle, then resolve with the first `synthetic-probe` snapshot
	 * published after the probe started whose guard has settled, or with the
	 * reason the probe was skipped or failed.
	 */
	public async request(context: ExtensionCommandContext): Promise<ProbeResult> {
		await context.waitForIdle();
		const unavailableReason = getProbeUnavailableReason(this.pi, context, this.compaction.isActive);
		if (unavailableReason !== undefined) return { status: "failed", reason: unavailableReason };
		this.attempt ??= this.run(context);
		return this.attempt;
	}

	/** Start the probe run with the working row hidden and wait for its result. */
	private async run(context: ExtensionCommandContext): Promise<ProbeResult> {
		const attempt = this.probe.start();
		// Subscribe before sending, so no publication of this probe is missed
		const result = waitForProbeResult(this.snapshots, attempt.completion, this.snapshotGraceMs);
		// Only the attempt's starter sends: a repeated empty send would be a real turn
		if (!attempt.started) return result;

		context.ui.setWorkingVisible(false);
		try {
			// Pi emits `input` and `before_agent_start` from inside this call, so the
			// token reaches both handlers and identifies the run even when another
			// extension's input transform rewrites the prompt text.
			runWithProbeToken(attempt.token, () => this.pi.sendUserMessage(""));
		} catch (error) {
			this.probe.fail(error instanceof Error ? error.message : String(error));
		}
		try {
			return await result;
		} finally {
			context.ui.setWorkingVisible(true);
		}
	}
}

/**
 * Resolve with the probe's settled snapshot, the attempt's failure, or a
 * missing-snapshot failure once `graceMs` passed after the probe settled.
 * Probes run one at a time, so any `synthetic-probe` publication belongs to
 * this attempt.
 */
function waitForProbeResult(
	snapshots: SnapshotReader,
	completion: Promise<ProbeOutcome>,
	graceMs: number,
): Promise<ProbeResult> {
	return new Promise((resolve) => {
		let finished = false;
		let graceTimer: NodeJS.Timeout | undefined;
		const unsubscribe = snapshots.subscribe((snapshot) => {
			if (snapshot.origin === "synthetic-probe" && snapshot.guard.status !== "pending") {
				finish({ status: "captured", snapshot });
			}
		});

		/** Resolve once, then stop listening and cancel the grace timer. */
		function finish(result: ProbeResult): void {
			if (finished) return;
			finished = true;
			unsubscribe();
			if (graceTimer !== undefined) clearTimeout(graceTimer);
			resolve(result);
		}

		void completion.then((outcome) => {
			if (finished) return;
			if (outcome.status === "failed") {
				finish(outcome);
				return;
			}
			graceTimer = setTimeout(() => finish({ status: "failed", reason: NO_SNAPSHOT_REASON }), graceMs);
		});
	});
}

/** Explain why a silent probe cannot run now, or undefined when it can. */
function getProbeUnavailableReason(
	pi: ExtensionAPI,
	context: ExtensionCommandContext,
	compactionInProgress: boolean,
): string | undefined {
	if (compactionInProgress) return "Silent probe unavailable: context compaction is in progress.";
	if (context.hasPendingMessages()) return "Silent probe unavailable: messages are waiting to be delivered.";
	if (context.model === undefined) return "Silent probe unavailable: no model is selected.";
	// Pi's virtual-model discriminator is not exported from its package root
	if (context.model.api === "pi-virtual") return "Silent probe unavailable: a virtual model is selected.";
	if (!context.modelRegistry.hasConfiguredAuth(context.model)) {
		return `Silent probe unavailable: ${context.model.provider} has no configured authentication.`;
	}
	return getProbeSettingsUnavailableReason(pi, context);
}

/** Check live compaction settings and both sources of the global-only warming preference. */
function getProbeSettingsUnavailableReason(
	pi: ExtensionAPI,
	context: ExtensionCommandContext,
): string | undefined {
	try {
		const settings = readLiveSettings(pi);
		// The merged snapshot can mask global idle warming with an ignored project override
		if (settings.getCacheWarmingMode() === "idle" || readGlobalCacheWarmingMode(context.cwd) === "idle") {
			return "Silent probe unavailable: idle cache warming is enabled.";
		}
		const compaction = settings.getCompactionSettings(context.model);
		const usage = context.getContextUsage();
		if (usage?.tokens != null && shouldCompact(usage.tokens, usage.contextWindow, compaction)) {
			return "Silent probe unavailable: context exceeds the auto-compaction threshold.";
		}
	} catch {
		return "Silent probe unavailable: Pi settings could not be checked.";
	}
	return undefined;
}
