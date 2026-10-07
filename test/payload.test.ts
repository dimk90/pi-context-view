import assert from "node:assert/strict";
import { test } from "node:test";

import type { MessageUnit } from "../src/capture/messages.ts";
import {
	CLAUDE_CODE_IDENTITY, copyPayload, DEFERRED_PLACEHOLDER_NAME, hasWarmOutputLimit, parsePayloadMessages,
	parsePayloadTools, PAYLOAD_SHAPE_CHECKS,
} from "../src/capture/payload.ts";
import { compareToolDeclarations } from "../src/capture/tools.ts";

/** Small declaration used across provider shapes. */
const READ = { name: "read", description: "Read a file." };
const WRITE = { name: "write", description: "Write a file." };

/** Completions declaration including a schema, which is deliberately not compared. */
function completionsTool(tool = READ): unknown {
	return { type: "function", function: { ...tool, parameters: { type: "object" } } };
}

/** Image data the message channel must never keep. */
const IMAGE_DATA = "data:image/png;base64,PRIVATE_IMAGE_BYTES";

/** Message units of a successful parse. */
function units(api: string, payload: unknown): readonly MessageUnit[] {
	const parsed = parsePayloadMessages(api, payload);
	assert.equal(parsed.status, "parsed", JSON.stringify(parsed));
	assert.ok(parsed.status === "parsed");
	assert.doesNotMatch(JSON.stringify(parsed.units), /PRIVATE_IMAGE_BYTES/);
	return parsed.units;
}

/** Successful parse, failing the test rather than masking an unsupported channel. */
function declarations(api: string, payload: unknown) {
	const parsed = parsePayloadTools(api, payload);
	assert.equal(parsed.status, "parsed");
	assert.ok(parsed.status === "parsed");
	return parsed.declarations;
}

test("copyPayload owns nested arrays and objects, shares text, and preserves __proto__ keys", () => {
	const payload = { messages: [{ role: "user", content: "A".repeat(100_000) }], tools: [completionsTool()] };
	const original = structuredClone(payload);
	const copy = copyPayload(payload);
	assert.ok(copy.supported);
	assert.deepEqual(copy.payload, original);
	assert.notEqual(copy.payload, payload);
	payload.messages[0].content = "changed";
	payload.tools.push(completionsTool(WRITE));
	assert.deepEqual(copy.payload, original);
	const special: unknown = JSON.parse('{"__proto__":{"name":"data, not a prototype"}}');
	assert.deepEqual(copyPayload(special), { supported: true, payload: special });
});

test("unsupported copies never expose exception text, images, or signature bytes in their reason", () => {
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	for (const payload of [new Uint8Array(3), new Date(), { value: () => undefined }, cyclic, {
		get content() { throw new Error("PRIVATE_PAYLOAD"); },
	}]) {
		const copy = copyPayload(payload);
		assert.equal(copy.supported, false);
		assert.doesNotMatch(JSON.stringify(copy), /PRIVATE_PAYLOAD/);
	}
});

test("warm limits include Responses' 16-token floor, but not arbitrary small or invalid limits", () => {
	for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
		assert.equal(hasWarmOutputLimit({ [field]: 1 }), true);
	}
	assert.equal(hasWarmOutputLimit({ max_output_tokens: 16 }), true);
	for (const value of [0, -1, 2, 15, 128, "1", undefined]) {
		assert.equal(hasWarmOutputLimit({ max_output_tokens: value }), false);
	}
});

test("parser selection comes from API even for ambiguous or mismatched payloads", () => {
	const ambiguous = { messages: [{ role: "user", content: "hi" }] };
	assert.deepEqual(declarations("openai-completions", ambiguous), []);
	assert.deepEqual(declarations("anthropic-messages", ambiguous), []);
	assert.equal(parsePayloadTools("pi-virtual", ambiguous).status, "unsupported");
	assert.equal(parsePayloadTools("google-generative-ai", ambiguous).status, "unsupported");
	assert.equal(parsePayloadTools("openai-responses", ambiguous).status, "unsupported");
	const responses = { input: [], tools: [{ type: "function", ...READ }] };
	assert.deepEqual(declarations("openai-responses", responses), [READ]);
	assert.equal(parsePayloadTools("anthropic-messages", responses).status, "unsupported");
	assert.equal(PAYLOAD_SHAPE_CHECKS["openai-completions"]({ ...ambiguous, system: "prompt" }), false);
});

test("Completions extracts function and grammar tools, including inline system additions", () => {
	const payload = {
		messages: [{ role: "user", content: "hi" }, { role: "system", tools: [completionsTool(WRITE)] }],
		tools: [completionsTool(), { type: "custom", custom: { name: "codemode", description: "Run JS." } }],
	};
	assert.deepEqual(declarations("openai-completions", payload), [READ, { name: "codemode", description: "Run JS." }, WRITE]);
});

