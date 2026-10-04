import assert from "node:assert/strict";
import { test } from "node:test";

import { getCurrentSystemMessage } from "@earendil-works/pi-ai";

import { diffConversation, diffSystemState, messageKey, sameMessage, trimMatchedEnds } from "../src/capture/diff.ts";
import type { BaselineMessage } from "../src/capture/request.ts";
import type { RequestMessage } from "../src/snapshot.ts";
import type { SystemMessage } from "../src/transcript.ts";

const READ = { name: "read", description: "Read a file", parameters: { type: "object" } };
const WRITE = { name: "write", description: "Write a file", parameters: { type: "object" } };

/** A user message with distinct text. */
function user(text: string, timestamp = 1): RequestMessage {
	return { role: "user", content: text, timestamp };
}

/** An assistant reply with distinct text. */
function assistant(text: string): Extract<RequestMessage, { role: "assistant" }> {
	return {
		role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "mock", model: "m",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop", timestamp: 2,
	};
}

/** Baseline messages with entry IDs `e0`, `e1`, ... */
function baseline(...messages: RequestMessage[]): BaselineMessage[] {
	return messages.map((message, index) => ({ entryId: `e${index}`, message }));
}

/** Compact description of edits for assertions. */
function describe(edits: ReturnType<typeof diffConversation>): string[] {
	return edits.map((edit) => {
		if (edit.type === "added") return `added ${messageText(edit.message)}`;
		if (edit.type === "deleted") return `deleted ${edit.baseline.entryId}`;
		return `modified ${edit.baseline.entryId} -> ${messageText(edit.message)}`;
	});
}

/** Text of a synthetic message. */
function messageText(message: RequestMessage): string {
	if (message.role === "user" || message.role === "custom") {
		return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
	}
	if (message.role === "assistant") return message.content.map((block) => block.type === "text" ? block.text : "").join("");
	return message.role;
}

test("an unchanged request has an empty diff, whatever its timestamps, metadata, and key order", () => {
	const before = baseline(user("one"), assistant("two"), {
		role: "custom", customType: "note", content: "three", display: true, details: { a: 1 }, timestamp: 3,
	});
	const after: RequestMessage[] = [
		user("one", 99),
		{ ...assistant("two"), usage: { ...assistant("two").usage, input: 5 }, timestamp: 100 },
		{ timestamp: 101, details: { b: 2 }, display: false, content: "three", customType: "note", role: "custom" },
	];
	assert.deepEqual(diffConversation(before, after), []);
	assert.equal(messageKey(before[2].message), messageKey(after[2]));
});

test("additions, deletions, and modifications are classified by aligned position", () => {
	const before = baseline(user("one"), assistant("a1"), user("two"), assistant("a2"), user("three"));
	const after = [user("one"), assistant("a1"), assistant("a2"), user("three changed"), user("added")];
	assert.deepEqual(describe(diffConversation(before, after)), [
		"deleted e2",
		"modified e4 -> three changed",
		"added added",
	]);
});

test("a modification pairs only with the same role in the same gap", () => {
	const before = baseline(user("one"), assistant("a1"), user("two"));
	const after = [user("one"), user("rewritten"), user("two")];
	assert.deepEqual(describe(diffConversation(before, after)), ["deleted e1", "added rewritten"]);
});

test("a reorder is a deletion plus an addition, never a modification", () => {
	const before = baseline(user("marked"), assistant("a1"), user("two"), assistant("a2"), user("latest"));
	const after = [user("latest"), assistant("a1"), user("two"), assistant("a2"), user("marked")];
	const edits = describe(diffConversation(before, after));
	assert.deepEqual(edits.toSorted(), ["added latest", "added marked", "deleted e0", "deleted e4"]);
});

test("system messages are not conversation messages", () => {
	const system: RequestMessage = { role: "system", content: "base", timestamp: 0 };
	assert.deepEqual(diffConversation(baseline(system, user("one")), [user("one")]), []);
	assert.deepEqual(diffConversation(baseline(user("one")), [system, user("one")]), []);
});

test("alignment keeps a longest common subsequence", () => {
	// Deterministic pseudo-random sequences over a small alphabet stress Myers' search
	let seed = 7;
	const next = () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed;
	};
	for (let round = 0; round < 200; round++) {
		const before = Array.from({ length: next() % 12 }, () => `m${next() % 4}`);
		const after = Array.from({ length: next() % 12 }, () => `m${next() % 4}`);
		const edits = diffConversation(baseline(...before.map((text) => user(text))), after.map((text) => user(text)));
		const unmatched = edits.filter((edit) => edit.type !== "added").length;
		assert.equal(before.length - unmatched, lcsLength(before, after), `${before} vs ${after}`);
		assert.equal(edits.filter((edit) => edit.type !== "deleted").length, after.length - lcsLength(before, after));
	}
});

