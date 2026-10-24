/** Source splits of prompt diffs: rounded shares, unknown edits, and request-only lines. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeSystemPrompt, UNREGISTERED_TOOL_SOURCE } from "../src/measure.ts";
import {
	AGGREGATE_SOURCE,
	buildSnapshot,
	type InjectionItem,
	type InjectionSnapshot,
	PI_SOURCE,
	sumTokenDiffs,
} from "../src/model.ts";
import { buildSystemPromptRows, partEditors } from "../src/system-prompt-rows.ts";

/** One prompt item or part, with its diff supplied separately from measurement. */
function item(id: string, text: string, added = 0, removed = 0): InjectionItem {
	return {
		id, label: id, kind: "base-prompt", source: PI_SOURCE, text,
		chars: text.length, tokens: Math.ceil(text.length / 4),
		...(added === 0 && removed === 0 ? {} : { diff: { added, removed } }),
	};
}

/** A parent prompt with the exact sum of its parts' diffs. */
function prompt(parts: InjectionItem[]): InjectionItem {
	return { ...item("base-prompt", parts.map((part) => part.text).join("")), children: parts,
		diff: sumTokenDiffs(parts.map((part) => part.diff)) };
}

test("prompt rows round extension shares cumulatively and leave all removals unattributed", () => {
	const first = { id: "first", label: "first", native: false };
	const second = { id: "second", label: "second", native: false };
	const part: InjectionItem = {
		...item("tools", "abcdefghij", 3, 2), requestOnly: true,
		injectedReferences: [
			{ start: 0, end: 5, source: first },
			{ start: 5, end: 10, source: second },
		],
	};
	const rows = buildSystemPromptRows([prompt([part])], [prompt([{ ...part, requestOnly: undefined }])]);

	assert.deepEqual(rows.map((row) => [row.source.label, row.diff, row.requestOnly]), [
		["first", { added: 2, removed: 0 }, undefined],
		["second", { added: 1, removed: 0 }, undefined],
		["unattributed", { added: 0, removed: 2 }, true],
	], "an unknown edit to pi text must not mark unchanged extension lines as request-only");
	assert.deepEqual(sumTokenDiffs(rows.map((row) => row.diff)), part.diff);
});

test("extension shares never exceed the part's added diff, even when its estimate rounds down", () => {
	const source = { id: "source", label: "source", native: false };
	const part = { ...item("tools", "abcde", 1), injectedReferences: [{ start: 0, end: 5, source }] };
	const rows = buildSystemPromptRows([prompt([part])], [prompt([part])]);
	assert.deepEqual(rows.map((row) => row.diff), [{ added: 1, removed: 0 }]);
	assert.equal(rows[0]?.requestOnly, undefined);
});

test("the unattributed prompt row includes instruction files and skills without counting them twice", () => {
	const file = { ...item("context-file:/tmp/AGENTS.md", "Changed file", 2, 1), kind: "context-file" as const,
		requestOnly: true };
	const skill = { ...item("skill:test", "Changed skill", 4, 3), kind: "skills" as const, requestOnly: true };
	const records: InjectionItem[] = [
		{ ...file, id: "context-files", children: [file], requestOnly: undefined },
		{ ...skill, id: "skills", children: [skill], requestOnly: undefined },
	];
	const rows = buildSystemPromptRows(records, []);
	assert.deepEqual(rows.map((row) => [row.source, row.diff, row.requestOnly]), [
		[AGGREGATE_SOURCE, { added: 6, removed: 4 }, true],
	]);
	assert.deepEqual(rows[0]?.sections?.map((section) => [section.label, section.text, section.diffOnly]), [
		[file.label, file.text, true], [skill.label, skill.text, true],
	]);
	const snapshot = buildSnapshot([...records, ...rows]);
	assert.equal(snapshot.totalTokens, file.tokens + skill.tokens);
	assert.equal(snapshot.groups.at(-1)?.totalTokens, 0);
	assert.equal(snapshot.groups.at(-1)?.diff, undefined);
});

test("a forced undivided prompt is request-only and wholly unattributed", () => {
	const forced: InjectionItem = { ...item("base-prompt", "Forced prompt", 4, 30), change: "forced" };
	const rows = buildSystemPromptRows([forced], []);
	assert.deepEqual(rows.map((row) => [row.source, row.diff, row.requestOnly]), [
		[AGGREGATE_SOURCE, forced.diff, true],
	]);
	assert.deepEqual(rows[0]?.sections?.map((section) => section.text), [forced.text]);
});

test("a replacement's dropped lines create no system prompt row", () => {
	const parts = analyzeSystemPrompt("Custom prompt\n\n<cwd>\n/tmp\n</cwd>", { customPrompt: "Custom prompt" }, [{
		name: "search", description: "Search the web", parametersJson: "{}", snippet: "Search", guidelines: ["Verify"],
		source: "npm:web",
	}]);
	assert.ok(parts[0]?.children?.some((part) => part.dropped === true && part.injectedReferences?.length));
	assert.deepEqual(buildSystemPromptRows(parts, parts), []);
});

