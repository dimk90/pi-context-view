/**
 * Process-local helpers for Pi's transcript-backed system messages. Replay
 * itself uses Pi's `getCurrentSystemMessage()`.
 */
import type { ContextEvent } from "@earendil-works/pi-coding-agent";

/** System-message shape supplied by Pi, with content and declaration patches. */
export type SystemMessage = Extract<ContextEvent["messages"][number], { role: "system" }>;

/** Content followed by non-deleted sections, matching Pi's complete-prompt rendering. */
export function systemMessageText(message: Pick<SystemMessage, "content" | "sections">): string {
	return [systemContentText(message), ...Object.values(message.sections ?? {})]
		.filter((part): part is string => part !== null && part.length > 0).join("\n\n");
}

/** Extract plain text without copying opaque text-block signatures. */
function systemContentText(message: Pick<SystemMessage, "content">): string {
	return typeof message.content === "string" ? message.content : message.content.map((block) => block.text).join("\n");
}
