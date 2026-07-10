/**
 * pi-context-inspect — inspect what occupies the model context.
 *
 * Passively captures the Initial context snapshot from the first observed
 * agent run: structured prompt options and active tools are prepared in
 * before_agent_start, then the snapshot is finalized in the first context
 * event using the final chained system prompt from ctx.getSystemPrompt().
 * The snapshot freezes once captured; later runs never overwrite it.
 *
 * The /context command UI is built on top of this capture (see PLAN.md).
 */
import { type BuildSystemPromptOptions, type ContextEvent, type ExtensionAPI, estimateTokens } from "@earendil-works/pi-coding-agent";

import { analyzeSystemPrompt, type MeasuredComponent, type ToolSlice } from "./measure.ts";
import { renderReport } from "./report.ts";

/** Initial context snapshot, frozen at the first observed agent run. */
interface InitialCapture {
	/** Final chained system prompt (all before_agent_start handlers applied). */
	systemPrompt: string;
	/** Structured inputs pi used to build the base system prompt. */
	systemPromptOptions: BuildSystemPromptOptions;
	/** Extension-injected messages present in the first LLM context. */
	contextMessages: ContextEvent["messages"];
	/** Active tools with provenance, prompt text, and payload definitions. */
	tools: ToolSlice[];
}

/** Inputs prepared in before_agent_start, pending finalization in context. */
interface PendingCapture {
	systemPromptOptions: BuildSystemPromptOptions;
	tools: ToolSlice[];
}

export default function (pi: ExtensionAPI) {
	let pending: PendingCapture | undefined;
	let initial: InitialCapture | undefined;

	pi.on("before_agent_start", async (event) => {
		if (initial !== undefined || pending !== undefined) return;
		// Prepare only: event.systemPrompt is NOT final here — handlers of
		// later-loaded extensions may still append to it. The final chained
		// prompt is read in the context event below.
		const active = new Set(pi.getActiveTools());
		pending = {
			systemPromptOptions: event.systemPromptOptions,
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

	pi.on("context", async (event, ctx) => {
		if (initial !== undefined || pending === undefined) return;
		// All before_agent_start handlers have completed by now, so
		// ctx.getSystemPrompt() is the final chained prompt regardless of
		// extension load order. Freeze the snapshot; never overwrite it.
		initial = {
			systemPrompt: ctx.getSystemPrompt(),
			systemPromptOptions: pending.systemPromptOptions,
			contextMessages: event.messages.filter(isInjectedMessage),
			tools: pending.tools,
		};
		pending = undefined;
		if (process.env["PI_CONTEXT_INSPECT_DEBUG"] !== undefined) {
			console.error(renderReport(measureCapture(initial)));
		}
	});
}

/**
 * True for messages injected into the context by extensions, as opposed to
 * ordinary conversation history. Extension injections via pi.sendMessage()
 * carry role "custom"; user/assistant/tool messages are conversation.
 */
function isInjectedMessage(message: ContextEvent["messages"][number]): boolean {
	return message.role === "custom";
}

/** Normalize promptGuidelines (string | string[] | undefined) to a string array. */
function normalizeGuidelines(guidelines: string | string[] | undefined): string[] {
	if (guidelines === undefined) return [];
	return Array.isArray(guidelines) ? guidelines : [guidelines];
}

/** Measure all captured injections: system prompt components + injected messages. */
function measureCapture(capture: InitialCapture): MeasuredComponent[] {
	const components = analyzeSystemPrompt(capture.systemPrompt, capture.systemPromptOptions, capture.tools);
	for (const message of capture.contextMessages) {
		const label = message.role === "custom" ? `extension message: ${message.customType}` : `injected message (role: ${message.role})`;
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
