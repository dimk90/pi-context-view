/**
 * DispatchConfirmer: records the dispatch identity of each paired request once.
 * Assistant `message_start` carries it; assistant `message_end` is the
 * fallback. A cache-warm refresh has no assistant events, so it cannot confirm
 * a paired request. Handlers only read the identity and return.
 */

/** The paired request still waiting for its dispatch identity, if any. */
export class DispatchConfirmer<Request> {
	private awaiting: Request | undefined;

	/**
	 * Wait for the identity of a newly paired request. Returns the previous
	 * request when it never received one: each request has at most one payload.
	 */
	public expect(request: Request): Request | undefined {
		const previous = this.awaiting;
		this.awaiting = request;
		return previous;
	}

	/**
	 * Take the request still waiting, as when an assistant event confirms it or
	 * its run settles without an identity; each request is taken once.
	 */
	public take(): Request | undefined {
		const request = this.awaiting;
		this.awaiting = undefined;
		return request;
	}

	/** Forget the waiting request, as at session shutdown. */
	public clear(): void {
		this.awaiting = undefined;
	}
}
