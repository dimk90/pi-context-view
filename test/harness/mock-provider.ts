/**
 * Loopback-only mock provider for the validation harness. It serves OpenAI
 * Completions, OpenAI Responses and Anthropic Messages streaming from one HTTP server, records
 * every request body, and answers with scripted replies: text, tool calls,
 * delayed stream events, or HTTP failures before streaming.
 */
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** Provider APIs the mock serves; each has its own base URL. */
export type MockApi = "openai-completions" | "openai-responses" | "anthropic-messages";

/** One scripted answer; the queue falls back to `DEFAULT_REPLY` when empty. */
export type MockReply =
	| { readonly type: "text"; readonly text: string; readonly delayMs?: number }
	| {
		readonly type: "tool-call";
		readonly name: string;
		readonly arguments: Record<string, unknown>;
		readonly delayMs?: number;
	}
	| { readonly type: "error"; readonly status: number; readonly message: string };

/** One HTTP request as the provider received it. */
export interface RecordedRequest {
	readonly api: MockApi;
	readonly path: string;
	readonly body: Record<string, unknown>;
}

/** Running mock provider. */
export interface MockProvider {
	/** Base URL to put in `models.json` for each API. */
	readonly baseUrls: Readonly<Record<MockApi, string>>;
	/** Every request in arrival order, including failed ones. */
	readonly requests: readonly RecordedRequest[];
	/** Queue replies for the next requests, in order. */
	enqueue(...replies: MockReply[]): void;
	/** Resolve once at least `count` requests arrived; reject after `timeoutMs`. */
	waitForRequests(count: number, timeoutMs?: number): Promise<void>;
	close(): Promise<void>;
}

const DEFAULT_REPLY: MockReply = { type: "text", text: "ok" };
const DEFAULT_WAIT_MS = 10_000;

/** Start the mock on an ephemeral loopback port. */
export async function startMockProvider(): Promise<MockProvider> {
	const requests: RecordedRequest[] = [];
	const replies: MockReply[] = [];
	const waiters = new Set<() => void>();
	let replyCount = 0;

	const server = createServer((request, response) => {
		void handleRequest(request, response);
	});

	/** Record the request, take the next reply and answer in the request's API format. */
	async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const path = request.url ?? "";
		const api = apiForPath(path);
		if (!api) {
			response.writeHead(404).end();
			return;
		}
		const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
		requests.push({ api, path, body });
		for (const notify of waiters) notify();
		const reply = replies.shift() ?? DEFAULT_REPLY;
		replyCount++;
		if (reply.type === "error") {
			response.writeHead(reply.status, { "Content-Type": "application/json" });
			response.end(JSON.stringify(errorBody(api, reply.message)));
			return;
		}
		response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
		response.flushHeaders();
		if (reply.delayMs) await sleep(reply.delayMs);
		const model = typeof body.model === "string" ? body.model : "mock";
		response.end(streamEvents(api, reply, model, replyCount).join(""));
	}

	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Mock provider has no TCP address");
	const origin = `http://127.0.0.1:${address.port}`;

	return {
		baseUrls: { "openai-completions": `${origin}/v1`, "openai-responses": `${origin}/v1`, "anthropic-messages": origin },
		requests,
		enqueue: (...next) => { replies.push(...next); },
		waitForRequests: (count, timeoutMs = DEFAULT_WAIT_MS) => new Promise((resolve, reject) => {
			if (requests.length >= count) return resolve();
			const timer = setTimeout(() => {
				waiters.delete(check);
				reject(new Error(`Expected ${count} provider requests, got ${requests.length}`));
			}, timeoutMs);
			function check() {
				if (requests.length < count) return;
				clearTimeout(timer);
				waiters.delete(check);
				resolve();
			}
			waiters.add(check);
		}),
		close: () => new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
			server.closeAllConnections();
		}),
	};
}

/** Map a request path to the API that uses it; the Anthropic SDK may append a query. */
function apiForPath(path: string): MockApi | undefined {
	const pathname = path.split("?")[0];
	if (pathname === "/v1/chat/completions") return "openai-completions";
	if (pathname === "/v1/responses") return "openai-responses";
	if (pathname === "/v1/messages") return "anthropic-messages";
	return undefined;
}

