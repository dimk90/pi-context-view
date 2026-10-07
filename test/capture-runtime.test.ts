/**
 * Structured capture in a real in-process Pi runtime against the mock
 * provider. The extension publishes to a store the test passes in.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite, test, type TestContext } from "node:test";

import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	type ExtensionFactory,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import registerExtension from "../src/index.ts";
import { buildInjectionsSnapshot } from "../src/injections.ts";
import { applyRequestSnapshot } from "../src/projection.ts";
import { buildUsageSnapshot } from "../src/replay.ts";
import type { ConversationChange, RequestSnapshot, SystemChange } from "../src/snapshot.ts";
import { SnapshotStore } from "../src/snapshot.ts";
import { collectPreviewEntries, computeUsage } from "../src/usage.ts";
import contextAdd, { CONTEXT_ADD_TEXT, CONTEXT_ADD_TYPE } from "./fixtures/context-add.ts";
import contextAddUser, { CONTEXT_ADD_USER_TEXT } from "./fixtures/context-add-user.ts";
import contextDelete, { CONTEXT_DELETE_MARKER } from "./fixtures/context-delete.ts";
import contextInPlace, { CONTEXT_IN_PLACE_SUFFIX } from "./fixtures/context-in-place.ts";
import contextModify, { CONTEXT_MODIFY_PREFIX } from "./fixtures/context-modify.ts";
import contextReorder, { CONTEXT_REORDER_MARKER } from "./fixtures/context-reorder.ts";
import contextReplaceRemove, {
	CONTEXT_REMOVE_TEXT, CONTEXT_REPLACE_ORIGINAL, CONTEXT_REPLACE_TEXT,
} from "./fixtures/context-replace-remove.ts";
import forcedPrompt, { FORCED_SYSTEM_PROMPT } from "./fixtures/forced-prompt.ts";
import inPlaceMutation, { IN_PLACE_SUFFIX } from "./fixtures/in-place-mutation.ts";
import inputTransform from "./fixtures/input-transform.ts";
import marker from "./fixtures/marker.ts";
import sectionDelete, { SECTION_DELETE_NAME, SECTION_DELETE_SECTIONS } from "./fixtures/section-delete.ts";
import sectionModify, { SECTION_MODIFY_SECTIONS, SECTION_MODIFY_TEXT } from "./fixtures/section-modify.ts";
import sectionPatch, { SECTION_PATCH_SECTIONS } from "./fixtures/section-patch.ts";
import systemAppend, { SYSTEM_APPEND_TEXT } from "./fixtures/system-append.ts";
import { type MockProvider, startMockProvider } from "./harness/mock-provider.ts";

const PROVIDER = "capture-test";
const NO_PAYLOAD = { status: "incomplete", reason: "No provider payload was observed for this request." };

/** Runtime options; defaults give one in-memory session on the `vision` model. */
interface RuntimeOptions {
	readonly factories: readonly ExtensionFactory[];
	readonly sessionManager?: SessionManager;
	readonly modelId?: "vision" | "text";
	readonly mode?: "tui" | "rpc";
}

/** A Pi runtime with the extension, its snapshot store, and every publication in order. */
interface Runtime {
	readonly session: AgentSession;
	readonly published: RequestSnapshot[];
	readonly errors: string[];
	/**
	 * Snapshots of captures after the deferred diff and guard settlement, latest
	 * copy per ID. Real turns must compare completely without late edits, unless
	 * `lateEdits` allows them.
	 */
	settled(options?: { readonly lateEdits?: boolean }): Promise<RequestSnapshot[]>;
}

