/**
 * RequestTracker: numbers captures and remembers the latest one still waiting
 * for its provider payload. `turnIndex` restarts with every agent run, so only
 * a local number identifies a request (D4).
 */

/** Guard reason of a capture that ended without a paired provider payload. */
export const NO_PAYLOAD_REASON = "No provider payload was observed for this request.";

/**
 * Capture numbering and payload pairing state. Until the payload guard pairs
 * payloads, every capture stays unpaired until the next capture or settlement.
 */
export class RequestTracker {
	private captureCount = 0;
	private unpairedId: number | undefined;

	/** Number a new capture; it becomes the latest unpaired capture. */
	public begin(): number {
		this.captureCount++;
		this.unpairedId = this.captureCount;
		return this.captureCount;
	}

	/** Take the unpaired capture, if any, so its guard can settle. */
	public takeUnpaired(): number | undefined {
		const id = this.unpairedId;
		this.unpairedId = undefined;
		return id;
	}
}
