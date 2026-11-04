/**
 * Fullscreen overlay host shared by the Usage and Injections views: wraps a view
 * in the component Pi's `ctx.ui.custom()` renders and reports whether the host
 * called the factory.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import type { CopyActions } from "./copy.ts";

/** What the overlay forwards to a view. */
export interface OverlayView {
	render(width: number): string[];
	invalidate(): void;
	dispose(): void;
	handleInput(data: string): void;
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

/** Builds a view from the host's theme, close callback, terminal height, and redraw hook. */
export type CreateOverlayView = (
	theme: Theme,
	done: (result: undefined) => void,
	getTerminalRows: () => number,
	actions: CopyActions,
) => OverlayView;

/**
 * Show a view as a fullscreen overlay until it closes. Resolves `false` when the
 * host never called the factory: Pi's RPC mode returns from `custom()` without a view.
 */
export async function showOverlayView(context: ExtensionCommandContext, createView: CreateOverlayView): Promise<boolean> {
	let opened = false;
	await context.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			opened = true;
			const view = createView(theme, done, () => tui.terminal.rows, {
				refresh: () => tui.requestRender(),
			});
			return {
				render: (width: number) => view.render(width),
				invalidate: () => view.invalidate(),
				dispose: () => view.dispose(),
				handleInput: (data: string) => {
					view.handleInput(data);
					tui.requestRender();
				},
				handleMouse: (event: TuiMouseEvent) => view.handleMouse(event),
			};
		},
		{
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
		},
	);

	return opened;
}
