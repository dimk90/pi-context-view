/**
 * Pi UI context for runtime tests. Capture and both views need `ctx.hasUI`,
 * which Pi reports only for a session bound with a `uiContext`; a view opens
 * only when the host calls its `custom()` factory, as Pi's TUI does.
 */
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";

/** What a command passes to `ctx.ui.custom()` to open a view. */
export type ViewFactory = Parameters<ExtensionUIContext["custom"]>[0];

/** Leaves text unstyled, so rendered views read as plain lines. */
export const PLAIN_THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

/** Build a view's component the way Pi's TUI does: 60 terminal rows, the plain theme, a no-op `done`. */
export function createView(factory: ViewFactory): ReturnType<ViewFactory> {
	const tui = { terminal: { rows: 60 }, requestRender: () => undefined } as unknown as Parameters<ViewFactory>[0];
	return factory(tui, PLAIN_THEME, undefined as unknown as Parameters<ViewFactory>[2], () => undefined);
}

/**
 * UI context whose `custom()` builds the view and closes it at once, as a TUI
 * user pressing Escape would. `overrides` replace single methods, loosely typed
 * like the rest of this partial stand-in.
 */
export function createUiContext(
	overrides: Partial<Record<keyof ExtensionUIContext, unknown>> = {},
): ExtensionUIContext {
	return {
		setWorkingVisible: () => undefined,
		notify: () => undefined,
		custom: async (factory: ViewFactory) => {
			await createView(factory);
		},
		...overrides,
	} as unknown as ExtensionUIContext;
}
