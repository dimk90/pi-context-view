/**
 * Demo extension: a `context_with_system` handler that appends plain text to
 * the system prompt for the request only. A system message with `content` and
 * no sections adds instructions after the replayed prompt.
 *
 * Expected result:
 *   before the monitor   structured system change, unattributed
 *   after the monitor    edited after monitor
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SYSTEM_APPEND_TEXT = "XYZZY_SYSTEM_APPEND: request-only system instruction.";

/** Append one system message with plain text after the existing transcript. */
export default function (pi: ExtensionAPI): void {
	pi.on("context_with_system", (event) => ({
		messages: [...event.messages, { role: "system", content: SYSTEM_APPEND_TEXT, timestamp: Date.now() }],
	}));
}
