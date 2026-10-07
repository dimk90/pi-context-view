/**
 * Pi's own adjustments to the message channel (D4). The captured request is
 * rebuilt as the monitor saw it, converted as Pi converts every request, and
 * rendered as the text units the selected API sends. Only adjustments that
 * the model's capabilities, its API, or the image-blocking setting decide are
 * applied; provider serializers are reproduced only as far as their text.
 */
import {
	type AssistantMessage,
	getCurrentSystemMessage,
	getSystemMessageText,
	type ImageContent,
	type Message,
	renderSystemMessageUpdate,
	type SystemMessage,
	type TextContent,
	type Tool,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

import type { RequestMessage } from "../snapshot.ts";
import { canonicalJson } from "./diff.ts";
import type { GuardModel } from "./guard.ts";
import { type MessageUnit, UnitCollector } from "./messages.ts";
import type { BaselineMessage, RequestCopy, SystemText } from "./request.ts";

/** Text that replaces each run of images while `images.blockImages` is on. */
const BLOCKED_IMAGE_TEXT = "Image reading is disabled.";
/** Texts that replace each run of images for a model without image input. */
const USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
/** Result Pi adds for a tool call that has none. */
const MISSING_RESULT_TEXT = "No result provided";
/** Tool-result texts the serializers send for a result with only images, or with nothing. */
const IMAGE_ONLY_RESULT_TEXT = "(see attached image)";
const EMPTY_RESULT_TEXT = "(no tool output)";
/** OpenAI Completions' assistant message after tool results, for providers that require one. */
const TOOL_RESULT_BRIDGE_TEXT = "I have processed the tool results.";
/** OpenAI Completions' user message that carries tool-result images. */
const TOOL_IMAGES_TEXT = "Attached image(s) from tool result:";

/** What conversion reads from a capture. */
export interface ConvertibleCapture
	extends Pick<RequestCopy, "system" | "systemTexts" | "declarations" | "conversation"> {
	readonly baseline: { readonly messages: readonly BaselineMessage[] };
	readonly forcedPrompt?: string;
}

/** Grammar input property per tool name, for tools Pi may send as OpenAI grammar tools. */
export interface GrammarInputs {
	/** Tools declared anywhere in the request, for models that keep later system messages. */
	readonly declared: ReadonlyMap<string, string>;
	/** Tools of the replayed system state, for models that collapse system messages. */
	readonly current: ReadonlyMap<string, string>;
}

/**
 * The captured request after Pi's model-independent conversion. Image data
 * and signature bytes are not kept; whether a signature is empty is.
 */
export interface ConvertedRequest {
	readonly messages: readonly Message[];
	readonly grammarInputs: GrammarInputs;
}

/**
 * Rebuild the request the monitor captured and apply the conversion every
 * model gets: the forced prompt projection, `convertToLlm()`, and image
 * blocking. Session baseline messages fill the ends the capture did not copy.
 */
export function convertCapturedRequest(
	capture: ConvertibleCapture,
	options: { readonly blockImages: boolean },
): ConvertedRequest {
	const converted = convertToLlm(rebuildRequest(capture));
	return {
		messages: (options.blockImages ? converted.map(blockImages) : converted).map(stripMessage),
		grammarInputs: collectGrammarInputs(capture),
	};
}

/**
 * Render the text units the model's API sends for a converted request: system
 * messages collapse unless the model keeps them, images become placeholders
 * without image input, cross-model replay and tool-call accounting follow
 * Pi's transform, and each serializer's text rules apply.
 */
export function renderExpectedUnits(request: ConvertedRequest, model: GuardModel): MessageUnit[] {
	const keepsSystem = compatFlag(model, "supportsMidConvoSystemMessages");
	const messages = closeToolCalls(downgradeImages(resolveSystemMessages(request.messages, keepsSystem), model)
		.map((message) => message.role === "assistant" ? replayAssistant(message, model) : message));
	const grammar = compatFlag(model, "supportsOpenAIGrammarTools")
		? keepsSystem ? request.grammarInputs.declared : request.grammarInputs.current
		: new Map<string, string>();
	switch (model.api) {
		case "openai-completions":
			return completionsUnits(messages, model, grammar);
		case "openai-responses":
			return responsesUnits(messages, model, grammar);
		case "anthropic-messages":
			return anthropicUnits(messages, model);
		default:
			throw new Error(`No message rules for the ${model.api} API.`);
	}
}

// ============================================================================
// Model-independent conversion
// ============================================================================

/**
 * The request at the monitor's handler: baseline ends around the copied
 * middle, with system messages at their positions, or the forced prompt as
 * the only system message, as Pi projects it after every context handler.
 */
function rebuildRequest(capture: ConvertibleCapture): RequestMessage[] {
	const baseline = capture.baseline.messages.map(({ message }) => message)
		.filter((message) => message.role !== "system");
	const { prefix, baseline: replaced, request } = capture.conversation;
	const conversation = [...baseline.slice(0, prefix), ...request, ...baseline.slice(prefix + replaced.length)];
	if (capture.forcedPrompt !== undefined) {
		return [{ role: "system", content: capture.forcedPrompt, timestamp: 0 }, ...conversation];
	}
	const messages: RequestMessage[] = [];
	let next = 0;
	for (let position = 0; position <= conversation.length; position++) {
		while (next < capture.systemTexts.length && capture.systemTexts[next].position === position) {
			messages.push(toSystemMessage(capture.systemTexts[next++]));
		}
		if (position < conversation.length) messages.push(conversation[position]);
	}
	return messages;
}

/** A system message with the captured text and no tool changes. */
function toSystemMessage(text: SystemText): SystemMessage {
	return text.sections === undefined
		? { role: "system", content: text.content, timestamp: 0 }
		: { role: "system", content: text.content, sections: { ...text.sections }, timestamp: 0 };
}

/** Replace each run of images with Pi's blocked-image text, as its `convertToLlm` wrapper does. */
function blockImages(message: Message): Message {
	if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return message;
	const content: ReadonlyArray<TextContent | ImageContent> = message.content;
	if (!content.some((block) => block.type === "image")) return message;
	const replaced = content.map((block): TextContent | ImageContent =>
		block.type === "image" ? { type: "text", text: BLOCKED_IMAGE_TEXT } : block);
	const deduplicated = replaced.filter((block, index) => !(index > 0 && isBlockedImageText(block)
		&& isBlockedImageText(replaced[index - 1])));
	return { ...message, content: deduplicated } as Message;
}

/** Whether a block is the blocked-image text. */
function isBlockedImageText(block: TextContent | ImageContent): boolean {
	return block.type === "text" && block.text === BLOCKED_IMAGE_TEXT;
}

/**
 * Keep only what text rendering reads. Image data and signature bytes are
 * released; a signature keeps only whether it is absent, empty, blank, or set.
 * Missing content becomes empty, as in Pi's transform.
 */
function stripMessage(message: Message): Message {
	switch (message.role) {
		case "user":
			if (typeof message.content === "string") return message;
			return { ...message, content: (message.content ?? []).map(stripImage) };
		case "toolResult":
			return { ...message, content: (message.content ?? []).map(stripImage) };
		case "assistant":
			return { ...message, content: (message.content ?? []).map(stripAssistantBlock) };
		default:
			return message;
	}
}

/** An image block without its data. */
function stripImage(block: TextContent | ImageContent): TextContent | ImageContent {
	return block.type === "image" ? { type: "image", data: "", mimeType: block.mimeType } : block;
}

/** An assistant block without signature bytes; tool-call arguments stay shared. */
function stripAssistantBlock(block: AssistantMessage["content"][number]): AssistantMessage["content"][number] {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "thinking": {
			const signature = reduceSignature(block.thinkingSignature);
			return {
				type: "thinking",
				thinking: block.thinking,
				...(signature === undefined ? {} : { thinkingSignature: signature }),
				...(block.redacted === undefined ? {} : { redacted: block.redacted }),
			};
		}
		case "toolCall":
			return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
		default:
			return block;
	}
}

