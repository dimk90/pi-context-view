/**
 * Focused `/context injections` view: hierarchical rows of the latest request
 * snapshot. The Runtime label stays hidden until the runtime-inspection roadmap step.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { InjectionItem, InjectionSnapshot, TokenDiff } from "../model.ts";
import type { GuardResult } from "../snapshot.ts";
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
	capNoticeLines,
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
import {
	type DiffBase,
	diffMarker,
	formatDiffAdded,
	formatDiffRemoved,
	stateMarkers,
} from "./markers.ts";
import {
	descriptionNoteLines, findingNotes, injectionsNotes, payloadCheck, payloadCheckLabel, requestOriginLabel,
} from "./notes.ts";
import {
	findMatches,
	highlightLine,
	isSearchNavigationKey,
	labelMatches,
	matchStatus,
	matchStepDirection,
	PreviewSearch,
	SEARCH_CONTEXT_LINES,
	SEARCH_KEY,
	searchableContent,
	searchHints,
	SearchPrompt,
} from "./search.ts";
import { previewBodyLines, previewLegendLines } from "./section-preview.ts";
import { statusBarLines } from "./status-bar.ts";
import { DEFAULT_WHEEL_SCROLL_LINES, parseWheelDirection, readWheelScrollLines } from "./wheel.ts";

/**
 * List frame rows excluding the status bar and the collapsible description:
 * both borders and their blank rows, one header row, the fixed total with its
 * preceding blank row, and the hint row above its own blank row.
 */
const LIST_FIXED_LINE_COUNT = 10;
/** Rows configuration notices may occupy before they start crowding out the list. */
const MAX_NOTICE_LINES = 3;
const PREVIEW_FIXED_LINE_COUNT = 8;
/** Where a diff-only row's changes count, in place of its preview estimate. */
const DIFF_ONLY_NOTE = "counted in System Prompt";
/** List rows that must stay visible for the description to keep its own rows. */
const LIST_DESCRIPTION_MIN_ROWS = 26;
const CURSOR_COLUMN_WIDTH = 2;
const MAX_TOKEN_VALUE_COLUMN = 54;
const TOKEN_LEADER_GAP = 4;
/** Spaces before each diff column, after the value column. */
const DIFF_COLUMN_GAP = 2;
/** List message in place of rows when a filter leaves none. */
const EMPTY_FILTER_MESSAGE = "No injections match the filter.";

/** Everything the Injections view renders. */
export interface InjectionsViewInput {
	readonly snapshot: InjectionSnapshot;
	readonly degradedReason?: string;
	/** Non-fatal problems shown under the header, such as ignored configuration entries. */
	readonly notices?: readonly string[];
	/** True when no request was captured yet and configuration disables the silent probe. */
	readonly probingDisabled?: boolean;
	/** True when a silent probe captured the request, not a real turn. */
	readonly probe?: boolean;
	/** Payload comparison of the request; absent for the degraded fallback, which has no request. */
	readonly guard?: GuardResult;
}

