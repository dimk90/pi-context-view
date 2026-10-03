/**
 * Demo extension: a `before_provider_request` handler that removes one tool
 * declaration from the provider payload. The tool stays active and callable.
 * This removal has no marker text: look for the missing declaration instead.
 *
 * Expected result:
 *   before the monitor   edited after monitor: a missing declaration with no
 *                        `model-only` candidates; Usage stops counting the tool
 *   after the monitor    not visible
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Built-in tool whose declaration the fixture removes. */
export const PAYLOAD_REMOVED_TOOL = "write";

/** Return a payload copy without the declaration; return nothing when it is absent. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event) => {
		const payload = event.payload as { tools?: unknown };
		if (!Array.isArray(payload.tools)) return undefined;
		const tools = payload.tools.filter((tool) => declaredToolName(tool) !== PAYLOAD_REMOVED_TOOL);
		return tools.length === payload.tools.length ? undefined : { ...payload, tools };
	});
}

/**
 * Name of a tool declaration:
 *   OpenAI Completions   `{ type: "function", function: { name } }`
 *   Anthropic Messages   `{ name }`
 */
export function declaredToolName(tool: unknown): unknown {
	const declaration = tool as { name?: unknown; function?: { name?: unknown } };
	return declaration.name ?? declaration.function?.name;
}
