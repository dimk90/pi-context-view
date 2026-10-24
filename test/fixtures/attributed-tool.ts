/**
 * Verification fixture: a path-loaded extension tool with a prompt snippet and
 * a guideline. Pi adds both lines to its Tools and Rules sections, and the
 * tool's source names this file, so the addition has an exact owner.
 *
 * Expected result:
 *   before the monitor   own `attributed-tool.ts` group: the tool and its prompt lines in Tools and Rules
 *   after the monitor    same as before
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ATTRIBUTED_TOOL_NAME = "context_view_fixture_tool";

/** Register one side-effect-free tool with prompt metadata. */
export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: ATTRIBUTED_TOOL_NAME,
		label: "Fixture Tool",
		description: "Return a fixed note. Does not read or modify files.",
		promptSnippet: "XYZZY_ATTRIBUTED_TOOL: return a fixed note",
		promptGuidelines: [`XYZZY_ATTRIBUTED_TOOL: use ${ATTRIBUTED_TOOL_NAME} only in tests.`],
		parameters: Type.Object({}),
		/** Return a fixed note without side effects. */
		async execute() {
			return { content: [{ type: "text", text: "fixed note" }], details: undefined };
		},
	});
}
