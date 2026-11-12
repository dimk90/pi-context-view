/**
 * Verification fixture that simulates another extension injecting a per-turn
 * system-prompt addition and a hidden startup message.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Register the marker prompt addition and startup message. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\nXYZZY_MARKER_INJECTION: verification prompt addition.`,
		};
	});

	pi.on("session_start", async () => {
		pi.sendMessage(
			{
				customType: "context-view-marker",
				content: "XYZZY_MARKER_MESSAGE: hidden startup context message.",
				display: false,
			},
			{ deliverAs: "nextTurn", triggerTurn: false },
		);
	});
}
