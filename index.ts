/**
 * pi-context-inspect — report initial context injections.
 *
 * Adds a --context-inspect CLI flag. When set, pi prints a table of initial
 * context injections (source: pi native or extension, size in estimated
 * tokens) and exits. Focused on startup injections only.
 *
 * Capture strategy (see PLAN.md, "Option B revised"): a probe user message
 * triggers a turn, before_agent_start captures the chained system prompt and
 * structured prompt options, the turn is aborted at turn_start before any
 * provider request, and the report prints at agent_end.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerFlag("context-inspect", {
		description: "Print initial context injections report (source, tokens) and exit",
		type: "boolean",
		default: false,
	});

	let inspecting = false;

	pi.on("session_start", async (_event, _ctx) => {
		if (pi.getFlag("context-inspect") !== true) return;
		inspecting = true;
		pi.sendUserMessage("probe");
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!inspecting) return;
		// TODO(step 2): capture event.systemPrompt and event.systemPromptOptions
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!inspecting) return;
		ctx.abort();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!inspecting) return;
		// TODO(step 3-4): measure components and render the report
		console.log("pi-context-inspect: report not implemented yet");
		ctx.shutdown();
	});
}
