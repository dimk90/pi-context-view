/**
 * Verification fixture: a `before_provider_request` handler that appends a
 * user message to the provider payload. OpenAI Completions and Anthropic
 * Messages both accept a `{ role, content }` message with string content.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PAYLOAD_REWRITE_TEXT = "XYZZY_PAYLOAD_REWRITE: added to the provider payload.";

/** Return a payload copy with one more user message; leave other shapes unchanged. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event) => {
		const payload = event.payload as { messages?: unknown };
		if (!Array.isArray(payload.messages)) return undefined;
		return { ...payload, messages: [...payload.messages, { role: "user", content: PAYLOAD_REWRITE_TEXT }] };
	});
}
