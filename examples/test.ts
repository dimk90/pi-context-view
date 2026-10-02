import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Smoke-test extension: hits every injection point pi exposes so we can
 * verify that pcv's `/context injections` view captures ALL of them.
 *
 *   Phase 0: before_agent_start        — appends a custom message to messages
 *   Phase 1: context                    — appends a user message
 *   Phase 2: context_with_system        — appends a custom message
 *   Phase 3: before_provider_request    — appends a user message to payload
 *
 * Each line is tagged with `TEST Phase N` so it is easy to tell which path a
 * given injection in `/context injections` came from.
 */
export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async () => {
		return {
			message: {
				role: "custom",
				customType: "test.before_agent_start",
				content: "TEST Phase 0 before_agent_start injection",
				display: false,
				timestamp: Date.now(),
			},
		};
	});

	pi.on("context", async (event) => {
		event.messages.push({
			role: "user",
			content: "TEST Phase 1 context injection",
			timestamp: Date.now(),
		});
		return { messages: event.messages };
	});

	pi.on("context_with_system", async (event) => {
		event.messages.push({
			role: "custom",
			customType: "test.context_with_system",
			content: "TEST Phase 2 context_with_system custom injection",
			display: false,
			timestamp: Date.now(),
		});
		return { messages: event.messages };
	});

	pi.on("before_provider_request", async (event) => {
		const payload = event.payload as { messages?: unknown[]; system?: unknown };
		if (Array.isArray(payload.messages)) {
			payload.messages.push({
				role: "user",
				content: [{ type: "text", text: "TEST Phase 3 before_provider_request injection" }],
			});
		}
		// Do NOT return event: the runner chains handlers by their returned
		// payload, so returning the whole event would replace the provider's
		// real payload with the event wrapper. Mutation is enough.
		return undefined;
	});
}