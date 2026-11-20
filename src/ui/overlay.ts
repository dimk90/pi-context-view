/**
 * Fullscreen overlay host shared by the Usage and Injections views: wraps a view
 * in the component Pi's `ctx.ui.custom()` renders, gives its content side
 * padding inside full-width borders, and reports whether the host called the
 * factory.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import type { CopyActions } from "./copy.ts";
import { framePadding, padFrame } from "./layout.ts";

/** What the overlay forwards to a view. */
export interface OverlayView {
	/** The frame for a content width; its first and last rows are the borders. */
	render(width: number): string[];
	/** The top border for the full width, carrying the view's copy notice. */
	topBorder(width: number): string;
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
export async function showOverlayView(
	context: ExtensionCommandContext,
	createView: CreateOverlayView,
): Promise<boolean> {
	let opened = false;
	await context.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			opened = true;
			const view = createView(theme, done, () => tui.terminal.rows, {
				refresh: () => tui.requestRender(),
			});

			return {
				render: (width: number) => renderPadded(view, theme, width),
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

/**
 * Render the view at the content width left between the side padding, then
 * stretch its borders back across the full width.
 */
export function renderPadded(view: OverlayView, theme: Theme, width: number): string[] {
	const padding = framePadding(width);
	const border = theme.fg("border", "─".repeat(Math.max(1, width)));

	return padFrame(view.render(width - 2 * padding), padding, view.topBorder(width), border);
}
