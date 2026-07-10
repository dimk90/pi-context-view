import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	Container,
	matchesKey,
	Text,
} from "@earendil-works/pi-tui";

import {
	buildNativeFallbackSnapshot,
	type InitialCaptureState,
	type SilentProbeState,
} from "./capture.ts";
import type { InitialSnapshot } from "./model.ts";

const COMMAND_USAGE = "Usage: /context [usage|injections|runtime on|runtime off]";
const ARGUMENT_OPTIONS = [
	{ value: "usage", label: "usage", description: "Show estimated context usage" },
	{ value: "injections", label: "injections", description: "Explore initial and runtime injections" },
	{ value: "runtime on", label: "runtime on", description: "Enable future runtime injection logging" },
	{ value: "runtime off", label: "runtime off", description: "Disable runtime injection logging" },
] satisfies AutocompleteItem[];

export type ContextView = "usage" | "injections";

/** Parsed `/context` argument grammar. */
export type ContextCommand =
	| { readonly type: "view"; readonly view: ContextView }
	| { readonly type: "runtime"; readonly enabled: boolean }
	| { readonly type: "invalid"; readonly message: string };

/** Data shown by the temporary step-3 capture confirmation view. */
export interface CapturePlaceholder {
	readonly snapshot: InitialSnapshot;
	readonly degradedReason?: string;
}

/** Parse the complete, intentionally small `/context` argument grammar. */
export function parseContextCommand(argumentsText: string): ContextCommand {
	const words = argumentsText.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0 || (words.length === 1 && words[0] === "usage")) {
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
): Promise<CapturePlaceholder> {
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

/** Render a minimal capture confirmation until the full focused views land. */
export async function showCapturePlaceholder(
	context: ExtensionCommandContext,
	view: ContextView,
	capture: CapturePlaceholder,
): Promise<void> {
	await context.ui.custom<void>(
		(_tui, theme, _keybindings, done) => {
			let container = createPlaceholderContainer(theme, view, capture);
			return {
				render: (width: number) => container.render(width),
				invalidate: () => {
					container = createPlaceholderContainer(theme, view, capture);
				},
				handleInput: (data: string) => {
					if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") {
						done(undefined);
					}
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				width: 62,
				minWidth: 36,
				maxHeight: "70%",
				margin: 1,
			},
		},
	);
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

function getProbeUnavailableReason(context: ExtensionCommandContext): string | undefined {
	if (context.model === undefined) return "Silent probe unavailable: no model is selected.";
	if (!context.modelRegistry.hasConfiguredAuth(context.model)) {
		return `Silent probe unavailable: ${context.model.provider} has no configured authentication.`;
	}
	return undefined;
}

function createFallback(
	pi: ExtensionAPI,
	context: ExtensionCommandContext,
	reason: string,
): CapturePlaceholder {
	return {
		snapshot: buildNativeFallbackSnapshot({
			systemPrompt: context.getSystemPrompt(),
			options: context.getSystemPromptOptions(),
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
		}),
		degradedReason: `${reason} Extension additions were not observed.`,
	};
}

function createPlaceholderContainer(
	theme: Theme,
	view: ContextView,
	capture: CapturePlaceholder,
): Container {
	const container = new Container();
	const title = view === "usage" ? "Context usage" : "Context injections";
	const origin = formatCaptureOrigin(capture);
	const detail = view === "usage"
		? "The full Usage composition view is not implemented yet."
		: "The full Injections explorer is not implemented yet.";

	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	container.addChild(new Text(theme.fg("success", "Initial capture ready."), 1, 1));
	container.addChild(new Text(`Origin: ${origin}`, 1, 0));
	container.addChild(new Text(`Groups: ${capture.snapshot.groups.length}`, 1, 0));
	container.addChild(new Text(`Estimated tokens: ${capture.snapshot.totalTokens.toLocaleString("en-US")}`, 1, 0));
	if (capture.degradedReason !== undefined) {
		container.addChild(new Text(theme.fg("warning", capture.degradedReason), 1, 1));
	}
	container.addChild(new Text(theme.fg("muted", detail), 1, 1));
	container.addChild(new Text(theme.fg("dim", "Enter/Esc close"), 1, 0));
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	return container;
}

function formatCaptureOrigin(capture: CapturePlaceholder): string {
	if (capture.degradedReason !== undefined) return "pi-native fallback";
	return capture.snapshot.origin === "real-turn" ? "first real turn" : "silent probe";
}
