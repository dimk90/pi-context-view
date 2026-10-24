/**
 * Verification fixture: removes `docs` and two seeded sections from every request.
 * `before_agent_start` records originals so deletions have a baseline
 * even in a fresh session. The request-only patch sets each section to `null`.
 *
 * Expected result:
 *   before the monitor   three structured section deletions, unattributed
 *   after the monitor    edited after monitor
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Pi section that the fixture removes. */
export const SECTION_DELETE_NAME = "docs";

/**
 * Baseline-only section bodies retained for Deleted preview assertions, not sent.
 * Pi wraps prompt option sections in their XML tags itself.
 */
export const SECTION_DELETE_SECTIONS = {
	"context-view-fixture-obsolete": "XYZZY_SECTION_DELETE_OBSOLETE: This migration note is outdated.",
	"context-view-fixture-scratch": "XYZZY_SECTION_DELETE_SCRATCH: Temporary investigation notes are no longer needed.",
};

/** Seed baseline sections and append their removal patch after the transcript. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		Object.assign(event.systemPromptOptions.sections, SECTION_DELETE_SECTIONS);
	});
	pi.on("context_with_system", (event) => ({
		messages: [...event.messages, {
			role: "system",
			content: "",
			sections: Object.fromEntries([SECTION_DELETE_NAME, ...Object.keys(SECTION_DELETE_SECTIONS)]
				.map((name) => [name, null])),
			timestamp: Date.now(),
		}],
	}));
}
