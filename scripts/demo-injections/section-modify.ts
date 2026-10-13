/**
 * Demo extension: expands one saved review instruction for the request only.
 * `before_agent_start` seeds the original; `context_with_system` replaces it.
 * Pi's own sections, including `cwd`, stay unchanged.
 *
 * Expected result:
 *   before the monitor   one structured section modification, unattributed
 *   after the monitor    payload change after an ordinary prompt
 */
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SECTION_MODIFY_NAME = "demo_review";
export const SECTION_MODIFY_ORIGINAL = "Review the changed files for correctness.";
export const SECTION_MODIFY_TEXT = "Review the changed files for correctness, error handling, and test coverage.";

/** Seed one baseline section, then replace its body only in outgoing requests. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections[SECTION_MODIFY_NAME] = `<${SECTION_MODIFY_NAME}>\n`
			+ `${SECTION_MODIFY_ORIGINAL}\n</${SECTION_MODIFY_NAME}>`;
	});
	pi.on("context_with_system", (event) => {
		const original = getCurrentSystemMessage(event.messages)?.sections?.[SECTION_MODIFY_NAME];
		if (!original) return undefined;
		return {
			messages: [...event.messages, {
				role: "system",
				content: "",
				sections: { [SECTION_MODIFY_NAME]: original.replace(SECTION_MODIFY_ORIGINAL, SECTION_MODIFY_TEXT) },
				timestamp: Date.now(),
			}],
		};
	});
}