/**
 * A stand-in for a signature that the checks of Pi's transform and the
 * Anthropic serializer treat alike: absent, empty, blank, or set.
 */
function reduceSignature(signature: string | undefined): string | undefined {
	if (typeof signature !== "string") return undefined;
	if (signature.length === 0) return "";
	return signature.trim().length === 0 ? " " : "*";
}

/** Grammar inputs of every tool the request declares, and of its current tools. */
function collectGrammarInputs(capture: ConvertibleCapture): GrammarInputs {
	const current = grammarInputsOf(capture.system?.toolsAdded ?? []);
	// The forced prompt projection leaves one system message holding the current tools
	if (capture.forcedPrompt !== undefined) return { declared: current, current };
	return { declared: grammarInputsOf(capture.declarations), current };
}

/** Grammar input property per tool that declares a usable OpenAI grammar. */
function grammarInputsOf(tools: readonly Tool[]): Map<string, string> {
	const inputs = new Map<string, string>();
	for (const tool of tools) {
		const property = grammarInputProperty(tool);
		if (property !== undefined) inputs.set(tool.name, property);
	}
	return inputs;
}

/** The parameter schema fields Pi reads to find a grammar tool's input property. */
interface GrammarSchema {
	readonly type?: unknown;
	readonly required?: unknown;
	readonly properties?: Readonly<Record<string, { readonly type?: unknown } | undefined>>;
}