suite("structured capture calibration", { concurrency: true }, () => {
	test("prompts, tool follow-ups, compaction, and a probe leave the diff empty", async (t) => {
		const provider = await startProvider(t);
		const runtime = await createRuntime(t, provider, { factories: [] });
		await runtime.session.prompt("/context injections");
		await runtime.session.prompt("first prompt");
		provider.enqueue({ type: "tool-call", name: "read", arguments: { path: "missing.txt" } }, { type: "text", text: "done" });
		await runtime.session.prompt("second prompt");
		provider.enqueue({ type: "text", text: "Compacted summary." });
		await runtime.session.compact();
		await runtime.session.prompt("after compaction");

		const snapshots = await runtime.settled();
		assert.deepEqual(runtime.errors, []);
		assert.deepEqual(snapshots.map((snapshot) => snapshot.origin),
			["synthetic-probe", "real-turn", "real-turn", "real-turn", "real-turn"], "the tool follow-up is captured too");
		for (const snapshot of snapshots) assertEmpty(snapshot);
		assert.deepEqual(snapshots.map((snapshot) => snapshot.id), [1, 2, 3, 4, 5]);
		assert.ok(snapshots.every((snapshot) => snapshot.leafId !== null));
		// Pending, then one guard update; or one publication when the guard settled before the diff ran
		for (const { id, origin } of snapshots) {
			const statuses = runtime.published.filter((snapshot) => snapshot.id === id).map((snapshot) => snapshot.guard.status);
			const settled = origin === "synthetic-probe" ? "incomplete" : "complete";
			assert.ok([`pending,${settled}`, settled].includes(statuses.join()), `${id}: ${statuses}`);
		}
	});

	test("a resumed session on another model has an empty diff", async (t) => {
		const provider = await startProvider(t);
		const directory = await temporaryDirectory(t);
		const first = SessionManager.create(directory, directory);
		const before = await createRuntime(t, provider, { factories: [], sessionManager: first });
		await before.session.prompt("first prompt");
		const file = first.getSessionFile();
		assert.ok(file);
		before.session.dispose();

		const after = await createRuntime(t, provider, {
			factories: [], sessionManager: SessionManager.open(file, directory), modelId: "text",
		});
		await after.session.prompt("after resume");
		const [snapshot] = await after.settled();
		assert.equal(provider.requests.at(-1)?.body.model, "text");
		assertEmpty(snapshot);
	});

	test("Pi's collapse of system messages after a changing context handler is no system change", async (t) => {
		const provider = await startProvider(t);
		let addSection = false;
		const laterSection: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", (event) => {
				// Recorded as a mid-conversation system message on the second prompt
				if (addSection) event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, later: "<later/>" };
			});
		};
		const runtime = await createRuntime(t, provider, { factories: [laterSection, contextAdd] });
		await runtime.session.prompt("first prompt");
		addSection = true;
		await runtime.session.prompt("second prompt");
		const snapshots = await runtime.settled();
		const systemMessages = runtime.session.sessionManager.buildSessionProjection().messages
			.filter((message) => message.role === "system");
		assert.ok(systemMessages.length >= 2, "the session records a later system message");
		for (const snapshot of snapshots) {
			assert.deepEqual(snapshot.changes.system, []);
			assert.deepEqual(snapshot.changes.conversation.map(describeChange), [`added ${CONTEXT_ADD_TYPE}: ${CONTEXT_ADD_TEXT}`]);
		}
	});

	test("capture runs in RPC mode without any consumer", async (t) => {
		const provider = await startProvider(t);
		const runtime = await createRuntime(t, provider, { factories: [contextAdd], mode: "rpc" });
		await runtime.session.prompt("prompt");
		const [snapshot] = await runtime.settled();
		assert.deepEqual(runtime.errors, []);
		assert.deepEqual(snapshot.changes.conversation.map(describeChange), [`added ${CONTEXT_ADD_TYPE}: ${CONTEXT_ADD_TEXT}`]);
	});
});

