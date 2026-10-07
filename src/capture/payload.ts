/**
 * PayloadParser: copies a provider payload in `before_provider_request` and
 * extracts its tool-declaration and message channels (D4). The API of the
 * request or dispatched model selects the parser, never the payload's shape:
 * the shape is only checked against that API, and a payload that does not
 * match it is not compared. Pure functions over process-local data.
 */
import { canonicalJson } from "./diff.ts";
import { type MessageUnit, UnitCollector } from "./messages.ts";

/** Name of the deferred tool Pi declares for Anthropic's native tool changes; the model never sees it. */
export const DEFERRED_PLACEHOLDER_NAME = "__pi_deferred_placeholder__";

/** System block Pi puts before the prompt for an Anthropic OAuth token. */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Deepest nesting a payload copy follows; tool schemas are the deepest part of a payload. */
const MAX_COPY_DEPTH = 256;

/** Message roles each API's serializer emits. */
const COMPLETIONS_ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const ANTHROPIC_ROLES = new Set(["system", "user", "assistant"]);

/** APIs whose payloads the guard parses. */
export const SUPPORTED_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

/**
 * Result of copying a payload:
 *   supported     an owned copy of every array and plain object; strings are shared
 *   unsupported   the payload holds something else, such as bytes or a class instance
 */
export type PayloadCopy =
	| { readonly supported: true; readonly payload: unknown }
	| { readonly supported: false; readonly reason: string };

/** One tool declaration as the payload states it. */
export interface PayloadDeclaration {
	/** The payload's declared name; never inferred from a provider tool type. */
	readonly name: string;
	readonly description?: string;
}

/**
 * Result of parsing a payload's tool-declaration channel:
 *   parsed        declarations after replaying inline tool changes, in declaration order,
 *                 without Pi's deferred placeholder
 *   unsupported   the API has no parser, or the payload does not match its representation
 */
export type ParsedTools =
	| { readonly status: "parsed"; readonly declarations: readonly PayloadDeclaration[] }
	| { readonly status: "unsupported"; readonly reason: string };

/**
 * Result of parsing a payload's message channel:
 *   parsed        text units in payload order, without inline tool changes, reasoning, or image data
 *   unsupported   the API has no parser, or a message or block has an unknown shape
 */
export type ParsedMessages =
	| { readonly status: "parsed"; readonly units: readonly MessageUnit[] }
	| { readonly status: "unsupported"; readonly reason: string };

/** A JSON object in a payload. */
type Item = Readonly<Record<string, unknown>>;

/**
 * Copy a payload's arrays and plain objects and share its strings. Later
 * handlers can replace a string but cannot change it in place, so sharing is
 * safe; a full clone would cost the payload's whole size.
 */
export function copyPayload(payload: unknown): PayloadCopy {
	try {
		return { supported: true, payload: copyValue(payload, 0) };
	} catch {
		// A getter may throw with raw content in its error; never expose that message
		return { supported: false, reason: "The payload could not be copied as JSON data." };
	}
}

/** Whether a payload carries a one-token output limit, as a cache-warm refresh does. */
export function hasWarmOutputLimit(payload: unknown): boolean {
	if (!isItem(payload)) return false;
	// OpenAI Responses raises the limit to its minimum of 16 output tokens
	return payload.max_tokens === 1 || payload.max_completion_tokens === 1
		|| payload.max_output_tokens === 1 || payload.max_output_tokens === 16;
}

/**
 * Parse the tool-declaration channel with the parser of `api`. Inline tool
 * changes are replayed on the request-level list in order: a later definition
 * with the same name replaces an earlier one.
 */
export function parsePayloadTools(api: string, payload: unknown): ParsedTools {
	switch (api) {
		case "openai-completions":
			return isCompletionsPayload(payload) ? parsed(completionsDeclarations(payload)) : mismatch(api);
		case "openai-responses":
			return isResponsesPayload(payload) ? parsed(responsesDeclarations(payload)) : mismatch(api);
		case "anthropic-messages": {
			if (!isAnthropicPayload(payload)) return mismatch(api);
			const declarations = anthropicDeclarations(payload);
			return declarations === undefined ? mismatch(api) : parsed(declarations);
		}
		default:
			return { status: "unsupported", reason: unsupportedApiReason(api) };
	}
}

/**
 * Parse the message channel with the parser of `api`: one unit per run of
 * system, user, or assistant text in a message, and one per tool call and
 * tool result. Image data, reasoning, and inline tool changes are left out.
 */
