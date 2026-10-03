/**
 * Verification fixture: a `context` handler that rewrites the text of the
 * latest user message for the request only. It returns a modified copy and
 * leaves the original message object unchanged.
 *
 * Expected result:
 *   before the monitor   structured modification, unattributed
 *   after the monitor    structured modification, unattributed
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CONTEXT_MODIFY_PREFIX = "XYZZY_CONTEXT_MODIFY:";

/** Prefix the latest user message with the marker. */
export default function (pi: ExtensionAPI): void {
	pi.on("context", (event) => {
		const index = event.messages.findLastIndex((message) => message.role === "user");
		const target = event.messages[index];
		if (target?.role !== "user") return undefined;
		const text = typeof target.content === "string"
			? target.content
			: target.content.map((block) => block.type === "text" ? block.text : "").join("");
		const messages = [...event.messages];
		messages[index] = { ...target, content: `${CONTEXT_MODIFY_PREFIX} ${text}` };
		return { messages };
	});
}
