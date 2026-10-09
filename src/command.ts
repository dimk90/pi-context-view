/**
 * `/context` command grammar, argument completions, and resolution of the
 * latest request snapshot that both views read.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import type { ConfigCreationResult } from "./config.ts";
import { MIN_PI_VERSION } from "./pi-version.ts";
import type { ProbeTrigger } from "./probe/trigger.ts";
import type { RequestSnapshot, SnapshotReader } from "./snapshot.ts";
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
	{ value: "injections", label: "injections", description: "Explore the latest request's injections" },
	{ value: "config", label: "config", description: "Create config file populated with defaults" },
] satisfies AutocompleteItem[];

/** The focused view a `/context` invocation requests. */
export type ContextView = "usage" | "injections";

/** Parsed `/context` argument grammar. */
export type ContextCommand =
	| { readonly type: "view"; readonly view: ContextView }
	| { readonly type: "config" }
	| { readonly type: "invalid"; readonly message: string };

/** The latest request snapshot, or why the view must degrade without one. */
export type RequestSnapshotResult =
	| { readonly type: "snapshot"; readonly snapshot: RequestSnapshot }
	| { readonly type: "missing"; readonly degradedReason: string };

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

/**
 * Obtain the latest request snapshot of this runtime, asking ProbeTrigger
 * only when the store has none after the agent is idle: a real turn that was
 * running publishes one without a probe. A probe's snapshot is read from the
 * store, not from the probe result.
 */
export async function resolveRequestSnapshot(
	snapshots: SnapshotReader,
	trigger: ProbeTrigger,
	context: ExtensionCommandContext,
): Promise<RequestSnapshotResult> {
	const existing = snapshots.latest();
	if (existing !== undefined) return { type: "snapshot", snapshot: existing };
	await context.waitForIdle();
	const afterIdle = snapshots.latest();
	if (afterIdle !== undefined) return { type: "snapshot", snapshot: afterIdle };

	const result = await trigger.request(context);
	const probed = snapshots.latest();
	if (probed !== undefined) return { type: "snapshot", snapshot: probed };
	const reason = result.status === "failed" ? result.reason : "Silent probe did not capture a request.";
	return { type: "missing", degradedReason: `${reason} Extension additions were not observed.` };
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

/**
 * Refuse a view while compaction is active: the session projection both views
 * read is about to be replaced, and a probe could not run safely anyway.
 */
export function reportCompactionInProgress(context: ExtensionCommandContext, view: ContextView): void {
	reportCommandMessage(context, `/context ${view} is unavailable while compaction is in progress.`, "warning");
}

/** Refuse any `/context` form on a Pi version whose lifecycle this extension does not capture. */
export function reportUnsupportedPi(context: ExtensionCommandContext, version: string): void {
	reportCommandMessage(context,
		`/context requires Pi ${MIN_PI_VERSION} or newer; this is Pi ${version}. Nothing was captured.`,
		"error",
	);
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
