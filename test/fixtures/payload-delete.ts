/**
 * Demo extension: a `before_provider_request` handler that removes every user
 * message containing a marker from the provider payload. The session and the
 * structured request keep the message.
 *
 * Expected result:
 *   before the monitor   edited after monitor
 *   after the monitor    not visible
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Send a prompt containing this marker to have the fixture delete it. */
export const PAYLOAD_DELETE_MARKER = "XYZZY_PAYLOAD_DELETE";

/** Return a payload copy without marked user messages; return nothing when none match. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event) => {
		const payload = event.payload as { messages?: unknown };
		if (!Array.isArray(payload.messages)) return undefined;
		const messages = payload.messages.filter((message: { role?: unknown }) => message.role !== "user"
			|| !JSON.stringify(message).includes(PAYLOAD_DELETE_MARKER));
		return messages.length === payload.messages.length ? undefined : { ...payload, messages };
	});
}
