/**
 * Focused `/context injections` view: hierarchical Initial snapshot rows and
 * a disabled Runtime roadmap label.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { InitialSnapshot, InjectionItem } from "../model.ts";
import {
	buildInjectionRows,
	collectItemsById,
	type InjectionRow,
	ListNavigator,
	normalizeInlineText,
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
	wrapDescriptionLines,
} from "./layout.ts";

const LIST_FIXED_LINE_COUNT = 10;
const PREVIEW_FIXED_LINE_COUNT = 8;
const LIST_DESCRIPTION = "Injections into the model context for the first turn, with token estimates.";
const CURSOR_COLUMN_WIDTH = 2;
const MAX_TOKEN_VALUE_COLUMN = 54;
const TOKEN_LEADER_GAP = 4;

/** Everything the Injections view renders. */
export interface InjectionsViewInput {
	readonly snapshot: InitialSnapshot;
	readonly degradedReason?: string;
}

/** Shared token-value column measured after the fixed cursor column. */
interface InjectionColumns {
	readonly value: number;
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
		this.navigator = new ListNavigator(this.rows.length, 1, this.rows.length - 2);
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
		const headerLines = this.headerLines(width);
		const warningLines = this.degradedWarningLines(width);
		const descriptionLines = this.descriptionLines(width);
		const extraLineCount = headerLines.length - 1 + warningLines.length + descriptionLines.length - 1;
		const viewport = calculateViewport(this.rows.length, terminalRows, LIST_FIXED_LINE_COUNT, extraLineCount);
		this.navigator.setVisibleCount(viewport.visibleCount);
		const lines: string[] = [border, "", ...headerLines, "", ...warningLines];
		const listLines = this.listLines(width);
		lines.push(...listLines);
		if (viewport.showScroll) lines.push(this.scrollLine(width));
		const paddingCount = viewport.visibleCount - listLines.length;
		for (let pad = 0; pad < paddingCount; pad++) lines.push("");
		lines.push("");
		lines.push(...descriptionLines);
		lines.push("");
		lines.push(
			this.fit(
				hintRow(this.theme, [
					["↑↓", "Navigate"],
					["Enter", "Preview"],
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
		const title = theme.fg("accent", theme.bold(normalizeInlineText(item.label)));
		const source = normalizeInlineText(item.source.label);
		const meta = theme.fg("muted", `${source} · ${item.tokens.toLocaleString("en-US")} tokens `);
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
			this.theme.fg("dim", `${BODY_INDENT}(${this.previewScroller.visibleEnd}/${totalLines})`),
			width,
		);
	}

	/** Keep title/tabs together when possible; give narrow tabs their own breathing room. */
	private headerLines(width: number): string[] {
		const theme = this.theme;
		const title = theme.fg("accent", theme.bold("Context Injections"));
		const separator = theme.fg("dim", " · ");
		const initial = theme.fg("mdHeading", theme.bold("[INITIAL]"));
		const runtime = theme.fg("dim", "RUNTIME");
		const tabs = `${initial}  ${runtime}`;
		const combined = `${title}${separator}${tabs}`;
		if (visibleWidth(combined) <= width) return [this.fit(combined, width)];
		return [this.fit(title, width), "", this.fit(tabs, width)];
	}

	/** Render the current hierarchy viewport against one stable, nearby value column. */
	private listLines(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		const contentWidth = Math.max(1, width - CURSOR_COLUMN_WIDTH);
		const columns = this.injectionColumns(contentWidth);
		const start = this.navigator.offset;
		const end = start + this.navigator.windowSize;
		for (let index = start; index < end; index++) {
			const row = this.rows[index];
			if (row === undefined) break;
			if (row.kind === "separator") {
				lines.push("");
				continue;
			}
			const selected = row.kind !== "total" && index === this.navigator.selected;
			const cursor = selected ? theme.fg("accent", "→ ") : BODY_INDENT;
			const content = this.injectionLine(row, columns, contentWidth, selected);
			lines.push(this.fit(`${cursor}${content}`, width));
		}
		return lines;
	}

	/** Choose the earliest useful shared value column, capped on wide terminals. */
	private injectionColumns(width: number): InjectionColumns {
		const contentRows = this.rows.filter((row) => row.kind !== "separator");
		const labelWidth = Math.max(1, ...contentRows.map((row) => visibleWidth(this.plainRowLabel(row))));
		const tokenWidth = Math.max(
			1,
			...contentRows.map((row) => row.tokens.toLocaleString("en-US").length),
		);
		const idealValue = Math.min(MAX_TOKEN_VALUE_COLUMN, labelWidth + TOKEN_LEADER_GAP);
		return { value: Math.max(1, Math.min(idealValue, width - tokenWidth)) };
	}

	/** One hierarchy row with dim leaders and a full token estimate when width permits. */
	private injectionLine(
		row: Exclude<InjectionRow, { readonly kind: "separator" }>,
		columns: InjectionColumns,
		width: number,
		selected: boolean,
	): string {
		const labelWidth = Math.max(1, columns.value - 1);
		const left = fitLine(this.styledRowLabel(row, selected), labelWidth);
		const leader = this.tokenLeader(columns.value - visibleWidth(left));
		const value = row.tokens.toLocaleString("en-US");
		const tokens = row.kind === "total"
			? this.theme.bold(this.theme.fg("text", value))
			: this.theme.fg(selected ? "accent" : "muted", value);
		return fitLine(`${left}${leader}${tokens}`, width);
	}

	/** Fill a label/value gap with dim dots, retaining spaces at both ends. */
	private tokenLeader(width: number): string {
		if (width < 3) return " ".repeat(Math.max(0, width));
		return ` ${this.theme.fg("dim", ".".repeat(width - 2))} `;
	}

	/** Unstyled hierarchy label used to keep the value column stable while scrolling. */
	private plainRowLabel(row: Exclude<InjectionRow, { readonly kind: "separator" }>): string {
		const label = normalizeInlineText(row.label);
		return row.kind === "item" ? `${this.treePrefix(row)}${label}` : label;
	}

	/** Themed hierarchy label with connectors intentionally dim even on selection. */
	private styledRowLabel(
		row: Exclude<InjectionRow, { readonly kind: "separator" }>,
		selected: boolean,
	): string {
		const theme = this.theme;
		const label = normalizeInlineText(row.label);
		if (row.kind === "group" || row.kind === "total") {
			return theme.bold(theme.fg(selected ? "accent" : "text", label));
		}
		const prefix = theme.fg("dim", this.treePrefix(row));
		const color = selected ? "accent" : row.depth === 1 ? "muted" : "dim";
		return `${prefix}${theme.fg(color, label)}`;
	}

	/** Tree branch and ancestor continuation prefix for one item row. */
	private treePrefix(row: Extract<InjectionRow, { readonly kind: "item" }>): string {
		const branch = row.isLast ? "└─ " : "├─ ";
		if (row.depth === 1) return branch;
		return `${row.parentContinues === true ? "│  " : "   "}${branch}`;
	}

	private scrollLine(width: number): string {
		if (!this.navigator.hasOverflow) return this.fit("", width);
		return this.fit(
			this.theme.fg(
				"dim",
				`${BODY_INDENT}(${this.navigator.selectedOrdinal + 1}/${this.navigator.selectableCount})`,
			),
			width,
		);
	}

	/** Wrapped degraded-capture reason placed below the dialog header. */
	private degradedWarningLines(width: number): string[] {
		if (this.input.degradedReason === undefined) return [];
		const reason = this.theme.fg(
			"warning",
			`${BODY_INDENT}${normalizeInlineText(this.input.degradedReason)}`,
		);
		return wrapTextWithAnsi(reason, width);
	}

	/** Wrapped dialog description, including the degraded-capture indicator when needed. */
	private descriptionLines(width: number): string[] {
		const lines = wrapDescriptionLines(this.theme, LIST_DESCRIPTION, "muted", width);
		if (this.input.degradedReason !== undefined) {
			lines.push(...wrapDescriptionLines(
				this.theme,
				"[Degraded: pi-native fallback used]",
				"warning",
				width,
			));
		}
		return lines;
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
