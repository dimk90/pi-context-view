/**
 * Demo extension: a `context_with_system` handler that changes Pi's own `cwd`
 * section for the request only. It appends a system message that replaces the
 * section by name with the replayed text plus a marker line.
 *
 * Expected result:
 *   before the monitor   structured system change to `cwd`, unattributed
 *   after the monitor    edited after monitor
 */
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SECTION_MODIFY_TEXT = "XYZZY_SECTION_MODIFY: request-only line in the cwd section.";

/** Replace the `cwd` section; return nothing when the transcript has none. */
export default function (pi: ExtensionAPI): void {
	pi.on("context_with_system", (event) => {
		const cwd = getCurrentSystemMessage(event.messages)?.sections?.cwd;
		if (!cwd) return undefined;
		const modified = cwd.replace("\n</cwd>", `\n${SECTION_MODIFY_TEXT}\n</cwd>`);
		return {
			messages: [...event.messages, { role: "system", content: "", sections: { cwd: modified }, timestamp: Date.now() }],
		};
	});
}
