import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildSnapshot,
	extensionSource,
	groupInjections,
	type InjectionItem,
	type InjectionKind,
} from "../src/model.ts";

/** InjectionItem fixture with sizes derived from the token count. */
function item(
	id: string,
	sourceId: string,
	sourceLabel: string,
	native: boolean,
	tokens: number,
	kind: InjectionKind = "message",
): InjectionItem {
	return {
		id,
		kind,
		source: { id: sourceId, label: sourceLabel, native },
		label: id,
		chars: tokens * 4,
		tokens,
		text: id.repeat(tokens),
	};
}

test("groupInjections creates hierarchy and totals in display order", () => {
	const groups = groupInjections([
		item("small", "tool-source:small", "small", false, 2),
		item("pi-small", "pi", "pi", true, 1),
		item("large-b", "tool-source:large", "large", false, 5),
		item("aggregate", "aggregate:extensions", "unattributed", false, 20),
		item("large-a", "tool-source:large", "large", false, 8),
	]);

	assert.deepEqual(
		groups.map((group) => group.source.id),
		["pi", "tool-source:large", "tool-source:small", "aggregate:extensions"],
	);
	assert.deepEqual(
		groups[1]?.items.map((entry) => entry.id),
		["large-a", "large-b"],
	);
	assert.equal(groups[1]?.totalTokens, 13);
});

test("groupInjections orders pi items by provider payload section", () => {
	const [pi] = groupInjections([
		item("context-file:./AGENTS.md", "pi", "pi", true, 30, "context-file"),
		item("skills", "pi", "pi", true, 5, "skills"),
		item("tool:builtin", "pi", "pi", true, 3, "tool"),
		item("base-prompt", "pi", "pi", true, 1, "base-prompt"),
		item("append-prompt", "pi", "pi", true, 50, "append-prompt"),
		item("tool:pi:web_search", "pi", "pi", true, 40, "tool"),
	]);

	assert.deepEqual(
		pi?.items.map((entry) => entry.id),
		[
			"base-prompt",
			"append-prompt",
			"context-file:./AGENTS.md",
			"skills",
			"tool:builtin",
			"tool:pi:web_search",
		],
	);
});

test("buildSnapshot owns nested input data and computes the total", () => {
	const source = { id: "message-type:test", label: "test", native: false };
	const sections = [{ label: "Definition", text: "hello world!", tokens: 3 }];
	const input: InjectionItem = {
		id: "message:test:0",
		kind: "message",
		source,
		label: "message",
		chars: 12,
		tokens: 3,
		text: "hello world!",
		sections,
	};
	const snapshot = buildSnapshot([input]);

	source.label = "changed";
	sections[0]!.label = "changed";

	assert.equal(snapshot.groups[0]?.source.label, "test");
	assert.equal(snapshot.groups[0]?.items[0]?.sections?.[0]?.label, "Definition");
	assert.equal(snapshot.totalTokens, 3);
});

test("buildSnapshot owns injected references on sections and standalone children", () => {
	const source = { id: "tool-source:npm:web", label: "npm:web", native: false };
	const reference = { offset: 12, text: "\n- Cite sources", itemId: "tool:npm:web:search", source };
	const references = [reference];
	const child = { ...item("guidelines", "pi", "pi", true, 3), injectedReferences: references };
	const input = {
		...item("base", "pi", "pi", true, 3),
		sections: [{ label: "Guidelines", text: child.text, tokens: 3, injectedReferences: references }],
		children: [child],
	};
	const snapshot = buildSnapshot([input]);
	reference.offset = 0;
	reference.text = "changed";
	source.label = "changed";
	references.length = 0;
	const base = snapshot.groups[0]?.items[0];
	for (const owned of [base?.sections?.[0]?.injectedReferences, base?.children?.[0]?.injectedReferences]) {
		assert.equal(owned?.length, 1);
		assert.equal(owned?.[0]?.offset, 12);
		assert.equal(owned?.[0]?.text, "\n- Cite sources");
		assert.equal(owned?.[0]?.source.label, "npm:web");
	}
	assert.equal(snapshot.totalTokens, 3);
});

test("extensionSource labels path extensions by their shortest unique path tail", () => {
	const fixture = { source: "cli", path: "/repo/test/fixtures/hidden-tools.ts" };
	const folder = { source: "auto", path: "/home/tester/.pi/agent/extensions/my-ext/index.ts" };
	const first = { source: "local", path: "/a/tools/web.ts" };
	const second = { source: "cli", path: "/b/tools/web.ts" };
	const roster = [fixture, folder, first, second, { source: "npm:web", path: "/pkgs/web/web.ts" }];

	assert.deepEqual(extensionSource({ source: "npm:web", path: "/pkgs/web/index.ts" }, roster),
		{ id: "tool-source:npm:web", label: "npm:web", native: false });
	assert.deepEqual(extensionSource(fixture, roster),
		{ id: "tool-source:cli:/repo/test/fixtures/hidden-tools.ts", label: "hidden-tools.ts", native: false });
	assert.equal(extensionSource(folder, roster).label, "my-ext");
	// Package paths never collide with loose files, which need just enough of their path to differ.
	assert.equal(extensionSource(first, roster).label, "a/tools/web.ts");
	assert.equal(extensionSource(second, roster).label, "b/tools/web.ts");
	assert.equal(extensionSource(second).label, "web.ts");
	assert.notEqual(extensionSource(first).id, extensionSource({ ...second, source: "local" }).id);
});
