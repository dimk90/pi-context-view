/**
 * Pure context-usage classification: combine the frozen Initial snapshot's
 * prompt/tool decomposition with the live session messages into estimated
 * category totals. No pi API access — unit-testable.
 */
import { type ContextEvent, type ContextUsage, convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";

import type {
	ContextUsageSnapshot,
	InvisibleReasoningEstimate,
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
				agentText.push(...blockEntries(message.timestamp, "text", texts));
				agentThinking.push(...thinkingEntries(message));
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
			case "bashExecution": {
				const tokens = transformedTokens(message);
				// The transform drops `!!` bash executions: they never reach the provider.
				if (tokens !== undefined) {
					bashExecutions.push({
						timestamp: message.timestamp,
						breadcrumb: ["bash"],
						tokens,
						text: `$ ${message.command}\n${message.output}`,
					});
				}
				break;
			}
			case "branchSummary":
				compacted.push({
					timestamp: message.timestamp,
					breadcrumb: ["branch"],
					tokens: transformedTokens(message) ?? 0,
					text: message.summary,
				});
				break;
			case "compactionSummary":
				compacted.push({
					timestamp: message.timestamp,
					breadcrumb: ["compaction"],
					tokens: transformedTokens(message) ?? 0,
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

/**
 * Tokens for a message as pi's LLM transform actually sends it, so wrapper text
 * `estimateTokens` alone cannot see (summary tags, `Ran ...` bash framing) is
 * counted. Returns undefined for messages the transform excludes from context.
 */
function transformedTokens(message: ContextEvent["messages"][number]): number | undefined {
	const converted = convertToLlm([message])[0];
	return converted === undefined ? undefined : estimateTokens(converted);
}

/** Assistant-message shape narrowed out of the context event union. */
type AssistantContextMessage = Extract<ContextEvent["messages"][number], { role: "assistant" }>;

/**
 * Build thinking previews while accounting once per assistant message. Provider-reported
 * reasoning replaces a smaller visible-text estimate; signature-only estimates stay approximate metadata.
 */
function thinkingEntries(message: AssistantContextMessage): UsagePreviewEntry[] {
	const texts = message.content.flatMap((block) => (block.type === "thinking" ? [block.thinking] : []));
	const visibleTokens = textTokens(texts.reduce((sum, text) => sum + text.length, 0));
	const reportedTokens = reportedReasoningTokens(message);
	const countedTokens = Math.max(visibleTokens, reportedTokens ?? 0);
	const signatureChars = message.content.reduce((sum, block) => {
		if (block.type === "thinking") return sum + stringLength(block.thinkingSignature);
		if (block.type === "toolCall") return sum + stringLength(block.thoughtSignature);
		return sum;
	}, 0);
	const invisibleReasoning = createInvisibleReasoningEstimate(signatureChars, visibleTokens, reportedTokens);

	if (texts.length === 0) {
		if (countedTokens === 0 && invisibleReasoning === undefined) return [];
		return [{
			timestamp: message.timestamp,
			breadcrumb: ["assistant"],
			tokens: countedTokens,
			...(invisibleReasoning === undefined ? {} : { visibleTokens: 0, invisibleReasoning }),
			text: "",
		}];
	}

	const allocations = allocateTextTokens(texts);
	const entries = texts.map((text, index): UsagePreviewEntry => ({
		timestamp: message.timestamp,
		breadcrumb: texts.length > 1
			? ["assistant", `thinking ${index + 1}/${texts.length}`]
			: ["assistant"],
		tokens: allocations[index] ?? 0,
		text,
	}));
	const first = entries[0];
	if (first !== undefined) {
		const countedInvisibleTokens = countedTokens - visibleTokens;
		entries[0] = {
			...first,
			tokens: first.tokens + countedInvisibleTokens,
			...(invisibleReasoning === undefined
				? {}
				: { visibleTokens: first.tokens, invisibleReasoning }),
		};
	}
	return entries;
}

/** Describe a positive invisible share or signature-size proxy without retaining its source bytes. */
function createInvisibleReasoningEstimate(
	signatureChars: number,
	visibleTokens: number,
	reportedTokens: number | undefined,
): InvisibleReasoningEstimate | undefined {
	if (reportedTokens !== undefined) {
		const tokens = Math.max(0, reportedTokens - visibleTokens);
		if (tokens === 0) return undefined;
		return {
			tokens,
			basis: "provider-reported",
			encoded: signatureChars > 0,
		};
	}
	if (signatureChars === 0) return undefined;
	// chars/4 over a signature is a rough proxy, not a bound: the server decrypts the
	// envelope and counts the reconstructed thinking, at a model-dependent ratio that
	// measured either side of 4. See doc/THINKING.md.
	return {
		tokens: textTokens(signatureChars),
		basis: "signature-proxy",
		encoded: true,
	};
}

/** Accept only a finite, non-negative provider reasoning count from possibly old session data. */
function reportedReasoningTokens(message: AssistantContextMessage): number | undefined {
	const usage: unknown = message.usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const reasoning = (usage as { reasoning?: unknown }).reasoning;
	return typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning >= 0
		? reasoning
		: undefined;
}

/** Pool chars/4 rounding across all blocks while retaining one preview entry per block. */
function allocateTextTokens(texts: readonly string[]): number[] {
	const allocations = texts.map((text) => Math.floor(text.length / 4));
	const target = textTokens(texts.reduce((sum, text) => sum + text.length, 0));
	let remainder = target - allocations.reduce((sum, tokens) => sum + tokens, 0);
	const rankedIndexes = texts
		.map((text, index) => ({ index, remainder: text.length % 4 }))
		.filter((candidate) => candidate.remainder > 0)
		.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
	for (const candidate of rankedIndexes) {
		if (remainder === 0) break;
		allocations[candidate.index] = (allocations[candidate.index] ?? 0) + 1;
		remainder--;
	}
	return allocations;
}

/** String length from an optional or untyped signature field without exposing its contents. */
function stringLength(value: unknown): number {
	return typeof value === "string" ? value.length : 0;
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