for (const inlineType of ["additional_tools", "tool_search_output"]) {
	test(`Responses replays ${inlineType} and ignores tool_search_call arguments`, () => {
		const payload = {
			tools: [{ type: "function", ...READ }],
			input: [
				{ type: "tool_search_call", arguments: { query: "write" } },
				{ type: inlineType, role: "developer", tools: [{ type: "custom", ...WRITE }] },
			],
		};
		assert.deepEqual(declarations("openai-responses", payload), [READ, WRITE]);
	});
}

test("Anthropic replays inline addition, removal and same-name redefinition, ignoring the placeholder", () => {
	const payload = {
		system: [{ type: "text", text: "prompt" }],
		tools: [READ, { name: DEFERRED_PLACEHOLDER_NAME }],
		messages: [{ role: "system", content: [
			{ type: "tool_addition", tool: { type: "tool_definition", definition: WRITE } },
			{ type: "tool_addition", tool: { type: "tool_definition", definition: { ...READ, description: "new" } } },
			{ type: "tool_removal", tool: { type: "tool_reference", name: "write" } },
			{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: DEFERRED_PLACEHOLDER_NAME } } },
		] }],
	};
	assert.deepEqual(declarations("anthropic-messages", payload), [{ ...READ, description: "new" }]);
});

test("malformed declarations and inline changes cannot produce a complete tool channel", () => {
	const cases: Array<[string, unknown]> = [
		["openai-completions", { messages: [], tools: [{ type: "function", function: {} }] }],
		["openai-completions", { messages: [], tools: [completionsTool({ name: "read", description: 42 as unknown as string })] }],
		["openai-responses", { input: [], tools: [{ type: "unknown" }] }],
		["openai-responses", { input: [{ type: "additional_tools", tools: "bad" }] }],
		["anthropic-messages", { messages: [], tools: null }],
		...[{ type: "tool_addition", tool: {} }, { type: "tool_removal", tool: {} }].map((block): [string, unknown] =>
			["anthropic-messages", { messages: [{ role: "system", content: [block] }] }]),
	];
	for (const [api, payload] of cases) assert.equal(parsePayloadTools(api, payload).status, "unsupported");
});

test("tool comparison reports additions, changed descriptions, and missing declarations with candidates", () => {
	const result = compareToolDeclarations({
		expected: [READ, WRITE], baselineNames: ["read", "write", "old"],
		declarations: [{ ...READ, description: "changed" }, { name: "late", description: "Added later." }],
		ignoreNameCase: false, loadoutCandidates: () => ["codemode", "tool_search"],
	});
	assert.deepEqual(result, {
		findings: [
			{ type: "hidden-declaration", name: "write", candidates: ["codemode", "tool_search"] },
			{ type: "late-tool-edit", change: "modified", name: "read", description: "changed" },
			{ type: "late-tool-edit", change: "added", name: "late", description: "Added later." },
		],
		declaredTools: { declared: ["read", "late"], baseline: ["read", "write", "old"] },
	});
});

test("Anthropic OAuth names map back to captured spelling; other APIs retain case changes", () => {
	const input = {
		expected: [READ], baselineNames: ["read"], declarations: [{ ...READ, name: "Read" }],
		loadoutCandidates: () => [],
	};
	assert.deepEqual(compareToolDeclarations({ ...input, ignoreNameCase: true }), {
		findings: [], declaredTools: { declared: ["read"], baseline: ["read"] },
	});
	assert.equal(compareToolDeclarations({ ...input, ignoreNameCase: false }).findings.length, 2);
});

test("Completions message units: roles, text parts, tool calls and results; not reasoning or inline tools", () => {
	const payload = {
		messages: [
			{ role: "developer", content: [{ type: "text", text: "prompt", cache_control: { type: "ephemeral" } }] },
			{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: IMAGE_DATA } }] },
			{
				role: "assistant", content: null, reasoning_content: "hidden reasoning",
				tool_calls: [
					{ id: "a", type: "function", function: { name: "read", arguments: '{"path":"x","limit":2}' } },
					{ id: "b", type: "custom", custom: { name: "codemode", input: "return 1;" } },
					{ id: "c", type: "function", function: { name: "bad", arguments: "{not json" } },
				],
			},
			{ role: "tool", tool_call_id: "a", content: "file" },
			{ role: "system", tools: [completionsTool(WRITE)] },
			{ role: "system", content: "update" },
			{ role: "assistant", content: "done" },
		],
	};
	assert.deepEqual(units("openai-completions", payload), [
		{ part: "system", text: "prompt" },
		{ part: "user", text: "look" },
		{ part: "assistant", text: "" },
		{ part: "tool-call", name: "read", text: '{"limit":2,"path":"x"}' },
		{ part: "tool-call", name: "codemode", text: "return 1;" },
		{ part: "tool-call", name: "bad", text: "{not json" },
		{ part: "tool-result", text: "file" },
		{ part: "system", text: "update" },
		{ part: "assistant", text: "done" },
	]);
});

