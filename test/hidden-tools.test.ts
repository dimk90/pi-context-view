/** Regression coverage for #11 through capture, PayloadGuard, Usage, and Injections. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { getCurrentSystemPrompt, Type, type Tool } from "@earendil-works/pi-ai";
import { SessionManager, type ToolInfo } from "@earendil-works/pi-coding-agent";

import { SnapshotBuilder } from "../src/capture/builder.ts";
import { PayloadGuard } from "../src/capture/guard.ts";
import { DEFERRED_PLACEHOLDER_NAME, parsePayloadTools } from "../src/capture/payload.ts";
import { captureRequest } from "../src/capture/request.ts";
import { buildInjectionsSnapshot } from "../src/injections.ts";
import type { InjectionItem } from "../src/model.ts";
import { applyRequestSnapshot } from "../src/projection.ts";
import { buildUsageSnapshot } from "../src/replay.ts";
import { SnapshotStore } from "../src/snapshot.ts";
import { collectPreviewEntries, computeUsage } from "../src/usage.ts";

const BUILTIN_NAMES = ["read", "bash", "edit", "write"];
const TOOLS: Tool[] = [...BUILTIN_NAMES, "codemode"].map((name) => ({
	name, description: `${name} description`, parameters: Type.Object({}),
}));
const CODEMODE = TOOLS[4];
const METADATA: ToolInfo[] = TOOLS.map((tool) => ({
	...tool,
	exposure: tool.name === "codemode" ? "model-only" : "direct",
	sourceInfo: {
		path: `<builtin:${tool.name}>`, source: tool.name === "codemode" ? "builtin:codemode" : "builtin",
		scope: "temporary", origin: "top-level",
	},
}));
const ACTIVE = TOOLS.map((tool) => tool.name);

/** View inputs, with Pi's live hidden tools in the prompt options. */
function viewInput(hiddenTools: readonly string[] = BUILTIN_NAMES) {
	return {
		systemPrompt: "", options: { cwd: "/tmp/project", hiddenTools: [...hiddenTools] }, allTools: METADATA,
		activeToolNames: ACTIVE,
	};
}

/** A baseline that declares every active tool, including codemode's hidden direct tools. */
function createSession(): SessionManager {
	const session = SessionManager.inMemory("/tmp/project");
	session.appendMessage({
		role: "system", content: "", sections: { cwd: "<cwd>\n/tmp/project\n</cwd>" }, toolsAdded: TOOLS, timestamp: 1,
	});
	session.appendMessage({ role: "user", content: "hi", timestamp: 2 });
	return session;
}

/** Capture the unchanged structured request; Pi leaves out the hidden declarations afterward. */
function capture(session: SessionManager, id: number, api: string, hiddenTools: readonly string[]) {
	const messages = session.buildSessionProjection().messages;
	return captureRequest({
		id, origin: "real-turn", sessionManager: session, messages, effectivePrompt: getCurrentSystemPrompt(messages),
		probe: { filterMessages: (projected) => projected }, hiddenTools,
		requestModel: { provider: "mock", api, id: "text", input: ["text"],
			compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } },
	});
}

/** The issue's payload: only codemode and Pi's invisible deferred placeholder are declared. */
function payload(session: SessionManager, api: string) {
	const prompt = getCurrentSystemPrompt(session.buildSessionProjection().messages);
	const declarations = [CODEMODE, { name: DEFERRED_PLACEHOLDER_NAME, description: "Never available." }];
	return api === "openai-completions"
		? { messages: [{ role: "system", content: prompt }, { role: "user", content: "hi" }],
			tools: declarations.map((tool) => ({ type: "function", function: tool })) }
		: { system: [{ type: "text", text: prompt }], messages: [{ role: "user", content: "hi" }], tools: declarations };
}

/** Pair, compare, and confirm through the production builder and guard, then read the retained snapshot. */
async function publish(
	session: SessionManager,
	store: SnapshotStore,
	api: string,
	body: unknown,
	hiddenTools: readonly string[] = BUILTIN_NAMES,
) {
	const request = capture(session, (store.latest()?.id ?? 0) + 1, api, hiddenTools);
	const builder = new SnapshotBuilder(store);
	const guard = new PayloadGuard({ publisher: builder, blockImages: () => false });
	builder.build(request);
	guard.accept(request, body);
	guard.confirm(request.id, { provider: "mock", api, model: "text" }, () => undefined);
	await new Promise((resolve) => setImmediate(resolve));
	const snapshot = store.latest();
	assert.ok(snapshot);
	return snapshot;
}

