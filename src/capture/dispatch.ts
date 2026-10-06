/**
 * DispatchConfirmer: records the dispatch identity of each paired request once
 * (D4). Assistant `message_start` and `provider_stream_event` both carry it,
 * in no fixed order; assistant `message_end` is the fallback, as for a request
 * that fails before streaming. Handlers only read the identity and return.
 */

/**
 * Which event supplied an identity:
 *   assistant   assistant `message_start` or `message_end`; a cache-warm refresh has none
 *   stream      `provider_stream_event`, which a cache-warm refresh also fires
 */
export type IdentitySource = "assistant" | "stream";

/** The paired request still waiting for its dispatch identity, if any. */
export class DispatchConfirmer<Request> {
	private awaiting: Request | undefined;
	private warmRefreshInFlight = false;

	/**
	 * Wait for the identity of a newly paired request. Returns the previous
	 * request when it never received one: each request has at most one payload.
	 */
	public expect(request: Request): Request | undefined {
		const previous = this.awaiting;
		this.awaiting = request;
		this.warmRefreshInFlight = false;
		return previous;
	}

	/** Note a cache-warm refresh payload: its stream events must not confirm a paired request. */
	public noteWarmRefresh(): void {
		this.warmRefreshInFlight = true;
	}

	/** The request an identity-bearing event confirms; each request is confirmed once. */
	public confirm(source: IdentitySource): Request | undefined {
		if (source === "stream" && this.warmRefreshInFlight) return undefined;
		return this.takeUnconfirmed();
	}

	/** Take the request still waiting, as when its run settles without an identity. */
	public takeUnconfirmed(): Request | undefined {
		const request = this.awaiting;
		this.awaiting = undefined;
		return request;
	}

	/** Forget the waiting request, as at session shutdown. */
	public clear(): void {
		this.awaiting = undefined;
		this.warmRefreshInFlight = false;
	}
}
