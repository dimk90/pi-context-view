/**
 * pi-context-inspect — inspect what occupies the model context.
 *
 * Passively captures the Initial context snapshot from the first observed
 * agent run: structured prompt options are saved in before_agent_start (the
 * only place they exist), then the snapshot is finalized in the first context
 * event — final chained system prompt, final active tool set, and injected
 * messages — after every extension's handlers have run. The snapshot holds
 * owned copies and freezes once captured; later runs never overwrite it.
 *
 * The /context command UI is built on top of this capture (see PLAN.md).
 */
import type { BuildSystemPromptOptions, ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { PromptOptionsSlice, ToolSlice } from "./measure.ts";

/** Initial context snapshot, frozen as owned copies at the first observed agent run. */
interface InitialCapture {
	/** Final chained system prompt (all before_agent_start handlers applied). */
	systemPrompt: string;
	/** Structured inputs pi used to build the base system prompt. */
	promptOptions: PromptOptionsSlice;
	/** Extension-injected messages present in the first LLM context. */
	contextMessages: ContextEvent["messages"];
	/** Active tools with provenance, prompt text, and payload definitions. */
	tools: ToolSlice[];
}

export default function (pi: ExtensionAPI) {
	let pendingOptions: BuildSystemPromptOptions | undefined;
	let initial: InitialCapture | undefined;

	pi.on("before_agent_start", (event) => {
		if (initial !== undefined) return;
		// Save only the prompt options: everything else (final prompt, active
		// tools) is read in the context event, after all handlers have run.
		// Refresh on every run until the snapshot freezes so a run aborted
		// before its context event cannot leave stale options behind.
		pendingOptions = event.systemPromptOptions;
	});

	pi.on("context", (event, ctx) => {
		if (initial !== undefined || pendingOptions === undefined) return;
		// All before_agent_start handlers have completed by now: the chained
		// system prompt and the active tool set (setActiveTools mutations
		// applied) are final for this request regardless of extension load
		// order. Freeze owned copies; later mutations cannot leak in.
		initial = {
			systemPrompt: ctx.getSystemPrompt(),
			promptOptions: copyPromptOptions(pendingOptions),
			contextMessages: structuredClone(event.messages.filter(isInjectedMessage)),
			tools: captureActiveTools(pi, pendingOptions),
		};
		pendingOptions = undefined;
	});
}

/**
 * True for messages this extension treats as extension injections. Injections
 * via pi.sendMessage() carry role "custom". Extensions can also inject
 * user/assistant/tool-role messages from context handlers; detecting those
 * requires diffing against the session branch (see PLAN.md, steps 2+).
 */
function isInjectedMessage(message: ContextEvent["messages"][number]): boolean {
	return message.role === "custom";
}

/** Copy the slice of the prompt options that measurement needs (owned, no shared references). */
function copyPromptOptions(options: BuildSystemPromptOptions): PromptOptionsSlice {
	return {
		cwd: options.cwd,
		customPrompt: options.customPrompt,
		appendSystemPrompt: options.appendSystemPrompt,
		contextFiles: options.contextFiles?.map((file) => ({ path: file.path, content: file.content })),
		skills: options.skills?.map((skill) => ({ name: skill.name })),
	};
}

/** Snapshot the final active tool set with provenance, prompt snippets, and payload definitions. */
function captureActiveTools(pi: ExtensionAPI, options: BuildSystemPromptOptions): ToolSlice[] {
	const active = new Set(pi.getActiveTools());
	return pi
		.getAllTools()
		.filter((tool) => active.has(tool.name))
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parametersJson: JSON.stringify(tool.parameters ?? {}),
			snippet: options.toolSnippets?.[tool.name],
			guidelines: normalizeGuidelines(tool.promptGuidelines),
			source: tool.sourceInfo.source,
		}));
}

/** Normalize promptGuidelines (string | string[] | undefined) to a string array. */
function normalizeGuidelines(guidelines: string | string[] | undefined): string[] {
	if (guidelines === undefined) return [];
	return Array.isArray(guidelines) ? guidelines : [guidelines];
}
