/**
 * Demo extension: adds one review checklist section for the request only.
 *
 * Expected result:
 *   before the monitor   one structured section addition, unattributed
 *   after the monitor    payload change after an ordinary prompt
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SECTION_PATCH_NAME = "demo_checklist";
export const SECTION_PATCH_TEXT = `<${SECTION_PATCH_NAME}>\n`
	+ "- Read the affected files before editing.\n- Run focused tests after the change.\n"
	+ `</${SECTION_PATCH_NAME}>`;

/** Append a request-only section without changing the saved prompt. */
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
