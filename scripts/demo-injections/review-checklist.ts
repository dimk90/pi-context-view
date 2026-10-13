/**
 * Demo extension: a harmless tool whose definition and prompt lines have a
 * known owner. Unlike custom sections and messages, its contribution appears
 * under `review-checklist.ts` in both extension load orders.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REVIEW_CHECKLIST_TEXT = "- Check correctness.\n- Check error handling.\n- Check test coverage.";

/** Register a read-only checklist with exactly attributable prompt metadata. */
export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review_checklist",
		label: "Review Checklist",
		description: "Return a checklist for reviewing a code change. Does not read or modify files.",
		promptSnippet: "Get a checklist for correctness, error handling, and test coverage",
		promptGuidelines: ["Use review_checklist when preparing a code review."],
		parameters: Type.Object({}),
		exposure: "direct",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		/** Return fixed review guidance without side effects. */
		async execute() {
			return { content: [{ type: "text", text: REVIEW_CHECKLIST_TEXT }], details: undefined };
		},
	});
}
