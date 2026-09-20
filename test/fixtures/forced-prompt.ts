/**
 * Verification fixture: an extension that replaces the whole system prompt for
 * one run, the way a `before_agent_start` handler returning `systemPrompt`
 * does. Pi keeps recording the structured sections and projects this text onto
 * the request after the `context` handlers.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Complete replacement; it deliberately contains none of Pi's own sections. */
export const FORCED_SYSTEM_PROMPT = "XYZZY_FORCED_PROMPT: replacement system prompt with no Pi sections.";

/** Load before or after context-view to verify capture reads the forced prompt. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", () => ({ systemPrompt: FORCED_SYSTEM_PROMPT }));
}
