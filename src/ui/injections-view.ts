/**
 * Focused `/context injections` view: hierarchical Initial snapshot rows,
 * capture-origin metadata, and the Runtime logging toggle.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { InitialSnapshot, InjectionItem } from "../model.ts";
import {
	buildInjectionRows,
	collectItemsById,
	type InjectionRow,
	ListNavigator,
	normalizePreviewText,
	PreviewScroller,
} from "./injections-model.ts";

const LIST_FIXED_LINE_COUNT = 13;
const PREVIEW_FIXED_LINE_COUNT = 10;
const MIN_LIST_LINES = 4;
const LIST_DESCRIPTION = "Initial injections and estimated token counts.";
const PREVIEW_DESCRIPTION = "Raw captured text; never logged or persisted.";

/** Runtime-logging state owned by the extension factory closure. */
export interface RuntimeToggle {
	isEnabled(): boolean;
	setEnabled(enabled: boolean): void;
}

/** Everything the Injections view renders. */
export interface InjectionsViewInput {
	readonly snapshot: InitialSnapshot;
	readonly degradedReason?: string;
	readonly runtime: RuntimeToggle;
}

/** Open the Injections view as a fullscreen overlay. */
export async function showInjectionsView(
	context: ExtensionCommandContext,
	input: InjectionsViewInput,
): Promise<void> {
	await context.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const view = new InjectionsView(theme, input, done);
			return {
				render: (width: number) => view.render(width),
				invalidate: () => view.invalidate(),
				handleInput: (data: string) => {
					view.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
		},
	);
}

/** Exported for direct render/input tests; use showInjectionsView from pi code. */
export class InjectionsView {
	private readonly theme: Theme;
	private readonly input: InjectionsViewInput;
	private readonly done: (result: undefined) => void;
	private readonly rows: InjectionRow[];
	private readonly navigator: ListNavigator;
	private readonly itemsById: Map<string, InjectionItem>;
	private readonly previewScroller = new PreviewScroller();
	private previewItem: InjectionItem | undefined;
	private previewLines: string[] | undefined;
	private previewWrapWidth: number | undefined;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	public constructor(theme: Theme, input: InjectionsViewInput, done: (result: undefined) => void) {
		this.theme = theme;
		this.input = input;
		this.done = done;
		this.rows = buildInjectionRows(input.snapshot);
		this.navigator = new ListNavigator(this.rows.length, this.visibleRowCount());
		this.itemsById = collectItemsById(input.snapshot);
	}

	public handleInput(data: string): void {
		if (this.previewItem !== undefined) {
			this.handlePreviewInput(data);
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
			return;
		}
		if (data === "r") {
			this.input.runtime.setEnabled(!this.input.runtime.isEnabled());
			this.clearCache();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.openPreview();
		} else if (matchesKey(data, Key.up)) {
			if (this.navigator.moveBy(-1)) this.clearCache();
		} else if (matchesKey(data, Key.down)) {
			if (this.navigator.moveBy(1)) this.clearCache();
		} else if (matchesKey(data, Key.pageUp)) {
			if (this.navigator.page(-1)) this.clearCache();
		} else if (matchesKey(data, Key.pageDown)) {
			if (this.navigator.page(1)) this.clearCache();
		} else if (matchesKey(data, Key.home)) {
			if (this.navigator.moveTo(0)) this.clearCache();
		} else if (matchesKey(data, Key.end)) {
			if (this.navigator.moveTo(this.rows.length - 1)) this.clearCache();
		}
	}