/** Use the same projection application and measurement as `/context usage`. */
function usage(session: SessionManager, store: SnapshotStore, hiddenTools?: readonly string[]) {
	const applied = applyRequestSnapshot({
		snapshot: store.latest(), entries: session.getEntries(), leafId: session.getLeafId(),
		filterMessages: (messages) => messages,
	});
	return computeUsage({
		messages: applied.messages,
		snapshot: buildUsageSnapshot({ ...viewInput(hiddenTools), ...applied }),
	});
}

/** Names listed in a Usage tool category, which drops entirely when it counts no tokens. */
function listedTools(result: ReturnType<typeof usage>, id: string): string[] {
	return (result.categories.find((category) => category.id === id)?.children ?? []).map((child) => child.label).sort();
}

/** The Injections tree of a snapshot, built with no live hidden tools so only the snapshot's apply. */
function injections(session: SessionManager, snapshot: NonNullable<ReturnType<SnapshotStore["latest"]>>) {
	return buildInjectionsSnapshot({
		...viewInput([]), snapshot, entries: session.getEntries(), filterMessages: (messages) => messages,
	});
}

/** Every Injections item, children included. */
function injectionItems(session: SessionManager, snapshot: NonNullable<ReturnType<SnapshotStore["latest"]>>) {
	const flatten = (item: InjectionItem): InjectionItem[] => [item, ...(item.children ?? []).flatMap(flatten)];
	return injections(session, snapshot).groups.flatMap((group) => group.items).flatMap(flatten);
}

for (const api of ["openai-completions", "anthropic-messages"]) {
	test(`#11 ${api}: only codemode counts; Injections leaves out and counts the four tools Pi hid`, async () => {
		const session = createSession();
		const store = new SnapshotStore();
		const before = usage(session, store, []);
		assert.deepEqual(listedTools(before, "built-in-tools"), [...BUILTIN_NAMES].sort());
		const snapshot = await publish(session, store, api, payload(session, api));
		assert.deepEqual(snapshot.hiddenTools, BUILTIN_NAMES);
		assert.deepEqual(snapshot.guard, { status: "complete", dispatch: { provider: "mock", api, model: "text" }, findings: [] });
		assert.doesNotMatch(JSON.stringify(snapshot), /__pi_deferred_placeholder__/);

		const observed = usage(session, store);
		assert.equal(observed.categories.find((category) => category.id === "built-in-tools"), undefined);
		assert.deepEqual(listedTools(observed, "custom-tools"), ["codemode"]);
		const builtins = before.categories.find((category) => category.id === "built-in-tools");
		assert.ok(builtins && builtins.tokens > 0);
		assert.equal(observed.estimatedTokens, before.estimatedTokens - builtins.tokens, "no hidden definition counts");
		assert.ok(observed.categories.flatMap(collectPreviewEntries)
			.every((entry) => !BUILTIN_NAMES.some((name) => entry.text.includes(`${name} description`))));

		const items = injectionItems(session, snapshot);
		assert.equal(items.find((item) => item.id === "tool:builtin"), undefined, "no Built-in Tools row is left");
		assert.deepEqual(items.filter((item) => item.kind === "tool").map((item) => item.label), ["codemode"]);
		assert.deepEqual(injections(session, snapshot).hiddenTools, BUILTIN_NAMES);
		assert.doesNotMatch(JSON.stringify(items), /(read|bash|edit|write) description/);
		const sent = items.find((item) => item.label === "codemode");
		assert.ok(sent && sent.tokens > 0 && sent.change === undefined);
		assert.doesNotMatch(JSON.stringify([observed, items]), /__pi_deferred_placeholder__/);
	});
}

