/**
 * Verification fixture: a `context_with_system` handler that appends a system
 * message adding three named prompt sections for the request only.
 *
 * Expected result:
 *   before the monitor   three structured section additions, unattributed
 *   after the monitor    edited after monitor
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SECTION_PATCH_NAME = "context-view-fixture";
export const SECTION_PATCH_TEXT = "<context-view-fixture>XYZZY_SECTION_PATCH: request-only section.</context-view-fixture>";

/** Request-only sections with distinct content for the demo previews. */
export const SECTION_PATCH_SECTIONS = {
	[SECTION_PATCH_NAME]: SECTION_PATCH_TEXT,
	"context-view-fixture-checklist": "<context-view-fixture-checklist>\nXYZZY_SECTION_PATCH_CHECKLIST:\n"
		+ "- Read the affected files before editing.\n- Run focused tests after the change.\n</context-view-fixture-checklist>",
	"context-view-fixture-summary": "<context-view-fixture-summary>\nXYZZY_SECTION_PATCH_SUMMARY:\n"
		+ "Summarize the change, checks run, and any remaining limitations.\n</context-view-fixture-summary>",
};

/** Append all section additions after the existing transcript. */
export default function (pi: ExtensionAPI): void {
	pi.on("context_with_system", (event) => ({
		messages: [...event.messages, {
			role: "system",
			content: "",
			sections: { ...SECTION_PATCH_SECTIONS },
			timestamp: Date.now(),
		}],
	}));
}
