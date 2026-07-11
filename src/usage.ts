/**
 * Pure context-usage classification: combine the frozen Initial snapshot's
 * prompt/tool decomposition with the live session messages into estimated
 * category totals. No pi API access — unit-testable.
 */
import { type ContextEvent, type ContextUsage, estimateTokens } from "@earendil-works/pi-coding-agent";

import type {
	ContextUsageSnapshot,
	InitialSnapshot,
	InjectionItem,
	ReportedContextUsage,
	UsageCategory,
} from "./model.ts";

/** Everything computeUsage needs; messages must already be synthetic-filtered. */
export interface UsageInputs {
	snapshot: InitialSnapshot;
	messages: ContextEvent["messages"];
	reported?: ReportedContextUsage;
	modelLabel?: string;
	computedAt?: Date;
}

/**
 * Estimate the current/next-request context composition. Prompt and tool
 * categories come from the frozen Initial snapshot; message categories are
 * classified from the live session context. Empty categories are dropped and
 * every aggregate equals the exact sum of its children.
 */
export function computeUsage(inputs: UsageInputs): ContextUsageSnapshot {
	const categories = [
		...classifyPromptCategories(inputs.snapshot),
		...classifyMessages(inputs.messages),
	].filter((category) => category.tokens > 0);
	return {
		computedAt: inputs.computedAt ?? new Date(),
		modelLabel: inputs.modelLabel,
		reported: inputs.reported,
		categories,
		estimatedTokens: categories.reduce((sum, category) => sum + category.tokens, 0),
	};
}

/** Convert pi's nullable ContextUsage to the undefined-based model shape. */
export function toReportedUsage(usage: ContextUsage | undefined): ReportedContextUsage | undefined {
	if (usage === undefined) return undefined;
	return {
		tokens: usage.tokens ?? undefined,
		contextWindow: usage.contextWindow,
		percent: usage.percent ?? undefined,
	};
}

/** Map frozen snapshot items to prompt/tool/memory/skill categories. */
function classifyPromptCategories(snapshot: InitialSnapshot): UsageCategory[] {
	const systemPrompt: UsageCategory[] = [];
	const systemTools: UsageCategory[] = [];
	const customTools: UsageCategory[] = [];
	const mcpTools: UsageCategory[] = [];
	const contextFiles: UsageCategory[] = [];
	const skills: UsageCategory[] = [];
	for (const group of snapshot.groups) {
		for (const item of group.items) {
			switch (item.kind) {
				case "base-prompt":
				case "append-prompt":
				case "prompt-addition":
					systemPrompt.push(leafFromItem(item));
					break;
				case "tool":
					if (item.source.native) systemTools.push(...breakdownFromItem(item));
					else if (isMcpTool(item)) mcpTools.push(leafFromItem(item));
					else customTools.push(leafFromItem(item));
					break;
				case "context-file":
					contextFiles.push(leafFromItem(item));
					break;
				case "skills":
					skills.push(...breakdownFromItem(item));
					break;
				case "message":
					// Initial custom messages live in the session; classifyMessages counts them.
					break;
			}
		}
	}
	return withoutEmpty([
		aggregate("system-prompt", "System Prompt", systemPrompt),
		aggregate("system-tools", "System Tools", systemTools),
		aggregate("custom-tools", "Custom Tools", customTools),
		aggregate("mcp-tools", "MCP Tools", mcpTools),
		aggregate("context-files", "Memory (AGENTS.md)", contextFiles),
		aggregate("skills", "Skills", skills),
	]);
}

/** Best-effort MCP attribution from the only public provenance field available. */
function isMcpTool(item: InjectionItem): boolean {
	return /(^|[^a-z])mcp([^a-z]|$)/i.test(`${item.source.id} ${item.source.label}`);
}

