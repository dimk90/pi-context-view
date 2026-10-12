/**
 * Redaction of messages a snapshot retains. Image payloads and opaque provider
 * signatures never leave the capture's short-lived transcript copy.
 */
import { formatSize } from "@earendil-works/pi-coding-agent";

import type { RequestMessage } from "../snapshot.ts";

/** Stands in for each signature character, so the length-only reasoning proxy keeps working. */
const SIGNATURE_FILLER = "*";

/**
 * Copy a message for retention:
 *   image `data`                              `<size omitted>` marker of the captured base64 text
 *   `textSignature`                           removed
 *   `thinkingSignature`, `thoughtSignature`   same-length filler; only the length remains
 * Token estimates are unchanged: Pi counts images by a fixed proxy and never counts signatures.
 */
export function redactMessage(message: RequestMessage): RequestMessage {
	if (message.role === "assistant") {
		return { ...message, content: message.content.map(redactAssistantBlock) };
	}
	if ((message.role === "user" || message.role === "custom" || message.role === "toolResult")
		&& Array.isArray(message.content)) {
		return { ...message, content: message.content.map(redactImageBlock) } as RequestMessage;
	}
	return message;
}

/** Assistant block without signature bytes. */
function redactAssistantBlock<Block extends Extract<RequestMessage, { role: "assistant" }>["content"][number]>(
	block: Block,
): Block {
	if (block.type === "text") {
		const { textSignature: _textSignature, ...rest } = block;
		return rest as Block;
	}
	if (block.type === "thinking" && block.thinkingSignature !== undefined) {
		return { ...block, thinkingSignature: maskSignature(block.thinkingSignature) };
	}
	if (block.type === "toolCall" && block.thoughtSignature !== undefined) {
		return { ...block, thoughtSignature: maskSignature(block.thoughtSignature) };
	}
	return block;
}

/** Content block with an image payload replaced by its size marker. */
function redactImageBlock<Block extends { readonly type: string }>(block: Block): Block {
	if (block.type !== "image") return block;
	const data = (block as { readonly data?: unknown }).data;
	if (typeof data !== "string") return block;
	return { ...block, data: `<${formatSize(data.length)} omitted>` };
}

/** Filler of the signature's length; untyped non-string values become empty. */
function maskSignature(signature: unknown): string {
	return typeof signature === "string" ? SIGNATURE_FILLER.repeat(signature.length) : "";
}
