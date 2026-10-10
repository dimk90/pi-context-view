/**
 * Demo extension: a `context_with_system` handler that adds a request-only
 * custom message. Nothing is saved, so only the request contains it. After the
 * monitor, Pi has already turned it into a user message when the payload guard
 * sees it, so its `customType` is lost.
 *
 * Expected result:
 *   before the monitor   structured addition, source `context-view-fixture-system-add`
 *   after the monitor    edited after monitor: an added user message
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SYSTEM_ADD_MESSAGE_TYPE = "context-view-fixture-system-add";
export const SYSTEM_ADD_MESSAGE_TEXT = "XYZZY_SYSTEM_ADD_MESSAGE: request-only context_with_system message.";

/** Append one custom message to every request. */
export default function (pi: ExtensionAPI): void {
	pi.on("context_with_system", (event) => ({
		messages: [...event.messages, {
			role: "custom",
			customType: SYSTEM_ADD_MESSAGE_TYPE,
			content: SYSTEM_ADD_MESSAGE_TEXT,
			display: false,
			timestamp: Date.now(),
		}],
	}));
}