/** Classify live session messages into estimated categories. */
function classifyMessages(messages: ContextEvent["messages"]): UsageCategory[] {
	let userTokens = 0;
	let assistantTextChars = 0;
	let thinkingChars = 0;
	let toolCallChars = 0;
	let bashTokens = 0;
	let compactedTokens = 0;
	const toolResults = new Map<string, number>();
	const customMessages = new Map<string, number>();

	for (const message of messages) {
		switch (message.role) {
			case "user":
				userTokens += estimateTokens(message);
				break;
			case "assistant":
				for (const block of message.content) {
					if (block.type === "text") assistantTextChars += block.text.length;
					else if (block.type === "thinking") thinkingChars += block.thinking.length;
					else if (block.type === "toolCall") {
						toolCallChars += block.name.length + JSON.stringify(block.arguments).length;
					}
				}
				break;
			case "toolResult":
				addTokens(toolResults, message.toolName, estimateTokens(message));
				break;
			case "custom":
				addTokens(customMessages, message.customType, estimateTokens(message));
				break;
			case "bashExecution":
				if (message.excludeFromContext !== true) bashTokens += estimateTokens(message);
				break;
			case "branchSummary":
			case "compactionSummary":
				compactedTokens += estimateTokens(message);
				break;
		}
	}

	const assistant = aggregate("assistant-messages", "Assistant Messages", withoutEmpty([
		leaf("assistant-text", "Text", textTokens(assistantTextChars)),
		leaf("assistant-thinking", "Thinking", textTokens(thinkingChars)),
		leaf("assistant-tool-calls", "Tool Calls", textTokens(toolCallChars)),
	]));
	const conversation = aggregate("messages", "Messages", withoutEmpty([
		leaf("user-messages", "User Messages", userTokens),
		assistant,
		aggregate("tool-results", "Tool Results", leavesFromMap("tool-result", toolResults)),
		leaf("bash-executions", "Bash Executions", bashTokens),
	]));
	return withoutEmpty([
		conversation,
		aggregate("extension-messages", "Extensions", leavesFromMap("custom-message", customMessages)),
		leaf("compacted-data", "Compacted Data", compactedTokens),
	]);
}

/** One category without children. */
function leaf(id: string, label: string, tokens: number): UsageCategory {
	return { id, label, tokens };
}

/** Category carrying a snapshot item's label and estimate. */
function leafFromItem(item: InjectionItem): UsageCategory {
	return leaf(`item:${item.id}`, item.label, item.tokens);
}

/** Expand an aggregate snapshot item into its children, or itself when it has none. */
function breakdownFromItem(item: InjectionItem): UsageCategory[] {
	if (item.children === undefined || item.children.length === 0) return [leafFromItem(item)];
	return item.children.map((child) => leafFromItem(child));
}

/** Parent category whose total is the exact sum of its children; undefined when empty. */
function aggregate(id: string, label: string, children: UsageCategory[]): UsageCategory | undefined {
	if (children.length === 0) return undefined;
	return {
		id,
		label,
		tokens: children.reduce((sum, child) => sum + child.tokens, 0),
		children: [...children].sort((a, b) => b.tokens - a.tokens),
	};
}

/** Keep only present categories with a non-zero estimate. */
function withoutEmpty(categories: Array<UsageCategory | undefined>): UsageCategory[] {
	return categories.filter((category): category is UsageCategory => category !== undefined && category.tokens > 0);
}

/** Accumulate an estimate under a map key. */
function addTokens(totals: Map<string, number>, key: string, tokens: number): void {
	totals.set(key, (totals.get(key) ?? 0) + tokens);
}

/** Sorted leaves from accumulated per-key totals. */
function leavesFromMap(idPrefix: string, totals: Map<string, number>): UsageCategory[] {
	return [...totals.entries()].map(([label, tokens]) => leaf(`${idPrefix}:${label}`, label, tokens));
}

/** Same chars/4 heuristic pi's estimateTokens uses for text content. */
function textTokens(chars: number): number {
	return Math.ceil(chars / 4);
}