/** Shared token-value and diff columns measured after the fixed cursor column. */
interface InjectionColumns {
	readonly value: number;
	/** Width of the largest formatted estimate in the whole tree, including TOTAL. */
	readonly valueWidth: number;
	/** Width of the widest `+N` in the whole tree; 0 when no row adds tokens. */
	readonly addedWidth: number;
	/** Width of the widest `-N` in the whole tree; 0 when no row removes tokens. */
	readonly removedWidth: number;
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
	/** Unfiltered selection and scroll from before the filter, restored when the query is cleared or canceled. */
	private unfilteredNavigator: ListNavigator | undefined;
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
		// Navigation keys still move the selection while the filter prompt is open
		if (this.filter.editing && !isSearchNavigationKey(data)) {
			this.handleFilterInput(data);
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			if (this.filter.active) this.clearFilter();
			else this.done(undefined);
			return;
		}
		if (data === SEARCH_KEY) {
			if (!this.filter.active) this.unfilteredNavigator = this.navigator;
			this.filter.edit();
			this.clearCache();
			return;
		}
		// One notch moves the selection one row, like a single step key
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
			if (this.navigator.moveTo(this.navigator.selectableCount - 1)) this.clearCache();
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
		// A blank row separates warnings from the list; the emergency frame drops it with the other spacing
		const warningRows = warningLines.length === 0 ? 0 : warningLines.length + 1;
		// The status bar never collapses: the list and the description give way to it
		const statusLines = this.statusLines(width);
		const statusRows = descriptionBlockRows(statusLines);
		const prefixRows = headerLines.length - 1 + filterLines.length + warningRows;
		const availableRows = Math.max(1, terminalRows - LIST_FIXED_LINE_COUNT - prefixRows - statusRows);
		const descriptionLines = this.fittedDescriptionLines(width, availableRows);
		const extraLineCount = prefixRows + statusRows + descriptionBlockRows(descriptionLines);
		const viewport = calculateViewport(
			this.navigator.selectableCount, terminalRows, LIST_FIXED_LINE_COUNT, extraLineCount,
		);
		this.navigator.setVisibleCount(viewport.visibleCount);
		const lines: string[] = [
			border, "", ...headerLines, "", ...filterLines, ...warningLines, ...(warningRows > 0 ? [""] : []),
		];
		const listLines = this.navigator.selectableCount === 0
			? [this.fit(theme.fg("muted", `${BODY_INDENT}${EMPTY_FILTER_MESSAGE}`), width)]
			: this.listLines(width);
		lines.push(...listLines);
		if (viewport.showScroll) lines.push(this.scrollLine(width));
		const total = this.totalLine(width);
		lines.push("", total);
		if (statusLines.length > 0) lines.push("", ...statusLines);
		const hints = fitHintRow(theme, this.listHints(), width);
		const tail = [...(descriptionLines.length > 0 ? ["", ...descriptionLines] : []), "", hints, "", border];
		// Fill the terminal so the overlay hides the chat, keeping the list, total, and bar together
		while (lines.length + tail.length < terminalRows) lines.push("");
		lines.push(...tail);

