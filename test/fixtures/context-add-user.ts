/**
 * Verification fixture: a `context` handler that adds a request-only user message.
 * Unlike a custom message, it has no `customType` to name its source.
 *
 * Expected result:
 *   before the monitor   structured addition, unattributed
 *   after the monitor    structured addition, unattributed
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CONTEXT_ADD_USER_TEXT = "XYZZY_CONTEXT_ADD_USER: request-only user message.";

/** Append one user message to every request. */
export default function (pi: ExtensionAPI): void {
	pi.on("context", (event) => ({
		messages: [...event.messages, { role: "user", content: CONTEXT_ADD_USER_TEXT, timestamp: Date.now() }],
	}));
}
