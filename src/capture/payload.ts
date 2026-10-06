/**
 * PayloadParser: copies a provider payload in `before_provider_request` and
 * extracts its tool-declaration channel (D4). The API of the request or
 * dispatched model selects the parser, never the payload's shape: the shape is
 * only checked against that API, and a payload that does not match it is not
 * compared. Pure functions over process-local data.
 */

/** Name of the deferred tool Pi declares for Anthropic's native tool changes; the model never sees it. */
export const DEFERRED_PLACEHOLDER_NAME = "__pi_deferred_placeholder__";

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
			return { status: "unsupported", reason: `Payloads of the ${api} API are not compared.` };
	}
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
	if (!isItem(payload) || !isItemList(payload.messages) || "input" in payload || "system" in payload) return false;
	return payload.messages.every((message) => COMPLETIONS_ROLES.has(String(message.role))
		&& (message.tools === undefined || isItemList(message.tools) && message.tools.every(isCompletionsTool)))
		&& optionalItems(payload.tools)?.every(isCompletionsTool) === true;
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

// ============================================================================
// OpenAI Responses
// ============================================================================

/** `input` items instead of messages, flat declarations. */
function isResponsesPayload(payload: unknown): payload is Item & { readonly input: readonly Item[] } {
	if (!isItem(payload) || !isItemList(payload.input) || "messages" in payload) return false;
	return payload.input.every((item) => typeof item.role === "string" || typeof item.type === "string")
		&& optionalItems(payload.tools)?.every(isResponsesTool) === true
		&& payload.input.every((item) => !isInlineResponsesTools(item) || isItemList(item.tools)
			&& item.tools.every(isResponsesTool));
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

// ============================================================================
// Anthropic Messages
// ============================================================================

/**
 * Top-level `system`, declarations with a name and no `function`. With
 * `supportsMidConvoSystemMessages`, `messages` also holds system messages.
 */
function isAnthropicPayload(payload: unknown): payload is Item & { readonly messages: readonly Item[] } {
	if (!isItem(payload) || !isItemList(payload.messages) || "input" in payload) return false;
	return (payload.system === undefined || typeof payload.system === "string" || isItemList(payload.system))
		&& payload.messages.every((message) => ANTHROPIC_ROLES.has(String(message.role)))
		&& optionalItems(payload.tools)?.every((tool) => isDeclaration(tool) && !("function" in tool)) === true;
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

/** A successful parse. */
function parsed(declarations: readonly PayloadDeclaration[]): ParsedTools {
	return { status: "parsed", declarations };
}

/** A payload that does not match the selected API's representation. */
function mismatch(api: string): ParsedTools {
	return { status: "unsupported", reason: `The payload does not match the ${api} request format.` };
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
