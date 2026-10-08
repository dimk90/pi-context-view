/**
 * Focused `/context injections` view: hierarchical Initial snapshot rows. The
 * Runtime label stays hidden until the runtime-inspection roadmap step.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { InitialSnapshot, InjectionItem } from "../model.ts";
import { normalizeInlineText, normalizePreviewText } from "../text.ts";
import {
	buildInjectionRows,
	collectItemsById,
	filterInjections,
	type InjectionFilterMode,
	type InjectionRow,
	ListNavigator,
	PreviewScroller,
} from "./injections-model.ts";
import { expandJsonSpan } from "./json-preview.ts";
import {
	BODY_INDENT,
	calculateViewport,
	DEFAULT_TERMINAL_ROWS,
	descriptionBlockRows,
	fitHintRow,
	fitLine,
	fitToTerminalHeight,
	type Hint,
	isPageBackKey,
	isPageForwardKey,
	isStepBackKey,
	isStepForwardKey,
	normalizeTerminalRows,
	spreadLine,
	STEP_KEY_HINT,
	wrapDescriptionLines,
} from "./layout.ts";
import { type ContextMarker, droppedMarker, markerLegendLines, movedMarker } from "./markers.ts";
import {
	findMatches,
	highlightLine,
	labelMatches,
	MATCH_STEP_KEY_HINT,
	matchStatus,
	PreviewSearch,
	SEARCH_KEY,
	searchableContent,
	SearchPrompt,
} from "./search.ts";
import { previewBodyLines, previewLegendLines } from "./section-preview.ts";
import { DEFAULT_WHEEL_SCROLL_LINES, parseWheelDirection, readWheelScrollLines } from "./wheel.ts";

/**
 * List frame rows excluding the collapsible description: both borders and their
 * blank rows, one header row, and the hint row above its own blank row.
 */
