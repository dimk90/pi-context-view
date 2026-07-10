/**
 * Initial capture state and conversion from pi event data to the semantic
 * model. Event registration remains in index.ts; this module is independently
 * unit-testable.
 */
import {
	type BuildSystemPromptOptions,
	type ContextEvent,
	estimateTokens,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import { analyzeSystemPrompt, type PromptOptionsSlice, type ToolSlice } from "./measure.ts";
import {
	buildSnapshot,
	type CaptureOrigin,
	type InitialSnapshot,
	type InjectionItem,
	type InjectionSource,
} from "./model.ts";

/** Everything available when the first context event finalizes a snapshot. */
export interface CaptureFinalization {
	systemPrompt: string;
	messages: ContextEvent["messages"];
	allTools: readonly ToolInfo[];
	activeToolNames: readonly string[];
	origin: CaptureOrigin;
	capturedAt?: Date;
}

/**
 * Capture-once state machine. `prepare()` refreshes the structured options on
 * every run until `finalize()` succeeds; subsequent finalizations return the
 * original snapshot unchanged.
 */
export class InitialCaptureState {
	private pendingOptions: BuildSystemPromptOptions | undefined;
	private initialSnapshot: InitialSnapshot | undefined;

	public get snapshot(): InitialSnapshot | undefined {
		return this.initialSnapshot;
	}

	public prepare(options: BuildSystemPromptOptions): void {
		if (this.initialSnapshot !== undefined) return;
		this.pendingOptions = options;
	}

	public finalize(input: CaptureFinalization): InitialSnapshot | undefined {
		if (this.initialSnapshot !== undefined) return this.initialSnapshot;
		if (this.pendingOptions === undefined) return undefined;

		const options = copyPromptOptions(this.pendingOptions);
		const tools = captureActiveTools(input.allTools, input.activeToolNames, this.pendingOptions);
		const items = [
			...analyzeSystemPrompt(input.systemPrompt, options, tools),
			...measureInjectedMessages(input.messages),
		];
		this.initialSnapshot = buildSnapshot(items, input.origin, input.capturedAt ?? new Date());
		this.pendingOptions = undefined;
		return this.initialSnapshot;
	}
}

/** Copy the prompt-options slice used by measurement, without shared nested references. */
export function copyPromptOptions(options: BuildSystemPromptOptions): PromptOptionsSlice {
	return {
		cwd: options.cwd,
		customPrompt: options.customPrompt,
		appendSystemPrompt: options.appendSystemPrompt,
		contextFiles: options.contextFiles?.map((file) => ({ path: file.path, content: file.content })),
		skills: options.skills?.map((skill) => ({ name: skill.name })),
	};
}

/** Snapshot the final active tool set with provenance and payload definitions. */
export function captureActiveTools(
	allTools: readonly ToolInfo[],
	activeToolNames: readonly string[],
	options: BuildSystemPromptOptions,
): ToolSlice[] {
	const active = new Set(activeToolNames);
	return allTools
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

/** Measure custom-role messages, the reliable public marker for extension messages. */
export function measureInjectedMessages(messages: ContextEvent["messages"]): InjectionItem[] {
	const occurrences = new Map<string, number>();
	const items: InjectionItem[] = [];
	for (const message of messages) {
		if (message.role !== "custom") continue;
		const occurrence = occurrences.get(message.customType) ?? 0;
		occurrences.set(message.customType, occurrence + 1);
		const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		const source = messageSource(message.customType);
		items.push({
			id: `message:${message.customType}:${occurrence}`,
			phase: "initial",
			kind: "message",
			source,
			label: "message",
			chars: text.length,
			tokens: estimateTokens(message),
			text,
		});
	}
	return items;
}

function messageSource(customType: string): InjectionSource {
	return { id: `message-type:${customType}`, label: customType, native: false };
}

function normalizeGuidelines(guidelines: string | string[] | undefined): string[] {
	if (guidelines === undefined) return [];
	return Array.isArray(guidelines) ? [...guidelines] : [guidelines];
}