export function parsePayloadMessages(api: string, payload: unknown): ParsedMessages {
	let units: MessageUnit[] | undefined;
	switch (api) {
		case "openai-completions":
			if (!isCompletionsMessages(payload)) return messageMismatch(api);
			units = completionsUnits(payload);
			break;
		case "openai-responses":
			if (!isResponsesInput(payload)) return messageMismatch(api);
			units = responsesUnits(payload);
			break;
		case "anthropic-messages":
			if (!isAnthropicMessages(payload)) return messageMismatch(api);
			units = anthropicUnits(payload);
			break;
		default:
			return { status: "unsupported", reason: unsupportedApiReason(api) };
	}
	return units === undefined
		? { status: "unsupported", reason: `A payload message has a shape the ${api} parser does not know.` }
		: { status: "parsed", units };
}

/**
 * Representation checks. They only reject a payload that cannot be the
 * selected API's: a payload without a system prompt, tools, or tool history can
 * pass more than one.
 */
export const PAYLOAD_SHAPE_CHECKS: Readonly<Record<(typeof SUPPORTED_APIS)[number], (payload: unknown) => boolean>> = {
	"openai-completions": isCompletionsPayload,
	"openai-responses": isResponsesPayload,
	"anthropic-messages": isAnthropicPayload,
};

// ============================================================================
// Copy
// ============================================================================

/** Copy one value; throws on anything outside JSON-like data. */
function copyValue(value: unknown, depth: number): unknown {
	if (value === null || typeof value !== "object") {
		if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
			throw new Error(`The payload holds a ${typeof value} value.`);
		}
		return value;
	}
	if (depth >= MAX_COPY_DEPTH) throw new Error("The payload is nested too deeply.");
	if (Array.isArray(value)) return value.map((element) => copyValue(element, depth + 1));
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error("The payload holds a non-JSON object.");
	return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, copyValue(nested, depth + 1)]));
}

// ============================================================================
// OpenAI Completions
// ============================================================================

/**
 * System prompt in `messages`, `tool` results, declarations nested under
 * `function`, or `custom` for grammar tools.
 */
function isCompletionsPayload(payload: unknown): payload is Item & { readonly messages: readonly Item[] } {
	return isCompletionsMessages(payload)
		&& payload.messages.every((message) => message.tools === undefined
			|| isItemList(message.tools) && message.tools.every(isCompletionsTool))
		&& optionalItems(payload.tools)?.every(isCompletionsTool) === true;
}

/** Completions' message representation, independent of declaration support. */
function isCompletionsMessages(payload: unknown): payload is Item & { readonly messages: readonly Item[] } {
	return isItem(payload) && isItemList(payload.messages) && !("input" in payload) && !("system" in payload)
		&& payload.messages.every((message) => COMPLETIONS_ROLES.has(String(message.role)));
}

/** A function or grammar declaration with a nested name. */
function isCompletionsTool(tool: Item): boolean {
	const nested = tool.type === "custom" ? tool.custom : tool.function;
	return (tool.type === "function" || tool.type === "custom") && isItem(nested) && isDeclaration(nested);
}

/** Request-level declarations, then additions in system messages with a `tools` list. */
function completionsDeclarations(payload: Item & { readonly messages: readonly Item[] }): PayloadDeclaration[] {
	const declared = new Map<string, PayloadDeclaration>();
	const declare = (tool: Item) => {
		const nested = (tool.type === "custom" ? tool.custom : tool.function) as Item;
		addDeclaration(declared, nested.name as string, nested.description);
	};
	for (const tool of optionalItems(payload.tools) ?? []) declare(tool);
	for (const message of payload.messages) {
		if (message.role === "system" && isItemList(message.tools)) message.tools.forEach(declare);
	}
	return [...declared.values()];
}

/**
 * Units of each message: `system` and `developer` text, user text without
 * images, assistant text and `tool_calls`, and `tool` results. Reasoning
 * fields and a system message's inline `tools` belong to other channels.
 */