suite("structured edits", { concurrency: true }, () => {
	for (const position of ["before", "after"] as const) {
		/** Fixtures are loaded before or after the monitor. */
		const runWith = (t: TestContext, fixture: ExtensionFactory) => withProvider(t, (provider) =>
			createRuntime(t, provider, { factories: position === "before" ? [fixture, monitorSlot] : [monitorSlot, fixture] }));

		test(`context addition is attributed by customType (fixture ${position})`, async (t) => {
			const runtime = await runWith(t, contextAdd);
			await runtime.session.prompt("prompt");
			const [snapshot] = await runtime.settled();
			assert.deepEqual(snapshot.changes.conversation.map(describeChange), [`added ${CONTEXT_ADD_TYPE}: ${CONTEXT_ADD_TEXT}`]);
		});

		test(`context user addition is unattributed (fixture ${position})`, async (t) => {
			const runtime = await runWith(t, contextAddUser);
			await runtime.session.prompt("prompt");
			const [snapshot] = await runtime.settled();
			assert.deepEqual(snapshot.changes.conversation.map(describeChange), [`added user: ${CONTEXT_ADD_USER_TEXT}`]);
		});

		test(`context modification references its entry (fixture ${position})`, async (t) => {
			const runtime = await runWith(t, contextModify);
			await runtime.session.prompt("original text");
			const [snapshot] = await runtime.settled();
			assert.deepEqual(snapshot.changes.conversation.map(describeChange),
				[`modified user: ${CONTEXT_MODIFY_PREFIX} original text`]);
			assertReferencesUserEntry(runtime, snapshot.changes.conversation[0], "original text");
		});

		test(`#6: Usage counts only the replacement and matches the request (fixture ${position})`, async (t) => {
			const provider = await startProvider(t);
			const factories = position === "before"
				? [contextReplaceRemove, monitorSlot] : [monitorSlot, contextReplaceRemove];
			const runtime = await createRuntime(t, provider, { factories });
			await runtime.session.prompt(CONTEXT_REPLACE_ORIGINAL);
			await runtime.session.prompt(CONTEXT_REMOVE_TEXT);
			const snapshots = await runtime.settled();
			assert.equal(snapshots.length, 2);
			const latest = snapshots[1];
			assert.deepEqual(latest.changes.conversation.map(describeChange), ["modified user: bbbb", "deleted"]);
			assertReferencesUserEntry(runtime, latest.changes.conversation[0], CONTEXT_REPLACE_ORIGINAL);
			assertReferencesUserEntry(runtime, latest.changes.conversation[1], CONTEXT_REMOVE_TEXT);

			const session = runtime.session.sessionManager;
			const applied = applyRequestSnapshot({
				snapshot: latest, entries: session.getEntries(), leafId: session.getLeafId(),
				filterMessages: (messages) => messages,
			});
			const usage = computeUsage({
				messages: applied.messages,
				snapshot: buildUsageSnapshot({
					...applied, systemPrompt: "", options: { cwd: "/" }, allTools: [], activeToolNames: [],
				}),
			});
			const users = usage.categories.find((category) => category.id === "user-messages");
			assert.ok(users);
			assert.equal(users.tokens, 1);
			const texts = collectPreviewEntries(users).map((entry) => entry.text);
			assert.deepEqual(texts, [CONTEXT_REPLACE_TEXT]);
			assert.equal(provider.requests.length, 2);
			for (const request of provider.requests) {
				const messages = request.body.messages as Array<{ role: string; content: string }>;
				assert.deepEqual(messages.filter((message) => message.role === "user").map((message) => message.content), texts);
			}
			assert.deepEqual(runtime.errors, []);
		});

		test(`context in-place edit is a modification (fixture ${position})`, async (t) => {
			const runtime = await runWith(t, contextInPlace);
			await runtime.session.prompt("original text");
			const [snapshot] = await runtime.settled();
			assert.deepEqual(snapshot.changes.conversation.map(describeChange),
				[`modified user: original text\n${CONTEXT_IN_PLACE_SUFFIX}`]);
		});

		test(`context deletion references its entry (fixture ${position})`, async (t) => {
			const runtime = await runWith(t, contextDelete);
			await runtime.session.prompt(`${CONTEXT_DELETE_MARKER}: drop me`);
			await runtime.session.prompt("keep me");
			const snapshots = await runtime.settled();
			assert.deepEqual(snapshots[1].changes.conversation.map(describeChange), ["deleted"]);
			assertReferencesUserEntry(runtime, snapshots[1].changes.conversation[0], `${CONTEXT_DELETE_MARKER}: drop me`);
		});

		test(`context reorder is a deletion plus an addition (fixture ${position})`, async (t) => {
			const runtime = await runWith(t, contextReorder);
			await runtime.session.prompt(`${CONTEXT_REORDER_MARKER}: move me`);
			await runtime.session.prompt("latest prompt");
			const snapshots = await runtime.settled();
			assertEmpty(snapshots[0]);
			// Which messages anchor the alignment is a tie; every moved message stays counted once
			const changes = snapshots[1].changes.conversation.map(describeChange);
			assert.equal(changes.filter((change) => change === "deleted").length, 2);
			assert.equal(changes.filter((change) => change.startsWith("added ")).length, 2);
			assert.ok(changes.includes(`added user: ${CONTEXT_REORDER_MARKER}: move me`));
		});

		const structured = position === "before";
		test(`context_with_system changes are structured only before the monitor (fixture ${position})`, async (t) => {
			const fixtures = [systemAppend, sectionPatch, sectionModify, sectionDelete, inPlaceMutation];
			await withProvider(t, async (provider) => {
				const factories = structured ? [...fixtures, monitorSlot] : [monitorSlot, ...fixtures];
				const runtime = await createRuntime(t, provider, { factories });
				await runtime.session.prompt("prompt");
				const [snapshot] = await runtime.settled({ lateEdits: !structured });
				if (!structured) {
					assertEmpty(snapshot);
					assertLateEdits(snapshot);
					return;
				}
				assert.deepEqual(snapshot.guard.status === "complete" && snapshot.guard.findings, []);
				const system = snapshot.changes.system.map(describeSystemChange);
				assert.equal(system.length, 10);
				assert.match(system[0], new RegExp(`^content: .*${SYSTEM_APPEND_TEXT}$`, "s"));
				assertSectionChanges(snapshot);
				assert.deepEqual(snapshot.changes.conversation.map(describeChange), [`modified user: prompt\n${IN_PLACE_SUFFIX}`]);
			});
		});

		test(`section demos run automatically in a fresh probe (fixture ${position})`, async (t) => {
			const provider = await startProvider(t);
			let responses = 0;
			const sentinel: ExtensionFactory = (pi) => {
				pi.on("after_provider_response", () => { responses++; });
			};
			const fixtures = [sectionPatch, sectionModify, sectionDelete];
			const factories = structured ? [...fixtures, monitorSlot, sentinel] : [monitorSlot, ...fixtures, sentinel];
			const runtime = await createRuntime(t, provider, { factories });
			await runtime.session.prompt("/context injections");
			const [probe] = await runtime.settled();
			assert.equal(probe.origin, "synthetic-probe");
			assert.equal(responses, 0);
			assert.equal(provider.requests.length, 0);
			if (structured) {
				assertSectionChanges(probe);
				const composition = buildInjectionsSnapshot({
					snapshot: probe, entries: runtime.session.sessionManager.getEntries(),
					filterMessages: (messages) => messages, options: { cwd: "/" },
					allTools: [], systemPrompt: "", activeToolNames: [],
				});
				const parts = composition.groups.flatMap((group) => group.items.flatMap((item) => item.children ?? []));
				for (const change of ["added", "modified", "deleted"]) {
					assert.equal(parts.filter((part) => part.change === change).length, 3, change);
				}
				for (const [name, text] of Object.entries(SECTION_DELETE_SECTIONS)) {
					const part = parts.find((part) => part.label === name);
					assert.equal(part?.tokens, 0);
					assert.ok(part?.text.includes(text.split("\n")[1]), "deleted preview retains its original");
				}
			} else assertEmpty(probe);

			await runtime.session.prompt("ordinary prompt");
			await runtime.session.prompt("another ordinary prompt");
			const snapshots = await runtime.settled({ lateEdits: !structured });
			assert.equal(snapshots.length, 3);
			for (const snapshot of snapshots) {
				assert.deepEqual(snapshot.changes.system, probe.changes.system, "changes do not accumulate");
			}
			assert.deepEqual(runtime.errors, []);
		});

		test(`a forced prompt is captured in real and probe runs (fixture ${position})`, async (t) => {
			await withProvider(t, async (provider) => {
				const fixtures = [marker, forcedPrompt, inputTransform];
				const factories = position === "before" ? [...fixtures, monitorSlot] : [monitorSlot, ...fixtures];
				const runtime = await createRuntime(t, provider, { factories });
				await runtime.session.prompt("/context injections");
				await runtime.session.prompt("real prompt");
				const snapshots = await runtime.settled();
				assert.deepEqual(runtime.errors, []);
				assert.deepEqual(snapshots.map((snapshot) => snapshot.origin), ["synthetic-probe", "real-turn"]);
				for (const snapshot of snapshots) {
					assert.equal(snapshot.forcedPrompt, FORCED_SYSTEM_PROMPT);
					assert.deepEqual(snapshot.changes, { conversation: [], system: [] },
						"the marker's nextTurn message is persisted, so it belongs to the baseline");
				}
			});
		});
	}
});

