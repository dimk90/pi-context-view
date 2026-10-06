/** Minimal stdio MCP server for guard tests: one direct tool and no external resources. */
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const request = JSON.parse(line) as { id?: number | string; method?: string };
	if (request.id === undefined) return;
	const result = respond(request.method);
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});

/** Protocol-only replies; the server receives no prompts and logs no content. */
function respond(method: string | undefined): unknown {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2024-11-05", capabilities: { tools: {} },
				serverInfo: { name: "context-guard-fixture", version: "1" }, instructions: "Test tools only.",
			};
		case "tools/list":
			return { tools: [{ name: "echo", description: "Fixture echo.", inputSchema: { type: "object", properties: {} } }] };
		case "tools/call":
			return { content: [{ type: "text", text: "ok" }] };
		default:
			return {};
	}
}
