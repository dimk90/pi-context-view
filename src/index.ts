/**
 * pi-context-inspect — report initial context injections.
 *
 * Adds a --context-inspect CLI flag. When set, pi prints a table of initial
 * context injections (source: pi native or extension, size in estimated
 * tokens) and exits. Focused on startup injections only.
 *
 * Capture strategy (see PLAN.md, "Option B revised"): a probe user message
 * triggers a turn, before_agent_start captures the chained system prompt and
 * structured prompt options, the context event captures messages injected by
 * other extensions, the turn is aborted at turn_start before any provider
 * request, and the report prints at agent_end.
 */
import { type BuildSystemPromptOptions, type ContextEvent, type ExtensionAPI, estimateTokens } from "@earendil-works/pi-coding-agent";

import { analyzeSystemPrompt, type MeasuredComponent } from "./measure.ts";
import { renderReport } from "./report.ts";

const PROBE_TEXT = "pi-context-inspect probe";

/** Everything captured during the probe turn. */
interface Capture {
	/** Fully chained system prompt as seen at our position in the handler chain. */
	systemPrompt: string;
	/** Structured inputs pi used to build the base system prompt. */
	systemPromptOptions: BuildSystemPromptOptions;
	/** Messages present in the LLM context at the probe turn (excluding the probe itself). */
	contextMessages: ContextEvent["messages"];
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("context-inspect", {
		description: "Print initial context injections report (source, tokens) and exit",
		type: "boolean",
		default: false,
	});

	let inspecting = false;
	let capture: Capture | undefined;
	let shutdownRetry: NodeJS.Timeout | undefined;

	pi.on("session_start", async (_event, _ctx) => {
		if (pi.getFlag("context-inspect") !== true) return;
		inspecting = true;
		// sendUserMessage (unlike sendMessage + triggerTurn) starts a turn even
		// in print mode without -p.
		pi.sendUserMessage(PROBE_TEXT);
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!inspecting) return;
		capture = {
			systemPrompt: event.systemPrompt,
			systemPromptOptions: event.systemPromptOptions,
			contextMessages: [],
		};
	});

	pi.on("context", async (event, _ctx) => {
		if (!inspecting || capture === undefined) return;
		capture.contextMessages = event.messages.filter((message) => !isProbeMessage(message));
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!inspecting) return;
		// Abort before any provider request; later hooks are unreliable for
		// custom providers (see AGENTS.md).
		ctx.abort();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!inspecting) return;
		if (capture === undefined) {
			console.error("pi-context-inspect: capture failed (before_agent_start did not fire)");
		} else {
			console.log(renderReport(measureCapture(capture)));
		}
		// The probe turn can finish BEFORE the TUI subscribes to agent events
		// (extensions bind first), so a single deferred shutdown request would
		// never be honored — the TUI checks the flag only when it sees agent_end.
		// Retry until the request lands: ctx.shutdown() executes immediately when
		// pi is idle. The ctx goes stale once shutdown proceeds (or in print mode
		// once the process is exiting), so stop retrying on any error and on
		// session_shutdown.
		ctx.shutdown();
		shutdownRetry = setInterval(() => {
			try {
				if (ctx.isIdle()) ctx.shutdown();
			} catch {
				clearInterval(shutdownRetry);
				shutdownRetry = undefined;
			}
		}, 100);
	});

	pi.on("session_shutdown", async () => {
		if (shutdownRetry !== undefined) {
			clearInterval(shutdownRetry);
			shutdownRetry = undefined;
		}
	});
}

/** True for the synthetic user message this extension sends to trigger the probe turn. */
function isProbeMessage(message: ContextEvent["messages"][number]): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string") return message.content === PROBE_TEXT;
	return message.content.some((block) => block.type === "text" && block.text === PROBE_TEXT);
}

/** Measure all captured injections: system prompt components + injected messages. */
function measureCapture(capture: Capture): MeasuredComponent[] {
	const components = analyzeSystemPrompt(capture.systemPrompt, capture.systemPromptOptions);
	for (const message of capture.contextMessages) {
		const label =
			message.role === "custom"
				? `extension message: ${message.customType}`
				: `startup message (role: ${message.role})`;
		const content = "content" in message ? message.content : undefined;
		const text = typeof content === "string" ? content : JSON.stringify(content ?? message);
		components.push({
			label,
			group: "extensions",
			chars: text.length,
			tokens: estimateTokens(message),
			text,
		});
	}
	return components;
}
