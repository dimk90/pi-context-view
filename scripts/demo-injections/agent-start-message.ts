/**
 * Demo extension: a `before_agent_start` handler that adds a custom message to
 * every run, including a silent probe. Pi saves the message in the session, so
 * it belongs to the baseline and is not a request-only change; each run saves
 * one more copy.
 *
 * Expected result:
 *   before the monitor   no change: an unmarked saved part in unattributed messages
 *   after the monitor    same as before
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Readable, since the customType labels the message's preview part. */
export const AGENT_START_MESSAGE_TYPE = "Custom Demo Message: Findings Format";
export const AGENT_START_MESSAGE_TEXT = "Review findings should include the affected file and a suggested improvement.";

/** Add one hidden custom message to every run. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", () => ({
		message: { customType: AGENT_START_MESSAGE_TYPE, content: AGENT_START_MESSAGE_TEXT, display: false },
	}));
}
