/**
 * Measurement inputs from recorded system state, plus the live prompt/tool
 * fallback when no state was recorded. Usage and Injections share these helpers.
 */
import type { BuildSystemPromptOptions, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@earendil-works/pi-ai";

import { analyzeSystemPrompt, type PromptOptionsSlice, type ToolSlice } from "./measure.ts";
import { buildSnapshot, type InitialSnapshot } from "./model.ts";
import type { PromptSourceSlice } from "./prompt-additions.ts";
import type { SystemMessage } from "./transcript.ts";

/** Inputs for an on-demand pi-native prompt/tool fallback without recorded system state. */
export interface NativeSnapshotInput {
	systemPrompt: string;
	options: BuildSystemPromptOptions;
	allTools: readonly ToolInfo[];
	activeToolNames: readonly string[];
	/** Loaded extension provenance, used only to guess who appended prompt text. */
	promptSources?: readonly PromptSourceSlice[];
	capturedAt?: Date;
}

/** Build a view-local pi-native fallback without starting a capture. */
export function buildNativeSnapshot(input: NativeSnapshotInput): InitialSnapshot {
	const options = copyPromptOptions(input.options);
	const tools = captureActiveTools(input.allTools, input.activeToolNames, input.options);
	const items = analyzeSystemPrompt(input.systemPrompt, options, tools, { sources: input.promptSources });
	return buildSnapshot(items, "synthetic-probe", input.capturedAt ?? new Date());
}

/** Copy the prompt-options slice used by measurement, without shared nested references. */
export function copyPromptOptions(options: BuildSystemPromptOptions): PromptOptionsSlice {
	return {
		homeDir: process.env.HOME,
		customPrompt: options.customPrompt,
		sections: options.sections === undefined ? undefined : { ...options.sections },
	};
}

/**
 * Snapshot the final active tool set with provenance and payload definitions.
 * Keep pi's active-tool order: it decides which tool owns a guideline bullet
 * that several tools declare.
 */
export function captureActiveTools(
	allTools: readonly ToolInfo[],
	activeToolNames: readonly string[],
	options: { readonly toolSnippets?: Readonly<Record<string, string>> },
): ToolSlice[] {
	const byName = new Map(allTools.map((tool) => [tool.name, tool]));
	return [...new Set(activeToolNames)]
		.map((name) => byName.get(name))
		.filter((tool) => tool !== undefined)
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parametersJson: JSON.stringify(tool.parameters ?? {}),
			snippet: options.toolSnippets?.[tool.name],
			guidelines: normalizeGuidelines(tool.promptGuidelines),
			source: tool.sourceInfo.source,
		}));
}

/**
 * Tool slices for recorded declarations. The declaration supplies name,
 * description, and schema; the prompt snippet comes from the recorded `tools`
 * section. Current registration metadata supplies only guidelines and
 * provenance; an unregistered tool stays unattributed.
 */
export function replayedToolSlices(
	state: Pick<SystemMessage, "sections">,
	declarations: readonly Tool[],
	allTools: readonly ToolInfo[],
): ToolSlice[] {
	const registered = new Map(allTools.map((tool) => [tool.name, tool]));
	const snippetLines = state.sections?.tools?.split("\n") ?? [];
	return declarations.map((tool) => {
		const metadata = registered.get(tool.name);
		const snippetLine = snippetLines.find((line) => line.startsWith(`- ${tool.name}: `));
		return {
			name: tool.name,
			description: tool.description,
			parametersJson: JSON.stringify(tool.parameters),
			snippet: snippetLine?.slice(`- ${tool.name}: `.length),
			guidelines: normalizeGuidelines(metadata?.promptGuidelines),
			source: metadata?.sourceInfo.source ?? "unattributed",
		};
	});
}

/** Normalize the string-or-array promptGuidelines field to an owned array. */
function normalizeGuidelines(guidelines: string | string[] | undefined): string[] {
	if (guidelines === undefined) return [];
	return Array.isArray(guidelines) ? [...guidelines] : [guidelines];
}
