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

const OVERLAY_MIN_COLUMNS = 70;
const OVERLAY_WIDTH = 66;
const CHROME_LINE_COUNT = 8;
const MIN_LIST_LINES = 4;

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

/** Open the Injections view as an overlay, or full-width on narrow terminals. */
export async function showInjectionsView(
	context: ExtensionCommandContext,
	input: InjectionsViewInput,
): Promise<void> {
	const useOverlay = (process.stdout.columns ?? 0) >= OVERLAY_MIN_COLUMNS;
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
		useOverlay
			? {
					overlay: true,
					overlayOptions: { width: OVERLAY_WIDTH, minWidth: 40, maxHeight: "80%", margin: 1 },
				}
			: undefined,
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
		} else if (matchesKey(data, Key.up) || data === "k") {
			if (this.navigator.moveBy(-1)) this.clearCache();
		} else if (matchesKey(data, Key.down) || data === "j") {
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

		this.navigator.setVisibleCount(this.visibleRowCount());
		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const lines: string[] = [border];

		lines.push(this.headerLine(width));
		if (this.input.degradedReason !== undefined) {
			lines.push(...wrapTextWithAnsi(theme.fg("warning", ` ${this.input.degradedReason}`), width));
		}
		lines.push(this.fit(theme.fg("dim", ` ${"INITIAL"}`), width));
		lines.push(...this.listLines(width));
		lines.push(this.scrollLine(width));
		lines.push(this.runtimeLine(width));
		lines.push(this.fit(theme.fg("dim", " ↑/↓ j/k select · Enter preview · r logging · Esc close"), width));
		lines.push(border);

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
		if (matchesKey(data, Key.up) || data === "k") {
			if (this.previewScroller.scrollBy(-1)) this.clearCache();
		} else if (matchesKey(data, Key.down) || data === "j") {
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
		const visibleCount = Math.max(MIN_LIST_LINES, this.previewChromeBudget());
		this.previewScroller.setExtent(wrapped.length, visibleCount);

		const lines: string[] = [border];
		const title = theme.fg("accent", theme.bold(` ${item.label}`));
		const meta = `${item.source.label} · ${item.tokens.toLocaleString("en-US")} tokens `;
		lines.push(this.spread(title, theme.fg("muted", meta), width));

		const start = this.previewScroller.offset;
		const end = start + this.previewScroller.windowSize;
		for (let index = start; index < end; index++) {
			lines.push(wrapped[index] ?? "");
		}

		lines.push(this.previewScrollLine(width, wrapped.length));
		lines.push(this.fit(theme.fg("dim", " ↑/↓ j/k scroll · PgUp/PgDn · Esc back"), width));
		lines.push(border);
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
		const first = this.previewScroller.offset + 1;
		const last = this.previewScroller.offset + this.previewScroller.windowSize;
		return this.fit(this.theme.fg("dim", ` ${first}–${last} of ${totalLines} lines`), width);
	}

	private previewChromeBudget(): number {
		const terminalRows = process.stdout.rows ?? 24;
		return Math.floor(terminalRows * 0.8) - 5;
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
			const marker = selected ? theme.fg("accent", "▶ ") : "  ";
			const indent = "  ".repeat(row.depth + 1);
			const tokens = row.tokens.toLocaleString("en-US");
			const labelWidth = Math.max(8, width - visibleWidth(indent) - tokens.length - 4);
			const label = truncateToWidth(row.label, labelWidth, "…");
			const line = this.spread(`${indent}${marker}${this.rowLabel(row, label, selected)}`, `${tokens}  `, width);
			lines.push(selected ? theme.bg("selectedBg", line) : line);
		}
		return lines;
	}

	private rowLabel(row: InjectionRow, label: string, selected: boolean): string {
		const theme = this.theme;
		if (row.kind === "total") return theme.bold(label);
		if (row.kind === "group") {
			return theme.bold(theme.fg(row.native ? "accent" : "text", label));
		}
		return selected ? label : theme.fg("muted", label);
	}

	private scrollLine(width: number): string {
		if (!this.navigator.hasOverflow) return this.fit("", width);
		const first = this.navigator.offset + 1;
		const last = this.navigator.offset + this.navigator.windowSize;
		return this.fit(this.theme.fg("dim", ` ${first}–${last} of ${this.rows.length}`), width);
	}

	private runtimeLine(width: number): string {
		const theme = this.theme;
		const enabled = this.input.runtime.isEnabled();
		const status = enabled
			? theme.fg("success", "logging: on")
			: theme.fg("muted", "logging: off");
		return this.spread(theme.fg("dim", " RUNTIME"), `${status} `, width);
	}

	private visibleRowCount(): number {
		const terminalRows = process.stdout.rows ?? 24;
		const budget = Math.floor(terminalRows * 0.8) - CHROME_LINE_COUNT;
		return Math.max(MIN_LIST_LINES, Math.min(this.rows.length, budget));
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
