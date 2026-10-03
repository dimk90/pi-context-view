/**
 * Verification fixture: a `context_with_system` handler that appends a system
 * message setting one named prompt section for the request only.
 *
 * Expected result:
 *   before the monitor   structured system change adding the section, unattributed
 *   after the monitor    edited after monitor
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SECTION_PATCH_NAME = "context-view-fixture";
export const SECTION_PATCH_TEXT = "<context-view-fixture>XYZZY_SECTION_PATCH: request-only section.</context-view-fixture>";

/** Append the section patch after the existing transcript. */
export default function (pi: ExtensionAPI): void {
	pi.on("context_with_system", (event) => ({
		messages: [...event.messages, {
			role: "system",
			content: "",
			sections: { [SECTION_PATCH_NAME]: SECTION_PATCH_TEXT },
			timestamp: Date.now(),
		}],
	}));
}
