/**
 * Clipboard payload and confirmation helpers shared by the Usage and Injections
 * views. The copied text is the captured content itself: terminal control
 * sequences are stripped, while tabs, spacing, and characters are kept; only
 * preview-added wrapping, gutters, subheaders, and JSON expansion stay out.
 */
import { copyToClipboard, type Theme } from "@earendil-works/pi-coding-agent";

import { normalizeInlineText, normalizeMultilineText } from "../text.ts";
import { BODY_INDENT, fitLine, type Hint } from "./layout.ts";

/** Hint-row entry advertising the copy action; it is optional, so narrow rows drop it whole. */
export const COPY_HINT: Hint = ["c", "Copy", true];
/** Splits copied text into graphemes, the characters a user sees. */
const SEGMENTER = new Intl.Segmenter();

/** Clipboard writer injected by the host, or stubbed by a test. */
export type CopyText = (text: string) => Promise<void>;

/** View hooks around a copy: how text reaches the clipboard and how to redraw its confirmation. */
export interface CopyActions {
	/** Clipboard writer; defaults to pi's `copyToClipboard`. */
	readonly copyText?: CopyText;
	/** Request a redraw after an asynchronous clipboard result. */
	readonly refresh?: () => void;
}

/** One line of copy confirmation or failure feedback. */
export interface CopyNotice {
	readonly text: string;
	readonly kind: "pending" | "success" | "error";
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
	return { text: `Copied ${countCharacters(text).toLocaleString("en-US")} chars`, kind: "success" };
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

/**
 * Copy confirmation shared by both views. One write is pending at a time and
 * only the newest request publishes a result, so a cleared notice stays
 * cleared and two quick copies cannot land out of order.
 */
export class CopyNotices {
	private readonly copyText: CopyText;
	private readonly refresh: () => void;
	private sequence = 0;
	private disposed = false;
	private notice: CopyNotice | undefined;

	public constructor(copyText: CopyText = copyToClipboard, refresh: () => void = () => {}) {
		this.copyText = copyText;
		this.refresh = refresh;
	}

	/** Latest confirmation, for exact-state decisions and tests. */
	public get current(): CopyNotice | undefined {
		return this.notice;
	}

	/** Drop the last confirmation before the next key; an in-flight write must not restore it. */
	public clear(): void {
		this.sequence++;
		if (this.notice === undefined) return;
		this.notice = undefined;
		this.refresh();
	}

	/** Stop publishing results and refuse later copies, e.g. when the overlay closes. */
	public dispose(): void {
		this.disposed = true;
		this.sequence++;
	}

	/** Write one payload; only the newest request may publish its result. */
	public copy(text: string): void {
		if (this.disposed) return;
		const sequence = ++this.sequence;
		if (text.length === 0) {
			this.notice = { text: "Nothing to copy", kind: "error" };
			this.refresh();
			return;
		}
		this.notice = { text: "Copying…", kind: "pending" };
		this.refresh();
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

	/** Footer spacer row carrying the latest confirmation; empty while there is none. */
	public line(theme: Theme, width: number): string {
		if (this.notice === undefined) return "";
		const color = this.notice.kind === "error"
			? "error"
			: this.notice.kind === "success" ? "success" : "muted";
		return fitLine(theme.fg(color, `${BODY_INDENT}${normalizeInlineText(this.notice.text)}`), width);
	}

	/** Publish a result only while its request is still the newest one. */
	private settle(sequence: number, notice: CopyNotice): void {
		if (sequence !== this.sequence) return;
		this.notice = notice;
		this.refresh();
	}
}
