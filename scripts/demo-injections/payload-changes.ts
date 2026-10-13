/**
 * Demo extension: expands one review instruction only in the provider payload.
 * `context` seeds a request-only note; `before_provider_request` replaces it.
 * Genuine user prompts stay unchanged by this fixture.
 *
 * Expected result after an ordinary prompt (not a silent probe):
 *   before the monitor   one modified user message under payload changes
 *   after the monitor    not visible
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PAYLOAD_CHANGE_ORIGINAL = "Keep the review brief.";
export const PAYLOAD_CHANGE_MODIFIED = "Keep the review brief. Include a short explanation for each finding.";

/** Fields shared by the supported providers' user messages. */
interface PayloadMessage {
	readonly role?: unknown;
	readonly content?: unknown;
}

/** Seed one note without saving it, then edit it only in the provider payload. */
export default function (pi: ExtensionAPI): void {
	pi.on("context", (event) => ({
		// After the real prompt, so message alignment cannot mistake the note for its replacement
		messages: [
			...event.messages,
			{ role: "user", content: PAYLOAD_CHANGE_ORIGINAL, timestamp: Date.now() },
		],
	}));
	pi.on("before_provider_request", (event) => {
		const payload = event.payload as { messages?: unknown; input?: unknown };
		const key = Array.isArray(payload.input) ? "input" : "messages";
		const source = payload[key];
		if (!Array.isArray(source)) return undefined;
		const messages: PayloadMessage[] = source;
		// The fixture appends its note last; an earlier genuine prompt may have the same text
		const index = messages.findLastIndex((message) => hasText(message, PAYLOAD_CHANGE_ORIGINAL));
		if (index === -1) return undefined;
		const blockType = key === "input" ? "input_text" : "text";
		return {
			...payload,
			[key]: messages.map((message, position) => position === index
				? { ...message, content: [{ type: blockType, text: PAYLOAD_CHANGE_MODIFIED }] }
				: message),
		};
	});
}

/** Match a complete synthetic note, not text contained in a genuine prompt. */
function hasText(message: PayloadMessage, text: string): boolean {
	if (message.role !== "user") return false;
	if (message.content === text) return true;
	if (!Array.isArray(message.content) || message.content.length !== 1) return false;
	const block = message.content[0];
	return (block?.type === "text" || block?.type === "input_text") && block.text === text;
}