function completionsUnits(payload: Item & { readonly messages: readonly Item[] }): MessageUnit[] | undefined {
	const units = new UnitCollector();
	for (const message of payload.messages) {
		units.boundary();
		switch (message.role) {
			case "system":
			case "developer": {
				// A message with only inline tool additions has no content
				if (message.content === undefined && message.tools !== undefined) break;
				const text = completionsText(message.content);
				if (text === undefined) return undefined;
				units.text("system", text);
				break;
			}
			case "user":
			case "assistant": {
				const text = message.role === "assistant" && message.content === null ? "" : completionsText(message.content);
				if (text === undefined) return undefined;
				units.text(message.role, text);
				if (message.role === "assistant" && !addCompletionsToolCalls(units, message.tool_calls)) return undefined;
				break;
			}
			case "tool": {
				const text = completionsText(message.content);
				if (text === undefined) return undefined;
				units.toolResult(text);
				break;
			}
			default:
				return undefined;
		}
	}
	return units.result();
}

/** Text of string content or of `text` parts; `image_url` parts carry no text. Undefined for other shapes. */
function completionsText(content: unknown): string | undefined {
	return blockText(content, { text: "text", image_url: "skip" });
}

/** Add function and grammar tool calls; false for an unknown shape. */
function addCompletionsToolCalls(units: UnitCollector, toolCalls: unknown): boolean {
	if (toolCalls === undefined || toolCalls === null) return true;
	if (!isItemList(toolCalls)) return false;
	for (const call of toolCalls) {
		const nested = call.type === "custom" ? call.custom : call.function;
		if (!isItem(nested) || typeof nested.name !== "string") return false;
		if (call.type === "custom" && typeof nested.input === "string") units.toolCall(nested.name, nested.input);
		else if (call.type === "function") units.toolCall(nested.name, argumentsText(nested.arguments));
		else return false;
	}
	return true;
}

// ============================================================================
// OpenAI Responses
// ============================================================================

/** `input` items instead of messages, flat declarations. */
function isResponsesPayload(payload: unknown): payload is Item & { readonly input: readonly Item[] } {
	return isResponsesInput(payload) && optionalItems(payload.tools)?.every(isResponsesTool) === true
		&& payload.input.every((item) => !isInlineResponsesTools(item) || isItemList(item.tools)
			&& item.tools.every(isResponsesTool));
}

/** Responses' input representation, independent of declaration support. */
function isResponsesInput(payload: unknown): payload is Item & { readonly input: readonly Item[] } {
	return isItem(payload) && isItemList(payload.input) && !("messages" in payload)
		&& payload.input.every((item) => typeof item.role === "string" || typeof item.type === "string");
}

/** Function and grammar declarations; unknown provider-native tools make the channel incomplete. */
function isResponsesTool(tool: Item): boolean {
	return (tool.type === "function" || tool.type === "custom") && isDeclaration(tool);
}

/** An item that declares later tools in place: `additional_tools` or a tool search output. */
function isInlineResponsesTools(item: Item): boolean {
	return item.type === "additional_tools" || item.type === "tool_search_output";
}

/** Request-level declarations, then inline additions in item order. */
function responsesDeclarations(payload: Item & { readonly input: readonly Item[] }): PayloadDeclaration[] {
	const declared = new Map<string, PayloadDeclaration>();
	const declare = (tool: Item) => addDeclaration(declared, tool.name as string, tool.description);
	for (const tool of optionalItems(payload.tools) ?? []) declare(tool);
	for (const item of payload.input) {
		if (isInlineResponsesTools(item) && isItemList(item.tools)) item.tools.forEach(declare);
	}
	return [...declared.values()];
}

/** Items with no message text: reasoning replay and the inline tool changes of the tool channel. */
const RESPONSES_SKIPPED_ITEMS = new Set(["reasoning", "additional_tools", "tool_search_call", "tool_search_output"]);

/**
 * Units of each input item: role messages, function and grammar tool calls,
 * and their outputs. Reasoning items and inline tool changes are skipped.
 */
function responsesUnits(payload: Item & { readonly input: readonly Item[] }): MessageUnit[] | undefined {
	const units = new UnitCollector();
	for (const item of payload.input) {
		units.boundary();
		if (typeof item.type === "string" && RESPONSES_SKIPPED_ITEMS.has(item.type)) continue;
		switch (item.type) {
			case undefined:
			case "message": {
				const part = responsesPart(item.role);
				const text = part === undefined ? undefined : blockText(item.content, RESPONSES_CONTENT[part]);
				if (part === undefined || text === undefined) return undefined;
				units.text(part, text);
				break;
			}
			case "function_call":
				if (typeof item.name !== "string") return undefined;
				units.toolCall(item.name, argumentsText(item.arguments));
				break;
			case "custom_tool_call":
				if (typeof item.name !== "string" || typeof item.input !== "string") return undefined;
				units.toolCall(item.name, item.input);
				break;
			case "function_call_output":
			case "custom_tool_call_output": {
				const text = blockText(item.output, { input_text: "text", input_image: "skip" });
				if (text === undefined) return undefined;
				units.toolResult(text);
				break;
			}
			default:
				return undefined;
		}
	}
	return units.result();
}

