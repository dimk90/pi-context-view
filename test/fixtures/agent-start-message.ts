/**
 * Demo extension: a `before_agent_start` handler that adds a custom message to
 * every run, including a silent probe. Pi saves the message in the session, so
 * it belongs to the baseline and is not a request-only change; each run saves
 * one more copy.
 *
 * Expected result:
 *   before the monitor   no change: listed under `context-view-fixture-agent-message` without a marker
 *   after the monitor    no change: listed under `context-view-fixture-agent-message` without a marker
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const AGENT_START_MESSAGE_TYPE = "context-view-fixture-agent-message";
export const AGENT_START_MESSAGE_TEXT = "XYZZY_AGENT_START_MESSAGE: saved before_agent_start message.";

/** Add one hidden custom message to every run. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", () => ({
		message: { customType: AGENT_START_MESSAGE_TYPE, content: AGENT_START_MESSAGE_TEXT, display: false },
	}));
}