/**
 * The single required string property a grammar tool call carries as raw
 * input, as Pi infers it; undefined for other tools. Pi rejects a grammar
 * tool without one before sending, so no payload exists to compare.
 */
function grammarInputProperty(tool: Tool): string | undefined {
	const config = tool.constrainedSampling;
	if (config === undefined || config === false || config.type !== "grammar") return undefined;
	const hasVariant = [config.variants.openai_lark, config.variants.openai_regex]
		.some((variant) => typeof variant === "string" && variant.trim().length > 0);
	const schema = tool.parameters as GrammarSchema;
	if (!hasVariant || schema.type !== "object" || !Array.isArray(schema.required) || schema.required.length !== 1) {
		return undefined;
	}
	const property: unknown = schema.required[0];
	return typeof property === "string" && schema.properties?.[property]?.type === "string" ? property : undefined;
}

// ============================================================================
// Model-dependent transform
// ============================================================================

/** Without mid-conversation system messages, Pi replays them into one leading message. */
function resolveSystemMessages(messages: readonly Message[], keepsSystem: boolean): readonly Message[] {
	if (keepsSystem) return messages;
	const head = getCurrentSystemMessage(messages);
	const conversation = messages.filter((message) => message.role !== "system");
	return head === undefined ? conversation : [head, ...conversation];
}

/** Without image input, each run of user or tool-result images becomes one placeholder text. */
function downgradeImages(messages: readonly Message[], model: GuardModel): readonly Message[] {
	if (model.input.includes("image")) return messages;
	return messages.map((message) => {
		if (message.role === "user" && Array.isArray(message.content)) {
			return { ...message, content: replaceImages(message.content, USER_IMAGE_PLACEHOLDER) };
		}
		if (message.role === "toolResult") {
			return { ...message, content: replaceImages(message.content, TOOL_IMAGE_PLACEHOLDER) };
		}
		return message;
	});
}

/** Replace images with one placeholder per run; a run after the placeholder text adds none. */
function replaceImages(
	content: ReadonlyArray<TextContent | ImageContent>,
	placeholder: string,
): Array<TextContent | ImageContent> {
	const result: Array<TextContent | ImageContent> = [];
	let previousWasPlaceholder = false;
	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) result.push({ type: "text", text: placeholder });
			previousWasPlaceholder = true;
			continue;
		}
		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}
	return result;
}

/**
 * Replay an assistant message for the dispatched model. Another model's
 * thinking becomes text when it has any, and its redacted thinking is
 * dropped; the same model keeps signed and non-empty thinking.
 */
function replayAssistant(message: AssistantMessage, model: GuardModel): AssistantMessage {
	const sameModel = message.provider === model.provider && message.api === model.api && message.model === model.id;
	const content = message.content.flatMap((block): AssistantMessage["content"] => {
		if (block.type !== "thinking") return [block];
		if (block.redacted) return sameModel ? [block] : [];
		if (sameModel && block.thinkingSignature) return [block];
		if (!block.thinking || block.thinking.trim() === "") return [];
		return sameModel ? [block] : [{ type: "text", text: block.thinking }];
	});
	return { ...message, content };
}

/**
 * Pi's tool-call accounting: error and aborted assistant messages are
 * dropped, a tool call without a result gets a `No result provided` error
 * result, and a system message between a tool call and its results moves
 * after them.
 */