test("an unregistered recorded tool and its prompt lines belong to unattributed", () => {
	const items = analyzeSystemPrompt("Base prompt\n\n<tools>\n- old_tool: Old snippet\n</tools>", {}, [{
		name: "old_tool", description: "Old tool", parametersJson: "{}", snippet: "Old snippet", guidelines: [],
		source: UNREGISTERED_TOOL_SOURCE,
	}]);
	const tools = items.find((entry) => entry.id === "base-prompt")?.children
		?.find((part) => part.label === "Tools");
	assert.ok(tools);
	assert.deepEqual(items.find((entry) => entry.kind === "tool")?.source, AGGREGATE_SOURCE,
		"the tool joins the unattributed group instead of forming its own");
	assert.deepEqual(tools.injectedReferences?.map((reference) => [reference.source, reference.tool]),
		[[AGGREGATE_SOURCE, "old_tool"]]);
	const part = { ...tools, diff: { added: 6, removed: 0 } };
	const rows = buildSystemPromptRows([prompt([part])], [prompt([part])]);
	assert.deepEqual(rows.map((row) => [row.source, row.diff]), [
		[AGGREGATE_SOURCE, { added: 6, removed: 0 }],
	]);
});

test("a removed session-only child stays in the unattributed preview and marks the row request-only", () => {
	const kept = { ...item("skill:kept", "Kept skill"), kind: "skills" as const };
	const removed = { ...item("skill:removed", "Removed skill"), kind: "skills" as const };
	const session: InjectionItem = { ...item("skills", kept.text + removed.text), kind: "skills", children: [kept, removed] };
	const request: InjectionItem = { ...session, children: [kept], diff: { added: 0, removed: removed.tokens } };
	const rows = buildSystemPromptRows([request], [session]);
	assert.deepEqual(rows.map((row) => [row.diff, row.requestOnly]), [[request.diff, true]]);
	assert.deepEqual(rows[0]?.sections?.map((section) => [section.label, section.text, section.diff]), [
		[removed.label, removed.text, request.diff],
	]);
});

test("diff-only rows cannot inflate a group value or diff even with an accidental estimate", () => {
	const diffOnly = { ...item("system-prompt:pi", "Repeated text", 10, 2), diffOnly: true };
	const snapshot: InjectionSnapshot = buildSnapshot([item("counted", "Counted text", 2, 1), diffOnly]);
	assert.equal(snapshot.totalTokens, Math.ceil("Counted text".length / 4));
	assert.deepEqual(snapshot.groups[0]?.diff, { added: 2, removed: 1 });
});

test("part editors use the ownership split for saved lines, but never infer a request-only editor", () => {
	const source = { id: "ext", label: "npm:web", native: false };
	const part: InjectionItem = { ...item("base-prompt:additions", "abcdefgh", 3, 1),
		injectedReferences: [{ start: 0, end: 8, source, attribution: "guess" }] };
	assert.deepEqual(partEditors(part), [
		{ type: "extension", source, attribution: "guess" }, { type: "unknown" },
	]);
	assert.deepEqual(partEditors({ ...part, requestOnly: true }), [{ type: "unknown" }]);
	assert.equal(partEditors({ ...part, diff: undefined }), undefined);
	assert.deepEqual(partEditors({ ...part, injectedReferences: [{ start: 0, end: 8, source: AGGREGATE_SOURCE }] }),
		[{ type: "unknown" }]);
});

test("unattributed request edits do not inherit saved changes from known owners beside them", () => {
	const source = { id: "ext", label: "npm:web", native: false };
	const session: InjectionItem = { ...item("base-prompt:available-tools", "abcdefgh", 2),
		injectedReferences: [{ start: 0, end: 8, source }] };
	const request: InjectionItem = { ...session, text: "abcdefgh edited", requestOnly: true, savedChange: true,
		diff: { added: 4, removed: 1 } };
	const rows = buildSystemPromptRows([prompt([request])], [prompt([session])]);
	assert.equal(rows[0]?.savedChange, true, "the extension's lines are saved");
	assert.equal(rows[0]?.requestOnly, undefined);
	assert.equal(rows[1]?.savedChange, undefined, "the unknown edit is only in the request");
	assert.equal(rows[1]?.requestOnly, true);

	const unownedSession = { ...session, injectedReferences: [{ start: 0, end: 8, source: AGGREGATE_SOURCE }] };
	const unownedRequest = { ...request, injectedReferences: unownedSession.injectedReferences };
	const unowned = buildSystemPromptRows([prompt([unownedRequest])], [prompt([unownedSession])]);
	assert.equal(unowned[0]?.savedChange, true, "unowned extension lines the session keeps are saved too");
	assert.equal(unowned[0]?.requestOnly, true);
});
