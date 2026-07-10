/**
 * pi-context-inspect — inspect what occupies the model context.
 *
 * Passively captures the first real turn, or runs one on-demand silent probe
 * when a context view is opened before any real turn.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	getContextArgumentCompletions,
	parseContextCommand,
	reportCommandMessage,
	resolveInitialCapture,
	showCapturePlaceholder,
} from "./command.ts";
import { InitialCaptureState, SilentProbeState } from "./capture.ts";

export default function (pi: ExtensionAPI) {
	const capture = new InitialCaptureState();
	const probe = new SilentProbeState();
	let runtimeEnabled = false;

	pi.on("input", (event) => {
		probe.observeInput(event.source, event.text);
	});

	pi.on("before_agent_start", (event) => {
		probe.beginRun(event.prompt);
		capture.prepare(event.systemPromptOptions);
	});

	pi.on("turn_start", (_event, ctx) => {
		if (probe.isCurrentRun) ctx.abort();
	});

	pi.on("message_start", (event) => {
		probe.recordMessage(event.message);
	});

	pi.on("message_end", (event) => {
		const message = probe.sanitizeAssistant(event.message);
		return message === undefined ? undefined : { message };
	});

	pi.on("context", (event, ctx) => {
		const messages = probe.filterMessages(event.messages);
		capture.finalize({
			systemPrompt: ctx.getSystemPrompt(),
			messages,
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
			origin: probe.isCurrentRun ? "synthetic-probe" : "real-turn",
		});
		return messages === event.messages ? undefined : { messages };
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!probe.isCurrentRun) return;
		if (ctx.mode === "tui") ctx.ui.setWorkingVisible(true);
		probe.settle(capture.snapshot !== undefined);
	});

	pi.on("session_shutdown", () => {
		probe.fail("Session ended before the silent probe completed.");
	});

	pi.registerCommand("context", {
		description: "Inspect context usage or injections",
		getArgumentCompletions: getContextArgumentCompletions,
		handler: async (args, ctx) => {
			const command = parseContextCommand(args);
			if (command.type === "invalid") {
				reportCommandMessage(ctx, command.message, "error");
				return;
			}
			if (ctx.mode !== "tui") {
				reportCommandMessage(ctx, "/context requires TUI mode.", "warning");
				return;
			}
			if (command.type === "runtime") {
				runtimeEnabled = command.enabled;
				const state = runtimeEnabled ? "enabled" : "disabled";
				reportCommandMessage(ctx, `Runtime injection logging ${state}.`, "info");
				return;
			}

			const placeholder = await resolveInitialCapture(pi, capture, probe, ctx);
			await showCapturePlaceholder(ctx, command.view, placeholder);
		},
	});
}
