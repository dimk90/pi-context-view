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
import {
	BODY_INDENT,
	calculateViewport,
	DEFAULT_TERMINAL_ROWS,
	fitLine,
	fitToTerminalHeight,
	hintRow,
	normalizeTerminalRows,
	spreadLine,
} from "./layout.ts";

const LIST_FIXED_LINE_COUNT = 13;
const PREVIEW_FIXED_LINE_COUNT = 8;
const LIST_DESCRIPTION = "Initial injections and estimated token counts.";

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
			const view = new InjectionsView(theme, input, done, () => tui.terminal.rows);
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
	private readonly getTerminalRows: () => number;
	private readonly rows: InjectionRow[];
	private readonly navigator: ListNavigator;
	private readonly itemsById: Map<string, InjectionItem>;
	private readonly previewScroller = new PreviewScroller();
	private previewItem: InjectionItem | undefined;
	private previewLines: string[] | undefined;
	private previewWrapWidth: number | undefined;
	private cachedWidth: number | undefined;
	private cachedTerminalRows: number | undefined;
	private cachedLines: string[] | undefined;

	public constructor(
		theme: Theme,
		input: InjectionsViewInput,
		done: (result: undefined) => void,
		getTerminalRows: () => number = () => process.stdout.rows ?? DEFAULT_TERMINAL_ROWS,
	) {
		this.theme = theme;
		this.input = input;
		this.done = done;
		this.getTerminalRows = getTerminalRows;
		this.rows = buildInjectionRows(input.snapshot);
		this.navigator = new ListNavigator(this.rows.length, 1);
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
		const terminalRows = normalizeTerminalRows(this.getTerminalRows());
		if (
			this.cachedLines !== undefined &&
			this.cachedWidth === width &&
			this.cachedTerminalRows === terminalRows
		) {
			return this.cachedLines;
		}
		if (this.previewItem !== undefined) {
			const lines = this.renderPreview(width, terminalRows, this.previewItem);
			this.cachedWidth = width;
			this.cachedTerminalRows = terminalRows;
			this.cachedLines = lines;
			return lines;
		}

		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const warningLines = this.degradedWarningLines(width);
		const viewport = calculateViewport(this.rows.length, terminalRows, LIST_FIXED_LINE_COUNT, warningLines.length);
		this.navigator.setVisibleCount(viewport.visibleCount);
		const lines: string[] = [border, ""];

		lines.push(this.headerLine(width));
		lines.push("");
		lines.push(this.initialHeaderLine(width));
		lines.push(...warningLines);
		const listLines = this.listLines(width);
		lines.push(...listLines);
		if (viewport.showScroll) lines.push(this.scrollLine(width));
		// Pad so the fixed TOTAL summary sits at the bottom of the scroll area.
		const paddingCount = viewport.visibleCount - listLines.length;
		for (let pad = 0; pad < paddingCount; pad++) lines.push("");
		// TOTAL is outside the scroll area and separated from the sections above.
		lines.push("");
		lines.push(this.totalLine(width));
		lines.push("");
		lines.push(this.fit(theme.fg("muted", `${BODY_INDENT}${LIST_DESCRIPTION}`), width));
		lines.push("");
		lines.push(
			this.fit(
				hintRow(this.theme, [
					["↑↓", "Navigate"],
					["Enter", "Preview"],
					["R", "Toggle Runtime Logging"],
					["Esc", "Close"],
				]),
				width,
			),
		);
		lines.push("", border);

		const fittedLines = fitToTerminalHeight(lines, terminalRows, border);
		this.cachedWidth = width;
		this.cachedTerminalRows = terminalRows;
		this.cachedLines = fittedLines;
		return fittedLines;
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
		if (row?.kind !== "item") return;
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

	private renderPreview(width: number, terminalRows: number, item: InjectionItem): string[] {
		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const wrapped = this.getPreviewLines(width, item);
		const viewport = calculateViewport(wrapped.length, terminalRows, PREVIEW_FIXED_LINE_COUNT);
		this.previewScroller.setExtent(wrapped.length, viewport.visibleCount);

		const lines: string[] = [border, ""];
		const title = theme.fg("accent", theme.bold(item.label));
		const meta = theme.fg("muted", `${item.source.label} · ${item.tokens.toLocaleString("en-US")} tokens `);
		lines.push(this.spread(title, meta, width));
		lines.push("");

		const start = this.previewScroller.offset;
		for (let index = start; index < start + viewport.visibleCount; index++) {
			lines.push(wrapped[index] ?? "");
		}

		if (viewport.showScroll) lines.push(this.previewScrollLine(width, wrapped.length));
		lines.push("");
		lines.push(
			this.fit(
				hintRow(this.theme, [
					["↑↓", "Scroll"],
					["PgUp/PgDn", "Page"],
					["Esc", "Back"],
				]),
				width,
			),
		);
		lines.push("", border);
		return fitToTerminalHeight(lines, terminalRows, border);
	}

	private getPreviewLines(width: number, item: InjectionItem): string[] {
		const wrapWidth = Math.max(10, width - BODY_INDENT.length - 1);
		if (this.previewLines !== undefined && this.previewWrapWidth === wrapWidth) return this.previewLines;
		const text = normalizePreviewText(item.text);
		const lines: string[] = [];
		for (const paragraph of text.split("\n")) {
			const wrapped = wrapTextWithAnsi(paragraph, wrapWidth);
			if (wrapped.length === 0) {
				lines.push("");
				continue;
			}
			for (const line of wrapped) lines.push(`${BODY_INDENT}${line}`);
		}
		this.previewLines = lines;
		this.previewWrapWidth = wrapWidth;
		return lines;
	}

	private previewScrollLine(width: number, totalLines: number): string {
		if (!this.previewScroller.hasOverflow) return this.fit("", width);
		return this.fit(
			this.theme.fg("dim", `${BODY_INDENT}(${this.previewScroller.offset + 1}/${totalLines})`),
			width,
		);
	}

	private headerLine(width: number): string {
		const theme = this.theme;
		const title = theme.fg("accent", theme.bold("Context Injections"));
		const enabled = this.input.runtime.isEnabled();
		const state = enabled ? theme.fg("accent", "On") : theme.fg("muted", "Off");
		const status = `${theme.fg("dim", "Runtime Logging:")} ${state} `;
		return this.spread(title, status, width);
	}

	/** The `INITIAL` sub-header, tagged with the capture origin only when degraded. */
	private initialHeaderLine(width: number): string {
		const theme = this.theme;
		const label = theme.fg("mdHeading", theme.bold("[INITIAL]"));
		if (this.input.degradedReason === undefined) return this.fit(label, width);
		const tag = `${theme.fg("dim", " [")}${theme.fg("error", "Degraded:")}` +
			`${theme.fg("dim", " pi-native fallback used]")}`;
		return this.fit(`${label}${tag}`, width);
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
			const marker = selected ? theme.fg("accent", "→ ") : BODY_INDENT;
			const indent = BODY_INDENT.repeat(row.depth);
			const valueColor = selected ? "accent" : "muted";
			const tokens = theme.fg(valueColor, row.tokens.toLocaleString("en-US"));
			const labelWidth = Math.max(8, width - indent.length - visibleWidth(tokens) - 6);
			const label = truncateToWidth(row.label, labelWidth, "…");
			lines.push(this.spread(`${marker}${indent}${this.rowLabel(row, label, selected)}`, `${tokens}  `, width));
		}
		return lines;
	}

	private rowLabel(row: InjectionRow, label: string, selected: boolean): string {
		const theme = this.theme;
		if (selected) return theme.fg("accent", label);
		if (row.kind === "group") return theme.bold(theme.fg("text", label));
		return theme.fg(row.depth > 1 ? "dim" : "muted", label);
	}

	/** Fixed TOTAL summary across all currently rendered sections. */
	private totalLine(width: number): string {
		const theme = this.theme;
		const label = theme.bold(theme.fg("text", "TOTAL"));
		const total = this.input.snapshot.totalTokens.toLocaleString("en-US");
		const tokens = theme.bold(theme.fg("text", total));
		return this.spread(`${BODY_INDENT}${label}`, `${tokens}  `, width);
	}

	private scrollLine(width: number): string {
		if (!this.navigator.hasOverflow) return this.fit("", width);
		return this.fit(
			this.theme.fg("dim", `${BODY_INDENT}(${this.navigator.selected + 1}/${this.rows.length})`),
			width,
		);
	}

	/** Wrapped degraded-capture warning placed after the first sub-header. */
	private degradedWarningLines(width: number): string[] {
		if (this.input.degradedReason === undefined) return [];
		return wrapTextWithAnsi(this.theme.fg("warning", `${BODY_INDENT}${this.input.degradedReason}`), width);
	}

	private spread(left: string, right: string, width: number): string {
		return spreadLine(left, right, width);
	}

	private fit(line: string, width: number): string {
		return fitLine(line, width);
	}

	private clearCache(): void {
		this.cachedWidth = undefined;
		this.cachedTerminalRows = undefined;
		this.cachedLines = undefined;
	}
}