/** Content part types of each Responses message role. */
const RESPONSES_CONTENT: Readonly<Record<"system" | "user" | "assistant", BlockTypes>> = {
	system: { input_text: "text" },
	user: { input_text: "text", input_image: "skip" },
	assistant: { output_text: "text" },
};

/** The message part of a Responses role; undefined for unknown roles. */
function responsesPart(role: unknown): "system" | "user" | "assistant" | undefined {
	if (role === "system" || role === "developer") return "system";
	return role === "user" || role === "assistant" ? role : undefined;
}

// ============================================================================
// Anthropic Messages
// ============================================================================

/**
 * Top-level `system`, declarations with a name and no `function`. With
 * `supportsMidConvoSystemMessages`, `messages` also holds system messages.
 */
function isAnthropicPayload(payload: unknown): payload is Item & { readonly messages: readonly Item[] } {
	return isAnthropicMessages(payload)
		&& optionalItems(payload.tools)?.every((tool) => isDeclaration(tool) && !("function" in tool)) === true;
}

/** Anthropic's message representation, independent of declaration support. */
function isAnthropicMessages(payload: unknown): payload is Item & { readonly messages: readonly Item[] } {
	return isItem(payload) && isItemList(payload.messages) && !("input" in payload)
		&& (payload.system === undefined || typeof payload.system === "string" || isItemList(payload.system))
		&& payload.messages.every((message) => ANTHROPIC_ROLES.has(String(message.role)));
}

/**
 * Request-level declarations without the deferred placeholder, then the
 * `tool_removal` and `tool_addition` blocks of system messages in order.
 * Undefined when an inline block is malformed.
 */
function anthropicDeclarations(payload: Item & { readonly messages: readonly Item[] }): PayloadDeclaration[] | undefined {
	const declared = new Map<string, PayloadDeclaration>();
	for (const tool of optionalItems(payload.tools) ?? []) {
		if (tool.name !== DEFERRED_PLACEHOLDER_NAME) addDeclaration(declared, tool.name as string, tool.description);
	}
	for (const message of payload.messages) {
		if (message.role !== "system" || !Array.isArray(message.content)) continue;
		for (const block of message.content as unknown[]) {
			if (!applyAnthropicToolChange(declared, block)) return undefined;
		}
	}
	return [...declared.values()];
}

/**
 * Units of the top-level `system` prompt and each message. The Claude Code
 * identity block that Pi adds for an OAuth token is left out, and so are
 * thinking, inline tool changes, and image data.
 */
function anthropicUnits(payload: Item & { readonly messages: readonly Item[] }): MessageUnit[] | undefined {
	const units = new UnitCollector();
	const system = Array.isArray(payload.system) && isItem(payload.system[0])
		&& payload.system[0].type === "text" && payload.system[0].text === CLAUDE_CODE_IDENTITY
		? payload.system.slice(1)
		: payload.system;
	if (system !== undefined) {
		const text = blockText(system, { text: "text" });
		if (text === undefined) return undefined;
		units.text("system", text);
	}
	for (const message of payload.messages) {
		units.boundary();
		const part = message.role as "system" | "user" | "assistant";
		if (typeof message.content === "string") {
			units.text(part, message.content);
			continue;
		}
		if (!Array.isArray(message.content)) return undefined;
		for (const block of message.content as unknown[]) {
			if (!isItem(block) || !addAnthropicBlock(units, part, block)) return undefined;
		}
	}
	return units.result();
}

/** Blocks with no message text: reasoning, and the inline tool changes of the tool channel. */
const ANTHROPIC_SKIPPED_BLOCKS: Readonly<Record<"system" | "user" | "assistant", ReadonlySet<string>>> = {
	system: new Set(["tool_addition", "tool_removal"]),
	user: new Set(["image"]),
	assistant: new Set(["thinking", "redacted_thinking"]),
};

