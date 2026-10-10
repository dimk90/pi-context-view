/**
 * Demo extension: removes `docs` and two seeded sections from every request.
 * `before_agent_start` records demo originals so deletions have a baseline
 * even in a fresh session. The request-only patch sets each section to `null`.
 *
 * Expected result:
 *   before the monitor   three structured section deletions, unattributed
 *   after the monitor    edited after monitor
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Pi section that the fixture removes. */
export const SECTION_DELETE_NAME = "docs";

/** Baseline-only demo sections retained for Deleted previews, not sent. */
export const SECTION_DELETE_SECTIONS = {
	"context-view-fixture-obsolete": "<context-view-fixture-obsolete>\n"
		+ "XYZZY_SECTION_DELETE_OBSOLETE: This migration note is outdated.\n</context-view-fixture-obsolete>",
	"context-view-fixture-scratch": "<context-view-fixture-scratch>\n"
		+ "XYZZY_SECTION_DELETE_SCRATCH: Temporary investigation notes are no longer needed.\n</context-view-fixture-scratch>",
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
