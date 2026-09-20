/**
 * Verification fixture that simulates another extension rewriting user input,
 * including the silent probe's own synthetic prompt. Load it before and after
 * this extension to prove a transform cannot turn a probe into a real turn.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("input", (event) => ({
		action: "transform",
		text: `XYZZY_MARKER_TRANSFORM: prepended instructions\n${event.text}`,
	}));
}
