/**
 * PoC Option B: trigger a synthetic turn at session_start, capture the fully
 * chained system prompt + structured options in before_agent_start, then
 * abort before any provider request and shut down.
 *
 * Run: pi -e ./marker.ts -e ./poc-b.ts --context-inspect --no-session
 */
import { type ExtensionAPI, estimateTokens } from "@earendil-works/pi-coding-agent";

function tokens(text: string): number {
	return estimateTokens({ role: "user", content: text } as Parameters<typeof estimateTokens>[0]);
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("context-inspect", {
		description: "Print initial context injections report and exit",
		type: "boolean",
		default: false,
	});

	let inspecting = false;

	pi.on("session_start", async (_event, _ctx) => {
		if (pi.getFlag("context-inspect") !== true) return;
		inspecting = true;
		console.log("=== session_start: mode", _ctx.mode, "— sending probe message");
		// Trigger a synthetic turn so before_agent_start fires.
		// sendUserMessage (unlike sendMessage+triggerTurn) starts a turn even in
		// print mode without -p.
		pi.sendUserMessage("probe");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!inspecting) return;

		console.log("=== before_agent_start fired (synthetic turn)");
		const prompt = event.systemPrompt;
		console.log("=== event.systemPrompt:", prompt.length, "chars,", tokens(prompt), "tokens (est)");
		console.log("=== marker present:", prompt.includes("XYZZY_MARKER_INJECTION"));

		const options = event.systemPromptOptions as
			| {
					customPrompt?: string;
					selectedTools?: string[];
					toolSnippets?: Record<string, string>;
					promptGuidelines?: string[];
					appendSystemPrompt?: string;
					cwd: string;
					contextFiles?: Array<{ path: string; content: string }>;
					skills?: Array<{ name: string; description: string }>;
			  }
			| undefined;

		if (!options) {
			console.log("=== event.systemPromptOptions: NOT AVAILABLE");
		} else {
			console.log("=== event.systemPromptOptions: AVAILABLE");
			console.log("  customPrompt:", options.customPrompt ? `${options.customPrompt.length} chars` : "(none)");
			console.log("  selectedTools:", options.selectedTools?.join(", ") ?? "(none)");
			console.log("  promptGuidelines:", options.promptGuidelines?.length ?? 0, "items");
			console.log(
				"  appendSystemPrompt:",
				options.appendSystemPrompt ? `${options.appendSystemPrompt.length} chars` : "(none)",
			);
			for (const file of options.contextFiles ?? []) {
				console.log(`  contextFile: ${file.path} — ${file.content.length} chars, ~${tokens(file.content)} tokens`);
			}
			for (const skill of options.skills ?? []) {
				console.log(`  skill: ${skill.name}`);
			}
		}

		// Startup messages visible in branch now?
		const custom = ctx.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message" || entry.type === "custom");
		console.log("=== message/custom entries in branch:", custom.length);
		for (const entry of custom) {
			const info =
				entry.type === "message"
					? `message role=${(entry as { message: { role: string; customType?: string } }).message.role} customType=${(entry as { message: { customType?: string } }).message.customType ?? "-"}`
					: `custom customType=${(entry as { customType?: string }).customType ?? "-"}`;
			console.log("  ", info);
		}

		console.log("=== capture done; aborting at turn_start");
	});

	// Abort before any provider call. Proven: no request is sent.
	pi.on("turn_start", async (_event, ctx) => {
		if (!inspecting) return;
		ctx.abort();
	});

	// Verify no response ever arrives.
	pi.on("after_provider_response", async (event) => {
		if (inspecting) {
			console.log("!!! after_provider_response fired — provider call NOT prevented, status:", event.status);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!inspecting) return;
		console.log("=== agent_end: report would print here; shutting down");
		// In TUI mode shutdown is deferred until idle and honored right after
		// agent_end (checkShutdownRequested); in print mode exit is automatic.
		ctx.shutdown();
	});
}
