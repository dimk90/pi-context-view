/**
 * Demo extension: use Pi's real codemode tool in `only` mode without changing
 * settings. Other active tools stay callable through scripts, but their
 * declarations are hidden from the model in either extension load order.
 */
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Register codemode with a process-local mode override and activate it at session start. */
export default function (pi: ExtensionAPI): void {
	createCodemodeExtension({ mode: "only" })(pi);
	pi.on("session_start", () => {
		pi.setActiveTools([...new Set([...pi.getActiveTools(), "codemode"])]);
	});
}
