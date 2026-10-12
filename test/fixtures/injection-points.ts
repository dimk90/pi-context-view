/**
 * Verification fixture adopted from #9: one request-only addition at each of
 * four points of a request, each with its own marker text. Handlers change the
 * shared messages and payload in place, as the PR's example did.
 *
 * Expected result after an ordinary prompt (not a silent probe):
 *   point                     before the monitor                   after the monitor
 *   before_agent_start        no change: the message is persisted  no change
 *   context                   structured addition, unattributed    structured addition, unattributed
 *   context_with_system       structured addition with its source  edited after monitor
 *   before_provider_request   edited after monitor                 not visible
 *
 * The `context_with_system` addition's source is its `customType`, `context-view-fixture-system`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const POINT_AGENT_START_TYPE = "context-view-fixture-agent-start";
export const POINT_AGENT_START_TEXT = "XYZZY_POINT_AGENT_START: before_agent_start custom message.";
export const POINT_CONTEXT_TEXT = "XYZZY_POINT_CONTEXT: context user message.";
export const POINT_SYSTEM_TYPE = "context-view-fixture-system";
export const POINT_SYSTEM_TEXT = "XYZZY_POINT_SYSTEM: context_with_system custom message.";
export const POINT_PAYLOAD_TEXT = "XYZZY_POINT_PAYLOAD: before_provider_request payload message.";

/** Add one message at each point. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", () => ({
		message: { customType: POINT_AGENT_START_TYPE, content: POINT_AGENT_START_TEXT, display: false },
	}));

	pi.on("context", (event) => {
		event.messages.push({ role: "user", content: POINT_CONTEXT_TEXT, timestamp: Date.now() });
		return { messages: event.messages };
	});

	pi.on("context_with_system", (event) => {
		event.messages.push({
			role: "custom", customType: POINT_SYSTEM_TYPE, content: POINT_SYSTEM_TEXT, display: false, timestamp: Date.now(),
		});
		return { messages: event.messages };
	});

	pi.on("before_provider_request", (event) => {
		const payload = event.payload as { messages?: unknown; input?: unknown };
		// OpenAI Responses sends `input` items instead of `messages`
		const responses = Array.isArray(payload.input);
		const messages = responses ? payload.input : payload.messages;
		if (!Array.isArray(messages)) return;
		// Edit in place and return nothing: a returned value replaces the payload for later handlers
		messages.push({ role: "user", content: [{ type: responses ? "input_text" : "text", text: POINT_PAYLOAD_TEXT }] });
	});
}