	public render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;
		if (this.previewItem !== undefined) {
			const lines = this.renderPreview(width, this.previewItem);
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const warningLines = this.degradedWarningLines(width);
		const visibleRowCount = this.visibleRowCount(warningLines.length);
		this.navigator.setVisibleCount(visibleRowCount);
		const lines: string[] = [border, ""];

		lines.push(this.headerLine(width));
		lines.push("");
		lines.push(this.fit(theme.fg("dim", ` ${"INITIAL"}`), width));
		lines.push(...warningLines);
		const listLines = this.listLines(width);
		const paddingCount = visibleRowCount - listLines.length;
		if (paddingCount > 0 && listLines.length > 0) {
			// Keep TOTAL adjacent to the next section; spare fullscreen rows belong
			// inside the Initial section, before its summary.
			lines.push(...listLines.slice(0, -1));
			for (let pad = 0; pad < paddingCount; pad++) lines.push("");
			lines.push(listLines[listLines.length - 1] ?? "");
		} else {
			lines.push(...listLines);
		}
		if (this.navigator.hasOverflow) lines.push(this.scrollLine(width));
		lines.push("");
		lines.push(this.runtimeLine(width));
		lines.push("");
		lines.push(this.fit(theme.fg("muted", ` ${LIST_DESCRIPTION}`), width));
		lines.push("");
		lines.push(
			this.fit(
				` ${this.hint("↑↓", "navigate")}  ${this.hint("enter", "preview")}  ` +
					`${this.hint("r", "logging")}  ${this.hint("esc", "close")}`,
				width,
			),
		);
		lines.push("", border);

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	public invalidate(): void {
		this.clearCache();
	}

	// === Preview mode ===

	private handlePreviewInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.closePreview();
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.previewScroller.scrollBy(-1)) this.clearCache();
		} else if (matchesKey(data, Key.down)) {
			if (this.previewScroller.scrollBy(1)) this.clearCache();
		} else if (matchesKey(data, Key.pageUp)) {
			if (this.previewScroller.page(-1)) this.clearCache();
		} else if (matchesKey(data, Key.pageDown)) {
			if (this.previewScroller.page(1)) this.clearCache();
		} else if (matchesKey(data, Key.home)) {
			if (this.previewScroller.scrollTo(0)) this.clearCache();
		} else if (matchesKey(data, Key.end)) {
			if (this.previewScroller.scrollTo(this.previewScroller.maxOffset)) this.clearCache();
		}
	}

	private openPreview(): void {
		const row = this.rows[this.navigator.selected];
		if (row?.itemId === undefined) return;
		const item = this.itemsById.get(row.itemId);
		if (item === undefined) return;
		this.previewItem = item;
		this.previewLines = undefined;
		this.previewWrapWidth = undefined;
		this.previewScroller.reset();
		this.clearCache();
	}

	private closePreview(): void {
		this.previewItem = undefined;
		this.previewLines = undefined;
		this.previewWrapWidth = undefined;
		this.clearCache();
	}

	private renderPreview(width: number, item: InjectionItem): string[] {
		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const wrapped = this.getPreviewLines(width, item);
		const visibleCount = this.previewVisibleCount(wrapped.length);
		this.previewScroller.setExtent(wrapped.length, visibleCount);

		const lines: string[] = [border, ""];
		const title = theme.fg("accent", theme.bold(` ${item.label}`));
		const meta = theme.fg("muted", `${item.source.label} · ${item.tokens.toLocaleString("en-US")} tokens `);
		lines.push(this.spread(title, meta, width));
		lines.push("");

		const start = this.previewScroller.offset;
		for (let index = start; index < start + visibleCount; index++) {
			lines.push(wrapped[index] ?? "");
		}

		if (this.previewScroller.hasOverflow) lines.push(this.previewScrollLine(width, wrapped.length));
		lines.push("");
		lines.push(this.fit(theme.fg("muted", ` ${PREVIEW_DESCRIPTION}`), width));
		lines.push("");
		lines.push(
			this.fit(
				` ${this.hint("↑↓", "scroll")}  ${this.hint("pgup/pgdn", "page")}  ${this.hint("esc", "back")}`,
				width,
			),
		);
		lines.push("", border);
		return lines;
	}

	private getPreviewLines(width: number, item: InjectionItem): string[] {
		const wrapWidth = Math.max(10, width - 2);
		if (this.previewLines !== undefined && this.previewWrapWidth === wrapWidth) return this.previewLines;
		const text = normalizePreviewText(item.text);
		const lines: string[] = [];
		for (const paragraph of text.split("\n")) {
			const wrapped = wrapTextWithAnsi(paragraph, wrapWidth);
			if (wrapped.length === 0) {
				lines.push("");
				continue;
			}
			for (const line of wrapped) lines.push(` ${line}`);
		}
		this.previewLines = lines;
		this.previewWrapWidth = wrapWidth;
		return lines;
	}

	private previewScrollLine(width: number, totalLines: number): string {
		if (!this.previewScroller.hasOverflow) return this.fit("", width);
		return this.fit(this.theme.fg("dim", ` (${this.previewScroller.offset + 1}/${totalLines})`), width);
	}

	/** Number of preview text lines that fit, reserving one row only when scrolling. */
	private previewVisibleCount(totalLines: number): number {
		const terminalRows = process.stdout.rows ?? 24;
		const available = Math.max(MIN_LIST_LINES, terminalRows - PREVIEW_FIXED_LINE_COUNT);
		return totalLines > available ? Math.max(MIN_LIST_LINES, available - 1) : available;
	}

	private headerLine(width: number): string {
		const theme = this.theme;
		const title = theme.fg("accent", theme.bold(" Context injections"));
		const origin = this.input.degradedReason === undefined
			? this.input.snapshot.origin === "real-turn" ? "captured: first real turn" : "captured: silent probe"
			: "captured: pi-native fallback";
		return this.spread(title, theme.fg("muted", `${origin} `), width);
	}

	private listLines(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		const start = this.navigator.offset;
		const end = start + this.navigator.windowSize;
		for (let index = start; index < end; index++) {
			const row = this.rows[index];
			if (row === undefined) break;
			const selected = index === this.navigator.selected;
			// The cursor stays in one fixed column; hierarchy indents after it.
			const marker = selected ? theme.fg("accent", "→ ") : "  ";
			const indent = "  ".repeat(row.depth);
			const valueColor = selected ? "accent" : "muted";
			const tokens = theme.fg(valueColor, row.tokens.toLocaleString("en-US"));
			const labelWidth = Math.max(8, width - indent.length - visibleWidth(tokens) - 6);
			const label = truncateToWidth(row.label, labelWidth, "…");
			lines.push(this.spread(` ${marker}${indent}${this.rowLabel(row, label, selected)}`, `${tokens}  `, width));
		}
		return lines;
	}

	private rowLabel(row: InjectionRow, label: string, selected: boolean): string {
		const theme = this.theme;
		if (selected) return theme.fg("accent", label);
		if (row.kind === "total") return theme.bold(theme.fg("text", label));
		if (row.kind === "group") return theme.bold(theme.fg("text", label));
		return theme.fg(row.depth > 1 ? "dim" : "muted", label);
	}

	private scrollLine(width: number): string {
		if (!this.navigator.hasOverflow) return this.fit("", width);
		return this.fit(this.theme.fg("dim", ` (${this.navigator.selected + 1}/${this.rows.length})`), width);
	}

	private runtimeLine(width: number): string {
		const theme = this.theme;
		const enabled = this.input.runtime.isEnabled();
		const status = theme.fg("muted", enabled ? "logging: on" : "logging: off");
		return this.spread(theme.fg("dim", " RUNTIME"), `${status} `, width);
	}

	/** Pi-style hint: dim key, slightly brighter (muted) description. */
	private hint(key: string, description: string): string {
		return this.theme.fg("dim", key) + this.theme.fg("muted", ` ${description}`);
	}

	/** Number of list rows that fit after warnings and an optional scroll indicator. */
	private visibleRowCount(extraLineCount = 0): number {
		const terminalRows = process.stdout.rows ?? 24;
		const available = Math.max(MIN_LIST_LINES, terminalRows - LIST_FIXED_LINE_COUNT - extraLineCount);
		return this.rows.length > available ? Math.max(MIN_LIST_LINES, available - 1) : available;
	}

	/** Wrapped degraded-capture warning placed after the first sub-header. */
	private degradedWarningLines(width: number): string[] {
		if (this.input.degradedReason === undefined) return [];
		return wrapTextWithAnsi(this.theme.fg("warning", ` ${this.input.degradedReason}`), width);
	}

	private spread(left: string, right: string, width: number): string {
		const gap = width - visibleWidth(left) - visibleWidth(right);
		if (gap < 1) {
			return this.fit(`${truncateToWidth(left, Math.max(1, width - visibleWidth(right) - 2), "…")} ${right}`, width);
		}
		return `${left}${" ".repeat(gap)}${right}`;
	}

	private fit(line: string, width: number): string {
		return truncateToWidth(line, width, "…");
	}

	private clearCache(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
