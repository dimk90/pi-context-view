/**
 * Demo extension: a `context` handler that swaps the first user message that
 * contains a marker with the latest user message, for the request only. The
 * swap keeps user and assistant messages alternating. Send a marked prompt,
 * then at least one more prompt.
 *
 * Expected result:
 *   before the monitor   structured deletion plus addition, unattributed
 *   after the monitor    structured deletion plus addition, unattributed
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Send a prompt containing this marker to have the fixture move it. */
export const CONTEXT_REORDER_MARKER = "XYZZY_CONTEXT_REORDER";

/** Swap the marked and the latest user messages; return nothing when they are the same. */
export default function (pi: ExtensionAPI): void {
	pi.on("context", (event) => {
		const marked = event.messages.findIndex((message) => message.role === "user"
			&& JSON.stringify(message.content).includes(CONTEXT_REORDER_MARKER));
		const latest = event.messages.findLastIndex((message) => message.role === "user");
		if (marked === -1 || marked === latest) return undefined;
		const messages = [...event.messages];
		[messages[marked], messages[latest]] = [messages[latest], messages[marked]];
		return { messages };
	});
}
