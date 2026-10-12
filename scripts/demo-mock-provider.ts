/** Completions-only demo endpoint: discard request bodies and return a fixed reply, without logging or retaining them. */
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const MOCK_PROVIDER = "demo-mock";
export const MOCK_MODEL = "demo";
export const MOCK_REPLY = "ok";

/** Running loopback endpoint; it makes no outbound requests. */
export interface DemoMockProvider {
	readonly baseUrl: string;
	/** Close the listener and any remaining connections; safe to call again. */
	close(): Promise<void>;
}

/** Start the demo endpoint on an ephemeral IPv4 loopback port. */
export async function startDemoMockProvider(): Promise<DemoMockProvider> {
	let sequence = 0;
	const server = createServer((request, response) => {
		void serveRequest(request, response, ++sequence);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Demo mock provider has no TCP address");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		close: () => new Promise<void>((resolve, reject) => {
			if (!server.listening) return resolve();
			server.close((error) => error ? reject(error) : resolve());
			server.closeAllConnections();
		}),
	};
}

/** Consume and discard the payload, then answer with a text-only OpenAI Completions stream. */
async function serveRequest(request: IncomingMessage, response: ServerResponse, sequence: number): Promise<void> {
	if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
		request.resume();
		response.writeHead(404).end();
		return;
	}
	try {
		const consumed = once(request, "end");
		request.resume();
		await consumed;
		const chunk = {
			id: `chatcmpl-demo-${sequence}`, object: "chat.completion.chunk", model: MOCK_MODEL,
		};
		const first = {
			...chunk, choices: [{ index: 0, delta: { role: "assistant", content: MOCK_REPLY }, finish_reason: null }],
		};
		const last = {
			...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
		};
		response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
		response.end(`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`);
	} catch {
		// Never include a request body or a transport error in output
		response.writeHead(400).end();
	}
}
