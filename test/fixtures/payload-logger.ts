/**
 * Verification fixture: a `before_provider_request` handler that appends each
 * provider payload as one JSON line to the file named by
 * `CONTEXT_VIEW_PAYLOAD_LOG`. Load it last, so the log shows the payload after
 * every other handler; it does nothing when the variable is unset. The log holds
 * raw prompts: use it only with test sessions.
 */
import { appendFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Environment variable with the log file path. */
export const PAYLOAD_LOG_VARIABLE = "CONTEXT_VIEW_PAYLOAD_LOG";

/** Log the payload and leave it unchanged. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event) => {
		const path = process.env[PAYLOAD_LOG_VARIABLE];
		if (path) appendFileSync(path, `${JSON.stringify(event.payload)}\n`);
	});
}
