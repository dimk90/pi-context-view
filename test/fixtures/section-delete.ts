/**
 * Demo extension: a `context_with_system` handler that removes Pi's own `docs`
 * section for the request only, through a system message whose `sections`
 * patch sets it to `null`. This removal has no marker text: look for the
 * missing Pi documentation paths instead.
 *
 * Expected result:
 *   before the monitor   structured system change removing `docs`, unattributed
 *   after the monitor    edited after monitor
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Pi section that the fixture removes. */
export const SECTION_DELETE_NAME = "docs";

/** Append the removal patch after the existing transcript. */
export default function (pi: ExtensionAPI): void {
	pi.on("context_with_system", (event) => ({
		messages: [...event.messages, {
			role: "system",
			content: "",
			sections: { [SECTION_DELETE_NAME]: null },
			timestamp: Date.now(),
		}],
	}));
}
