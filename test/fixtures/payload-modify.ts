/**
 * Demo extension: a `before_provider_request` handler that appends a marker to
 * the latest user message in the provider payload. It handles string content
 * and content-block arrays, so it works for OpenAI Completions and Anthropic
 * Messages.
 *
 * Expected result:
 *   before the monitor   edited after monitor
 *   after the monitor    not visible
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PAYLOAD_MODIFY_SUFFIX = "XYZZY_PAYLOAD_MODIFY: appended in the provider payload.";

/** Payload message fields the fixture reads; other fields are copied unchanged. */
interface PayloadMessage {
	readonly role?: unknown;
	readonly content?: unknown;
}

/** Return a payload copy whose latest user message carries the marker. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event) => {
		const payload = event.payload as { messages?: unknown };
		if (!Array.isArray(payload.messages)) return undefined;
		const messages: PayloadMessage[] = [...payload.messages];
		const index = messages.findLastIndex((message) => message.role === "user");
		if (index === -1) return undefined;
		messages[index] = { ...messages[index], content: appendSuffix(messages[index].content) };
		return { ...payload, messages };
	});
}

/** Append the marker as text; leave unknown content shapes unchanged. */
function appendSuffix(content: unknown): unknown {
	if (typeof content === "string") return `${content}\n${PAYLOAD_MODIFY_SUFFIX}`;
	if (Array.isArray(content)) return [...content, { type: "text", text: PAYLOAD_MODIFY_SUFFIX }];
	return content;
}
