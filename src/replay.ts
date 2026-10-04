/**
 * Measurement inputs from recorded system state, plus the live prompt/tool
 * fallback when no state was recorded. Usage and Injections share these helpers.
 */
import type { BuildSystemPromptOptions, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage, type Tool } from "@earendil-works/pi-ai";

import {
	analyzeSystemPrompt,
	type DeletedSection,
	type PromptChanges,
	type PromptOptionsSlice,
	type ToolSlice,
} from "./measure.ts";
import { buildSnapshot, type InitialSnapshot, type RequestChange } from "./model.ts";
import type { PromptSourceSlice } from "./prompt-additions.ts";
import type { RequestMessage, SystemChange } from "./snapshot.ts";
import { type SystemMessage, systemMessageText } from "./transcript.ts";

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

/** Inputs for Usage's branch-local prompt/tool estimate. */
export interface UsageSnapshotInput extends NativeSnapshotInput {
	/** Current branch messages; their system messages supply the recorded state. */
	messages: readonly RequestMessage[];
	/** Request-only system changes of the latest request, applied after the replayed state. */
	systemChanges?: readonly SystemChange[];
	/** Forced prompt of the latest request, measured instead of the prompt; tool changes still apply. */
	forcedPrompt?: string;
}

/** System state a request carried, with what its changes touched. */
export interface RequestSystemState {
	readonly state: Pick<SystemMessage, "content" | "sections">;
	readonly declarations: readonly Tool[];
	readonly prompt: PromptChanges;
	readonly tools: ReadonlyMap<string, Exclude<RequestChange, "deleted">>;
	readonly deletedTools: readonly Tool[];
}

/** Build a view-local pi-native fallback without starting a capture. */
export function buildNativeSnapshot(input: NativeSnapshotInput): InitialSnapshot {
	const options = copyPromptOptions(input.options);
	const tools = captureActiveTools(input.allTools, input.activeToolNames, input.options);
	const items = analyzeSystemPrompt(input.systemPrompt, options, tools, { sources: input.promptSources });
	return buildSnapshot(items, "synthetic-probe", input.capturedAt ?? new Date());
}

/**
 * Measure the branch's replayed prompt and tools instead of today's loader
 * prompt/tools, with the latest request's system changes applied once. A forced
 * prompt replaces every section, so only tool changes reach it. Only a branch
 * with no recorded system message yet uses the live fallback.
 */
export function buildUsageSnapshot(input: UsageSnapshotInput): InitialSnapshot {
	const forced = input.forcedPrompt;
	const base = getCurrentSystemMessage(input.messages);
	// Undefined means a branch with no recorded system message yet, not an explicitly empty state
	if (base === undefined) return buildNativeSnapshot({ ...input, systemPrompt: forced ?? input.systemPrompt });
	const request = applySystemChanges(base, input.systemChanges ?? []);
	const tools = replayedToolSlices(request.state, request.declarations, input.allTools);
	const options = copyPromptOptions(input.options);
	const items = analyzeSystemPrompt(forced ?? systemMessageText(request.state), {
		...options,
		// Current loader overrides are not evidence of what this branch recorded.
		customPrompt: undefined, sections: undefined,
		// The replayed layout locates inline or unwrapped request sections; Usage marks no changes
	}, tools, { sources: input.promptSources }, forced === undefined ? { replayed: request.prompt.replayed } : {});
	return buildSnapshot(items, "synthetic-probe", input.capturedAt ?? new Date());
}

/** Apply content, section, and tool changes in capture order to a replayed system state. */
export function applySystemChanges(base: SystemMessage, changes: readonly SystemChange[]): RequestSystemState {
	let content = contentText(base.content);
	const sections: Record<string, string | null> = { ...base.sections };
	const sectionChanges = new Map<string, Exclude<RequestChange, "deleted">>();
	const deletedSections: DeletedSection[] = [];
	const declarations = [...(base.toolsAdded ?? [])];
	const toolChanges = new Map<string, Exclude<RequestChange, "deleted">>();
	const deletedTools: Tool[] = [];
	for (const change of changes) {
		switch (change.type) {
			case "content":
				content = change.text;
				// Pi renders plain content before the first section, inside the measured Preamble
				sectionChanges.set("preamble", "modified");
				break;
			case "section": {
				const previous = sections[change.name];
				if (change.text === null) {
					if (typeof previous === "string") deletedSections.push({ name: change.name, text: previous });
					delete sections[change.name];
					break;
				}
				sectionChanges.set(change.name, typeof previous === "string" ? "modified" : "added");
				sections[change.name] = change.text;
				break;
			}
			case "tool": {
				const index = declarations.findIndex((tool) => tool.name === change.name);
				if (change.declaration === null) {
					if (index !== -1) deletedTools.push(...declarations.splice(index, 1));
				} else if (index === -1) {
					declarations.push(change.declaration);
					toolChanges.set(change.name, "added");
				} else {
					declarations[index] = change.declaration;
					toolChanges.set(change.name, "modified");
				}
				break;
			}
		}
	}
	return {
		state: { content, sections },
		declarations,
		prompt: { sections: sectionChanges, deleted: deletedSections, replayed: { content, sections } },
		tools: toolChanges,
		deletedTools,
	};
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

/** Plain text of system content; text blocks join with a newline, as Pi renders them. */
function contentText(content: SystemMessage["content"]): string {
	return typeof content === "string" ? content : content.map((block) => block.text).join("\n");
}

/** Normalize the string-or-array promptGuidelines field to an owned array. */
function normalizeGuidelines(guidelines: string | string[] | undefined): string[] {
	if (guidelines === undefined) return [];
	return Array.isArray(guidelines) ? [...guidelines] : [guidelines];
}