test("#11: a captured tool the payload drops that Pi did not hide is a deleted payload change", async () => {
	const session = createSession();
	const store = new SnapshotStore();
	const snapshot = await publish(session, store, "openai-completions", payload(session, "openai-completions"),
		["read", "bash", "edit"]);
	assert.deepEqual(snapshot.guard.status === "complete" && snapshot.guard.findings, [{
		type: "payload-tool-change", change: "deleted", name: "write", lines: [{ type: "removed", text: "write description" }],
	}]);
	const items = injectionItems(session, snapshot);
	const changes = items.filter((item) => item.source.id === "payload-changes");
	assert.deepEqual(changes.map((item) => [item.label, item.kind, item.change, item.tokens]), [["write", "tool", "deleted", 0]]);
	const builtins = items.find((item) => item.id === "tool:builtin");
	assert.equal(builtins?.label, "Built-in Tools (1)");
	assert.deepEqual(builtins.children?.map((item) => [item.label, item.change]), [["write", undefined]]);
	assert.deepEqual(injections(session, snapshot).hiddenTools, ["read", "bash", "edit"]);
	assert.deepEqual(listedTools(usage(session, store, ["read", "bash", "edit"]), "built-in-tools"), ["write"],
		"payload removals do not affect Usage");
});

test("#11: Usage leaves out Pi's live hidden tools without a snapshot or recorded system state", () => {
	const session = createSession();
	assert.deepEqual(listedTools(usage(session, new SnapshotStore()), "built-in-tools"), []);
	assert.deepEqual(listedTools(usage(session, new SnapshotStore(), ["write"]), "built-in-tools"), ["bash", "edit", "read"]);
	// No recorded system message: the live prompt and tools
	const fallback = computeUsage({ messages: [], snapshot: buildUsageSnapshot({ ...viewInput(["write"]), messages: [] }) });
	assert.deepEqual(listedTools(fallback, "built-in-tools"), ["bash", "edit", "read"]);
	assert.deepEqual(listedTools(fallback, "custom-tools"), ["codemode"]);
});

test("#11: an incomplete payload guard does not restore hidden definitions in either view", async () => {
	const session = createSession();
	const store = new SnapshotStore();
	const snapshot = await publish(session, store, "openai-completions", {
		...payload(session, "openai-completions"), tools: [{ type: "unknown" }],
	});
	assert.equal(snapshot.guard.status, "incomplete");
	assert.deepEqual(listedTools(usage(session, store), "built-in-tools"), []);
	assert.deepEqual(listedTools(usage(session, store), "custom-tools"), ["codemode"]);
	assert.deepEqual(injectionItems(session, snapshot).filter((item) => item.kind === "tool")
		.map((item) => item.label), ["codemode"]);
	assert.deepEqual(injections(session, snapshot).hiddenTools, BUILTIN_NAMES);
});

test("#11: Anthropic inline additions, removals, and same-name redefinitions are not payload changes", async () => {
	const session = createSession();
	const store = new SnapshotStore();
	const body = payload(session, "anthropic-messages");
	const messages: unknown[] = [...body.messages];
	const extra: Tool = { name: "search", description: "Search once.", parameters: Type.Object({}) };
	const redefined = { ...extra, description: "Search again." };
	for (const step of ["added", "redefined", "removed"] as const) {
		const definition = step === "added" ? extra : redefined;
		session.appendMessage({ role: "system", content: "", timestamp: 3,
			...(step === "removed" ? { toolsRemoved: [{ name: "search" }] } : { toolsAdded: [definition] }),
		});
		messages.push({ role: "system", content: [step === "removed"
			? { type: "tool_removal", tool: { type: "tool_reference", name: "search" } }
			: { type: "tool_addition", tool: { type: "tool_definition", definition } }] });
		const request = { ...body, messages };
		const parsed = parsePayloadTools("anthropic-messages", request);
		assert.deepEqual(parsed, { status: "parsed", declarations: (step === "removed" ? [CODEMODE] : [CODEMODE, definition])
			.map(({ name, description }) => ({ name, description })) });
		const snapshot = await publish(session, store, "anthropic-messages", request);
		assert.equal(snapshot.guard.status, "complete");
		assert.deepEqual(snapshot.guard.status === "complete" && snapshot.guard.findings, []);
	}
});