/** Add one content block of a message with role `part`; false for an unknown or malformed block. */
function addAnthropicBlock(units: UnitCollector, part: "system" | "user" | "assistant", block: Item): boolean {
	if (typeof block.type === "string" && ANTHROPIC_SKIPPED_BLOCKS[part].has(block.type)) return true;
	if (block.type === "text" && typeof block.text === "string") {
		units.text(part, block.text);
		return true;
	}
	if (part === "assistant" && block.type === "tool_use" && typeof block.name === "string") {
		units.toolCall(block.name, canonicalJson(block.input ?? {}));
		return true;
	}
	if (part === "user" && block.type === "tool_result") {
		const text = block.content === undefined ? "" : blockText(block.content, { text: "text", image: "skip" });
		if (text === undefined) return false;
		units.toolResult(text);
		return true;
	}
	return false;
}

/**
 * Apply one system-message block; other block types change no declaration.
 * False when a tool change block is malformed.
 */
function applyAnthropicToolChange(declared: Map<string, PayloadDeclaration>, block: unknown): boolean {
	if (!isItem(block)) return true;
	if (block.type === "tool_removal") {
		const reference = block.tool;
		if (!isItem(reference) || reference.type !== "tool_reference" || typeof reference.name !== "string") return false;
		declared.delete(reference.name);
		return true;
	}
	if (block.type !== "tool_addition") return true;
	const definition = isItem(block.tool) && block.tool.type === "tool_definition" ? block.tool.definition : undefined;
	if (!isItem(definition) || !isDeclaration(definition)) return false;
	addDeclaration(declared, definition.name, definition.description);
	return true;
}

// ============================================================================
// Helpers
// ============================================================================

/** Record a declaration; a later one with the same name replaces it. */
function addDeclaration(declared: Map<string, PayloadDeclaration>, name: string, description: unknown): void {
	if (name !== DEFERRED_PLACEHOLDER_NAME) declared.set(name, typeof description === "string" ? { name, description } : { name });
}

/** A declared name and an optional description; do not silently drop malformed descriptions. */
function isDeclaration(item: Item): item is Item & { readonly name: string } {
	return typeof item.name === "string" && (item.description === undefined || typeof item.description === "string");
}

/**
 * How a content part type contributes text:
 *   text   its `text` field is part of the unit
 *   skip   it carries no text, such as image data
 */
type BlockTypes = Readonly<Record<string, "text" | "skip">>;

/**
 * Text of string content or of a list of typed parts, joined by newlines.
 * Undefined for another shape or an unknown part type.
 */
function blockText(content: unknown, types: BlockTypes): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	for (const block of content as unknown[]) {
		if (!isItem(block) || typeof block.type !== "string" || !Object.hasOwn(types, block.type)) return undefined;
		if (types[block.type] === "skip") continue;
		if (typeof block.text !== "string") return undefined;
		texts.push(block.text);
	}
	return texts.join("\n");
}

/** Tool-call arguments sent as a JSON string, in canonical form; text that is not JSON stays as sent. */
function argumentsText(value: unknown): string {
	if (typeof value !== "string") return canonicalJson(value);
	try {
		return canonicalJson(JSON.parse(value));
	} catch {
		return value;
	}
}

/** A successful parse. */
function parsed(declarations: readonly PayloadDeclaration[]): ParsedTools {
	return { status: "parsed", declarations };
}

/** A payload that does not match the selected API's representation. */
function mismatch(api: string): ParsedTools {
	return { status: "unsupported", reason: mismatchReason(api) };
}

/** A payload that does not match the selected API's representation, for the message channel. */
function messageMismatch(api: string): ParsedMessages {
	return { status: "unsupported", reason: mismatchReason(api) };
}

/** Reason of a payload that does not match its API's representation. */
function mismatchReason(api: string): string {
	return `The payload does not match the ${api} request format.`;
}

/** Reason of an API without a parser. */
function unsupportedApiReason(api: string): string {
	return `Payloads of the ${api} API are not compared.`;
}

/** Whether `value` is a plain JSON object. */
function isItem(value: unknown): value is Item {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is an array of plain JSON objects. */
function isItemList(value: unknown): value is readonly Item[] {
	return Array.isArray(value) && value.every(isItem);
}

/** The items of an optional list: empty when absent, undefined when not a list of objects. */
function optionalItems(value: unknown): readonly Item[] | undefined {
	if (value === undefined) return [];
	return isItemList(value) ? value : undefined;
}