const LIST_FIXED_LINE_COUNT = 8;
const PREVIEW_FIXED_LINE_COUNT = 8;
const LIST_DESCRIPTION = "Injections into the model context for the first turn, with token estimates.";
/** List rows that must stay visible for the description to keep its own rows. */
const LIST_DESCRIPTION_MIN_ROWS = 26;
const CURSOR_COLUMN_WIDTH = 2;
const MAX_TOKEN_VALUE_COLUMN = 54;
const TOKEN_LEADER_GAP = 4;
/** Lines kept above a match scrolled into view, so it is read in context. */
const SEARCH_CONTEXT_LINES = 2;
const EMPTY_FILTER_MESSAGE = "No injections match the filter.";

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
			const view = new InjectionsView(theme, input, done, () => tui.terminal.rows, readWheelScrollLines(tui));
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
	private readonly wheelScrollLines: number;
	/** Unfiltered rows; they fix the value column so filtering never shifts it. */
	private readonly allRows: InjectionRow[];
	private rows: InjectionRow[];
	private navigator: ListNavigator;
	private readonly itemsById: Map<string, InjectionItem>;
	private readonly filter = new SearchPrompt();
	private filterMode: InjectionFilterMode = "name";
	/** Searchable content per item id, built on first use by a content filter. */
	private readonly contentById = new Map<string, string>();
	private readonly previewSearch = new PreviewSearch();
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
		wheelScrollLines: number = DEFAULT_WHEEL_SCROLL_LINES,
	) {
		this.theme = theme;
		this.input = input;
		this.done = done;
		this.getTerminalRows = getTerminalRows;
		this.wheelScrollLines = wheelScrollLines;
		this.allRows = buildInjectionRows(input.snapshot);
		this.rows = this.allRows;
		this.navigator = listNavigator(this.rows);
		this.itemsById = collectItemsById(input.snapshot);
	}

	public handleInput(data: string): void {
		if (this.previewItem !== undefined) {
			this.handlePreviewInput(data);
			return;
		}
		if (this.filter.editing) {
			this.handleFilterInput(data);
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			if (this.filter.active) this.clearFilter();
			else this.done(undefined);
			return;
		}
		if (data === SEARCH_KEY) {
			this.filter.edit();
			this.clearCache();
			return;
		}
		// One notch moves the selection one row, like a single step key.
		const wheel = parseWheelDirection(data);
		if (wheel !== undefined) {
			if (this.navigator.moveBy(wheel)) this.clearCache();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.openPreview();
		} else if (isStepBackKey(data)) {
			if (this.navigator.moveBy(-1)) this.clearCache();
		} else if (isStepForwardKey(data)) {
			if (this.navigator.moveBy(1)) this.clearCache();
		} else if (isPageBackKey(data)) {
			if (this.navigator.page(-1)) this.clearCache();
		} else if (isPageForwardKey(data)) {
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
		const filterLines = this.filterLines(width);
		const warningLines = this.degradedWarningLines(width);
		const prefixLineCount = headerLines.length - 1 + filterLines.length + warningLines.length;
		const availableRows = Math.max(1, terminalRows - LIST_FIXED_LINE_COUNT - prefixLineCount);
		const descriptionLines = this.fittedDescriptionLines(width, availableRows);
		const extraLineCount = prefixLineCount + descriptionBlockRows(descriptionLines);
		const viewport = calculateViewport(this.rows.length, terminalRows, LIST_FIXED_LINE_COUNT, extraLineCount);
		this.navigator.setVisibleCount(viewport.visibleCount);
		const lines: string[] = [border, "", ...headerLines, "", ...filterLines, ...warningLines];
		const listLines = this.rows.length === 0
			? [this.fit(theme.fg("muted", `${BODY_INDENT}${EMPTY_FILTER_MESSAGE}`), width)]
			: this.listLines(width);
		lines.push(...listLines);
		if (viewport.showScroll) lines.push(this.scrollLine(width));
		const paddingCount = viewport.visibleCount - listLines.length;
		for (let pad = 0; pad < paddingCount; pad++) lines.push("");
		if (descriptionLines.length > 0) lines.push("", ...descriptionLines);
		lines.push("");
		lines.push(fitHintRow(this.theme, this.listHints(), width));
		lines.push("", border);

		const fittedLines = fitToTerminalHeight(lines, terminalRows, border);
		this.cachedWidth = width;
		this.cachedTerminalRows = terminalRows;
		this.cachedLines = fittedLines;
		return fittedLines;
	}

	public invalidate(): void {
		this.clearPreviewContent();
		this.clearCache();
	}

	// === List filter ===

	/**
	 * Keys while the filter prompt is open: printable keys edit the query,
	 * the arrow and page keys still move the selection, Tab switches between
	 * names and content, Enter keeps the filter and opens the selected row,
	 * and Escape drops the filter.
	 */
	private handleFilterInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.clearFilter();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.filter.active) {
				this.filter.submit();
				this.openPreview();
			} else {
				this.clearFilter();
			}
			this.clearCache();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.filterMode = this.filterMode === "name" ? "content" : "name";
			this.applyFilter();
			return;
		}
		const wheel = parseWheelDirection(data);
		if (wheel !== undefined) {
			if (this.navigator.moveBy(wheel)) this.clearCache();
		} else if (matchesKey(data, Key.up)) {
			if (this.navigator.moveBy(-1)) this.clearCache();
		} else if (matchesKey(data, Key.down)) {
			if (this.navigator.moveBy(1)) this.clearCache();
		} else if (matchesKey(data, Key.pageUp)) {
			if (this.navigator.page(-1)) this.clearCache();
		} else if (matchesKey(data, Key.pageDown)) {
			if (this.navigator.page(1)) this.clearCache();
		} else if (this.filter.type(data)) {
			this.applyFilter();
		} else {
			// The cursor may have moved without changing the query.
			this.clearCache();
		}
	}

	/** Rebuild rows for the current query, selecting the first row that matched itself. */
	private applyFilter(): void {
		const pattern = this.filter.pattern;
		if (pattern === undefined) {
			this.showRows(this.allRows, this.selectedRowKey());
			return;
		}
		const filtered = filterInjections(this.input.snapshot, {
			mode: this.filterMode,
			nameMatches: (label) => labelMatches(label, pattern),
			contentMatches: (item) => pattern.test(this.contentOf(item)),
		});
		const rows = filtered.snapshot.groups.length === 0 ? [] : buildInjectionRows(filtered.snapshot, filtered.matched);
		this.rows = rows;
		this.navigator = listNavigator(rows);
		this.navigator.moveTo(Math.max(0, rows.findIndex((row) => isMatchedRow(row))));
		this.clearCache();
	}

	/** Drop the filter and restore every row, keeping the selected row selected. */
	private clearFilter(): void {
		const selected = this.selectedRowKey();
		this.filter.clear();
		this.showRows(this.allRows, selected);
	}

	/** Replace the visible rows and reselect the row with `key`, or the first row. */
	private showRows(rows: InjectionRow[], key: string | undefined): void {
		this.rows = rows;
		this.navigator = listNavigator(rows);
		this.navigator.moveTo(Math.max(0, rows.findIndex((row) => rowKey(row) === key)));
		this.clearCache();
	}

	private selectedRowKey(): string | undefined {
		const row = this.rows[this.navigator.selected];
		return row === undefined ? undefined : rowKey(row);
	}

	/**
	 * Searchable content of one item, cached for repeated keystrokes. JSON runs
	 * expand as the preview shows them, so a query that keeps a row also finds
	 * its match once the preview opens.
	 */
	private contentOf(item: InjectionItem): string {
		let content = this.contentById.get(item.id);
		if (content === undefined) {
			const parts = item.sections?.length ? item.sections : [item];
			content = searchableContent(parts.map((part) => expandJsonSpan(part.text, part.jsonSpan)).join(""));
			this.contentById.set(item.id, content);
		}
		return content;
	}

	/** Prompt row and its trailing blank row, shown while a filter is typed or kept. */
	private filterLines(width: number): string[] {
		if (!this.filter.editing && !this.filter.active) return [];
		const label = this.filterMode === "name" ? "Filter by Name" : "Filter by Content";
		const count = this.rows.filter(isMatchedRow).length;
		return [this.filter.render(this.theme, width, label, matchStatus(this.filter.active, count, undefined)), ""];
	}

	/** List hints for the plain list, an open filter prompt, or a kept filter. */
	private listHints(): Hint[] {
		if (this.filter.editing) {
			return [
				["↑↓", "Navigate"],
				["Tab", this.filterMode === "name" ? "Content" : "Name"],
				["Enter", "Preview"],
				["Esc", "Clear"],
			];
		}
		return [
			[STEP_KEY_HINT, "Navigate"],
			["Enter", "Preview"],
			[SEARCH_KEY, "Filter", true],
			["Esc", this.filter.active ? "Clear" : "Close"],
		];
	}

	// === Preview mode ===

	private handlePreviewInput(data: string): void {
		if (this.previewSearch.prompt.editing) {
			this.handlePreviewSearchInput(data);
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			this.closePreview();
			return;
		}
		if (data === SEARCH_KEY) {
			this.previewSearch.edit(this.previewScroller.offset);
			this.clearCache();
			return;
		}
		if (data === "n" || data === "N") {
			if (this.previewSearch.step(data === "n" ? 1 : -1)) this.clearCache();
			return;
		}
		const wheel = parseWheelDirection(data);
		if (wheel !== undefined) {
			if (this.previewScroller.scrollBy(wheel * this.wheelScrollLines)) this.clearCache();
			return;
		}
		if (isStepBackKey(data)) {
			if (this.previewScroller.scrollBy(-1)) this.clearCache();
		} else if (isStepForwardKey(data)) {
			if (this.previewScroller.scrollBy(1)) this.clearCache();
		} else if (isPageBackKey(data)) {
			if (this.previewScroller.page(-1)) this.clearCache();
		} else if (isPageForwardKey(data)) {
			if (this.previewScroller.page(1)) this.clearCache();
		} else if (matchesKey(data, Key.home)) {
			if (this.previewScroller.scrollTo(0)) this.clearCache();
		} else if (matchesKey(data, Key.end)) {
			if (this.previewScroller.scrollTo(this.previewScroller.maxOffset)) this.clearCache();
		}
	}

	/**
	 * Keys while the preview search prompt is open: printable keys edit the
	 * query, the arrow and page keys still scroll, Enter keeps the query, and
	 * Escape drops it.
	 */
	private handlePreviewSearchInput(data: string): void {
		const search = this.previewSearch;
		const wheel = parseWheelDirection(data);
		if (matchesKey(data, Key.escape)) {
			search.clear();
		} else if (matchesKey(data, Key.enter)) {
			if (search.prompt.active) search.prompt.submit();
			else search.clear();
		} else if (wheel !== undefined) {
			this.previewScroller.scrollBy(wheel * this.wheelScrollLines);
		} else if (matchesKey(data, Key.up)) {
			this.previewScroller.scrollBy(-1);
		} else if (matchesKey(data, Key.down)) {
			this.previewScroller.scrollBy(1);
		} else if (matchesKey(data, Key.pageUp)) {
			this.previewScroller.page(-1);
		} else if (matchesKey(data, Key.pageDown)) {
			this.previewScroller.page(1);
		} else {
			search.type(data);
		}
		this.clearCache();
	}

	/** Open the selected item; a content filter carries its query into the preview search. */
	private openPreview(): void {
		const row = this.rows[this.navigator.selected];
		if (row?.kind !== "item") return;
		const item = this.itemsById.get(row.itemId);
		if (item === undefined) return;
		this.previewItem = item;
		this.clearPreviewContent();
		this.previewScroller.reset();
		this.previewSearch.clear();
		if (this.filter.active && this.filterMode === "content") {
			this.previewSearch.prompt.set(this.filter.query);
			this.previewSearch.restart();
		}
		this.clearCache();
	}

	private closePreview(): void {
		this.previewItem = undefined;
		this.previewSearch.clear();
		this.clearPreviewContent();
		this.clearCache();
	}

	/** Drop width- and theme-dependent preview rendering. */
	private clearPreviewContent(): void {
		this.previewLines = undefined;
		this.previewWrapWidth = undefined;
	}

	private renderPreview(width: number, terminalRows: number, item: InjectionItem): string[] {
		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const wrapped = this.getPreviewLines(width, item);
		const search = this.previewSearch;
		const searchRowCount = search.prompt.editing || search.prompt.active ? 2 : 0;
		const descriptionLines = previewLegendLines(theme, [item], {
			width,
			availableRows: terminalRows - PREVIEW_FIXED_LINE_COUNT - searchRowCount,
			contentLineCount: wrapped.length,
		});
		const viewport = calculateViewport(
			wrapped.length,
			terminalRows,
			PREVIEW_FIXED_LINE_COUNT,
			searchRowCount + descriptionBlockRows(descriptionLines),
		);
		this.previewScroller.setExtent(wrapped.length, viewport.visibleCount);
		const revealLine = search.sync(wrapped);
		if (revealLine !== undefined) this.previewScroller.reveal(revealLine, SEARCH_CONTEXT_LINES);
		const searchLines = searchRowCount === 0
			? []
			: [search.prompt.render(theme, width, "Search", search.status), ""];

		const lines: string[] = [border, ""];
		const title = theme.fg("accent", theme.bold(normalizeInlineText(item.label)));
		const source = normalizeInlineText(item.source.label);
		const meta = theme.fg("muted", `${source} · ${item.tokens.toLocaleString("en-US")} tokens`);
		const marker = item.moved === true ? movedMarker(theme) : "";
		const fitsMarker = visibleWidth(title) + visibleWidth(meta) + visibleWidth(marker) + 2 <= width;
		lines.push(this.spread(title, `${meta}${fitsMarker ? marker : ""} `, width));
		lines.push("", ...searchLines);

		const start = this.previewScroller.offset;
		for (let index = start; index < start + viewport.visibleCount; index++) {
			lines.push(search.highlight(theme, wrapped[index] ?? "", index));
		}

		if (viewport.showScroll) lines.push(this.previewScrollLine(width, wrapped.length));
		if (descriptionLines.length > 0) lines.push("", ...descriptionLines);
		lines.push("");
		lines.push(fitHintRow(this.theme, this.previewHints(), width));
		lines.push("", border);
		return fitToTerminalHeight(lines, terminalRows, border);
	}

	/** Preview hints for plain scrolling, an open search prompt, or a kept search. */
	private previewHints(): Hint[] {
		const prompt = this.previewSearch.prompt;
		if (prompt.editing) return [["↑↓", "Scroll"], ["Enter", "Done"], ["Esc", "Clear"]];
		if (prompt.active) {
			return [
				[STEP_KEY_HINT, "Scroll"],
				[MATCH_STEP_KEY_HINT, "Next/Prev"],
				[SEARCH_KEY, "Search", true],
				["Esc", "Back"],
			];
		}
		return [[STEP_KEY_HINT, "Scroll"], ["PgUp/PgDn", "Page"], [SEARCH_KEY, "Search", true], ["Esc", "Back"]];
	}

	private getPreviewLines(width: number, item: InjectionItem): string[] {
		const wrapWidth = Math.max(10, width - BODY_INDENT.length - 1);
		if (this.previewLines !== undefined && this.previewWrapWidth === wrapWidth) return this.previewLines;
		// The item preview is the full-content level, so marked JSON expands here.
		const lines = previewBodyLines(
			this.theme,
			item,
			wrapWidth,
			(text, jsonSpan) => this.wrappedTextLines(expandJsonSpan(text, jsonSpan), wrapWidth),
			item.label,
		);
		this.previewLines = lines;
		this.previewWrapWidth = wrapWidth;
		return lines;
	}

	/** Wrap sanitized text into indented preview lines, keeping blank lines. */
	private wrappedTextLines(text: string, wrapWidth: number): string[] {
		const lines: string[] = [];
		for (const paragraph of normalizePreviewText(text).split("\n")) {
			const wrapped = wrapTextWithAnsi(paragraph, wrapWidth);
			if (wrapped.length === 0) {
				lines.push("");
				continue;
			}
			for (const line of wrapped) lines.push(`${BODY_INDENT}${line}`);
		}
		return lines;
	}

	private previewScrollLine(width: number, totalLines: number): string {
		if (!this.previewScroller.hasOverflow) return this.fit("", width);
		return this.fit(
			this.theme.fg("dim", `${BODY_INDENT}(${this.previewScroller.visibleEnd}/${totalLines})`),
			width,
		);
	}

	/** Keep title/label together when possible; give the narrow label its own breathing room. */
	private headerLines(width: number): string[] {
		const theme = this.theme;
		const title = theme.fg("accent", theme.bold("Context Injections"));
		const separator = theme.fg("dim", " · ");
		// Runtime remains unimplemented, so only the Initial label is shown.
		const tabs = theme.fg("mdHeading", theme.bold("[INITIAL]"));
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

	/** Mark a name filter's query inside a rendered row label. */
	private highlightLabel(label: string): string {
		const pattern = this.filter.pattern;
		if (pattern === undefined || this.filterMode !== "name") return label;
		const ranges = findMatches([label], pattern)
			.flatMap((match) => match.segments)
			.map((segment) => ({ start: segment.start, end: segment.end, current: false }));
		return ranges.length === 0 ? label : highlightLine(this.theme, label, ranges);
	}

	/** Choose the earliest useful shared value column, capped on wide terminals. */
	private injectionColumns(width: number): InjectionColumns {
		const contentRows = this.allRows.filter((row) => row.kind !== "separator");
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
		const left = this.highlightLabel(fitLine(this.styledRowLabel(row, selected), labelWidth));
		const leader = this.tokenLeader(columns.value - visibleWidth(left));
		const value = row.tokens.toLocaleString("en-US");
		const tokens = row.kind === "total"
			? this.theme.bold(this.theme.fg("text", value))
			: this.theme.fg(selected ? "accent" : "muted", value);
		const line = `${left}${leader}${tokens}`;
		return fitLine(`${line}${this.rowMarker(row, columns.value + value.length, width)}`, width);
	}

	/** State marker after the estimate, dropped whole rather than truncated when it does not fit. */
	private rowMarker(
		row: Exclude<InjectionRow, { readonly kind: "separator" }>,
		lineWidth: number,
		width: number,
	): string {
		if (row.kind !== "item") return "";
		const marker = row.dropped === true
			? droppedMarker(this.theme)
			: row.moved === true ? movedMarker(this.theme) : "";
		return lineWidth + visibleWidth(marker) <= width ? marker : "";
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

	/**
	 * Description block, collapsed whole once the list window falls below its
	 * readable floor. The Initial list is unbounded and scrolls on most
	 * terminals, so the description outlives the scroll counter instead of
	 * yielding to it; a list shorter than the floor keeps every row instead.
	 */
	private fittedDescriptionLines(width: number, availableRows: number): string[] {
		const lines = this.descriptionLines(width);
		const rowCount = Math.max(1, this.rows.length);
		const floor = Math.min(LIST_DESCRIPTION_MIN_ROWS, rowCount);
		const viewport = calculateViewport(rowCount, availableRows - descriptionBlockRows(lines), 0);
		return viewport.visibleCount >= floor ? lines : [];
	}

	/**
	 * Wrapped dialog description: the list sentence, the degraded-capture
	 * indicator when needed, and one legend bullet per marker the rows show.
	 */
	private descriptionLines(width: number): string[] {
		const lines = wrapDescriptionLines(this.theme, LIST_DESCRIPTION, "dim", width);
		if (this.input.degradedReason !== undefined) {
			lines.push(...wrapDescriptionLines(
				this.theme,
				"[Degraded: pi-native fallback used]",
				"warning",
				width,
			));
		}
		lines.push(...markerLegendLines(this.theme, this.rowMarkers(), width));
		return lines;
	}

	/** Markers the hierarchy rows carry, whatever the current width leaves room to render. */
	private rowMarkers(): ContextMarker[] {
		const items = this.rows.filter((row) => row.kind === "item");
		const markers: ContextMarker[] = [];
		if (items.some((row) => row.dropped === true)) markers.push("dropped");
		if (items.some((row) => row.moved === true)) markers.push("moved");
		return markers;
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

/** Navigator over rows whose trailing separator and total are never selected. */
function listNavigator(rows: readonly InjectionRow[]): ListNavigator {
	const selectable = rows.filter((row) => row.kind === "group" || row.kind === "item").length;
	return new ListNavigator(rows.length, 1, selectable);
}

/** Whether a filter matched the row itself rather than keeping it as context. */
function isMatchedRow(row: InjectionRow): boolean {
	return (row.kind === "group" || row.kind === "item") && row.matched === true;
}

/** Identity that survives rebuilding rows for a different filter. */
function rowKey(row: InjectionRow): string {
	if (row.kind === "item") return `item:${row.itemId}`;
	return `${row.kind}:${row.label}`;
}
