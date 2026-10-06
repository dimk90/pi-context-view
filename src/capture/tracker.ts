/**
 * RequestTracker: numbers captures and pairs each agent payload with the
 * latest capture still waiting for one. `turnIndex` restarts with every agent
 * run, so only a local number identifies a request (D4).
 */
import { hasWarmOutputLimit } from "./payload.ts";

/** Guard reason of a capture that ended without a paired provider payload. */
export const NO_PAYLOAD_REASON = "No provider payload was observed for this request.";

/**
 * How a payload relates to the captures:
 *   paired         the payload of the latest unpaired capture
 *   warm-refresh   a cache-warm refresh repeating an earlier request; not compared
 *   unpaired       no capture is waiting, as for a refresh after its run or a nonstandard host
 */
export type PayloadPairing<Capture> =
	| { readonly type: "paired"; readonly capture: Capture }
	| { readonly type: "warm-refresh" }
	| { readonly type: "unpaired" };

/**
 * Capture numbering and payload pairing state. Agent-level retries start a
 * new run with a new capture; provider-level retries resend a payload without
 * another `before_provider_request`, so neither needs special pairing.
 */
export class RequestTracker<Capture> {
	private captureCount = 0;
	private unpaired: Capture | undefined;
	private warmDecisionSinceCapture = false;

	/** Number the next capture; later captures have larger numbers. */
	public nextId(): number {
		return ++this.captureCount;
	}

	/** Make `capture` the latest unpaired capture; earlier warm decisions no longer apply. */
	public track(capture: Capture): void {
		this.unpaired = capture;
		this.warmDecisionSinceCapture = false;
	}

	/** Take the unpaired capture, if any, so its guard can settle without a payload. */
	public takeUnpaired(): Capture | undefined {
		const capture = this.unpaired;
		this.unpaired = undefined;
		return capture;
	}

	/** Note a `cache_warming_decision`: a refresh may follow before the next capture. */
	public noteWarmDecision(): void {
		this.warmDecisionSinceCapture = true;
	}

	/**
	 * Pair a payload. A warm decision alone is not enough: handler results do
	 * not update the decision event, so a later handler may have stopped the
	 * refresh. The refresh's one-token output limit confirms it.
	 */
	public pair(payload: unknown): PayloadPairing<Capture> {
		if (this.warmDecisionSinceCapture && hasWarmOutputLimit(payload)) return { type: "warm-refresh" };
		const capture = this.takeUnpaired();
		return capture === undefined ? { type: "unpaired" } : { type: "paired", capture };
	}

	/** Forget the unpaired capture and warm decisions, as at session shutdown. */
	public clear(): void {
		this.unpaired = undefined;
		this.warmDecisionSinceCapture = false;
	}
}
