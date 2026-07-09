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

import { analyzeSystemPrompt, type MeasuredComponent, type ToolSlice } from "./measure.ts";
import { renderReport } from "./report.ts";

const PROBE_TEXT = "pi-context-inspect probe";

/** How long to wait for the probe turn before giving up (ms). */
const WATCHDOG_TIMEOUT_MS = 15_000;

/**
 * Grace period before requesting shutdown (ms). Other extensions may still be
 * running async startup work (config loads, tool refreshes); shutting down
 * immediately makes their in-flight calls hit a stale ctx and spam stderr.
 */
const SHUTDOWN_GRACE_MS = 500;

/** Everything captured during the probe turn. */
interface Capture {
	/** Fully chained system prompt as seen at our position in the handler chain. */
	systemPrompt: string;
	/** Structured inputs pi used to build the base system prompt. */
	systemPromptOptions: BuildSystemPromptOptions;
	/** Messages present in the LLM context at the probe turn (excluding the probe itself). */
	contextMessages: ContextEvent["messages"];
	/** Active tools with provenance, prompt text, and payload definitions. */
	tools: ToolSlice[];
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("context-inspect", {
		description: "Print initial context injections report (source, tokens) and exit",
		type: "boolean",
		default: false,
	});

	let inspecting = false;
	let reportDone = false;
	let capture: Capture | undefined;
	let shutdownRetry: NodeJS.Timeout | undefined;

	pi.on("session_start", async (event, ctx) => {
		if (pi.getFlag("context-inspect") !== true) return;
		// Only inspect the initial startup; a /reload, /resume, or /fork with the
		// flag still set must not re-trigger the probe.
		if (event.reason !== "startup") return;
		// JSON mode: a raw text report would corrupt the machine-readable stream.
		if (ctx.mode === "json") {
			console.error("pi-context-inspect: --context-inspect is not supported in --mode json");
			ctx.shutdown();
			return;
		}
		inspecting = true;
		// Watchdog: if the probe turn never reaches agent_end (pi internals
		// changed, provider refused to start a turn, ...), report and bail out
		// instead of leaving pi sitting open. unref() keeps print mode free to
		// exit earlier on its own.
		const watchdog = setTimeout(() => {
			if (!reportDone) {
				console.error("pi-context-inspect: probe turn did not complete; no report. Try without other extensions.");
				ctx.shutdown();
			}
		}, WATCHDOG_TIMEOUT_MS);
		watchdog.unref();
	});

	// The probe is sent from resources_discover, not session_start: it fires
	// after every extension's session_start work — including late async tool
	// registrations (e.g. pi-web-providers) — so the probe turn sees the
	// complete tool set. sendUserMessage (unlike sendMessage + triggerTurn)
	// starts a turn even in print mode without -p.
	pi.on("resources_discover", async () => {
		if (!inspecting) return;
		pi.sendUserMessage(PROBE_TEXT);
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!inspecting) return;
		const active = new Set(pi.getActiveTools());
		capture = {
			systemPrompt: event.systemPrompt,
			systemPromptOptions: event.systemPromptOptions,
			contextMessages: [],
			tools: pi
				.getAllTools()
				.filter((tool) => active.has(tool.name))
				.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parametersJson: JSON.stringify(tool.parameters ?? {}),
					snippet: event.systemPromptOptions.toolSnippets?.[tool.name],
					guidelines: normalizeGuidelines(tool.promptGuidelines),
					source: tool.sourceInfo.source,
				})),
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
		if (!inspecting || reportDone) return;
		// TUI mode: don't print into the running TUI — the table would interleave
		// with UI frames. session_shutdown fires after the TUI is stopped, so the
		// report lands on a clean terminal instead.
		if (ctx.mode !== "tui") {
			printReport();
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
		// Grace period: in print mode pi exits as soon as the (aborted) probe
		// turn drains, which can cut off other extensions' in-flight async
		// startup work and spam "stale ctx" errors. session_shutdown handlers
		// are awaited, so waiting here lets that work finish first.
		if (inspecting) {
			await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
		}
		// TUI mode prints here (terminal is clean once the TUI stopped). Also the
		// fallback for print mode when pi exits before the probe turn reaches
		// agent_end — capture happens earlier (before_agent_start) either way.
		if (inspecting && !reportDone) {
			printReport();
		}
	});

	function printReport(): void {
		reportDone = true;
		if (capture === undefined) {
			console.error("pi-context-inspect: capture failed (before_agent_start did not fire)");
		} else {
			console.log(renderReport(measureCapture(capture)));
		}
	}
}

/** True for the synthetic user message this extension sends to trigger the probe turn. */
function isProbeMessage(message: ContextEvent["messages"][number]): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string") return message.content === PROBE_TEXT;
	return message.content.some((block) => block.type === "text" && block.text === PROBE_TEXT);
}

/** Normalize promptGuidelines (string | string[] | undefined) to a string array. */
function normalizeGuidelines(guidelines: string | string[] | undefined): string[] {
	if (guidelines === undefined) return [];
	return Array.isArray(guidelines) ? guidelines : [guidelines];
}

/** Measure all captured injections: system prompt components + injected messages. */
function measureCapture(capture: Capture): MeasuredComponent[] {
	const components = analyzeSystemPrompt(capture.systemPrompt, capture.systemPromptOptions, capture.tools);
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