suite("Injections composition", { concurrency: true }, () => {
	test("the first snapshot rebuilds its baseline and marks the request-only changes", async (t) => {
		const provider = await startProvider(t);
		const fixtures = [contextAdd, contextModify, systemAppend, sectionPatch, sectionDelete];
		const runtime = await createRuntime(t, provider, { factories: [...fixtures, monitorSlot] });
		await runtime.session.prompt("original text");
		await runtime.session.prompt("later prompt");
		const [first] = await runtime.settled();
		const composition = buildInjectionsSnapshot({
			snapshot: first,
			// Later entries do not change the first snapshot's baseline
			entries: runtime.session.sessionManager.getEntries(),
			filterMessages: (messages) => messages,
			options: { cwd: "/" },
			allTools: [],
			systemPrompt: "",
			activeToolNames: [],
		});

		const marked = composition.groups.flatMap((group) => group.items.flatMap((item) => [item, ...(item.children ?? [])]))
			.filter((item) => item.change !== undefined)
			.map((item) => `${item.source.label} / ${item.label}: ${item.change}`);
		assert.deepEqual(marked.sort(), [
			`${CONTEXT_ADD_TYPE} / message: added`,
			"pi / Documentation: deleted",
			"pi / Preamble: modified",
			...Object.keys(SECTION_PATCH_SECTIONS).map((name) => `pi / ${name}: added`),
			...Object.keys(SECTION_DELETE_SECTIONS).map((name) => `pi / ${name}: deleted`),
			"unattributed / user message: modified",
		].sort());
		const modified = composition.groups.flatMap((group) => group.items).find((item) => item.change === "modified");
		assert.deepEqual(modified?.sections?.map((part) => [part.label, part.text]), [
			["Request", `${CONTEXT_MODIFY_PREFIX} original text`],
			["Session", JSON.stringify([{ type: "text", text: "original text" }])],
		]);
	});
});

