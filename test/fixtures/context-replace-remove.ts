/**
 * #6 regression fixture: replace the issue's 40,000-character user message
 * with `bbbb` and remove a different marked user message, for the request only.
 * Send CONTEXT_REPLACE_ORIGINAL, then CONTEXT_REMOVE_TEXT to exercise both.
 *
 * Expected result:
 *   before the monitor   structured modification and deletion, unattributed; Usage counts 1 user token
 *   after the monitor    same as before; all context handlers precede context_with_system
 */
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CONTEXT_REPLACE_ORIGINAL = "a".repeat(40_000);
export const CONTEXT_REPLACE_TEXT = "bbbb";
export const CONTEXT_REMOVE_TEXT = "XYZZY_CONTEXT_REMOVE";

/** Transform only the two fixture messages; leave the saved session unchanged. */
export default function (pi: ExtensionAPI): void {
	pi.on("context", (event) => {
		let changed = false;
		const messages = event.messages.flatMap((message): ContextEvent["messages"] => {
			if (message.role !== "user") return [message];
			const text = typeof message.content === "string"
				? message.content
				: message.content.map((block) => block.type === "text" ? block.text : "").join("");
			if (text === CONTEXT_REMOVE_TEXT) {
				changed = true;
				return [];
			}
			if (text !== CONTEXT_REPLACE_ORIGINAL) return [message];
			changed = true;
			return [{ ...message, content: CONTEXT_REPLACE_TEXT }];
		});
		return changed ? { messages } : undefined;
	});
}