function closeToolCalls(messages: readonly Message[]): Message[] {
	const result: Message[] = [];
	let pending: Array<{ readonly id: string; readonly name: string }> = [];
	let answered = new Set<string>();
	const held: Message[] = [];
	const close = () => {
		for (const call of pending) {
			if (!answered.has(call.id)) result.push(missingResult(call.id, call.name));
		}
		pending = [];
		answered = new Set();
		result.push(...held.splice(0));
	};
	for (const message of messages) {
		switch (message.role) {
			case "assistant": {
				close();
				if (message.stopReason === "error" || message.stopReason === "aborted") break;
				const calls = message.content.filter((block) => block.type === "toolCall");
				if (calls.length > 0) {
					pending = calls;
					answered = new Set();
				}
				result.push(message);
				break;
			}
			case "toolResult":
				answered.add(message.toolCallId);
				result.push(message);
				break;
			case "system":
				if (pending.length > 0) held.push(message);
				else result.push(message);
				break;
			case "user":
				close();
				result.push(message);
				break;
			default:
				result.push(message);
		}
	}
	close();
	return result;
}

/** The synthetic error result of an unanswered tool call. */
function missingResult(toolCallId: string, toolName: string): ToolResultMessage {
	return {
		role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: MISSING_RESULT_TEXT }],
		isError: true, timestamp: 0,
	};
}

// ============================================================================
// OpenAI Completions
// ============================================================================

/**
 * Completions sends one message per transcript message: the leading system
 * prompt in full and later ones as updates, assistant text joined before its
 * tool calls, and tool results with fillers. Thinking stays out of `content`
 * unless the provider requires it as text.
 */
function completionsUnits(
	messages: readonly Message[],
	model: GuardModel,
	grammar: ReadonlyMap<string, string>,
): MessageUnit[] {
	const bridge = compatFlag(model, "requiresAssistantAfterToolResult");
	const thinkingAsText = compatFlag(model, "requiresThinkingAsText");
	const units = new UnitCollector();
	let lastRole: string | undefined;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		units.boundary();
		if (bridge && lastRole === "toolResult" && message.role === "user") {
			units.text("assistant", TOOL_RESULT_BRIDGE_TEXT);
			units.boundary();
		}
		switch (message.role) {
			case "system":
				units.text("system", index === 0 ? getSystemMessageText(message) : renderSystemMessageUpdate(message));
				break;
			case "user": {
				if (typeof message.content === "string") {
					units.text("user", message.content);
					break;
				}
				const parts = message.content.filter((block) => block.type !== "text" || block.text.length > 0);
				if (parts.length === 0) continue;
				units.text("user", textOf(parts));
				break;
			}
			case "assistant": {
				const texts = message.content.filter((block) => block.type === "text")
					.map((block) => block.text).filter((text) => text.trim().length > 0);
				const thinking = message.content.filter((block) => block.type === "thinking")
					.map((block) => block.thinking).filter((text) => text.trim().length > 0);
				const calls = message.content.filter((block) => block.type === "toolCall");
				const text = thinkingAsText && thinking.length > 0
					? [thinking.join("\n\n"), ...texts].join("\n") : texts.join("");
				if (text.length === 0 && calls.length === 0) continue;
				units.text("assistant", text);
				for (const call of calls) units.toolCall(call.name, toolCallText(call, grammar));
				break;
			}
			case "toolResult": {
				let images = false;
				for (; index < messages.length && messages[index].role === "toolResult"; index++) {
					const result = messages[index] as ToolResultMessage;
					units.toolResult(openAiResultText(result.content, false));
					if (model.input.includes("image") && hasImages(result.content)) images = true;
				}
				index--;
				if (images) {
					if (bridge) units.text("assistant", TOOL_RESULT_BRIDGE_TEXT);
					units.boundary();
					units.text("user", TOOL_IMAGES_TEXT);
				}
				lastRole = images ? "user" : "toolResult";
				continue;
			}
		}
		lastRole = message.role;
	}
	return units.result();
}

// ============================================================================
// OpenAI Responses
// ============================================================================

/**
 * Responses sends the leading system prompt in full and later ones as
 * updates, one item per assistant text block and tool call, and tool outputs
 * with fillers. Thinking travels as opaque reasoning items.
 */
function responsesUnits(
	messages: readonly Message[],
	model: GuardModel,
	grammar: ReadonlyMap<string, string>,
): MessageUnit[] {
	const units = new UnitCollector();
	for (const [index, message] of messages.entries()) {
		units.boundary();
		switch (message.role) {
			case "system":
				units.text("system", index === 0 ? getSystemMessageText(message) : renderSystemMessageUpdate(message));
				break;
			case "user":
				units.text("user", typeof message.content === "string" ? message.content : textOf(message.content));
				break;
			case "assistant":
				for (const block of message.content) {
					units.boundary();
					if (block.type === "text") units.text("assistant", block.text);
					else if (block.type === "toolCall") units.toolCall(block.name, toolCallText(block, grammar));
				}
				break;
			case "toolResult":
				units.toolResult(openAiResultText(message.content, model.input.includes("image")));
				break;
		}
	}
	return units.result();
}

