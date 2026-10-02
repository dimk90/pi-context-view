/**
 * Convert pi's provider-payload messages (the final `before_provider_request`
 * payload that pi sends to the LLM provider) into pi's internal AgentMessage
 * format that `measureInjectedMessages` diffs against.
 *
 * Provider-format quirks we have to undo:
 * - `custom` was already folded into `user` with text-block content by pi's
 *   `convertToLlm`. After this conversion there is no way to recover the
 *   original customType, so attribution falls back to "user message".
 * - `assistant.content` is an array of typed blocks (text / thinking /
 *   tool_use) that mostly match AgentMessage content blocks. We preserve
 *   them as-is and add the AgentMessage-required `timestamp` plus a
 *   normalized `stopReason`.
 * - Some providers nest `system` inside `payload.system`; if it appears in
 *   `payload.messages` (OpenAI style) we lift its text back into a single
 *   string.
 *
 * This conversion is intentionally lossy for `custom` messages — `before_provider_request`
 * is the order-independent freeze point, and the trade-off is precise attribution
 * in exchange for capturing every injection.
 */
import type { ContextEvent } from "@earendil-works/pi-coding-agent";

/** A pi AgentMessage — the internal pi format that `measureInjectedMessages` diffs against. */
export type AgentMessage = ContextEvent["messages"][number];

/** Shape of provider-payload messages we know how to convert. */
export interface ProviderMessage {
	role: string;
	content: unknown;
	timestamp?: number;
	stop_reason?: string;
	stopReason?: string;
	[key: string]: unknown;
}

/** Coerce an unknown content value into a string or array of blocks. */
type AgentContent = Extract<AgentMessage, { role: "user" | "assistant" | "system" }>["content"];

/** Normalize a provider-format message into an AgentMessage for diffing. */
export function providerToAgentMessage(pm: ProviderMessage): AgentMessage {
	const timestamp = typeof pm.timestamp === "number" ? pm.timestamp : Date.now();

	switch (pm.role) {
		case "user": {
			return {
				role: "user",
				content: normalizeUserContent(pm.content) as AgentContent,
				timestamp,
			} as AgentMessage;
		}
		case "assistant": {
			const assistant: AgentMessage = {
				role: "assistant",
				content: Array.isArray(pm.content) ? (pm.content as AgentContent) : [],
				timestamp,
				stopReason: pm.stop_reason ?? pm.stopReason ?? "stop",
			} as Extract<AgentMessage, { role: "assistant" }>;
			return assistant;
		}
		case "system": {
			return {
				role: "system",
				content: normalizeSystemContent(pm.content),
				timestamp,
			} as AgentMessage;
		}
		default:
			// toolResult, etc. — pass through with timestamp injection.
			return { ...pm, timestamp } as AgentMessage;
	}
}

/** Map every provider-payload message in order. */
export function providerMessagesToAgentMessages(
	messages: readonly ProviderMessage[],
): AgentMessage[] {
	return messages.map(providerToAgentMessage);
}

/** User content may be a plain string, a single text block, or an array of mixed blocks. */
function normalizeUserContent(content: unknown): AgentContent {
	if (typeof content === "string") return content as AgentContent;
	if (Array.isArray(content)) {
		const textParts: string[] = [];
		const otherBlocks: unknown[] = [];
		for (const block of content) {
			if (block && typeof block === "object" && (block as { type?: string }).type === "text"
				&& typeof (block as { text?: unknown }).text === "string") {
				textParts.push((block as { text: string }).text);
			} else if (block) {
				otherBlocks.push(block);
			}
		}
		if (otherBlocks.length === 0) return textParts.join("\n") as AgentContent;
		return [...otherBlocks, { type: "text", text: textParts.join("\n") }] as unknown as AgentContent;
	}
	return (content == null ? "" : String(content)) as AgentContent;
}

/** System content is normally a single string; some providers wrap it in text blocks. */
function normalizeSystemContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
			.map((b) => ((b as { text?: unknown }).text as string) ?? "")
			.join("\n");
	}
	return content == null ? "" : String(content);
}