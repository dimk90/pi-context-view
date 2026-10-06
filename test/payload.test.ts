import assert from "node:assert/strict";
import { test } from "node:test";

import {
	copyPayload, DEFERRED_PLACEHOLDER_NAME, hasWarmOutputLimit, parsePayloadTools, PAYLOAD_SHAPE_CHECKS,
} from "../src/capture/payload.ts";
import { compareToolDeclarations } from "../src/capture/tools.ts";

/** Small declaration used across provider shapes. */
const READ = { name: "read", description: "Read a file." };
const WRITE = { name: "write", description: "Write a file." };

/** Completions declaration including a schema, which is deliberately not compared. */
function completionsTool(tool = READ): unknown {
	return { type: "function", function: { ...tool, parameters: { type: "object" } } };
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
