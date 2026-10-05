/**
 * Self-tests for the validation harness: the mock provider speaks every
 * streaming format through a real Pi RPC process, and each harness fixture
 * makes its change visible in the provider request.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite, test, type TestContext } from "node:test";

import { startMockProvider, type MockProvider, type RecordedRequest } from "./harness/mock-provider.ts";
import { MOCK_PROVIDERS, startPi, type PiOptions, type PiProcess } from "./harness/pi-rpc.ts";
import { CONTEXT_ADD_TEXT } from "./fixtures/context-add.ts";
import { CONTEXT_ADD_USER_TEXT } from "./fixtures/context-add-user.ts";
import { CONTEXT_DELETE_MARKER } from "./fixtures/context-delete.ts";
import { CONTEXT_IN_PLACE_SUFFIX } from "./fixtures/context-in-place.ts";
import { CONTEXT_MODIFY_PREFIX } from "./fixtures/context-modify.ts";
import { CONTEXT_REORDER_MARKER } from "./fixtures/context-reorder.ts";
import { IN_PLACE_SUFFIX } from "./fixtures/in-place-mutation.ts";
import { PAYLOAD_DELETE_MARKER } from "./fixtures/payload-delete.ts";
import { PAYLOAD_LOG_VARIABLE } from "./fixtures/payload-logger.ts";
import { PAYLOAD_MODIFY_SUFFIX } from "./fixtures/payload-modify.ts";
import { declaredToolName, PAYLOAD_REMOVED_TOOL } from "./fixtures/payload-remove-tool.ts";
import { PAYLOAD_REWRITE_TEXT } from "./fixtures/payload-rewrite.ts";
import { SECTION_DELETE_NAME } from "./fixtures/section-delete.ts";
import { SECTION_MODIFY_TEXT } from "./fixtures/section-modify.ts";
import { SECTION_PATCH_TEXT } from "./fixtures/section-patch.ts";
import { SYSTEM_APPEND_TEXT } from "./fixtures/system-append.ts";

/** A 1×1 PNG for image-input checks. */
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

suite("mock provider through Pi RPC", { concurrency: true }, () => {
	for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
		test(`${api}: text reply, tool call and follow-up`, async (t) => {
			const { provider, client } = await startHarness(t, { model: `${MOCK_PROVIDERS[api]}/vision` });
			await client.promptAndWait("first prompt");
			assert.equal(await client.getLastAssistantText(), "ok");
			provider.enqueue({ type: "tool-call", name: "read", arguments: { path: "missing.txt" } },
				{ type: "text", text: "after tool" });
			await client.promptAndWait("second prompt");
			assert.equal(await client.getLastAssistantText(), "after tool");
			assert.deepEqual(provider.requests.map((request) => request.api), [api, api, api]);
			assert.ok(requestText(provider.requests[2]).includes("missing.txt"), "follow-up carries the tool result");
		});
	}

	test("delayed stream events still complete the reply", async (t) => {
		const { provider, client } = await startHarness(t, {});
		provider.enqueue({ type: "text", text: "late", delayMs: 300 });
		const started = Date.now();
		await client.promptAndWait("prompt");
		assert.ok(Date.now() - started >= 300);
		assert.equal(await client.getLastAssistantText(), "late");
	});

	test("a controlled failure ends the run with an error message", async (t) => {
		const { provider, client } = await startHarness(t, {});
		provider.enqueue({ type: "error", status: 500, message: "mock failure" });
		const events = await client.promptAndWait("prompt");
		const end = events.findLast((event) => event.type === "message_end" && event.message.role === "assistant");
		assert.ok(end?.type === "message_end" && end.message.role === "assistant");
		assert.equal(end.message.stopReason, "error");
		assert.match(end.message.errorMessage ?? "", /mock failure/);
		assert.equal(provider.requests.length, 1, "retries are disabled by default");
	});

	test("the text-only model receives an image placeholder", async (t) => {
		const image = { type: "image" as const, data: PIXEL_PNG, mimeType: "image/png" };
		const vision = await startHarness(t, {});
		await vision.client.promptAndWait("look", [image]);
		assert.ok(requestText(vision.provider.requests[0]).includes(PIXEL_PNG));
		const text = await startHarness(t, { model: `${MOCK_PROVIDERS["openai-completions"]}/text` });
		await text.client.promptAndWait("look", [image]);
		assert.ok(!requestText(text.provider.requests[0]).includes(PIXEL_PNG));
		assert.ok(requestText(text.provider.requests[0]).includes("image omitted"));
	});
});

