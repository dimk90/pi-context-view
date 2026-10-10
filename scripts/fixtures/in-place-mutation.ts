/**
 * Demo extension: a `context_with_system` handler that edits the latest
 * user message in place and returns nothing. Later handlers share the same
 * message objects, so a capture that keeps references would see this edit.
 *
 * Expected result:
 *   before the monitor   structured modification, unattributed
 *   after the monitor    edited after monitor
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const IN_PLACE_SUFFIX = "XYZZY_IN_PLACE: appended by in-place mutation.";

/** Append the marker to the latest user message without returning a result. */
export default function (pi: ExtensionAPI): void {
	pi.on("context_with_system", (event) => {
		const target = event.messages.findLast((message) => message.role === "user");
		if (target?.role !== "user") return;
		if (typeof target.content === "string") target.content = `${target.content}\n${IN_PLACE_SUFFIX}`;
		else target.content.push({ type: "text", text: IN_PLACE_SUFFIX });
	});
}
