/**
 * Verification fixture: saves one custom note per session, then omits it from
 * every request. Unlike `context-delete`, no marker prompt is needed, and the
 * deleted message cannot pair with a request-only user message.
 *
 * Expected result:
 *   before the monitor   one structured message deletion, unattributed
 *   after the monitor    same as before
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CONTEXT_DELETE_SAVED_TYPE = "context-view-fixture-obsolete";
export const CONTEXT_DELETE_SAVED_TEXT = "XYZZY_CONTEXT_DELETE_SAVED: obsolete saved note.";

/** Save the note once, then filter only its custom message type from requests. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", (_event, ctx) => {
		const saved = ctx.sessionManager.buildSessionProjection().messages;
		if (saved.some((message) => message.role === "custom" && message.customType === CONTEXT_DELETE_SAVED_TYPE)) {
			return undefined;
		}
		return { message: { customType: CONTEXT_DELETE_SAVED_TYPE, content: CONTEXT_DELETE_SAVED_TEXT, display: false } };
	});
	pi.on("context", (event) => ({
		messages: event.messages.filter((message) => message.role !== "custom"
			|| message.customType !== CONTEXT_DELETE_SAVED_TYPE),
	}));
}
