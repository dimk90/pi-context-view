/**
 * Verification fixture: a `context` handler that removes every user message
 * containing a marker from the request. The session keeps the message.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Send a prompt containing this marker to have the fixture delete it. */
export const CONTEXT_DELETE_MARKER = "XYZZY_CONTEXT_DELETE";

/** Drop marked user messages; return nothing when none match. */
export default function (pi: ExtensionAPI): void {
	pi.on("context", (event) => {
		const messages = event.messages.filter((message) => message.role !== "user"
			|| !JSON.stringify(message.content).includes(CONTEXT_DELETE_MARKER));
		return messages.length === event.messages.length ? undefined : { messages };
	});
}
