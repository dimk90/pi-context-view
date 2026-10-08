/** Regression coverage for #11 through PayloadGuard, DeclaredTools, Usage, and Injections. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { getCurrentSystemPrompt, getCurrentTools, Type, type Tool } from "@earendil-works/pi-ai";
import { SessionManager, type ToolInfo } from "@earendil-works/pi-coding-agent";

import { buildRequestSnapshot, SnapshotBuilder } from "../src/capture/builder.ts";
import { PayloadGuard } from "../src/capture/guard.ts";
import { DEFERRED_PLACEHOLDER_NAME, parsePayloadTools } from "../src/capture/payload.ts";
import { captureRequest } from "../src/capture/request.ts";
import { buildInjectionsSnapshot } from "../src/injections.ts";
import { applyRequestSnapshot, latestDeclaredTools } from "../src/projection.ts";
import { buildUsageSnapshot } from "../src/replay.ts";
import { type CaptureOrigin, SnapshotStore } from "../src/snapshot.ts";
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
const VIEW_INPUT = { systemPrompt: "", options: { cwd: "/tmp/project" }, allTools: METADATA, activeToolNames: TOOLS.map((tool) => tool.name) };

/** A baseline that declares every active tool, including codemode's hidden direct tools. */
function createSession(): SessionManager {
	const session = SessionManager.inMemory("/tmp/project");
	session.appendMessage({
		role: "system", content: "", sections: { cwd: "<cwd>\n/tmp/project\n</cwd>" }, toolsAdded: TOOLS, timestamp: 1,
	});
	session.appendMessage({ role: "user", content: "hi", timestamp: 2 });
	return session;
}