test("Responses message units: items in order; reasoning and inline tool items are skipped", () => {
	const payload = {
		input: [
			{ role: "developer", content: "prompt" },
			{ role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: IMAGE_DATA }] },
			{ type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "one", annotations: [] }] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "two", annotations: [] }] },
			{ type: "function_call", call_id: "a", name: "read", arguments: '{"path":"x"}' },
			{ type: "custom_tool_call", call_id: "b", name: "codemode", input: "return 1;" },
			{ type: "function_call_output", call_id: "a", output: "file" },
			{ type: "custom_tool_call_output", call_id: "b", output: [{ type: "input_image", image_url: IMAGE_DATA }] },
			{ type: "additional_tools", role: "developer", tools: [{ type: "function", ...WRITE }] },
			{ type: "tool_search_call", call_id: "s", arguments: { query: "write" } },
			{ type: "tool_search_output", call_id: "s", tools: [{ type: "function", ...WRITE }] },
		],
	};
	assert.deepEqual(units("openai-responses", payload), [
		{ part: "system", text: "prompt" },
		{ part: "user", text: "look" },
		{ part: "assistant", text: "one" },
		{ part: "assistant", text: "two" },
		{ part: "tool-call", name: "read", text: '{"path":"x"}' },
		{ part: "tool-call", name: "codemode", text: "return 1;" },
		{ part: "tool-result", text: "file" },
		{ part: "tool-result", text: "" },
	]);
});

test("Anthropic message units: OAuth identity, held system text, merged blocks, and skipped thinking", () => {
	const payload = {
		system: [{ type: "text", text: CLAUDE_CODE_IDENTITY }, { type: "text", text: "prompt" }],
		messages: [
			{ role: "user", content: "look" },
			{ role: "assistant", content: [
				{ type: "thinking", thinking: "signed", signature: "s" },
				{ type: "redacted_thinking", data: "opaque" },
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
				{ type: "tool_use", id: "a", name: "Read", input: { path: "x", limit: 2 } },
				{ type: "text", text: "after" },
			] },
			{ role: "user", content: [
				{ type: "tool_result", tool_use_id: "a", content: "file" },
				{ type: "tool_result", tool_use_id: "b", content: [
					{ type: "text", text: "(see attached image)" }, { type: "image", source: { data: IMAGE_DATA } },
				] },
			] },
			{ role: "system", content: [
				{ type: "text", text: "update" },
				{ type: "tool_addition", tool: { type: "tool_definition", definition: WRITE } },
			] },
			{ role: "system", content: [], output_config: { effort: "high" } },
		],
	};
	assert.deepEqual(units("anthropic-messages", payload), [
		{ part: "system", text: "prompt" },
		{ part: "user", text: "look" },
		{ part: "assistant", text: "one\ntwo" },
		{ part: "tool-call", name: "Read", text: '{"limit":2,"path":"x"}' },
		{ part: "assistant", text: "after" },
		{ part: "tool-result", text: "file" },
		{ part: "tool-result", text: "(see attached image)" },
		{ part: "system", text: "update" },
	]);
	// Only Pi's exact leading block is its OAuth identity
	assert.deepEqual(units("anthropic-messages", { system: `${CLAUDE_CODE_IDENTITY} Custom.`, messages: [] }),
		[{ part: "system", text: `${CLAUDE_CODE_IDENTITY} Custom.` }]);
});

test("unknown message parts, items, and blocks leave the message channel unsupported", () => {
	const cases: Array<[string, unknown]> = [
		["openai-completions", { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }] }],
		["openai-completions", { messages: [{ role: "assistant", content: null, tool_calls: [{ type: "mystery" }] }] }],
		["openai-completions", { messages: [{ role: "tool", content: 42 }] }],
		["openai-responses", { input: [{ type: "compaction", encrypted_content: "x" }] }],
		["openai-responses", { input: [{ role: "assistant", content: [{ type: "refusal", refusal: "no" }] }] }],
		["openai-responses", { input: [{ role: "critic", content: "x" }] }],
		["anthropic-messages", { messages: [{ role: "user", content: [{ type: "document", source: {} }] }] }],
		["anthropic-messages", { messages: [{ role: "assistant", content: [{ type: "server_tool_use", name: "x" }] }] }],
		["anthropic-messages", { system: [{ type: "image" }], messages: [] }],
	];
	for (const [api, payload] of cases) {
		const parsed = parsePayloadMessages(api, payload);
		assert.equal(parsed.status, "unsupported", `${api}: ${JSON.stringify(payload)}`);
	}
	assert.equal(parsePayloadMessages("google-generative-ai", { contents: [] }).status, "unsupported");
	assert.equal(parsePayloadMessages("openai-responses", { messages: [] }).status, "unsupported");
});
