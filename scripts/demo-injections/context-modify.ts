/**
 * Demo extension: adds a read-only review instruction to the latest saved
 * user prompt for the request only, leaving its session original unchanged.
 *
 * Expected result:
 *   before the monitor   one structured user-message modification, unattributed
 *   after the monitor    same as before
 */
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CONTEXT_MODIFY_SUFFIX = "Give recommendations only; do not edit files.";

/** Target the saved prompt, not a synthetic user note another demo added. */
export default function (pi: ExtensionAPI): void {
	pi.on("context", (event, ctx) => {
		const original = ctx.sessionManager.buildSessionProjection().messages.findLast((message) => message.role === "user");
		if (original?.role !== "user") return undefined;
		const text = contentText(original.content);
		const index = event.messages.findLastIndex((message) => message.role === "user"
			&& message.timestamp === original.timestamp && contentText(message.content) === text);
		const target = event.messages[index];
		if (target?.role !== "user") return undefined;
		const messages = [...event.messages];
		messages[index] = { ...target, content: `${text}\n${CONTEXT_MODIFY_SUFFIX}` };
		return { messages };
	});
}

/** Text of a user prompt, whether Pi stores it as a string or content blocks. */
function contentText(content: Extract<ContextEvent["messages"][number], { role: "user" }>["content"]): string {
	return typeof content === "string" ? content
		: content.map((block) => block.type === "text" ? block.text : "").join("");
}
