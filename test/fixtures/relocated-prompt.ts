/** Synthetic reproduction of pi-permission-system's tool-list/guideline relocation. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Remove pi's tool blocks from the preamble and reinsert them at the end, as
 * pi-permission-system does. Its renderer also drops pi's custom-tools filler.
 * Only synthetic text or process-local prompts should be passed to this helper.
 */
export function relocateToolSurface(prompt: string): string {
	const surfaceStart = prompt.indexOf("\nAvailable tools:\n");
	const surfaceEnd = prompt.indexOf("\nPi documentation");
	if (surfaceStart === -1 || surfaceEnd <= surfaceStart) return prompt;
	const surface = prompt.slice(surfaceStart + 1, surfaceEnd)
		.split("\n\n")
		.filter((block) => !block.startsWith("In addition to the tools above"))
		.join("\n\n")
		.trimEnd();
	return `${prompt.slice(0, surfaceStart)}${prompt.slice(surfaceEnd)}\n\n${surface}`;
}

/** Load before or after context-view to verify capture sees the completed rewrite. */
export default function (pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({ systemPrompt: relocateToolSurface(event.systemPrompt) }));
}