/** Placeholder replaced by the monitor in `createRuntime`, so fixtures can be ordered around it. */
const monitorSlot: ExtensionFactory = () => undefined;

/** Start a mock provider that stops when the test ends. */
async function startProvider(t: TestContext): Promise<MockProvider> {
	const provider = await startMockProvider();
	t.after(() => provider.close());
	return provider;
}

/** Run `body` with a fresh mock provider. */
async function withProvider<T>(t: TestContext, body: (provider: MockProvider) => Promise<T>): Promise<T> {
	return body(await startProvider(t));
}

/** A scratch directory removed when the test ends. */
async function temporaryDirectory(t: TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "context-capture-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

/**
 * Build an isolated Pi runtime with the extension at `monitorSlot`, or last when
 * the factories have no slot. No real credentials, resources, or endpoints.
 */
async function createRuntime(t: TestContext, provider: MockProvider, options: RuntimeOptions): Promise<Runtime> {
	const directory = await temporaryDirectory(t);
	// Keep almost nothing on manual compaction, so a short session can compact
	const settingsManager = SettingsManager.inMemory({
		cacheWarming: "off", compaction: { enabled: false, keepRecentTokens: 1 },
	});
	t.mock.method(SettingsManager, "create", () => settingsManager);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
	});
	const models = (["vision", "text"] as const).map((id) => ({
		provider: PROVIDER, id, name: id, api: "openai-completions", baseUrl: provider.baseUrls["openai-completions"],
		reasoning: false, input: id === "vision" ? ["text", "image"] : ["text"], contextWindow: 100_000, maxTokens: 128,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} satisfies NonNullable<ExtensionContext["model"]>));
	const store = new SnapshotStore();
	const published: RequestSnapshot[] = [];
	store.subscribe((snapshot) => published.push(snapshot));
	const monitor: ExtensionFactory = (pi) => registerExtension(pi, store);
	const ordered = options.factories.includes(monitorSlot)
		? options.factories.map((factory) => factory === monitorSlot ? monitor : factory)
		: [...options.factories, monitor];
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [
			(pi) => pi.registerProvider(PROVIDER, {
				api: "openai-completions", baseUrl: provider.baseUrls["openai-completions"], apiKey: "mock-key", models,
			}),
			...ordered,
		],
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd: directory, agentDir: directory, settingsManager, resourceLoader, modelRuntime,
		model: models.find((model) => model.id === (options.modelId ?? "vision")),
		sessionManager: options.sessionManager ?? SessionManager.inMemory(directory), tools: ["read"], thinkingLevel: "off",
	});
	t.after(() => session.dispose());
	assert.deepEqual(extensionsResult.errors, []);
	const errors: string[] = [];
	await session.bindExtensions({
		mode: options.mode ?? "tui",
		onError: (error) => { errors.push(`${error.event}: ${error.error}`); },
		...(options.mode === "rpc" ? {} : {
			uiContext: {
				setWorkingVisible: () => undefined,
				custom: async () => undefined,
				notify: () => undefined,
			} as unknown as ExtensionUIContext,
		}),
	});
	return {
		session, published, errors,
		settled: async ({ lateEdits = false } = {}) => {
			await new Promise((resolve) => setImmediate(resolve));
			const latest = new Map(published.map((snapshot) => [snapshot.id, snapshot]));
			const snapshots = [...latest.values()].sort((a, b) => a.id - b.id);
			for (const snapshot of snapshots) {
				if (snapshot.origin === "synthetic-probe") assert.deepEqual(snapshot.guard, NO_PAYLOAD);
				else {
					assert.ok(snapshot.guard.status === "complete", JSON.stringify(snapshot.guard));
					if (!lateEdits) assert.deepEqual(snapshot.guard.findings, []);
					assert.ok(snapshot.declaredTools);
				}
			}
			return snapshots;
		},
	};
}