/** Capture the unchanged structured request; hidden declarations are projected afterward by Pi. */
function capture(session: SessionManager, id: number, api: string, origin: CaptureOrigin = "real-turn") {
	const messages = session.buildSessionProjection().messages;
	return captureRequest({
		id, origin, sessionManager: session, messages, effectivePrompt: getCurrentSystemPrompt(messages),
		probe: { filterMessages: (projected) => projected },
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
async function publish(session: SessionManager, store: SnapshotStore, api: string, body: unknown) {
	const request = capture(session, (store.latest()?.id ?? 0) + 1, api);
	const builder = new SnapshotBuilder(store);
	const guard = new PayloadGuard({ publisher: builder, loadoutCandidates: () => ["codemode"], blockImages: () => false });
	builder.build(request);
	guard.accept(request, body);
	guard.confirm(request.id, { provider: "mock", api, model: "text" }, () => undefined);
	await new Promise((resolve) => setImmediate(resolve));
	const snapshot = store.latest();
	assert.ok(snapshot);
	return snapshot;
}

/** Publish the no-payload result of a standard probe, without discarding an earlier real turn. */
function publishProbe(session: SessionManager, store: SnapshotStore): void {
	store.publish(buildRequestSnapshot(capture(session, (store.latest()?.id ?? 0) + 1, "openai-completions", "synthetic-probe"), {
		status: "incomplete", reason: "No provider payload was observed for this request.",
	}));
}

/**
 * Use the same snapshot selection, projection application, and measurement as
 * `/context usage`. Live active tools default to the replayed ones, as when no
 * change is pending.
 */
function usage(session: SessionManager, store: SnapshotStore, activeToolNames?: readonly string[]) {
	const active = activeToolNames ?? getCurrentTools(session.buildSessionProjection().messages).map((tool) => tool.name);
	const applied = applyRequestSnapshot({
		snapshot: store.latest(), declaredTools: latestDeclaredTools(store), activeToolNames: active,
		entries: session.getEntries(), leafId: session.getLeafId(), filterMessages: (messages) => messages,
	});
	return computeUsage({
		messages: applied.messages,
		snapshot: buildUsageSnapshot({ ...VIEW_INPUT, ...applied, activeToolNames: active }),
	});
}

/** Names listed in a Usage tool category, which drops entirely when it counts no tokens. */
function listedTools(result: ReturnType<typeof usage>, id: string): string[] {
	return (result.categories.find((category) => category.id === id)?.children ?? []).map((child) => child.label).sort();
}

for (const api of ["openai-completions", "anthropic-messages"]) {
	test(`#11 ${api}: only codemode counts; Injections marks all four hidden declarations with their candidate`, async () => {
		const session = createSession();
		const store = new SnapshotStore();
		const before = usage(session, store);
		assert.deepEqual(listedTools(before, "built-in-tools"), [...BUILTIN_NAMES].sort());
		const snapshot = await publish(session, store, api, payload(session, api));
		assert.deepEqual(snapshot.declaredTools, { declared: ["codemode"], baseline: [...BUILTIN_NAMES, "codemode"] });
		assert.deepEqual(snapshot.guard, {
			status: "complete", dispatch: { provider: "mock", api, model: "text" },
			findings: BUILTIN_NAMES.map((name) => ({ type: "hidden-declaration", name, candidates: ["codemode"] })),
		});
		assert.doesNotMatch(JSON.stringify(snapshot), /__pi_deferred_placeholder__/);

		const observed = usage(session, store);
		assert.equal(observed.categories.find((category) => category.id === "built-in-tools"), undefined);
		assert.deepEqual(listedTools(observed, "custom-tools"), ["codemode"]);
		const builtins = before.categories.find((category) => category.id === "built-in-tools");
		assert.ok(builtins && builtins.tokens > 0);
		assert.equal(observed.estimatedTokens, before.estimatedTokens - builtins.tokens, "no hidden definition counts");
		assert.ok(observed.categories.flatMap(collectPreviewEntries)
			.every((entry) => !BUILTIN_NAMES.some((name) => entry.text.includes(`${name} description`))));

		const injections = buildInjectionsSnapshot({
			...VIEW_INPUT, snapshot, entries: session.getEntries(), filterMessages: (messages) => messages,
		});
		const tools = injections.groups.flatMap((group) => group.items);
		const hidden = tools.find((item) => item.id === "tool:builtin");
		assert.equal(hidden?.label, "Built-in Tools (0)");
		assert.equal(hidden.tokens, 0);
		assert.deepEqual(hidden.children?.map((item) => [item.label, item.change, item.tokens, item.candidates]).sort(),
			BUILTIN_NAMES.map((name) => [name, "hidden", 0, ["codemode"]]).sort());
		assert.ok(hidden.children?.every((item) => item.sections?.[0]?.change === "hidden"));
		const sent = tools.find((item) => item.label === "codemode");
		assert.ok(sent && sent.tokens > 0 && sent.change === undefined);
		assert.doesNotMatch(JSON.stringify([observed, injections]), /__pi_deferred_placeholder__/);
	});
}

test("#11: a probe before the first request keeps replay; a later probe preserves the real turn's declared names", async () => {
	const session = createSession();
	const store = new SnapshotStore();
	const before = usage(session, store);
	publishProbe(session, store);
	assert.equal(store.latest()?.declaredTools, undefined);
	assert.deepEqual(usage(session, store).categories, before.categories);
	await publish(session, store, "openai-completions", payload(session, "openai-completions"));
	const after = usage(session, store);
	assert.deepEqual(listedTools(after, "built-in-tools"), []);
	publishProbe(session, store);
	assert.equal(store.latest()?.origin, "synthetic-probe");
	assert.equal(store.latest()?.declaredTools, undefined);
	assert.deepEqual(usage(session, store).categories, after.categories);
});

test("#11: changed active or replayed tool names and incomplete declarations count every replayed tool", async () => {
	const session = createSession();
	const store = new SnapshotStore();
	await publish(session, store, "openai-completions", payload(session, "openai-completions"));
	const pending = usage(session, store, BUILTIN_NAMES);
	assert.deepEqual(listedTools(pending, "built-in-tools"), [...BUILTIN_NAMES].sort(),
		"a live change that Pi records only at the next request already drops the names");
	assert.deepEqual(listedTools(pending, "custom-tools"), ["codemode"], "replay still counts until the next request");
	session.appendMessage({ role: "system", content: "", toolsRemoved: [{ name: "write" }], timestamp: 3 });
	const fallback = usage(session, new SnapshotStore());
	assert.deepEqual(listedTools(fallback, "built-in-tools"), ["bash", "edit", "read"]);
	assert.deepEqual(usage(session, store).categories, fallback.categories, "changed replay invalidates old names");
	await publish(session, store, "openai-completions", payload(session, "openai-completions"));
	assert.deepEqual(listedTools(usage(session, store), "built-in-tools"), []);
	const incomplete = await publish(session, store, "openai-completions", {
		...payload(session, "openai-completions"), tools: [{ type: "unknown" }],
	});
	assert.equal(incomplete.guard.status, "incomplete");
	assert.equal(incomplete.declaredTools, undefined);
	assert.equal(latestDeclaredTools(store), undefined);
	assert.deepEqual(usage(session, store).categories, fallback.categories, "an older complete guard must not hide tools");
});

test("#11: Anthropic declared names follow inline additions, removals, and same-name redefinitions", async () => {
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
		const addedNames = step === "removed" ? [] : ["search"];
		assert.deepEqual(snapshot.declaredTools, {
			declared: ["codemode", ...addedNames], baseline: [...BUILTIN_NAMES, "codemode", ...addedNames],
		});
		assert.deepEqual(snapshot.guard.status === "complete" && snapshot.guard.findings,
			BUILTIN_NAMES.map((name) => ({ type: "hidden-declaration", name, candidates: ["codemode"] })));
	}
});