suite("harness fixtures change the provider request", { concurrency: true }, () => {
	test("context add", async (t) => {
		const { provider, client } = await startHarness(t, { extensions: [fixture("context-add")] });
		await client.promptAndWait("prompt");
		assert.ok(requestText(provider.requests[0]).includes(CONTEXT_ADD_TEXT));
	});

	test("context modify", async (t) => {
		const { provider, client } = await startHarness(t, { extensions: [fixture("context-modify")] });
		await client.promptAndWait("original text");
		assert.ok(requestText(provider.requests[0]).includes(`${CONTEXT_MODIFY_PREFIX} original text`));
	});

	test("context delete", async (t) => {
		const { provider, client } = await startHarness(t, { extensions: [fixture("context-delete")] });
		await client.promptAndWait(`${CONTEXT_DELETE_MARKER}: drop me`);
		await client.promptAndWait("keep me");
		const request = requestText(provider.requests[1]);
		assert.ok(!request.includes(CONTEXT_DELETE_MARKER));
		assert.ok(request.includes("keep me"));
	});

	test("context_with_system section patch", async (t) => {
		const { provider, client } = await startHarness(t, { extensions: [fixture("section-patch")] });
		await client.promptAndWait("prompt");
		assert.ok(requestText(provider.requests[0]).includes(SECTION_PATCH_TEXT));
	});

	test("in-place mutation", async (t) => {
		const { provider, client } = await startHarness(t, { extensions: [fixture("in-place-mutation")] });
		await client.promptAndWait("prompt");
		assert.ok(requestText(provider.requests[0]).includes(IN_PLACE_SUFFIX));
	});

	test("before_provider_request rewrite", async (t) => {
		const { provider, client } = await startHarness(t, { extensions: [fixture("payload-rewrite")] });
		await client.promptAndWait("prompt");
		assert.ok(requestText(provider.requests[0]).includes(PAYLOAD_REWRITE_TEXT));
	});

	test("context add user", async (t) => {
		const { provider, client } = await startHarness(t, { extensions: [fixture("context-add-user")] });
		await client.promptAndWait("prompt");
		assert.ok(requestText(provider.requests[0]).includes(CONTEXT_ADD_USER_TEXT));
	});

	test("context reorder", async (t) => {
		const { provider, client } = await startHarness(t, { extensions: [fixture("context-reorder")] });
		await client.promptAndWait(`${CONTEXT_REORDER_MARKER}: move me`);
		await client.promptAndWait("latest prompt");
		const request = requestText(provider.requests[1]);
		assert.ok(request.indexOf("latest prompt") < request.indexOf(CONTEXT_REORDER_MARKER));
	});

	test("context in-place mutation", async (t) => {
		const { provider, client } = await startHarness(t, { extensions: [fixture("context-in-place")] });
		await client.promptAndWait("first prompt");
		await client.promptAndWait("second prompt");
		const request = requestText(provider.requests[1]);
		assert.equal(request.split(CONTEXT_IN_PLACE_SUFFIX).length - 1, 1, "the session keeps the first prompt unchanged");
	});

	test("context_with_system append", async (t) => {
		const { provider, client } = await startHarness(t, { extensions: [fixture("system-append")] });
		await client.promptAndWait("prompt");
		assert.ok(requestText(provider.requests[0]).includes(SYSTEM_APPEND_TEXT));
	});

	test("context_with_system section modify", async (t) => {
		const { provider, client } = await startHarness(t, { extensions: [fixture("section-modify")] });
		await client.promptAndWait("prompt");
		// JSON escapes the newline before the closing tag
		assert.ok(requestText(provider.requests[0]).includes(`${SECTION_MODIFY_TEXT}\\n</cwd>`));
	});

	test("context_with_system section delete", async (t) => {
		const { provider, client } = await startHarness(t, { extensions: [fixture("section-delete")] });
		await client.promptAndWait("prompt");
		const request = requestText(provider.requests[0]);
		assert.ok(!request.includes(`<${SECTION_DELETE_NAME}>`));
		assert.ok(request.includes("<cwd>"), "other sections stay");
	});

	for (const api of ["openai-completions", "anthropic-messages"] as const) {
		const model = `${MOCK_PROVIDERS[api]}/vision`;

		test(`${api}: before_provider_request modify`, async (t) => {
			const { provider, client } = await startHarness(t, { model, extensions: [fixture("payload-modify")] });
			await client.promptAndWait("prompt");
			assert.ok(requestText(provider.requests[0]).includes(PAYLOAD_MODIFY_SUFFIX));
		});

		test(`${api}: before_provider_request delete`, async (t) => {
			const { provider, client } = await startHarness(t, { model, extensions: [fixture("payload-delete")] });
			await client.promptAndWait(`${PAYLOAD_DELETE_MARKER}: drop me`);
			await client.promptAndWait("keep me");
			const request = requestText(provider.requests[1]);
			assert.ok(!request.includes(PAYLOAD_DELETE_MARKER));
			assert.ok(request.includes("keep me"));
		});

		test(`${api}: before_provider_request tool removal`, async (t) => {
			const { provider, client } = await startHarness(t, { model, extensions: [fixture("payload-remove-tool")] });
			await client.promptAndWait("prompt");
			const tools = provider.requests[0].body.tools;
			assert.ok(Array.isArray(tools));
			const names = tools.map(declaredToolName);
			assert.ok(!names.includes(PAYLOAD_REMOVED_TOOL));
			assert.ok(names.includes("read"), "other declarations stay");
		});
	}

	test("payload logger writes the final payload", async (t) => {
		const logDir = await mkdtemp(join(tmpdir(), "context-view-payload-log-"));
		t.after(() => rm(logDir, { recursive: true, force: true }));
		const logPath = join(logDir, "payloads.jsonl");
		const { provider, client } = await startHarness(t, {
			extensions: [fixture("payload-rewrite"), fixture("payload-logger")],
			env: { [PAYLOAD_LOG_VARIABLE]: logPath },
		});
		await client.promptAndWait("prompt");
		const logged = (await readFile(logPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(logged, provider.requests.map((request) => request.body));
	});

	test("cache_warming_decision warm sends a one-token refresh", async (t) => {
		const { provider, client } = await startHarness(t, {
			extensions: [fixture("cache-warm")],
			settings: { cacheWarming: "idle" },
			modelFields: { promptCache: { short: 12 } },
		});
		await client.promptAndWait("prompt");
		await provider.waitForRequests(2);
		const [request, refresh] = provider.requests;
		assert.equal(request.body.max_completion_tokens, 1024);
		assert.equal(refresh.body.max_completion_tokens, 1);
		assert.deepEqual(refresh.body.messages, request.body.messages, "the refresh repeats the latest request");
	});
});

/** Start a mock provider and an isolated Pi process; both stop when the test ends. */
async function startHarness(t: TestContext, options: Omit<PiOptions, "provider" | "extensions"> & {
	extensions?: readonly string[];
}): Promise<{ provider: MockProvider; client: PiProcess["client"] }> {
	const provider = await startMockProvider();
	let pi: PiProcess;
	try {
		pi = await startPi({ ...options, provider, extensions: options.extensions ?? [] });
	} catch (error) {
		await provider.close();
		throw error;
	}
	// Stop Pi first, so no pending refresh reaches a closed provider
	t.after(async () => {
		await pi.stop();
		await provider.close();
	});
	return { provider, client: pi.client };
}

/** Absolute path of a fixture under `test/fixtures/`. */
function fixture(name: string): string {
	return new URL(`./fixtures/${name}.ts`, import.meta.url).pathname;
}

/** The whole request body as text, for marker checks independent of the API format. */
function requestText(request: RecordedRequest | undefined): string {
	assert.ok(request, "provider request was recorded");
	return JSON.stringify(request.body);
}
