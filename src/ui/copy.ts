/**
 * Clipboard payload and confirmation helpers shared by the Usage and Injections
 * views. The copied text is the captured content itself: terminal control
 * sequences are stripped, while tabs, spacing, and characters are kept; only
 * preview-added wrapping, gutters, subheaders, and JSON expansion stay out.
 */
import { copyToClipboard, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { normalizeInlineText, normalizeMultilineText } from "../text.ts";
import { fitLine, type Hint } from "./layout.ts";

/** Hint-row entry advertising the copy action; it is optional, so narrow rows drop it whole. */
export const COPY_HINT: Hint = ["c", "Copy", true];
/** Splits copied text into graphemes, the characters a user sees. */
const SEGMENTER = new Intl.Segmenter();
/** How long a notice stays on the top border, by kind; errors stay longer to be read. */
const NOTICE_DURATION_MS: Record<CopyNotice["kind"], number> = { success: 3_000, error: 5_000 };
/** Border cells kept to the right of a notice, so it reads as a label on the border. */
const NOTICE_TAIL_WIDTH = 3;
/** Cells around a notice's text: one leading border cell, ` [ `, ` ] `, and the tail. */
const NOTICE_FRAME_WIDTH = 1 + 3 + 3 + NOTICE_TAIL_WIDTH;
/** Narrowest text a notice keeps before the border drops it. */
const MIN_NOTICE_TEXT_WIDTH = 4;

/** Clipboard writer injected by the host, or stubbed by a test. */
export type CopyText = (text: string) => Promise<void>;

/** Run `callback` once after `milliseconds`; the returned function cancels it. */
export type ScheduleTimeout = (callback: () => void, milliseconds: number) => () => void;

/** View hooks around a copy: how text reaches the clipboard and how to redraw its confirmation. */
export interface CopyActions {
	/** Clipboard writer; defaults to pi's `copyToClipboard`. */
	readonly copyText?: CopyText;
	/** Request a redraw after a notice appears or expires. */
	readonly refresh?: () => void;
	/** Timer that expires a notice; defaults to an unref'd `setTimeout`. */
	readonly schedule?: ScheduleTimeout;
}

/** One copy confirmation or failure, shown on the view's top border until it expires. */
export interface CopyNotice {
	readonly text: string;
	readonly kind: "success" | "error";
}

/** Clean captured text for the clipboard without changing tabs, spacing, or characters. */
export function copyableText(text: string): string {
	return normalizeMultilineText(text).replace(/^\n+/, "").trimEnd();
}

/** Join several captured texts with one blank line, dropping empty pieces. */
export function copyableJoin(texts: Iterable<string>): string {
	return [...texts]
		.map(copyableText)
		.filter((text) => text.length > 0)
		.join("\n\n");
}

/** Short, human-readable confirmation of how much text reached the clipboard. */
export function copiedNotice(text: string): CopyNotice {
	return { text: `Copied: ${countCharacters(text).toLocaleString("en-US")} chars`, kind: "success" };
}

/** Count user-visible characters, so an emoji or a combined accent counts once. */
function countCharacters(text: string): number {
	let count = 0;
	for (const _segment of SEGMENTER.segment(text)) count++;
	return count;
}

/** Failure feedback for a clipboard write, with any terminal control text removed. */
export function copyFailureNotice(error: unknown): CopyNotice {
	const message = error instanceof Error ? error.message : String(error);
	return { text: `Copy failed: ${normalizeInlineText(message)}`, kind: "error" };
}

/** Default notice timer; unref'd so a visible notice never keeps the process alive. */
function scheduleTimeout(callback: () => void, milliseconds: number): () => void {
	const timer = setTimeout(callback, milliseconds);
	timer.unref();
	return () => clearTimeout(timer);
}

/**
 * Copy confirmation shared by both views, timed like pi's fullscreen flash:
 * the result appears when the write settles and expires after a fixed time,
 * not on the next key. Only the newest request publishes a result, so two
 * quick copies cannot land out of order.
 */
export class CopyNotices {
	private readonly copyText: CopyText;
	private readonly refresh: () => void;
	private readonly schedule: ScheduleTimeout;
	private sequence = 0;
	private disposed = false;
	private notice: CopyNotice | undefined;
	private cancelExpiry: (() => void) | undefined;

	public constructor(actions: CopyActions = {}) {
		this.copyText = actions.copyText ?? copyToClipboard;
		this.refresh = actions.refresh ?? (() => {});
		this.schedule = actions.schedule ?? scheduleTimeout;
	}

	/** Latest confirmation, for exact-state decisions and tests. */
	public get current(): CopyNotice | undefined {
		return this.notice;
	}

	/** Stop publishing results, cancel the expiry timer, and refuse later copies, e.g. when the overlay closes. */
	public dispose(): void {
		this.disposed = true;
		this.sequence++;
		this.cancelExpiry?.();
		this.cancelExpiry = undefined;
	}

	/** Write one payload; only the newest request may publish its result. */
	public copy(text: string): void {
		if (this.disposed) return;
		const sequence = ++this.sequence;
		if (text.length === 0) {
			this.show({ text: "Nothing to copy", kind: "error" });
			return;
		}
		let write: Promise<void>;
		try {
			write = this.copyText(text);
		} catch (error) {
			this.settle(sequence, copyFailureNotice(error));
			return;
		}
		void write.then(
			() => this.settle(sequence, copiedNotice(text)),
			(error: unknown) => this.settle(sequence, copyFailureNotice(error)),
		);
	}

	/**
	 * The view's top border, carrying the current notice as a label near its
	 * right end: `──── [ Copied: 11 chars ] ───`, with the text in the dim color.
	 * A plain border while there is no notice or too little width for a
	 * readable one.
	 */
	public topBorder(theme: Theme, width: number): string {
		const borderWidth = Math.max(1, width);
		const textWidth = borderWidth - NOTICE_FRAME_WIDTH;
		if (this.notice === undefined || textWidth < MIN_NOTICE_TEXT_WIDTH) {
			return theme.fg("border", "─".repeat(borderWidth));
		}
		const text = fitLine(normalizeInlineText(this.notice.text), textWidth);
		const leadWidth = borderWidth - visibleWidth(text) - NOTICE_FRAME_WIDTH + 1;
		return theme.fg("border", `${"─".repeat(leadWidth)} [ `) +
			theme.fg("dim", text) +
			theme.fg("border", ` ] ${"─".repeat(NOTICE_TAIL_WIDTH)}`);
	}

	/** Publish a result only while its request is still the newest one. */
	private settle(sequence: number, notice: CopyNotice): void {
		if (sequence !== this.sequence) return;
		this.show(notice);
	}

	/** Replace the current notice and restart its expiry timer. */
	private show(notice: CopyNotice): void {
		this.cancelExpiry?.();
		this.notice = notice;
		this.cancelExpiry = this.schedule(() => {
			this.cancelExpiry = undefined;
			if (this.notice !== notice) return;
			this.notice = undefined;
			this.refresh();
		}, NOTICE_DURATION_MS[notice.kind]);
		this.refresh();
	}
}
