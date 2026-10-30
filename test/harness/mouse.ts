/** Normalized mouse events, shaped like the ones fullscreen pi passes to an overlay's `handleMouse`. */
import type { TuiMouseEvent, TuiMouseEventType } from "@earendil-works/pi-tui";

/** One mouse event of `type` over a fullscreen 80x24 overlay, with no modifier held. */
export function mouseEvent(type: TuiMouseEventType, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type,
		button: "none",
		x: 20,
		y: 5,
		screenX: 20,
		screenY: 5,
		width: 80,
		height: 24,
		shift: false,
		alt: false,
		ctrl: false,
		...extra,
	};
}

/** One wheel notch; pi reports `wheelDelta` in lines, negative scrolling up. */
export function wheelEvent(wheelDelta: number): TuiMouseEvent {
	return mouseEvent("wheel", { wheelDelta });
}
