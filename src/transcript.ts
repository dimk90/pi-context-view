/** Process-local replay of Pi's transcript-backed prompt sections and tool declarations. */
import type { ContextEvent } from "@earendil-works/pi-coding-agent";

/** System-message shape supplied by Pi, with content and declaration patches. */
export type SystemMessage = Extract<ContextEvent["messages"][number], { role: "system" }>;

/** Current prompt and tools after applying system messages in transcript order. */
export interface SystemState {
	readonly content: string;
	readonly sections: Record<string, string>;
	readonly tools: NonNullable<SystemMessage["toolsAdded"]>;
}

/**
 * Replay Pi 0.86 semantics: content appends, sections patch by name (null deletes),
 * removals precede additions, and replacing a name preserves its insertion order.
 * Undefined means a legacy/empty transcript, not an explicitly empty system state.
 */
export function replaySystemMessages(messages: readonly ContextEvent["messages"][number][]): SystemState | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
	const tools = new Map<string, NonNullable<SystemMessage["toolsAdded"]>[number]>();
	let found = false;
	for (const message of messages) {
		if (message.role !== "system") continue;
		found = true;
		const text = systemContentText(message);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return found ? { content: content.join("\n\n"), sections: Object.fromEntries(sections), tools: [...tools.values()] }
		: undefined;
}

/** Content followed by non-deleted sections, matching Pi's complete-prompt rendering. */
export function systemMessageText(message: Pick<SystemMessage, "content" | "sections">): string {
	return [systemContentText(message), ...Object.values(message.sections ?? {})]
		.filter((part): part is string => part !== null && part.length > 0).join("\n\n");
}

/** Copy only replay inputs; opaque text signatures and message-envelope metadata are not retained. */
export function copySystemMessage(message: SystemMessage): SystemMessage {
	return {
		role: "system",
		content: systemContentText(message),
		sections: message.sections === undefined ? undefined : { ...message.sections },
		toolsAdded: message.toolsAdded === undefined ? undefined : structuredClone(message.toolsAdded),
		toolsRemoved: message.toolsRemoved?.map((tool) => ({ name: tool.name })),
		timestamp: message.timestamp,
	};
}

/** Extract plain text without copying opaque text-block signatures. */
function systemContentText(message: Pick<SystemMessage, "content">): string {
	return typeof message.content === "string" ? message.content : message.content.map((block) => block.text).join("\n");
}
