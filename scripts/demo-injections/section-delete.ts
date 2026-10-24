/**
 * Demo extension: removes one obsolete migration section from the request.
 * `before_agent_start` seeds its saved original for the zero-token preview.
 * Pi's own sections, including `docs`, stay unchanged.
 *
 * Expected result:
 *   before the monitor   one structured section deletion, unattributed
 *   after the monitor    payload change after an ordinary prompt
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SECTION_DELETE_NAME = "demo_legacy_migration";
/** Section body only: pi wraps prompt option sections in their XML tags itself. */
export const SECTION_DELETE_TEXT = "Use the legacy configuration format for migration.";

/** Keep the obsolete section in the session, but remove it from every request. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections[SECTION_DELETE_NAME] = SECTION_DELETE_TEXT;
	});
	pi.on("context_with_system", (event) => ({
		messages: [...event.messages, {
			role: "system",
			content: "",
			sections: { [SECTION_DELETE_NAME]: null },
			timestamp: Date.now(),
		}],
	}));
}
