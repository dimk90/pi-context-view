/**
 * Demo extension: one automatic payload addition, modification, and deletion.
 * `context` seeds request-only originals; `before_provider_request` edits them.
 * An unchanged message separates the modification from the deletion so the
 * guard cannot pair the addition with the wrong original.
 *
 * Expected result after an ordinary prompt (not a silent probe):
 *   before the monitor   three payload changes: Modified, Deleted, Added
 *   after the monitor    not visible
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PAYLOAD_CHANGE_ORIGINAL = "XYZZY_PAYLOAD_CHANGE_MODIFY: original request-only note.";
export const PAYLOAD_CHANGE_MODIFIED = "XYZZY_PAYLOAD_CHANGE_MODIFY: modified in the provider payload.";
export const PAYLOAD_CHANGE_DELETED = "XYZZY_PAYLOAD_CHANGE_DELETE: removed from the provider payload.";
export const PAYLOAD_CHANGE_ADDED = "XYZZY_PAYLOAD_CHANGE_ADD: added to the provider payload.";
const PAYLOAD_CHANGE_ANCHOR = "XYZZY_PAYLOAD_CHANGE_ANCHOR: unchanged request-only note.";

/** Fields shared by the supported providers' user messages. */
interface PayloadMessage {
	readonly role?: unknown;
	readonly content?: unknown;
}

/** Seed synthetic originals without persisting them, then edit only the payload. */
export default function (pi: ExtensionAPI): void {
	pi.on("context", (event) => ({
		messages: [
			...[PAYLOAD_CHANGE_ORIGINAL, PAYLOAD_CHANGE_ANCHOR, PAYLOAD_CHANGE_DELETED].map((content) => ({
				role: "user" as const, content, timestamp: Date.now(),
			})),
			...event.messages,
		],
	}));
	pi.on("before_provider_request", (event) => {
		const payload = event.payload as { messages?: unknown; input?: unknown };
		const key = Array.isArray(payload.input) ? "input" : "messages";
		const source = payload[key];
		if (!Array.isArray(source)) return undefined;
		const messages: PayloadMessage[] = source;
		const blockType = key === "input" ? "input_text" : "text";
		return {
			...payload,
			[key]: [
				...messages.filter((message) => !hasText(message, PAYLOAD_CHANGE_DELETED)).map((message) =>
					hasText(message, PAYLOAD_CHANGE_ORIGINAL)
						? { ...message, content: [{ type: blockType, text: PAYLOAD_CHANGE_MODIFIED }] }
						: message),
				{ role: "user", content: [{ type: blockType, text: PAYLOAD_CHANGE_ADDED }] },
			],
		};
	});
}

/** Match only a complete synthetic user message, never a marker inside a real prompt. */
function hasText(message: PayloadMessage, text: string): boolean {
	if (message.role !== "user") return false;
	if (message.content === text) return true;
	if (!Array.isArray(message.content) || message.content.length !== 1) return false;
	const block = message.content[0];
	return (block?.type === "text" || block?.type === "input_text") && block.text === text;
}
