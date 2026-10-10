/**
 * Demo extension: changes `cwd` and two seeded sections for the request only.
 * `before_agent_start` records the demo originals in Pi's structured prompt;
 * `context_with_system` replaces them without changing the saved baseline.
 *
 * Expected result:
 *   before the monitor   three structured section modifications, unattributed
 *   after the monitor    edited after monitor
 */
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SECTION_MODIFY_TEXT = "XYZZY_SECTION_MODIFY: request-only line in the cwd section.";

/** Original and replacement bodies for automatically demonstrated modifications. */
export const SECTION_MODIFY_SECTIONS = [
	{
		name: "context-view-fixture-review",
		original: "Review the changed files for correctness.",
		text: "XYZZY_SECTION_MODIFY_REVIEW: Review correctness, error handling, and test coverage.",
	},
	{
		name: "context-view-fixture-output",
		original: "List the changed files.",
		text: "XYZZY_SECTION_MODIFY_OUTPUT: List the changed files and explain the user-visible effects.",
	},
];

/** Seed two baseline sections, then modify them and `cwd` in each request. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		for (const { name, original } of SECTION_MODIFY_SECTIONS) {
			event.systemPromptOptions.sections[name] = `<${name}>\n${original}\n</${name}>`;
		}
	});
	pi.on("context_with_system", (event) => {
		const current = getCurrentSystemMessage(event.messages)?.sections;
		const sections: Record<string, string> = {};
		if (current?.cwd) sections.cwd = current.cwd.replace("\n</cwd>", `\n${SECTION_MODIFY_TEXT}\n</cwd>`);
		for (const { name, original, text } of SECTION_MODIFY_SECTIONS) {
			if (current?.[name]) sections[name] = current[name].replace(original, text);
		}
		if (Object.keys(sections).length === 0) return undefined;
		return {
			messages: [...event.messages, { role: "system", content: "", sections, timestamp: Date.now() }],
		};
	});
}