// ============================================================================
// Anthropic Messages
// ============================================================================

/**
 * Anthropic sends the leading system prompt as the top-level `system`. Later
 * system messages are rendered as updates and wait for the next assistant
 * message. Unsigned thinking becomes text unless the model accepts empty
 * signatures; whitespace-only user and assistant text is dropped.
 */
function anthropicUnits(messages: readonly Message[], model: GuardModel): MessageUnit[] {
	const allowEmptySignature = compatFlag(model, "allowEmptySignature");
	const units = new UnitCollector();
	const leading = messages[0]?.role === "system" ? messages[0] : undefined;
	if (leading !== undefined) units.text("system", getSystemMessageText(leading));
	const held: string[] = [];
	const flushHeld = () => {
		for (const text of held.splice(0)) {
			units.boundary();
			units.text("system", text);
		}
	};
	for (let index = leading === undefined ? 0 : 1; index < messages.length; index++) {
		const message = messages[index];
		units.boundary();
		switch (message.role) {
			case "system": {
				const text = renderSystemMessageUpdate(message);
				if (text.length > 0) held.push(text);
				break;
			}
			case "user":
				units.text("user", typeof message.content === "string" ? message.content : textOf(message.content));
				break;
			case "assistant":
				flushHeld();
				units.boundary();
				for (const block of message.content) addAnthropicAssistantBlock(units, block, allowEmptySignature);
				break;
			case "toolResult":
				units.toolResult(anthropicResultText(message.content));
				break;
		}
	}
	flushHeld();
	return units.result();
}

/** One assistant block as Anthropic sends it; signed and redacted thinking is opaque. */
function addAnthropicAssistantBlock(
	units: UnitCollector,
	block: AssistantMessage["content"][number],
	allowEmptySignature: boolean,
): void {
	switch (block.type) {
		case "text":
			units.text("assistant", block.text);
			return;
		case "thinking": {
			const signed = block.thinkingSignature !== undefined && block.thinkingSignature.trim().length > 0;
			if (block.redacted || signed || allowEmptySignature || block.thinking.trim().length === 0) return;
			units.text("assistant", block.thinking);
			return;
		}
		case "toolCall":
			units.toolCall(block.name, canonicalJson(block.arguments ?? {}));
	}
}

/** Anthropic tool-result text: the text blocks, or a filler when only images remain. */
function anthropicResultText(content: ReadonlyArray<TextContent | ImageContent>): string {
	const text = textOf(content);
	return hasImages(content) && !content.some((block) => block.type === "text") ? IMAGE_ONLY_RESULT_TEXT : text;
}

// ============================================================================
// Helpers
// ============================================================================

/** Text blocks joined by newlines; images carry no text. */
function textOf(content: ReadonlyArray<TextContent | ImageContent>): string {
	return content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

/** Whether content holds an image. */
function hasImages(content: ReadonlyArray<TextContent | ImageContent>): boolean {
	return content.some((block) => block.type === "image");
}

/**
 * OpenAI tool-result text. Without text, a result with images says so and an
 * empty one says it has no output; Responses sends images to an image model
 * as parts beside the text instead.
 */
function openAiResultText(content: ReadonlyArray<TextContent | ImageContent>, imagesAsParts: boolean): string {
	const text = textOf(content);
	if (text.length > 0 || (imagesAsParts && hasImages(content))) return text;
	return hasImages(content) ? IMAGE_ONLY_RESULT_TEXT : EMPTY_RESULT_TEXT;
}

/** A tool call's text: the raw grammar input for a grammar tool, otherwise canonical JSON arguments. */
function toolCallText(
	call: { readonly name: string; readonly arguments: unknown },
	grammar: ReadonlyMap<string, string>,
): string {
	const property = grammar.get(call.name);
	if (property !== undefined && typeof call.arguments === "object" && call.arguments !== null) {
		const input = (call.arguments as Record<string, unknown>)[property];
		if (typeof input === "string") return input;
	}
	return canonicalJson(call.arguments);
}

/** Whether a model's `compat` sets a boolean flag; unset flags are false for every compared API. */
function compatFlag(model: GuardModel, name: string): boolean {
	return (model.compat as Readonly<Record<string, unknown>> | undefined)?.[name] === true;
}
