/**
 * Compaction lifecycle tracking for the silent-probe preconditions: a probe
 * must not start while an observed compaction can still reject prompts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tracks the observable compaction lifecycle that makes a silent probe unsafe. */
export class CompactionState {
	private currentSignal: AbortSignal | undefined;

	/** Whether a compaction observed through `session_before_compact` is still active. */
	public get isActive(): boolean {
		return this.currentSignal !== undefined && !this.currentSignal.aborted;
	}

	/** Track the current compaction until Pi reports its end or its signal aborts. */
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

/** Follow compaction through Pi's session events; a new or ending session clears it. */
export function registerCompactionTracking(pi: ExtensionAPI, compaction: CompactionState): void {
	pi.on("session_start", () => {
		compaction.finish();
	});

	pi.on("session_before_compact", (event) => {
		compaction.begin(event.signal);
	});

	// Pi ends every observed compaction with exactly one of these two events.
	pi.on("session_compact", () => {
		compaction.finish();
	});

	pi.on("session_compact_failed", () => {
		compaction.finish();
	});

	pi.on("session_shutdown", () => {
		compaction.finish();
	});
}
