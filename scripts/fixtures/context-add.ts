/**
 * Demo extension: a `context` handler that adds a request-only custom
 * message. Nothing is persisted, so only the request contains it.
 *
 * Expected result:
 *   before the monitor   structured addition, source `context-view-fixture-add`
 *   after the monitor    structured addition, source `context-view-fixture-add`
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CONTEXT_ADD_TYPE = "context-view-fixture-add";
export const CONTEXT_ADD_TEXT = "XYZZY_CONTEXT_ADD: request-only custom message.";

/** Append one custom message to every request. */
export default function (pi: ExtensionAPI): void {
	pi.on("context", (event) => ({
		messages: [...event.messages, {
			role: "custom",
			customType: CONTEXT_ADD_TYPE,
			content: CONTEXT_ADD_TEXT,
			display: false,
			timestamp: Date.now(),
		}],
	}));
}
