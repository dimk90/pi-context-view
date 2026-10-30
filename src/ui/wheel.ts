/**
 * Mouse-wheel step shared by the Usage and Injections views.
 *
 * Pi enables mouse reporting only in fullscreen (alt-screen) mode, where it
 * parses wheel reports and passes them to the focused overlay's `handleMouse`.
 * In regular mode the terminal keeps the wheel for its own scrollback and no
 * wheel event ever reaches a view.
 */
import type { TUI } from "@earendil-works/pi-tui";

/** Lines one notch scrolls when the TUI exposes no step of its own. */
export const DEFAULT_WHEEL_SCROLL_LINES = 3;

/**
 * Lines one notch scrolls in the surrounding TUI.
 *
 * `TuiAltScreen` keeps its `wheelScrollLines` option private and pi never
 * surfaces it, so read it defensively: honoring the real step keeps previews
 * consistent with the transcript viewport, while any pi that hides, renames, or
 * never had the field falls back to the default instead of a contradicting step.
 */
export function readWheelScrollLines(tui: TUI): number {
	const lines = (tui as { readonly wheelScrollLines?: unknown }).wheelScrollLines;
	if (typeof lines !== "number" || !Number.isFinite(lines)) return DEFAULT_WHEEL_SCROLL_LINES;
	return Math.max(1, Math.floor(lines));
}