/** Read the whole request body as UTF-8 text. */
async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

/** Error body in the shape each SDK reports as the error message. */
function errorBody(api: MockApi, message: string): unknown {
	return api === "anthropic-messages"
		? { type: "error", error: { type: "api_error", message } }
		: { error: { message, type: "server_error" } };
}

/** SSE frames of a text or tool-call reply in the API's streaming format. */
function streamEvents(api: MockApi, reply: Exclude<MockReply, { type: "error" }>, model: string, sequence: number): string[] {
	switch (api) {
		case "openai-completions": return openAiEvents(reply, model, sequence);
		case "openai-responses": return responsesEvents(reply, model, sequence);
		case "anthropic-messages": return anthropicEvents(reply, model, sequence);
	}
}

/** OpenAI Completions SSE frames for a text or tool-call reply. */
function openAiEvents(reply: Exclude<MockReply, { type: "error" }>, model: string, sequence: number): string[] {
	const chunk = (delta: unknown, finishReason: string | null, usage?: unknown) => ({
		id: `chatcmpl-${sequence}`, object: "chat.completion.chunk", model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage ? { usage } : {}),
	});
	const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
	const first = reply.type === "text"
		? chunk({ role: "assistant", content: reply.text }, null)
		: chunk({
			role: "assistant",
			tool_calls: [{
				index: 0, id: `call_${sequence}`, type: "function",
				function: { name: reply.name, arguments: JSON.stringify(reply.arguments) },
			}],
		}, null);
	const last = chunk({}, reply.type === "text" ? "stop" : "tool_calls", usage);
	return [first, last].map((data) => `data: ${JSON.stringify(data)}\n\n`).concat("data: [DONE]\n\n");
}

/** OpenAI Responses SSE frames for a text or tool-call reply. */
function responsesEvents(reply: Exclude<MockReply, { type: "error" }>, model: string, sequence: number): string[] {
	const args = reply.type === "tool-call" ? JSON.stringify(reply.arguments) : "";
	const item = reply.type === "text"
		? {
			added: { type: "message", id: `msg_${sequence}`, role: "assistant", status: "in_progress", content: [] },
			delta: { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: reply.text },
			done: {
				type: "message", id: `msg_${sequence}`, role: "assistant", status: "completed",
				content: [{ type: "output_text", text: reply.text, annotations: [] }],
			},
		}
		: {
			added: { type: "function_call", id: `fc_${sequence}`, call_id: `call_${sequence}`, name: reply.name, arguments: "" },
			delta: { type: "response.function_call_arguments.delta", output_index: 0, delta: args },
			done: {
				type: "function_call", id: `fc_${sequence}`, call_id: `call_${sequence}`, name: reply.name, arguments: args,
				status: "completed",
			},
		};
	const response = { id: `resp_${sequence}`, object: "response", model, output: [] as unknown[] };
	const events = [
		{ type: "response.created", response: { ...response, status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: item.added },
		item.delta,
		{ type: "response.output_item.done", output_index: 0, item: item.done },
		{
			type: "response.completed",
			response: {
				...response, status: "completed", output: [item.done],
				usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
			},
		},
	];
	return events.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Anthropic Messages SSE frames for a text or tool-call reply. */
function anthropicEvents(reply: Exclude<MockReply, { type: "error" }>, model: string, sequence: number): string[] {
	const block = reply.type === "text"
		? { start: { type: "text", text: "" }, delta: { type: "text_delta", text: reply.text } }
		: {
			start: { type: "tool_use", id: `toolu_${sequence}`, name: reply.name, input: {} },
			delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.arguments) },
		};
	const events: Array<[string, unknown]> = [
		["message_start", {
			type: "message_start",
			message: {
				id: `msg_${sequence}`, type: "message", role: "assistant", model, content: [],
				stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 },
			},
		}],
		["content_block_start", { type: "content_block_start", index: 0, content_block: block.start }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: block.delta }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", {
			type: "message_delta",
			delta: { stop_reason: reply.type === "text" ? "end_turn" : "tool_use" },
			usage: { output_tokens: 1 },
		}],
		["message_stop", { type: "message_stop" }],
	];
	return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Resolve after `milliseconds`. */
function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