		const fittedLines = lines.length <= terminalRows ? lines : compactListLines({
			border, header: this.headerLines(width, true), filter: filterLines.slice(0, 1), warnings: warningLines,
			selected: listLines[this.navigator.selected - this.navigator.offset],
			total, status: statusLines, hints, terminalRows,
		});
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
	 * Non-navigation keys while the filter prompt is open: printable keys edit
	 * the query, Tab switches between names and content, Enter keeps the filter
	 * and opens the selected row, and Escape drops the filter.
	 */
	private handleFilterInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.cancelFilter();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.filter.active) {
				this.filter.submit();
				this.openPreview();
			} else {
				this.cancelFilter();
			}
			this.clearCache();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.filterMode = this.filterMode === "name" ? "content" : "name";
			this.applyFilter();
			return;
		}
		if (this.filter.type(data)) {
			this.applyFilter();
		} else {
			// The cursor may have moved without changing the query
			this.clearCache();
		}
	}

	/** Rebuild rows for the current query, selecting the first row that matched itself. */
	private applyFilter(): void {
		const pattern = this.filter.pattern;
		if (pattern === undefined) {
			this.restoreUnfilteredRows();
			return;
		}
		const filtered = filterInjections(this.input.snapshot, {
			mode: this.filterMode,
			nameMatches: (label) => labelMatches(label, pattern),
			contentMatches: (item) => pattern.test(this.contentOf(item)),
		});
		const rows = buildInjectionRows(this.input.snapshot, filtered);
		this.rows = rows;
		this.navigator = listNavigator(rows);
		this.navigator.moveTo(Math.max(0, rows.findIndex((row) => isMatchedRow(row))));
		this.clearCache();
	}

	/** Drop the filter and restore every row, keeping the selected row selected. */
	private clearFilter(): void {
		const selected = this.selectedRowKey();
		this.filter.clear();
		this.unfilteredNavigator = undefined;
		this.showRows(this.allRows, selected);
	}

	/** Drop the filter being typed and return to the selection and scroll from before it. */
	private cancelFilter(): void {
		this.filter.clear();
		this.restoreUnfilteredRows();
		this.unfilteredNavigator = undefined;
	}

	/** Show every row with the navigator saved before filtering, or keep the selected row without one. */
	private restoreUnfilteredRows(): void {
		if (this.unfilteredNavigator === undefined) {
			this.showRows(this.allRows, this.selectedRowKey());
			return;
		}
		this.rows = this.allRows;
		this.navigator = this.unfilteredNavigator;
		this.clearCache();
	}

	/** Replace the visible rows and reselect the row with `key`, or the first row. */
	private showRows(rows: InjectionRow[], key: string | undefined): void {
		this.rows = rows;
		this.navigator = listNavigator(rows);
		this.navigator.moveTo(Math.max(0, rows.findIndex((row) => rowKey(row) === key)));
		this.clearCache();
	}

	/** Key of the selected row, or undefined when a filter leaves no rows. */
	private selectedRowKey(): string | undefined {
		if (this.navigator.selectableCount === 0) return undefined;
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
		if (!this.filter.shown) return [];
		const count = this.rows.filter(isMatchedRow).length;
		const status = matchStatus(this.filter.active, count, undefined);
		return [this.filter.renderAfter(this.theme, width, this.filterModeSwitcher(), status), ""];
	}

	/**
	 * `◉ Name | ○ Content >` lead of the filter prompt, marked like pi's own scope toggles:
	 * the active mode `◉` in bold accent, the other `○` dim.
	 */
	private filterModeSwitcher(): string {
		const theme = this.theme;
		const mode = (value: InjectionFilterMode, label: string): string =>
			value === this.filterMode ? theme.bold(theme.fg("accent", `◉ ${label}`)) : theme.fg("dim", `○ ${label}`);
		return `${mode("name", "Name")}${theme.fg("dim", " | ")}${mode("content", "Content")}${theme.fg("dim", " > ")}`;
	}

	/** List hints for the plain list, an open filter prompt, or a kept filter. */
	private listHints(): Hint[] {
		if (this.filter.editing) {
			// The prompt shows both modes; the hint only names the key that switches them
			return [
				["↑↓", "Navigate"],
				["Tab", "Mode"],
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
		// Navigation keys still scroll while the search prompt is open
		if (this.previewSearch.prompt.editing && !isSearchNavigationKey(data)) {
			this.previewSearch.handlePromptKey(data);
			this.clearCache();
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
		const matchStep = matchStepDirection(data);
		if (matchStep !== undefined) {
			if (this.previewSearch.step(matchStep)) this.clearCache();
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
		const searchRowCount = search.promptRowCount;
		const descriptionLines = previewLegendLines(theme, [item], {
			width,
			availableRows: terminalRows - PREVIEW_FIXED_LINE_COUNT - searchRowCount,
			contentLineCount: wrapped.length,
		}, findingNotes([item, ...(item.children ?? [])]).map((note) => note.text), previewDiffBase(item));
		const viewport = calculateViewport(
			wrapped.length,
			terminalRows,
			PREVIEW_FIXED_LINE_COUNT,
			searchRowCount + descriptionBlockRows(descriptionLines),
		);
		this.previewScroller.setExtent(wrapped.length, viewport.visibleCount);
		const revealLine = search.sync(wrapped);
		if (revealLine !== undefined) this.previewScroller.reveal(revealLine, SEARCH_CONTEXT_LINES);
		const searchLines = search.promptLines(theme, width);

		const lines: string[] = [border, ""];
		const title = theme.fg("accent", theme.bold(normalizeInlineText(item.label)));
		const source = normalizeInlineText(item.source.label);
		const meta = theme.fg("muted", item.diffOnly === true
			? source
			: `${source} · ${item.tokens.toLocaleString("en-US")} tokens`);
		const diff = diffMarker(theme, item.diff);
		const note = item.diffOnly === true
			? theme.fg("dim", " · ") + theme.fg("muted", DIFF_ONLY_NOTE)
			: "";
		const marker = stateMarkers(theme, {
			moved: item.moved, change: item.change, forcedEdit: item.forcedEdit, requestOnly: item.requestOnly,
		});
		// Drop the marker first when space runs out, then the accounting note, then the diff
		const headerWidth = visibleWidth(title) + visibleWidth(meta) + 2;
		const fitsDiff = headerWidth + visibleWidth(diff) <= width;
		const fitsNote = fitsDiff && headerWidth + visibleWidth(diff) + visibleWidth(note) <= width;
		const fitsMarker = fitsNote && headerWidth + visibleWidth(diff) + visibleWidth(note) + visibleWidth(marker) <= width;
		lines.push(this.spread(title,
			`${meta}${fitsDiff ? diff : ""}${fitsNote ? note : ""}${fitsMarker ? marker : ""} `, width));
		lines.push("", ...searchLines);

		const start = this.previewScroller.offset;
		for (let index = start; index < start + viewport.visibleCount; index++) {
			lines.push(search.highlight(theme, wrapped[index] ?? "", index));
		}

		if (viewport.showScroll) lines.push(this.previewScrollLine(width, wrapped.length));
		if (descriptionLines.length > 0) lines.push("", ...descriptionLines);
		lines.push("");
		lines.push(fitHintRow(this.theme, searchHints(search.prompt, "Scroll"), width));
		lines.push("", border);
		return fitToTerminalHeight(lines, terminalRows, border);
	}

	private getPreviewLines(width: number, item: InjectionItem): string[] {
		const wrapWidth = Math.max(10, width - BODY_INDENT.length - 1);
		if (this.previewLines !== undefined && this.previewWrapWidth === wrapWidth) return this.previewLines;
		// The item preview is the full-content level, so marked JSON expands here
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

	/** Keep capture origin and payload attention visible, wrapping below the title rather than omitting status. */
	private headerLines(width: number, compact = false): string[] {
		const theme = this.theme;
		const separator = theme.fg("dim", " · ");
		const probe = this.input.probe === true;
		const label = theme.fg("mdHeading", theme.bold(requestOriginLabel(probe)));
		const payloadState = payloadCheck(this.input.guard);
		const status = payloadState === undefined ? ""
			: theme.fg("muted", "Payload") + theme.fg("dim", `: ${payloadCheckLabel(payloadState)}`);
		// An emergency frame drops the title, never the origin or payload attention
		if (compact) return wrapTextWithAnsi(`${label}${status === "" ? "" : separator + status}`, Math.max(1, width));
		const title = theme.fg("accent", theme.bold("Context Injections"));
		const combined = `${title}${separator}${label}`;
		const lines = visibleWidth(combined) <= width
			? [combined]
			: [this.fit(title, width), "", ...wrapTextWithAnsi(label, Math.max(1, width))];
		if (status === "") return lines;
		if (lines.length === 1 && visibleWidth(combined) + visibleWidth(status) < width) {
			return [this.spread(combined, status, width)];
		}
		return [...lines, ...wrapDescriptionLines(theme, status, "dim", width)];
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

	/** Render the fixed snapshot total with the hierarchy's shared value column and no cursor. */
	private totalLine(width: number): string {
		const row = this.rows.at(-1);
		if (row?.kind !== "total") return "";
		const contentWidth = Math.max(1, width - CURSOR_COLUMN_WIDTH);
		const content = this.injectionLine(row, this.injectionColumns(contentWidth), contentWidth, false);
		return this.fit(`${BODY_INDENT}${content}`, width);
	}

	/** Mark a name filter's query inside the rendered label of a row it matched. */
	private highlightLabel(row: InjectionRow, label: string): string {
		const pattern = this.filter.pattern;
		if (pattern === undefined || this.filterMode !== "name" || !isMatchedRow(row)) return label;
		const ranges = findMatches([label], pattern)
			.flatMap((match) => match.segments)
			.map((segment) => ({ start: segment.start, end: segment.end, current: false }));
		return ranges.length === 0 ? label : highlightLine(this.theme, label, ranges);
	}

	/**
	 * Choose the earliest useful shared value column, capped on wide terminals,
	 * and size the diff columns from the widest `+N` and `-N` in the whole tree,
	 * unfiltered so a filter never shifts them.
	 */
	private injectionColumns(width: number): InjectionColumns {
		const contentRows = this.allRows.filter((row) => row.kind !== "separator");
		const labelWidth = Math.max(1, ...contentRows.map((row) => visibleWidth(this.plainRowLabel(row))));
		const tokenWidth = Math.max(
			1,
			...contentRows.filter((row) => !isDiffOnly(row)).map((row) => row.tokens.toLocaleString("en-US").length),
		);
		const diffs = contentRows.map(rowDiff);
		const idealValue = Math.min(MAX_TOKEN_VALUE_COLUMN, labelWidth + TOKEN_LEADER_GAP);
		return {
			value: Math.max(1, Math.min(idealValue, width - tokenWidth)),
			valueWidth: tokenWidth,
			addedWidth: Math.max(0, ...diffs.map((diff) => diff !== undefined && diff.added > 0
				? formatDiffAdded(diff.added).length : 0)),
			removedWidth: Math.max(0, ...diffs.map((diff) => diff !== undefined && diff.removed > 0
				? formatDiffRemoved(diff.removed).length : 0)),
		};
	}

	/**
	 * One hierarchy row with dim leaders and a full token estimate when width
	 * permits, then its diff columns and state markers. A diff-only row has no
	 * estimate: its leaders run through the value column. Narrow widths drop the
	 * diff columns whole for every row, and a marker that does not fit.
	 */
	private injectionLine(
		row: Exclude<InjectionRow, { readonly kind: "separator" }>,
		columns: InjectionColumns,
		width: number,
		selected: boolean,
	): string {
		const labelWidth = Math.max(1, columns.value - 1);
		const left = this.highlightLabel(row, fitLine(this.styledRowLabel(row, selected, labelWidth), labelWidth));
		const diffOnly = isDiffOnly(row);
		const value = diffOnly ? "" : row.tokens.toLocaleString("en-US").padStart(columns.valueWidth);
		const leader = this.tokenLeader(
			columns.value - visibleWidth(left) + (diffOnly ? columns.valueWidth : 0),
			!diffOnly,
		);
		const tokens = row.kind === "total"
			? this.theme.bold(this.theme.fg("text", value))
			: this.theme.fg(selected ? "accent" : "muted", value);
		const marker = this.rowMarker(row);
		const diff = rowDiff(row);
		let lineWidth = columns.value + columns.valueWidth;
		let diffs = "";
		const diffWidth = diffColumnsWidth(columns);
		// Blank diff columns only keep a following marker aligned
		if (diffWidth > 0 && lineWidth + diffWidth <= width && (diff !== undefined || marker.length > 0)) {
			diffs = this.diffColumns(diff, columns, marker.length > 0);
			lineWidth += diffWidth;
		}
		const fittedMarker = lineWidth + visibleWidth(marker) <= width ? marker : "";
		return fitLine(`${left}${leader}${tokens}${diffs}${fittedMarker}`, width);
	}

	/**
	 * `+N` and `-N` right-aligned in their tree-wide columns. A blank column is
	 * padded only when `followed` by a marker, so no row ends in spaces.
	 */
	private diffColumns(diff: TokenDiff | undefined, columns: InjectionColumns, followed: boolean): string {
		const added = diff !== undefined && diff.added > 0 ? formatDiffAdded(diff.added) : "";
		const removed = diff !== undefined && diff.removed > 0 ? formatDiffRemoved(diff.removed) : "";
		let text = "";
		if (columns.addedWidth > 0 && (added.length > 0 || removed.length > 0 || followed)) {
			text += " ".repeat(DIFF_COLUMN_GAP + columns.addedWidth - added.length);
			if (added.length > 0) text += this.theme.fg("toolDiffAdded", added);
		}
		if (columns.removedWidth > 0 && (removed.length > 0 || followed)) {
			text += " ".repeat(DIFF_COLUMN_GAP + columns.removedWidth - removed.length);
			if (removed.length > 0) text += this.theme.fg("toolDiffRemoved", removed);
		}
		return text;
	}

	/**
	 * State markers after the estimate and diff columns: `Dropped`, `Moved`,
	 * `Forced`, and `Request-Only`. The diff columns show what a change added
	 * or removed.
	 */
	private rowMarker(row: Exclude<InjectionRow, { readonly kind: "separator" }>): string {
		return row.kind === "item" ? stateMarkers(this.theme, row) : "";
	}

	/** Fill a label/value gap with dim dots, omitting the trailing space for an empty value. */
	private tokenLeader(width: number, trailingSpace = true): string {
		if (width < 3) return " ".repeat(Math.max(0, width));
		return ` ${this.theme.fg("dim", ".".repeat(width - (trailingSpace ? 2 : 1)))}${trailingSpace ? " " : ""}`;
	}

	/** Unstyled hierarchy label used to keep the value column stable while scrolling. */
	private plainRowLabel(row: Exclude<InjectionRow, { readonly kind: "separator" }>): string {
		const label = normalizeInlineText(row.label);
		return row.kind === "item" ? `${this.treePrefix(row)}${row.labelPrefix ?? ""}${label}` : label;
	}

	/** Themed hierarchy label with connectors intentionally dim even on selection. */
	private styledRowLabel(
		row: Exclude<InjectionRow, { readonly kind: "separator" }>,
		selected: boolean,
		width: number,
	): string {
		const theme = this.theme;
		let label = normalizeInlineText(row.label);
		if (row.kind === "group" || row.kind === "total") {
			return theme.bold(theme.fg(selected ? "accent" : "text", label));
		}
		// The tool prefix stays dim on selection, like the connectors
		const prefix = theme.fg("dim", `${this.treePrefix(row)}${row.labelPrefix ?? ""}`);
		const item = this.itemsById.get(row.itemId);
		if (item?.kind === "context-file" && item.children === undefined) {
			label = shortenInstructionPath(label, Math.max(0, width - visibleWidth(prefix)));
		}
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

	/** The selected row's wrapped fields, or one empty reserved line without a change or marker. */
	private statusLines(width: number): string[] {
		// An empty filter result selects nothing; its rows are only the footer
		const row = this.navigator.selectableCount === 0 ? undefined : this.rows[this.navigator.selected];
		const lines = row === undefined ? [] : statusBarLines(this.theme, row, width);
		return lines.length > 0 ? lines : [""];
	}

	/**
	 * Wrapped degraded-capture reason, then configuration problems, placed below
	 * the dialog header. Only the notices are capped: the precise degraded
	 * reason always stays whole.
	 */
	private degradedWarningLines(width: number): string[] {
		const degraded = this.input.degradedReason === undefined ? [] : this.wrapWarning(this.input.degradedReason, width);
		const notices = (this.input.notices ?? []).map((notice) => this.wrapWarning(notice, width));
		return [...degraded, ...capNoticeLines(notices, MAX_NOTICE_LINES, (notice) => this.wrapWarning(notice, width))];
	}

	/** One sanitized warning wrapped to the available width, indented on its first line. */
	private wrapWarning(warning: string, width: number): string[] {
		return wrapTextWithAnsi(this.theme.fg("warning", `${BODY_INDENT}${normalizeInlineText(warning)}`), width);
	}

	/**
	 * Description block, collapsed whole once the list window falls below its
	 * readable floor. The injection list is unbounded and scrolls on most
	 * terminals, so the description outlives the scroll counter instead of
	 * yielding to it; a list shorter than the floor keeps every row instead.
	 */
	private fittedDescriptionLines(width: number, availableRows: number): string[] {
		const lines = this.descriptionLines(width);
		// An empty filter result still shows its one-row message
		const rowCount = Math.max(1, this.navigator.selectableCount);
		const floor = Math.min(LIST_DESCRIPTION_MIN_ROWS, rowCount);
		const viewport = calculateViewport(rowCount, availableRows - descriptionBlockRows(lines), 0);
		return viewport.visibleCount >= floor ? lines : [];
	}

	/**
	 * Wrapped dialog description: the list sentence, the degraded-capture
	 * indicator, request notes, and the note that explains payload changes
	 * further. The status bar, not a legend, explains the selected row's markers.
	 */
	private descriptionLines(width: number): string[] {
		return injectionsNotes(this.theme, {
			...this.input, hiddenTools: this.input.snapshot.hiddenTools, items: [...this.itemsById.values()],
		}).flatMap((note) => descriptionNoteLines(this.theme, note, width));
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

/** Navigator over rows whose trailing separator and total belong to the fixed footer, not the viewport. */
function listNavigator(rows: readonly InjectionRow[]): ListNavigator {
	return new ListNavigator(rows.length - 2, 1);
}

/** Whether a filter matched the row itself rather than keeping it as context. */
function isMatchedRow(row: InjectionRow): boolean {
	return (row.kind === "group" || row.kind === "item") && row.matched === true;
}

/** Identity that survives rebuilding rows for a different filter. */
function rowKey(row: InjectionRow): string {
	if (row.kind === "item") return `item:${row.itemId}`;
	if (row.kind === "group") return row.groupKey;
	return `${row.kind}:${row.label}`;
}

/** Parts of an emergency list frame, in which the bar has priority over frame spacing. */
interface CompactListInput {
	readonly border: string;
	readonly header: readonly string[];
	/** The filter prompt row, without its trailing blank row; empty when no filter is shown. */
	readonly filter: readonly string[];
	readonly warnings: readonly string[];
	readonly selected?: string;
	readonly total: string;
	readonly status: readonly string[];
	readonly hints: string;
	readonly terminalRows: number;
}

/**
 * When even a one-row list cannot fit, remove spare spacing and the title.
 * Keep capture status, the filter prompt, degraded reasons, the selected row,
 * the total, and the bar between borders; add hints only if they fit, after
 * empty rows that fill the remaining height. Below that physical minimum, clip content.
 */
function compactListLines(input: CompactListInput): string[] {
	const { border, header, filter, warnings, selected, total, status, hints, terminalRows } = input;
	const lines = [
		border, ...header, ...filter, ...warnings, ...(selected === undefined ? [] : [selected]), total, ...status,
	];
	const tail = lines.length + 2 <= terminalRows ? [hints, border] : [border];
	while (lines.length + tail.length < terminalRows) lines.push("");
	return fitToTerminalHeight([...lines, ...tail], terminalRows, border);
}

/**
 * Fit a sanitized path by replacing middle directories with an ellipsis. Keep
 * the root and longest whole tail that fits; give the filename priority when
 * even the root and ellipsis leave too little room.
 */
function shortenInstructionPath(path: string, width: number): string {
	if (visibleWidth(path) <= width) return path;
	const separators = [...path.matchAll(/[/\\]/g)];
	const lastSeparator = separators.at(-1);
	if (lastSeparator === undefined) return fitLine(path, width);
	const root = /^(?:~|[A-Za-z]:)?[/\\]/.exec(path)?.[0] ?? "";
	for (const separator of separators) {
		if (separator.index < root.length) continue;
		const shortened = `${root}…${path.slice(separator.index)}`;
		if (visibleWidth(shortened) <= width) return shortened;
	}
	const tail = `…${path.slice(lastSeparator.index)}`;
	return visibleWidth(tail) <= width ? tail : fitLine(path.slice(lastSeparator.index + 1), width);
}

/** Whether a list row shows only a diff, with no estimate in the value column. */
function isDiffOnly(row: InjectionRow): boolean {
	return row.kind === "item" && row.diffOnly === true;
}

/** Token diff a list row shows; the total and the separator have none. */
function rowDiff(row: InjectionRow): TokenDiff | undefined {
	return row.kind === "group" || row.kind === "item" ? row.diff : undefined;
}

/** Width the diff columns take after the value column, including their gaps. */
function diffColumnsWidth(columns: InjectionColumns): number {
	const added = columns.addedWidth > 0 ? DIFF_COLUMN_GAP + columns.addedWidth : 0;
	const removed = columns.removedWidth > 0 ? DIFF_COLUMN_GAP + columns.removedWidth : 0;
	return added + removed;
}

/**
 * What a preview's token diffs compare with: pi's default prompt for pi's
 * contributions and `system prompt` rows, the captured request for a payload
 * change, and the session for everything else.
 */
function previewDiffBase(item: InjectionItem): DiffBase {
	if (item.kind === "payload-change") return "captured-request";
	// A `system prompt` row splits pi's prompt changes by source
	return item.source.native || item.diffOnly === true ? "default-prompt" : "session";
}