/** Assert a snapshot found no request-only change. */
function assertEmpty(snapshot: RequestSnapshot | undefined): void {
	assert.ok(snapshot, "a snapshot was published");
	assert.deepEqual(snapshot.changes, { conversation: [], system: [] });
	assert.equal(snapshot.forcedPrompt, undefined);
}

/**
 * Assert the payload guard reports the fixtures' `context_with_system` edits
 * after the monitor: one modified system prompt and one modified user message,
 * each with only its changed lines.
 */
function assertLateEdits(snapshot: RequestSnapshot): void {
	assert.ok(snapshot.guard.status === "complete");
	const [system, user, ...rest] = snapshot.guard.findings;
	assert.deepEqual(rest, []);
	assert.ok(system?.type === "late-edit" && user?.type === "late-edit");
	assert.deepEqual([system.change, system.part, user.change, user.part], ["modified", "system", "modified", "user"]);
	assert.deepEqual(user.lines, [{ type: "added", text: IN_PLACE_SUFFIX }]);
	const added = system.lines.filter((line) => line.type === "added").map((line) => line.text);
	assert.deepEqual(added, [
		SYSTEM_APPEND_TEXT, SECTION_MODIFY_TEXT,
		...SECTION_MODIFY_SECTIONS.map(({ text }) => text),
		...Object.values(SECTION_PATCH_SECTIONS).flatMap((text) => text.split("\n")),
	]);
	const removed = system.lines.filter((line) => line.type === "removed").map((line) => line.text);
	assert.ok(removed.length > 0 && removed[0] === `<${SECTION_DELETE_NAME}>`, removed.join("\n"));
}

/** All nine section changes remain distinct, including the three deleted originals. */
function assertSectionChanges(snapshot: RequestSnapshot): void {
	const changes = snapshot.changes.system.filter((change) => change.type === "section");
	assert.deepEqual(changes.map(describeSystemChange).sort(), [
		`section cwd: ${SECTION_MODIFY_TEXT}`,
		...SECTION_MODIFY_SECTIONS.map(({ name, text }) => `section ${name}: ${text}`),
		...Object.entries(SECTION_PATCH_SECTIONS).map(([name, text]) =>
			`section ${name}: ${text.split("\n").find((line) => line.includes("XYZZY"))}`),
		...[SECTION_DELETE_NAME, ...Object.keys(SECTION_DELETE_SECTIONS)].map((name) => `section ${name}: removed`),
	].sort());
}

/** Assert a modification or deletion references the session entry of the user message with `text`. */
function assertReferencesUserEntry(runtime: Runtime, change: ConversationChange | undefined, text: string): void {
	assert.ok(change !== undefined && change.type !== "added");
	const entry = runtime.session.sessionManager.getEntry(change.entryId);
	assert.ok(entry?.type === "message" && entry.message.role === "user");
	assert.equal(contentText(entry.message.content), text);
}

/** One-line description of a conversation change. */
function describeChange(change: ConversationChange): string {
	if (change.type === "deleted") return "deleted";
	const message = change.message;
	const source = change.attribution.customType ?? message.role;
	const text = message.role === "user" || message.role === "custom" ? contentText(message.content) : message.role;
	return `${change.type} ${source}: ${text}`;
}

/** One-line description of a system change; section text keeps only its marker line when it has one. */
function describeSystemChange(change: SystemChange): string {
	if (change.type === "content") return `content: ${change.text}`;
	if (change.type === "tool") return `tool ${change.name}: ${change.declaration === null ? "removed" : "declared"}`;
	if (change.text === null) return `section ${change.name}: removed`;
	return `section ${change.name}: ${change.text.split("\n").find((line) => line.includes("XYZZY")) ?? change.text}`;
}

/** Text of string or block content. */
function contentText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	return typeof content === "string" ? content : content.map((block) => block.text ?? "").join("\n");
}
