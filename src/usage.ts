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
	UsagePreviewEntry,
} from "./model.ts";

/** Everything computeUsage needs; messages must already be synthetic-filtered. */
export interface UsageInputs {
	snapshot: InitialSnapshot;
	messages: ContextEvent["messages"];
	reported?: ReportedContextUsage;
	modelLabel?: string;
	computedAt?: Date;
	/** Auto-compaction reserve (settings `reserveTokens`); omit when auto-compaction is disabled. */
	autoCompactReserveTokens?: number;
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
		...classifyMessages(inputs.messages, contextOnlyMessages(inputs.snapshot)),
	].filter((category) => category.tokens > 0);
	return {
		computedAt: inputs.computedAt ?? new Date(),
		modelLabel: inputs.modelLabel,
		reported: inputs.reported,
		categories,
		estimatedTokens: categories.reduce((sum, category) => sum + category.tokens, 0),
		autoCompactReserveTokens: inputs.autoCompactReserveTokens,
	};
}

/**
 * Flatten one category's preview entries across its breakdown, chronologically
 * when every entry is message-backed. Raw entry text is process-local; the
 * caller must sanitize before rendering and never log or persist it.
 */
export function collectPreviewEntries(category: UsageCategory): UsagePreviewEntry[] {
	const entries: UsagePreviewEntry[] = [];
	const visit = (node: UsageCategory): void => {
		entries.push(...(node.entries ?? []));
		for (const child of node.children ?? []) visit(child);
	};
	visit(category);
	if (entries.length > 1 && entries.every((entry) => entry.timestamp !== undefined)) {
		entries.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
	}
	return entries;
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

/** Collect frozen messages that existed only in the transformed provider context. */
function contextOnlyMessages(snapshot: InitialSnapshot): InjectionItem[] {
	return snapshot.groups.flatMap((group) =>
		group.items.filter((item) => item.kind === "message" && item.contextOnly === true)
	);
}

/** Classify live session messages and frozen context-only injections with preview entries. */
function classifyMessages(
	messages: ContextEvent["messages"],
	contextOnly: readonly InjectionItem[],
): UsageCategory[] {
	const user: UsagePreviewEntry[] = [];
	const agentText: UsagePreviewEntry[] = [];
	const agentThinking: UsagePreviewEntry[] = [];
	const agentToolCalls: UsagePreviewEntry[] = [];
	const bashExecutions: UsagePreviewEntry[] = [];
	const compacted: UsagePreviewEntry[] = [];
	const toolResults = new Map<string, UsagePreviewEntry[]>();
	const customMessages = new Map<string, UsagePreviewEntry[]>();

	for (const item of contextOnly) {
		appendEntry(customMessages, item.source.label, {
			breadcrumb: [item.label],
			tokens: item.tokens,
			text: item.text,
		});
	}
	for (const message of messages) {
		switch (message.role) {
			case "user":
				user.push({
					timestamp: message.timestamp,
					breadcrumb: ["user"],
					tokens: estimateTokens(message),
					text: contentToText(message.content),
				});
				break;
			case "assistant": {
				const texts = message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
				const thinkings = message.content.flatMap((block) =>
					block.type === "thinking" ? [block.thinking] : []
				);
				agentText.push(...blockEntries(message.timestamp, "text", texts));
				agentThinking.push(...blockEntries(message.timestamp, "thinking", thinkings));
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const args = JSON.stringify(block.arguments);
					agentToolCalls.push({
						timestamp: message.timestamp,
						breadcrumb: ["assistant", block.name],
						tokens: textTokens(block.name.length + args.length),
						text: `${block.name}(${args})`,
					});
				}
				break;
			}
			case "toolResult":
				appendEntry(toolResults, message.toolName, {
					timestamp: message.timestamp,
					breadcrumb: [message.toolName],
					tokens: estimateTokens(message),
					text: contentToText(message.content),
				});
				break;
			case "custom":
				appendEntry(customMessages, message.customType, {
					timestamp: message.timestamp,
					breadcrumb: [message.customType],
					tokens: estimateTokens(message),
					text: contentToText(message.content),
				});
				break;
			case "bashExecution":
				if (message.excludeFromContext !== true) {
					bashExecutions.push({
						timestamp: message.timestamp,
						breadcrumb: ["bash"],
						tokens: estimateTokens(message),
						text: `$ ${message.command}\n${message.output}`,
					});
				}
				break;
			case "branchSummary":
				compacted.push({
					timestamp: message.timestamp,
					breadcrumb: ["branch"],
					tokens: estimateTokens(message),
					text: message.summary,
				});
				break;
			case "compactionSummary":
				compacted.push({
					timestamp: message.timestamp,
					breadcrumb: ["compaction"],
					tokens: estimateTokens(message),
					text: message.summary,
				});
				break;
		}
	}

	const toolOutput = aggregate("tool-output", "Tool Output", withoutEmpty([
		...leavesFromMap("tool-result", toolResults),
		leaf("bash-executions", "Bash Executions", bashExecutions),
	]));
	return withoutEmpty([
		leaf("user-messages", "User Messages", user),
		leaf("agent-text-messages", "Agent Text Messages", agentText),
		leaf("agent-thinking-messages", "Agent Thinking Messages", agentThinking),
		leaf("agent-tool-call-messages", "Agent Tool Call Messages", agentToolCalls),
		toolOutput,
		aggregate("extension-messages", "Extensions", leavesFromMap("custom-message", customMessages)),
		leaf("compacted-data", "Compacted Data", compacted),
	]);
}

/** One category whose estimate is the exact sum of its preview entries. */
function leaf(id: string, label: string, entries: readonly UsagePreviewEntry[]): UsageCategory {
	return {
		id,
		label,
		tokens: entries.reduce((sum, entry) => sum + entry.tokens, 0),
		entries,
	};
}

/** Category carrying a snapshot item's label, estimate, and timeless content entry. */
function leafFromItem(item: InjectionItem): UsageCategory {
	return {
		id: `item:${item.id}`,
		label: item.label,
		tokens: item.tokens,
		entries: [{ breadcrumb: [item.label], tokens: item.tokens, text: item.text }],
	};
}

/** Per-block entries; the block-index cell appears only for multi-block messages. */
function blockEntries(timestamp: number, kind: string, texts: readonly string[]): UsagePreviewEntry[] {
	return texts.map((text, index) => ({
		timestamp,
		breadcrumb: texts.length > 1 ? ["assistant", `${kind} ${index + 1}/${texts.length}`] : ["assistant"],
		tokens: textTokens(text.length),
		text,
	}));
}

/** Text rendering of string-or-block message content; non-text blocks become placeholders. */
function contentToText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => (block.type === "text" && block.text !== undefined ? block.text : `[${block.type}]`))
		.join("\n");
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

/** Accumulate a preview entry under a map key. */
function appendEntry(
	totals: Map<string, UsagePreviewEntry[]>,
	key: string,
	entry: UsagePreviewEntry,
): void {
	const entries = totals.get(key);
	if (entries === undefined) totals.set(key, [entry]);
	else entries.push(entry);
}

/** Leaves from accumulated per-key preview entries. */
function leavesFromMap(idPrefix: string, totals: Map<string, UsagePreviewEntry[]>): UsageCategory[] {
	return [...totals.entries()].map(([label, entries]) => leaf(`${idPrefix}:${label}`, label, entries));
}

/** Same chars/4 heuristic pi's estimateTokens uses for text content. */
function textTokens(chars: number): number {
	return Math.ceil(chars / 4);
}
