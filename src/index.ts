/**
 * pi-context-inspect — inspect what occupies the model context.
 *
 * Passively captures the Initial snapshot from the first observed agent run.
 * The /context command and TUI are built on this state in later plan steps.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { InitialCaptureState } from "./capture.ts";

export default function (pi: ExtensionAPI) {
	const capture = new InitialCaptureState();

	pi.on("before_agent_start", (event) => {
		capture.prepare(event.systemPromptOptions);
	});

	pi.on("context", (event, ctx) => {
		capture.finalize({
			systemPrompt: ctx.getSystemPrompt(),
			messages: event.messages,
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
			origin: "real-turn",
		});
	});
}
