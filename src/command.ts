/**
 * `/context` command grammar, argument completions, and Initial capture
 * resolution shared by the Usage and Injections views.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import {
	buildNativeSnapshot,
	type CompactionState,
	type InitialCaptureState,
	type SilentProbeState,
} from "./capture.ts";
import type { ConfigCreationResult } from "./config.ts";
import type { InitialSnapshot } from "./model.ts";
import { normalizePreviewText } from "./text.ts";

const COMMAND_USAGE = "Usage: /context [usage|injections|config]";
/**
 * Slash-command palette text, kept beside the grammar it describes.
 * RegisteredCommand has no argumentHint; mimic pi's `<hint> — <description>` style.
 */
export const CONTEXT_COMMAND_DESCRIPTION =
	"[usage|injections|config] - Inspect context usage, injections";
/** Cap for reported messages, which may quote configuration files and OS error text. */
const MAX_REPORTED_MESSAGE_LENGTH = 500;
const DEFAULT_VIEW: ContextView = "usage";
const ARGUMENT_OPTIONS = [
	{ value: "usage", label: "usage", description: "Show estimated context usage" },
	{ value: "injections", label: "injections", description: "Explore initial context injections" },
	{ value: "config", label: "config", description: "Create the default configuration file" },
] satisfies AutocompleteItem[];

/** The focused view a `/context` invocation requests. */
export type ContextView = "usage" | "injections";

/** Parsed `/context` argument grammar. */
export type ContextCommand =
	| { readonly type: "view"; readonly view: ContextView }
	| { readonly type: "config" }
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
	if (words.length === 1 && words[0] === "config") {
		return { type: "config" };
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
	compaction: CompactionState,
	context: ExtensionCommandContext,
): Promise<InitialCaptureResult> {
	if (capture.snapshot !== undefined) return { snapshot: capture.snapshot };

	await context.waitForIdle();
	if (capture.snapshot !== undefined) return { snapshot: capture.snapshot };

	const unavailableReason = getProbeUnavailableReason(context, compaction.isActive);
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

/**
 * Report command errors in both interactive and headless modes. Messages can
 * quote untrusted text such as configuration keys, so they are sanitized and
 * capped before reaching the terminal.
 */
export function reportCommandMessage(
	context: ExtensionCommandContext,
	message: string,
	type: "info" | "warning" | "error",
): void {
	const safeMessage = truncate(normalizePreviewText(message), MAX_REPORTED_MESSAGE_LENGTH);
	if (context.hasUI) {
		context.ui.notify(safeMessage, type);
		return;
	}
	process.stderr.write(`${safeMessage}\n`);
}

/** Refuse a view outside TUI mode, naming the form the user typed. */
export function reportTuiOnly(context: ExtensionCommandContext, view: ContextView): void {
	reportCommandMessage(context, `/context ${view} is available in TUI mode only.`, "warning");
}

/** Report the outcome of the explicit create-only configuration command. */
export function reportConfigCreation(context: ExtensionCommandContext, result: ConfigCreationResult): void {
	switch (result.type) {
		case "created":
			reportCommandMessage(context, `Created default configuration: ${result.filePath}`, "info");
			break;
		case "exists":
			reportCommandMessage(context, `Configuration already exists; left unchanged: ${result.filePath}`, "warning");
			break;
		case "failed":
			reportCommandMessage(context, `Cannot create configuration at ${result.filePath}: ${result.reason}`, "error");
			break;
		default: {
			// Compile-time proof that every result variant is reported.
			const _exhaustive: never = result;
			return _exhaustive;
		}
	}
}

/** Shorten over-long text with an ellipsis marker. */
function truncate(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/** Explain why a silent probe cannot run now, or undefined when it can. */
function getProbeUnavailableReason(
	context: ExtensionCommandContext,
	compactionInProgress: boolean,
): string | undefined {
	if (compactionInProgress) return "Silent probe unavailable: context compaction is in progress.";
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
