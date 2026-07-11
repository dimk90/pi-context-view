/**
 * `/context` command grammar, argument completions, and Initial capture
 * resolution shared by the Usage and Injections views.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import {
	buildNativeSnapshot,
	type InitialCaptureState,
	type SilentProbeState,
} from "./capture.ts";
import type { InitialSnapshot } from "./model.ts";

const COMMAND_USAGE = "Usage: /context [usage|injections|runtime on|runtime off]";
const DEFAULT_VIEW: ContextView = "usage";
const ARGUMENT_OPTIONS = [
	{ value: "usage", label: "usage", description: "Show estimated context usage" },
	{ value: "injections", label: "injections", description: "Explore initial and runtime injections" },
	{ value: "runtime on", label: "runtime on", description: "Enable future runtime injection logging" },
	{ value: "runtime off", label: "runtime off", description: "Disable runtime injection logging" },
] satisfies AutocompleteItem[];

/** The focused view a `/context` invocation requests. */
export type ContextView = "usage" | "injections";

/** Parsed `/context` argument grammar. */
export type ContextCommand =
	| { readonly type: "view"; readonly view: ContextView }
	| { readonly type: "runtime"; readonly enabled: boolean }
	| { readonly type: "invalid"; readonly message: string };

/** Resolved Initial capture, possibly degraded to the pi-native fallback. */
export interface InitialCaptureResult {
	readonly snapshot: InitialSnapshot;
	readonly degradedReason?: string;
}

/** Parse the complete, intentionally small `/context` argument grammar. */
export function parseContextCommand(argumentsText: string): ContextCommand {
	const words = argumentsText.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return { type: "view", view: DEFAULT_VIEW };
	}
	if (words.length === 1 && words[0] === "usage") {
		return { type: "view", view: "usage" };
	}
	if (words.length === 1 && words[0] === "injections") {
		return { type: "view", view: "injections" };
	}
	if (words.length === 2 && words[0] === "runtime" && (words[1] === "on" || words[1] === "off")) {
		return { type: "runtime", enabled: words[1] === "on" };
	}
	return { type: "invalid", message: COMMAND_USAGE };
}

/** Complete full argument values for the supported `/context` grammar. */
export function getContextArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const normalizedPrefix = argumentPrefix.trimStart().toLowerCase();
	const matches = ARGUMENT_OPTIONS.filter((option) => option.value.startsWith(normalizedPrefix));
	return matches.length > 0 ? matches.map((option) => ({ ...option })) : null;
}

/** Obtain Initial through passive capture, one silent probe, or a pi-native fallback. */
export async function resolveInitialCapture(
	pi: ExtensionAPI,
	capture: InitialCaptureState,
	probe: SilentProbeState,
	context: ExtensionCommandContext,
): Promise<InitialCaptureResult> {
	if (capture.snapshot !== undefined) return { snapshot: capture.snapshot };

	await context.waitForIdle();
	if (capture.snapshot !== undefined) return { snapshot: capture.snapshot };

	const unavailableReason = getProbeUnavailableReason(context);
	if (unavailableReason !== undefined) {
		return createFallback(pi, context, unavailableReason);
	}

	const attempt = probe.start();
	if (attempt.started) {
		context.ui.setWorkingVisible(false);
		try {
			pi.sendUserMessage("");
		} catch (error) {
			probe.fail(error instanceof Error ? error.message : String(error));
		}
	}

	try {
		const outcome = await attempt.completion;
		if (outcome.status === "captured" && capture.snapshot !== undefined) {
			return { snapshot: capture.snapshot };
		}
		const reason = outcome.status === "failed" ? outcome.reason : "Silent probe did not capture Initial.";
		return createFallback(pi, context, reason);
	} finally {
		if (attempt.started) context.ui.setWorkingVisible(true);
	}
}

/** Report command errors in both interactive and headless modes. */
export function reportCommandMessage(
	context: ExtensionCommandContext,
	message: string,
	type: "info" | "warning" | "error",
): void {
	if (context.hasUI) {
		context.ui.notify(message, type);
		return;
	}
	process.stderr.write(`${message}\n`);
}

/** Explain why a silent probe cannot run now, or undefined when it can. */
function getProbeUnavailableReason(context: ExtensionCommandContext): string | undefined {
	if (context.model === undefined) return "Silent probe unavailable: no model is selected.";
	if (!context.modelRegistry.hasConfiguredAuth(context.model)) {
		return `Silent probe unavailable: ${context.model.provider} has no configured authentication.`;
	}
	return undefined;
}

/** Build a degraded pi-native snapshot when passive capture and probing both failed. */
function createFallback(
	pi: ExtensionAPI,
	context: ExtensionCommandContext,
	reason: string,
): InitialCaptureResult {
	return {
		snapshot: buildNativeSnapshot({
			systemPrompt: context.getSystemPrompt(),
			options: context.getSystemPromptOptions(),
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
		}),
		degradedReason: `${reason} Extension additions were not observed.`,
	};
}
