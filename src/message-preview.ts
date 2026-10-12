/**
 * Content-only previews of captured messages: what the model receives, without
 * message-envelope metadata, raw image payloads, or opaque provider signatures.
 */
import { convertToLlm, formatSize } from "@earendil-works/pi-coding-agent";

import type { JsonSpan } from "./model.ts";
import type { RequestMessage } from "./snapshot.ts";
import { systemMessageText } from "./transcript.ts";

/** Provider-bound message content for raw preview, with any serialization marked as JSON. */
export interface MessagePreview {
	readonly text: string;
	readonly jsonSpan?: JsonSpan;
}

/**
 * Extract content-only previews without raw image payloads or opaque assistant
 * signatures. `redacted` is true only for RequestSnapshot messages, whose image
 * data already contains size markers rather than the original payload.
 */
export function messagePreview(message: RequestMessage, redacted = false): MessagePreview {
	if (message.role === "system") return { text: systemMessageText(message) };
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		return { text: message.summary };
	}
	if (message.role === "bashExecution") {
		const content = convertToLlm([message])[0]?.content ?? "";
		return {
			text: typeof content === "string"
				? content
				: content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n"),
		};
	}
	if (typeof message.content === "string") return { text: message.content };
	if (message.role === "assistant") {
		const content = message.content.map((block) => {
			if (block.type === "text") {
				const { textSignature, ...preview } = block;
				return preview;
			}
			if (block.type === "thinking") {
				const { thinkingSignature, ...preview } = block;
				return preview;
			}
			if (block.type === "toolCall") {
				const { thoughtSignature, ...preview } = block;
				return preview;
			}
			return block;
		});
		return serializedPreview(JSON.stringify(content));
	}
	return serializedPreview(JSON.stringify(redacted ? message.content : message.content.map(imagePreviewBlock)));
}

/**
 * Replace a captured image payload with the size it occupied, so a preview
 * reports what the message carried without retaining or rendering its bytes.
 * Sizes measure the base64 text as captured, not the decoded image.
 */
function imagePreviewBlock<Block extends { readonly type: string }>(block: Block): Block {
	if (block.type !== "image") return block;
	const data = (block as { readonly data?: unknown }).data;
	if (typeof data !== "string") return block;
	return { ...block, data: `<${formatSize(data.length)} omitted>` };
}

/** Preview whose whole text is one serialized JSON document. */
function serializedPreview(text: string): MessagePreview {
	return { text, jsonSpan: { start: 0, end: text.length } };
}
