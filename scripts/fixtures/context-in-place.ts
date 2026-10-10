/**
 * Demo extension: a `context` handler that edits the latest user message in
 * place and returns nothing. Pi keeps the edit because later handlers share
 * the same message objects; the session keeps the original text.
 *
 * Expected result:
 *   before the monitor   structured modification, unattributed
 *   after the monitor    structured modification, unattributed
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CONTEXT_IN_PLACE_SUFFIX = "XYZZY_CONTEXT_IN_PLACE: appended by in-place mutation.";

/** Append the marker to the latest user message without returning a result. */
export default function (pi: ExtensionAPI): void {
	pi.on("context", (event) => {
		const target = event.messages.findLast((message) => message.role === "user");
		if (target?.role !== "user") return;
		if (typeof target.content === "string") target.content = `${target.content}\n${CONTEXT_IN_PLACE_SUFFIX}`;
		else target.content.push({ type: "text", text: CONTEXT_IN_PLACE_SUFFIX });
	});
}