test("comparing in place agrees with message keys", () => {
	const toolResult = (content: unknown, extra: object = {}): RequestMessage => ({
		role: "toolResult", toolCallId: "c", toolName: "read", isError: false, timestamp: 1,
		content: content as [], ...extra,
	});
	const custom = (customType: string, content: unknown): RequestMessage => ({
		role: "custom", customType, content: content as string, display: true, timestamp: 1,
	});
	const bash = (output: string, timestamp: number): RequestMessage => ({
		role: "bashExecution", command: "ls", output, exitCode: 0, cancelled: false, truncated: false, timestamp,
	});
	class Box {
		public readonly value = 1;
	}
	const pairs: Array<[string, RequestMessage, RequestMessage]> = [
		["key order", custom("n", [{ a: 1, b: "x" }]), custom("n", [{ b: "x", a: 1 }])],
		["undefined property", custom("n", [{ a: 1, b: undefined }]), custom("n", [{ a: 1 }])],
		["function property", custom("n", [{ a: 1, f: () => 1 }]), custom("n", [{ a: 1 }])],
		["function only on the right", custom("n", [{ a: 1 }]), custom("n", [{ a: 1, f: () => 1 }])],
		["extra property", custom("n", [{ a: 1 }]), custom("n", [{ a: 1, b: 2 }])],
		["non-finite number", custom("n", [Number.NaN]), custom("n", [null])],
		["negative zero", custom("n", [-0]), custom("n", [0])],
		["undefined array item", custom("n", [undefined]), custom("n", [null])],
		["toJSON", custom("n", [{ toJSON: () => "x" }]), custom("n", ["x"])],
		["date", custom("n", [new Date(0)]), custom("n", [new Date(0).toJSON()])],
		["class instance", custom("n", [new Box()]), custom("n", [{ value: 1 }])],
		["number and string", custom("n", [1]), custom("n", ["1"])],
		["array length", custom("n", [1, 2]), custom("n", [1])],
		["custom type", custom("a", "x"), custom("b", "x")],
		["role", user("x"), custom("n", "x")],
		["tool result fields", toolResult([]), toolResult([], { toolName: "write" })],
		["tool result details", toolResult([], { details: { a: 1 } }), toolResult([])],
		["unknown role timestamp", bash("out", 1), bash("out", 2)],
		["unknown role output", bash("out", 1), bash("other", 1)],
		["assistant metadata", assistant("x"), { ...assistant("x"), timestamp: 9, model: "other" }],
	];
	for (const [name, a, b] of pairs) {
		const expected = messageKey(a) === messageKey(b);
		assert.equal(sameMessage(a, b), expected, name);
		assert.equal(sameMessage(b, a), expected, `${name}, reversed`);
	}
});

test("diffing the unmatched rest gives the same edits as diffing both whole sides", () => {
	let seed = 11;
	const next = () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed;
	};
	const system: RequestMessage = { role: "system", content: "base", timestamp: 0 };
	for (let round = 0; round < 200; round++) {
		const before = baseline(system, ...Array.from({ length: next() % 10 }, () => user(`m${next() % 3}`)));
		const after: RequestMessage[] = [system, ...Array.from({ length: next() % 10 }, () => user(`m${next() % 3}`))];
		const unmatched = trimMatchedEnds(before, after);
		assert.deepEqual(diffConversation(unmatched.baseline, unmatched.request), diffConversation(before, after));
	}
	const unchanged = [user("one"), assistant("two")];
	assert.deepEqual(trimMatchedEnds(baseline(system, ...unchanged), [system, ...unchanged]), { baseline: [], request: [] });
});

test("a collapsed system message equals the sequence it replaced", () => {
	const head: SystemMessage = {
		role: "system", content: "", sections: { preamble: "Base", cwd: "<cwd>/a</cwd>" }, toolsAdded: [READ], timestamp: 1,
	};
	const patch: SystemMessage = {
		role: "system", content: "", sections: { cwd: "<cwd>/b</cwd>" }, toolsAdded: [WRITE], timestamp: 3,
	};
	const before = [head, user("one"), patch, user("two")];
	const collapsed = getCurrentSystemMessage(before);
	assert.ok(collapsed);
	assert.deepEqual(diffSystemState(before, [collapsed, user("one"), user("two")]), []);
});

test("system changes report content, sections, and declarations separately", () => {
	const head: SystemMessage = {
		role: "system", content: "Base", sections: { keep: "<keep/>", drop: "<drop/>", edit: "<edit>old</edit>" },
		toolsAdded: [READ, WRITE], timestamp: 1,
	};
	const redefined = { ...READ, description: "Read a file, redefined" };
	const patch: SystemMessage = {
		role: "system", content: "Appended", timestamp: 2,
		sections: { drop: null, edit: "<edit>new</edit>", added: "<added/>" },
		toolsRemoved: [{ name: "write" }, { name: "read" }], toolsAdded: [redefined],
	};
	assert.deepEqual(diffSystemState([head], [head, patch]), [
		{ type: "content", text: "Base\n\nAppended" },
		{ type: "section", name: "edit", text: "<edit>new</edit>" },
		{ type: "section", name: "added", text: "<added/>" },
		{ type: "section", name: "drop", text: null },
		{ type: "tool", name: "read", declaration: redefined },
		{ type: "tool", name: "write", declaration: null },
	]);
});

/** Classic dynamic-programming LCS length, the reference for the Myers search. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
	const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
		}
	}
	return table[a.length][b.length];
}
