/**
 * PoC for pi-context-inspect: verify capture of initial context injections.
 *
 * Spike Option A: at session_start, read ctx.getSystemPromptOptions?.() and
 * ctx.getSystemPrompt(); dump raw components to see what is observable
 * without triggering a turn.
 *
 * Run: pi -e ./poc.ts --context-inspect --no-session
 */
import { type ExtensionAPI, estimateTokens } from "@earendil-works/pi-coding-agent";

function tokens(text: string): number {
	// estimateTokens takes an AgentMessage; wrap text in a minimal user message.
	return estimateTokens({ role: "user", content: text } as Parameters<typeof estimateTokens>[0]);
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("context-inspect", {
		description: "Print initial context injections report and exit",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("context-inspect") !== true) return;

		console.log("=== ctx.mode:", ctx.mode);

		// --- 1. Full chained system prompt as of session_start ---
		const fullPrompt = ctx.getSystemPrompt();
		console.log("=== getSystemPrompt(): length", fullPrompt.length, "chars,", tokens(fullPrompt), "tokens (est)");

		// --- 2. Structured options (feature-detect: optional on event ctx) ---
		const getOptions = (ctx as { getSystemPromptOptions?: () => unknown }).getSystemPromptOptions;
		if (typeof getOptions !== "function") {
			console.log("=== getSystemPromptOptions: NOT AVAILABLE on session_start ctx");
		} else {
			const options = getOptions.call(ctx) as {
				customPrompt?: string;
				selectedTools?: string[];
				toolSnippets?: Record<string, string>;
				promptGuidelines?: string[];
				appendSystemPrompt?: string;
				cwd: string;
				contextFiles?: Array<{ path: string; content: string }>;
				skills?: Array<{ name: string; description: string; filePath: string }>;
			};
			console.log("=== getSystemPromptOptions: AVAILABLE");
			console.log("  customPrompt:", options.customPrompt ? `${options.customPrompt.length} chars` : "(none)");
			console.log("  selectedTools:", options.selectedTools?.join(", ") ?? "(none)");
			console.log("  toolSnippets keys:", Object.keys(options.toolSnippets ?? {}).join(", ") || "(none)");
			console.log("  promptGuidelines:", options.promptGuidelines?.length ?? 0, "items");
			console.log(
				"  appendSystemPrompt:",
				options.appendSystemPrompt ? `${options.appendSystemPrompt.length} chars` : "(none)",
			);
			console.log("  cwd:", options.cwd);
			for (const file of options.contextFiles ?? []) {
				console.log(`  contextFile: ${file.path} — ${file.content.length} chars, ~${tokens(file.content)} tokens`);
			}
			for (const skill of options.skills ?? []) {
				console.log(`  skill: ${skill.name} — desc ${skill.description.length} chars`);
			}
		}

		// --- 3. Does the full prompt include extension additions? ---
		// Marker test: another extension (marker.ts) appends MARKER via before_agent_start;
		// static additions would only appear per-turn. Check if any marker text is present now.
		const hasMarker = fullPrompt.includes("XYZZY_MARKER_INJECTION");
		console.log("=== marker from other extension present in getSystemPrompt():", hasMarker);

		// --- 4. Startup messages already in the session branch ---
		const branch = ctx.sessionManager.getBranch();
		console.log("=== session branch entries at session_start:", branch.length);
		for (const entry of branch) {
			const summary =
				entry.type === "message"
					? `message role=${(entry as { message: { role: string } }).message.role}`
					: `type=${entry.type} customType=${(entry as { customType?: string }).customType ?? "-"}`;
			console.log("  entry:", summary);
		}

		ctx.shutdown();
	});
}
