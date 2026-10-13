/**
 * Demo extension: saves one obsolete review note, then omits it from requests.
 * No marker prompt is needed, and genuine user messages are never removed.
 *
 * Expected result:
 *   before the monitor   one structured message deletion, unattributed
 *   after the monitor    same as before
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Readable, since the customType labels the message's preview part. */
export const CONTEXT_DELETE_TYPE = "Custom Demo Message: Obsolete Scope";
export const CONTEXT_DELETE_TEXT = "Limit the review to formatting; skip error handling and test coverage.";

/** Seed the note once per session and filter only its custom message type. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", (_event, ctx) => {
		const saved = ctx.sessionManager.buildSessionProjection().messages;
		if (saved.some((message) => message.role === "custom" && message.customType === CONTEXT_DELETE_TYPE)) {
			return undefined;
		}
		return { message: { customType: CONTEXT_DELETE_TYPE, content: CONTEXT_DELETE_TEXT, display: false } };
	});
	pi.on("context", (event) => ({
		messages: event.messages.filter((message) => message.role !== "custom"
			|| message.customType !== CONTEXT_DELETE_TYPE),
	}));
}
