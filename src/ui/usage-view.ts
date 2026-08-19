/**
 * Focused `/context usage` view: estimated context composition with a
 * proportional context-window map, pi-reported metadata, selectable category
 * rows, an Enter-opened chronological block stream, and uncapped content for
 * a selected block that hides lines.
 */
import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { ContextUsageSnapshot, UsageCategory, UsagePreviewEntry } from "../model.ts";
import { collectPreviewEntries } from "../usage.ts";
import {
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
	isStepBackKey,
	isStepForwardKey,
	normalizeTerminalRows,
	spreadLine,
	STEP_KEY_HINT,
	wrapDescriptionLines,
} from "./layout.ts";
import { splitSkillPreview } from "./skill-preview.ts";
import {
	buildUsageMap,
	calculateFitMapScale,
	DEFAULT_MAP_COLUMNS,
	DEFAULT_MAP_ROWS,
	type UsageMap,
	type UsageMapCell,
} from "./usage-map.ts";
import { BlockNavigator, layoutPreviewBlocks, type PreviewLayout } from "./usage-preview.ts";

const USAGE_DESCRIPTION = "Estimated context for the next model request. " +
	"Token counts are approximate and may differ from the provider's estimate.";
const INVISIBLE_REASONING_DESCRIPTION =
	"Entry headers read: [DD-MM-YYYY] [assistant] visible + Reasoning ≈invisible (≈total). " +
	"≈ is a provider-reported count; ~ is a rough approximation when no breakdown " +
	"is reported and excluded from category totals. " +
	"Encoded replaces Reasoning when the provider replays encrypted reasoning with its message.";
const USAGE_TAIL_FIXED_LINE_COUNT = 5;
const DETAIL_CATEGORY_HEADER_LINE_COUNT = 1;
const PREVIEW_FIXED_LINE_COUNT = 8;
/** The block view adds the block identity header and its preceding separator to the preview frame. */
const BLOCK_FIXED_LINE_COUNT = PREVIEW_FIXED_LINE_COUNT + 2;
const PREVIEW_BLOCK_MAX_LINES = 10;
const PREVIEW_BLOCK_MIN_LINES = 4;
/** Stream rows two blocks spend around their content: both entry headers, both markers, one separator. */
const TWO_BLOCK_FRAME_ROWS = 5;
const BLOCK_GUTTER = "┃";
const CURSOR_COLUMN_WIDTH = 2;
const MAX_LEGEND_VALUE_COLUMN = 32;
const LEGEND_VALUE_GAP = 2;
const LEGEND_LEADER_GAP = 4;
const MAP_SIDE_BY_SIDE_MIN_WIDTH = 52;
const SPACED_MAP_MIN_WIDTH = 72;
const MAP_COLUMN_GAP = 2;
const SPACED_MAP_COLUMN_GAP = 3;
const FULL_CELL = "■";
const PARTIAL_CELL = "◧";
const COMPACTED_CELL = "▦";
const BUFFER_CELL = "⛝";
const FREE_CELL = "⛶";
const BREAKDOWN_MARKER = "•";
const MAP_KEY_FULL_DESCRIPTION = "Single category block";
const MAP_KEY_PART_DESCRIPTION = "Shared block, largest category shown";
const MAP_KEY_SIZE_LABEL = "Block Size";
/** Rows the detailed key costs beside the complete legend: one separator plus four key rows. */
const MAP_KEY_DETAILED_SPARE_ROWS = 5;
/** Rows the single-line key costs beside the complete legend: one separator plus one key row. */
const MAP_KEY_COMPACT_SPARE_ROWS = 2;

/** Everything the Usage view renders, classified once when the view opens. */
export interface UsageViewInput {
	readonly usage: ContextUsageSnapshot;
	readonly degradedReason?: string;
}

/** View-local denominator selected for the context map. */
type UsageMapScale = "window" | "fit";

interface CategoryLegendRow {
	readonly type: "category";
	readonly category: UsageCategory;
	readonly depth: number;
	readonly rootId: string;
}

interface BufferLegendRow {
	readonly type: "buffer";
	readonly tokens: number;
}

interface FreeLegendRow {
	readonly type: "free";
	readonly tokens: number;
}

type LegendRow = CategoryLegendRow | BufferLegendRow | FreeLegendRow;

interface LegendColumns {
	readonly value: number;
	readonly tokenWidth: number;
}

/** One navigable preview block: an entry header plus its capped content lines. */
interface PreviewBlock {
	/** Rendered after the two-column gutter, with the entry header first. */
	readonly lines: readonly string[];
	/** Content lines the per-block cap removed, shown as a trailing marker row. */
	readonly hiddenLineCount: number;
}

/** Width- and cap-dependent block rendering cached for one category preview. */
interface PreviewStream {
	readonly wrapWidth: number;
	readonly maxLines: number;
	readonly blocks: readonly PreviewBlock[];
	readonly layout: PreviewLayout;
}

/** Wrapped, indented content lines of one preview entry, before any cap. */
type EntryLines = readonly string[];

/** Uncapped content of every entry in the open category, wrapped for one width. */
interface PreviewContent {
	readonly wrapWidth: number;
	/** Positionally aligned with the category's preview entries. */
	readonly entries: readonly EntryLines[];
}

/** Uncapped content of the open block, wrapped and fitted for one terminal width. */
interface BlockBody {
	readonly width: number;
	readonly lines: readonly string[];
}

/** Open the Usage view as a fullscreen overlay. */
export async function showUsageView(context: ExtensionCommandContext, input: UsageViewInput): Promise<void> {
	await context.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const view = new UsageView(theme, input, done, () => tui.terminal.rows);
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

/** Exported for direct render/input tests; use showUsageView from pi code. */
export class UsageView {
	private readonly theme: Theme;
	private readonly input: UsageViewInput;
	private readonly done: (result: undefined) => void;
	private readonly getTerminalRows: () => number;
	private readonly usage: ContextUsageSnapshot;
	private readonly legendRows: readonly LegendRow[];
	private readonly navigator: ListNavigator;
	private readonly previewScroller = new PreviewScroller();
	private readonly blockNavigator = new BlockNavigator();
	private readonly fitMapScale: number | undefined;
	private mapScale: UsageMapScale = "window";
	private currentWidth: number | undefined;
	private previewRow: CategoryLegendRow | undefined;
	private cachedPreviewEntries: readonly UsagePreviewEntry[] | undefined;
	private cachedContent: PreviewContent | undefined;
	private cachedStream: PreviewStream | undefined;
	private openBlockIndex: number | undefined;
	private cachedBlockBody: BlockBody | undefined;
	private cachedWidth: number | undefined;
	private cachedTerminalRows: number | undefined;
	private cachedLines: string[] | undefined;

	/** Create a view over one precomputed usage snapshot. */
	public constructor(
		theme: Theme,
		input: UsageViewInput,
		done: (result: undefined) => void,
		getTerminalRows: () => number = () => process.stdout.rows ?? DEFAULT_TERMINAL_ROWS,
	) {
		this.theme = theme;
		this.input = input;
		this.done = done;
		this.getTerminalRows = getTerminalRows;
		this.usage = input.usage;
		this.fitMapScale = calculateFitMapScale(this.usage);
		this.legendRows = this.buildLegendRows();
		// The trailing buffer/free block has no preview: it scrolls with the list but is never selectable.
		const selectableCount = this.legendRows.filter((row) => row.type === "category").length;
		this.navigator = new ListNavigator(this.legendRows.length, 1, selectableCount);
	}

	/** Handle category navigation, preview opening, and close keys. */
	public handleInput(data: string): void {
		if (this.previewRow !== undefined) {
			// Route on the same predicate the renderer uses, so keys always target the visible level.
			if (this.openBlockEntry(this.previewRow) === undefined) this.handlePreviewInput(data);
			else this.handleBlockInput(data);
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "z")) {
			this.toggleMapScale();
		} else if (matchesKey(data, Key.enter)) {
			this.openPreview();
		} else if (isStepBackKey(data)) {
			if (this.navigator.moveBy(-1)) this.clearCache();
		} else if (isStepForwardKey(data)) {
			if (this.navigator.moveBy(1)) this.clearCache();
		} else if (matchesKey(data, Key.pageUp)) {
			if (this.navigator.page(-1)) this.clearCache();
		} else if (matchesKey(data, Key.pageDown)) {
			if (this.navigator.page(1)) this.clearCache();
		} else if (matchesKey(data, Key.home)) {
			if (this.navigator.moveTo(0)) this.clearCache();
		} else if (matchesKey(data, Key.end)) {
			if (this.navigator.moveTo(this.legendRows.length - 1)) this.clearCache();
		}
	}

	/** Render a cached fullscreen frame for the current width and terminal height. */
	public render(width: number): string[] {
		this.currentWidth = width;
		const terminalRows = normalizeTerminalRows(this.getTerminalRows());
		if (
			this.cachedLines !== undefined &&
			this.cachedWidth === width &&
			this.cachedTerminalRows === terminalRows
		) {
			return this.cachedLines;
		}

		const lines = this.renderActiveMode(width, terminalRows);
		this.cachedWidth = width;
		this.cachedTerminalRows = terminalRows;
		this.cachedLines = lines;
		return lines;
	}

	/** Invalidate theme-dependent rendered output. */
	public invalidate(): void {
		this.clearPreviewContent();
		this.clearCache();
	}

	/** Render the active level: dashboard, category block stream, or one full block. */
	private renderActiveMode(width: number, terminalRows: number): string[] {
		const row = this.previewRow;
		if (row === undefined) return this.renderDashboard(width, terminalRows);
		const entry = this.openBlockEntry(row);
		if (entry === undefined) return this.renderPreview(width, terminalRows, row);
		return this.renderBlockView(width, terminalRows, row, entry);
	}

	// === Dashboard mode ===

	/** Full map/legend frame with navigation hints. */
	private renderDashboard(width: number, terminalRows: number): string[] {
		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const prefix = [border, "", ...this.headerLines(width), "", ...this.degradedWarningLines(width)];
		const descriptionLines = wrapDescriptionLines(theme, USAGE_DESCRIPTION, "dim", width);
		const availableDashboardRows = Math.max(
			1,
			terminalRows - prefix.length - USAGE_TAIL_FIXED_LINE_COUNT - descriptionLines.length,
		);
		const dashboard = this.dashboardLines(width, availableDashboardRows).slice(0, availableDashboardRows);
		while (dashboard.length < availableDashboardRows) dashboard.push("");
		const tail = [
			"",
			...descriptionLines,
			"",
			this.fit(
				hintRow(theme, this.dashboardHints(width)),
				width,
			),
			"",
			border,
		];
		return fitToTerminalHeight([...prefix, ...dashboard, ...tail], terminalRows, border);
	}

	/** Accent title with responsive model, zoom label, and true-window usage metadata. */
	private headerLines(width: number): string[] {
		const theme = this.theme;
		const title = theme.fg("accent", theme.bold("Context Usage"));
		const summary = this.reportedSummary();
		if (width < MAP_SIDE_BY_SIDE_MIN_WIDTH) {
			return [this.fit(title, width), "", this.fit(summary, width)];
		}

		const normalizedModel = normalizeInlineText(this.usage.modelLabel ?? "");
		const separator = theme.fg("dim", " · ");
		const fullMetadata = normalizedModel === ""
			? summary
			: `${theme.fg("muted", normalizedModel)}${separator}${summary}`;
		const zoomLabel = this.zoomLabel(width);
		if (zoomLabel !== undefined) {
			const titleWithZoom = `${title}${separator}${zoomLabel}`;
			if (visibleWidth(titleWithZoom) + 1 + visibleWidth(fullMetadata) <= width) {
				return [spreadLine(titleWithZoom, fullMetadata, width)];
			}
			if (visibleWidth(titleWithZoom) + 1 + visibleWidth(summary) <= width) {
				return [spreadLine(titleWithZoom, summary, width)];
			}
			if (visibleWidth(title) + 1 + visibleWidth(summary) <= width) {
				return [spreadLine(title, summary, width), "", this.fit(zoomLabel, width)];
			}
			return [
				this.fit(title, width),
				"",
				this.fit(zoomLabel, width),
				"",
				this.fit(summary, width),
			];
		}

		if (visibleWidth(title) + 1 + visibleWidth(fullMetadata) <= width) {
			return [spreadLine(title, fullMetadata, width)];
		}
		if (visibleWidth(title) + 1 + visibleWidth(summary) <= width) {
			return [spreadLine(title, summary, width)];
		}
		return [this.fit(title, width), "", this.fit(summary, width)];
	}

	/** Toggle the view-local map denominator when the binding is currently visible. */
	private toggleMapScale(): void {
		if (!this.canToggleMapScale(this.currentWidth)) return;
		this.mapScale = this.mapScale === "window" ? "fit" : "window";
		this.clearCache();
	}

	/** Whether zoom can help and its binding is visible at this width. */
	private canToggleMapScale(width: number | undefined): boolean {
		const contextWindow = this.usage.reported?.contextWindow;
		return width !== undefined &&
			width >= MAP_SIDE_BY_SIDE_MIN_WIDTH &&
			contextWindow !== undefined &&
			this.fitMapScale !== undefined &&
			this.fitMapScale < contextWindow;
	}

	/** The active Fit label, omitted together with its map and binding. */
	private zoomLabel(width: number): string | undefined {
		const contextWindow = this.usage.reported?.contextWindow;
		if (
			this.mapScale !== "fit" ||
			!this.canToggleMapScale(width) ||
			contextWindow === undefined ||
			this.fitMapScale === undefined
		) return undefined;
		return this.theme.fg(
			"mdHeading",
			`Zoom ${formatTokens(contextWindow)} → ${formatTokens(this.fitMapScale)}`,
		);
	}

	/** Dashboard hints with Zoom immediately before Close when the binding is active. */
	private dashboardHints(width: number): Array<readonly [string, string]> {
		const hints: Array<readonly [string, string]> = [
			[STEP_KEY_HINT, "Navigate"],
			["Enter", "Preview"],
		];
		if (this.canToggleMapScale(width)) hints.push(["Z", "Zoom"]);
		hints.push(["Esc", "Close"]);
		return hints;
	}

	/** Render the map and legend side by side, or only details when width/window data is insufficient. */
	private dashboardLines(width: number, rows: number): string[] {
		const scaleTokens = this.mapScale === "fit" ? this.fitMapScale : undefined;
		const map = buildUsageMap(
			this.usage,
			DEFAULT_MAP_COLUMNS,
			DEFAULT_MAP_ROWS,
			scaleTokens,
		);
		if (map === undefined || width < MAP_SIDE_BY_SIDE_MIN_WIDTH) {
			return this.detailLines(width, rows, undefined).map((line) => this.fit(line, width));
		}

		const spaced = width >= SPACED_MAP_MIN_WIDTH;
		const separator = spaced ? " " : "";
		const mapLines = Array.from({ length: map.rows }, (_, row) => {
			const start = row * map.columns;
			const cells = map.cells.slice(start, start + map.columns);
			return `${BODY_INDENT}${cells.map((cell) => this.mapCell(cell)).join(separator)}`;
		});
		const mapWidth = BODY_INDENT.length + map.columns + (spaced ? map.columns - 1 : 0);
		const gap = spaced ? SPACED_MAP_COLUMN_GAP : MAP_COLUMN_GAP;
		const detailWidth = Math.max(1, width - mapWidth - gap);
		const details = this.detailLines(detailWidth, rows, map);
		const lineCount = Math.max(mapLines.length, details.length);
		return Array.from({ length: lineCount }, (_, index) => {
			const mapLine = mapLines[index] ?? " ".repeat(mapWidth);
			const detail = this.fit(details[index] ?? "", detailWidth);
			return this.fit(`${mapLine}${" ".repeat(gap)}${detail}`, width);
		});
	}

	/** Category heading, selectable category legend viewport, scroll counter, and map-fill key. */
	private detailLines(width: number, rows: number, map: UsageMap | undefined): string[] {
		const theme = this.theme;
		const keyLines = map === undefined ? [] : this.mapKeyLines(map, width, rows);
		const reservedLineCount = DETAIL_CATEGORY_HEADER_LINE_COUNT +
			(keyLines.length === 0 ? 0 : keyLines.length + 1);
		// The counter sits below the last legend row, so it consumes one of the available rows.
		const viewport = calculateViewport(this.legendRows.length, rows, reservedLineCount);
		this.navigator.setVisibleCount(viewport.visibleCount);

		const heading = theme.fg("mdHeading", theme.bold("Category:"));
		const rowWidth = Math.max(1, width - CURSOR_COLUMN_WIDTH);
		const columns = this.legendColumns(rowWidth);
		const visibleRows: string[] = [];
		const start = this.navigator.offset;
		for (let index = start; index < start + this.navigator.windowSize; index++) {
			const row = this.legendRows[index];
			if (row === undefined) break;
			const selected = index === this.navigator.selected;
			// The cursor stays in one fixed column at the start of the legend.
			const cursor = selected ? theme.fg("accent", "→ ") : "  ";
			visibleRows.push(this.fit(`${cursor}${this.legendLine(row, columns, rowWidth, selected)}`, width));
		}
		const counterLines = viewport.showScroll
			? [this.fit(
				theme.fg("dim", `${BODY_INDENT}(${this.navigator.visibleEnd}/${this.legendRows.length})`),
				width,
			)]
			: [];
		return [
			heading,
			...visibleRows,
			...counterLines,
			...(keyLines.length === 0 ? [] : ["", ...keyLines]),
		].slice(0, rows);
	}

	/**
	 * Map key: one heading plus a row per occupancy glyph and the scale-dependent
	 * block size, rendered below the more important category legend. It claims
	 * only rows the complete legend leaves over, so a shrinking terminal degrades
	 * it to the single-line key and then drops it before any category row goes.
	 */
	private mapKeyLines(map: UsageMap, width: number, rows: number): string[] {
		const spare = rows - DETAIL_CATEGORY_HEADER_LINE_COUNT - this.legendRows.length;
		if (spare < MAP_KEY_COMPACT_SPARE_ROWS) return [];
		if (spare < MAP_KEY_DETAILED_SPARE_ROWS) return [this.compactMapKeyLine(map, width)];
		const theme = this.theme;
		const sizeLabel = theme.fg("muted", `${MAP_KEY_SIZE_LABEL}: `);
		return [
			this.fit(theme.fg("mdHeading", theme.bold("Map:")), width),
			this.fit(this.mapKeyEntry("text", FULL_CELL, theme.fg("muted", MAP_KEY_FULL_DESCRIPTION)), width),
			this.fit(this.mapKeyEntry("text", PARTIAL_CELL, theme.fg("muted", MAP_KEY_PART_DESCRIPTION)), width),
			this.fit(this.mapKeyEntry("dim", FREE_CELL, `${sizeLabel}${this.blockSizeText(map, true)}`), width),
		];
	}

	/** One indented `glyph - text` key row. */
	private mapKeyEntry(glyphColor: ThemeColor, glyph: string, text: string): string {
		return `${BODY_INDENT}${this.theme.fg(glyphColor, glyph)}${this.theme.fg("dim", " - ")}${text}`;
	}

	/** Single-line key that drops detail in stages before it would truncate. */
	private compactMapKeyLine(map: UsageMap, width: number): string {
		const theme = this.theme;
		const heading = theme.fg("mdHeading", theme.bold("Map:"));
		const separator = theme.fg("dim", " · ");
		const full = `${theme.fg("text", FULL_CELL)}${theme.fg("muted", " One category")}`;
		const partial = `${theme.fg("text", PARTIAL_CELL)}${theme.fg("muted", " Mixed")}`;
		const size = (withPercent: boolean) =>
			`${theme.fg("dim", FREE_CELL)} ${this.blockSizeText(map, withPercent)}`;
		const prefix = `${heading} ${full}${separator}${partial}${separator}`;
		const detailed = `${prefix}${size(true)}`;
		if (visibleWidth(detailed) <= width) return detailed;
		const withoutPercent = `${prefix}${size(false)}`;
		if (visibleWidth(withoutPercent) <= width) return withoutPercent;
		const shortenedFull = `${theme.fg("text", FULL_CELL)}${theme.fg("muted", " One")}`;
		return this.fit(`${heading} ${shortenedFull}${separator}${partial}${separator}${size(false)}`, width);
	}

	/**
	 * Tokens one map cell covers, with its share of the mapped range. While Fit
	 * zoom shrinks the value, it shares the header zoom label's color. The share
	 * is derived from the current map geometry rather than assumed, so it follows
	 * any future cell count.
	 */
	private blockSizeText(map: UsageMap, withPercent: boolean): string {
		const percent = withPercent ? formatPercent(1 / (map.columns * map.rows)) : "";
		const tokens = formatTokens(Math.round(map.blockTokens));
		return this.theme.fg(
			this.mapScale === "fit" ? "mdHeading" : "muted",
			percent === "" ? tokens : `${tokens} (${percent})`,
		);
	}

	/** Pi-reported usage/window metadata, with a marked estimate when current usage is unknown. */
	private reportedSummary(): string {
		const reported = this.usage.reported;
		if (reported === undefined) return this.theme.fg("muted", "Context usage unavailable.");
		const contextWindow = formatTokens(reported.contextWindow);
		if (reported.tokens === undefined) {
			const percent = formatPercent(this.usage.estimatedTokens / reported.contextWindow);
			return this.theme.fg(
				"text",
				`≈${formatTokens(this.usage.estimatedTokens)}/${contextWindow} (${percent})`,
			);
		}
		const percent = reported.percent === undefined ? "" : ` (${formatPercent(reported.percent / 100)})`;
		return this.theme.fg("text", `${formatTokens(reported.tokens)}/${contextWindow}${percent}`);
	}

	/**
	 * All legend rows: top-level categories, Tool Output children, then the
	 * non-selectable auto-compact buffer and free space.
	 */
	private buildLegendRows(): LegendRow[] {
		const rows: LegendRow[] = buildCategoryLegendRows(this.usage.categories);
		const bufferTokens = this.bufferTokens();
		if (bufferTokens > 0) rows.push({ type: "buffer", tokens: bufferTokens });
		const freeTokens = this.freeSpaceTokens();
		if (freeTokens !== undefined) rows.push({ type: "free", tokens: freeTokens });
		return rows;
	}

	/** Tokens auto-compaction keeps unoccupied; zero when disabled or without a context window. */
	private bufferTokens(): number {
		const contextWindow = this.usage.reported?.contextWindow;
		const reserve = this.usage.autoCompactReserveTokens;
		if (contextWindow === undefined || contextWindow <= 0 || reserve === undefined) return 0;
		return Math.min(reserve, Math.max(0, contextWindow - this.usage.estimatedTokens));
	}

	/** Estimated remaining space before the buffer, or undefined without a usable context window. */
	private freeSpaceTokens(): number | undefined {
		const contextWindow = this.usage.reported?.contextWindow;
		if (contextWindow === undefined || contextWindow <= 0) return undefined;
		return Math.max(0, contextWindow - this.usage.estimatedTokens - this.bufferTokens());
	}

	/** Earliest shared token column plus the width needed to align percentages. */
	private legendColumns(width: number): LegendColumns {
		const rows = this.legendRows;
		const labelWidth = Math.max(1, ...rows.map((row) => this.plainLegendLabel(row).length));
		const tokenWidth = Math.max(1, ...rows.map((row) => formatTokens(legendTokens(row)).length));
		const percentWidth = Math.max(0, ...rows.map((row) => this.plainLegendPercent(legendTokens(row)).length));
		const rightWidth = tokenWidth + (percentWidth > 0 ? LEGEND_VALUE_GAP + percentWidth : 0);
		const idealValue = Math.min(MAX_LEGEND_VALUE_COLUMN, labelWidth + LEGEND_LEADER_GAP);
		return {
			value: Math.max(1, Math.min(idealValue, width - rightWidth)),
			tokenWidth,
		};
	}

	/** One aligned hierarchy row with dim leaders and independent token/percentage columns. */
	private legendLine(row: LegendRow, columns: LegendColumns, width: number, selected: boolean): string {
		const labelWidth = Math.max(1, columns.value - 1);
		const left = fitLine(this.styledLegendLabel(row, selected), labelWidth);
		const leader = this.legendLeader(columns.value - visibleWidth(left));
		const tokens = formatTokens(legendTokens(row));
		const valueColor = selected ? "accent" : row.type === "category" && row.depth > 1 ? "dim" : "muted";
		const tokenPadding = " ".repeat(Math.max(0, columns.tokenWidth - tokens.length));
		const percent = this.plainLegendPercent(legendTokens(row));
		const percentPart = percent === ""
			? ""
			: `${" ".repeat(LEGEND_VALUE_GAP)}${this.theme.fg(selected ? "accent" : "dim", percent)}`;
		return fitLine(
			`${left}${leader}${this.theme.fg(valueColor, tokens)}${tokenPadding}${percentPart}`,
			width,
		);
	}

	/** Fill a label/value gap with dim dots, retaining spaces at both ends. */
	private legendLeader(width: number): string {
		if (width < 3) return " ".repeat(Math.max(0, width));
		return ` ${this.theme.fg("dim", ".".repeat(width - 2))} `;
	}

	/** Unstyled hierarchy label used to choose the shared value column. */
	private plainLegendLabel(row: LegendRow): string {
		if (row.type === "buffer") return `${BUFFER_CELL} Auto-Compact Buffer`;
		if (row.type === "free") return `${FREE_CELL} Free Space`;
		const indent = "  ".repeat(row.depth);
		return `${indent}${categoryMarker(row.category.id, row.depth)} ${normalizeInlineText(row.category.label)}`;
	}

	/** Themed hierarchy label; the marker keeps its map color even when selected. */
	private styledLegendLabel(row: LegendRow, selected: boolean): string {
		if (row.type === "buffer") {
			return `${this.theme.fg("dim", BUFFER_CELL)} ${this.theme.fg("text", "Auto-Compact Buffer")}`;
		}
		if (row.type === "free") {
			return `${this.theme.fg("dim", FREE_CELL)} ${this.theme.fg(selected ? "accent" : "text", "Free Space")}`;
		}
		const indent = "  ".repeat(row.depth);
		const color = categoryColor(row.rootId);
		const marker = this.theme.fg(color, categoryMarker(row.category.id, row.depth));
		const labelColor = selected ? "accent" : row.depth === 0 ? "text" : row.depth === 1 ? "muted" : "dim";
		return `${indent}${marker} ${this.theme.fg(labelColor, normalizeInlineText(row.category.label))}`;
	}

	/** Percentage text used by the independently aligned rightmost column. */
	private plainLegendPercent(tokens: number): string {
		const contextWindow = this.usage.reported?.contextWindow;
		if (contextWindow === undefined || contextWindow <= 0) return "";
		return formatPercent(tokens / contextWindow);
	}

	/** Colored occupied/partial/buffer/free glyph for one map cell. */
	private mapCell(cell: UsageMapCell): string {
		if (cell.fill === "buffer") return this.theme.fg("dim", BUFFER_CELL);
		if (cell.fill === "free") return this.theme.fg("dim", FREE_CELL);
		const glyph = cell.categoryId === "compacted-data"
			? COMPACTED_CELL
			: cell.fill === "full" ? FULL_CELL : PARTIAL_CELL;
		return this.theme.fg(categoryColor(cell.categoryId), glyph);
	}

	/** Wrapped degraded-capture warning placed above the dashboard. */
	private degradedWarningLines(width: number): string[] {
		if (this.input.degradedReason === undefined) return [];
		const reason = normalizeInlineText(this.input.degradedReason);
		return wrapTextWithAnsi(this.theme.fg("warning", `${BODY_INDENT}${reason}`), width);
	}

	// === Preview mode ===

	/** Block navigation, block opening, and return-to-list keys. */
	private handlePreviewInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.closePreview();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.openBlock();
		} else if (isStepBackKey(data)) {
			if (this.blockNavigator.stepBack()) this.clearCache();
		} else if (isStepForwardKey(data)) {
			if (this.blockNavigator.stepForward()) this.clearCache();
		} else if (matchesKey(data, Key.pageUp)) {
			if (this.blockNavigator.page(-1)) this.clearCache();
		} else if (matchesKey(data, Key.pageDown)) {
			if (this.blockNavigator.page(1)) this.clearCache();
		} else if (matchesKey(data, Key.home)) {
			if (this.blockNavigator.moveToFirst()) this.clearCache();
		} else if (matchesKey(data, Key.end)) {
			if (this.blockNavigator.moveToLast()) this.clearCache();
		}
	}

	/** Full-block scrolling and return-to-blocks keys. */
	private handleBlockInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.closeBlock();
			return;
		}
		if (isStepBackKey(data)) {
			if (this.previewScroller.scrollBy(-1)) this.clearCache();
		} else if (isStepForwardKey(data)) {
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

	/** Open the selected category's block stream; free space has no preview. */
	private openPreview(): void {
		const row = this.legendRows[this.navigator.selected];
		if (row === undefined || row.type !== "category") return;
		this.previewRow = row;
		this.cachedPreviewEntries = undefined;
		this.clearPreviewContent();
		this.blockNavigator.reset();
		this.clearCache();
	}

	/** Return to the list with the same selected row. */
	private closePreview(): void {
		this.previewRow = undefined;
		this.openBlockIndex = undefined;
		this.cachedPreviewEntries = undefined;
		this.clearPreviewContent();
		this.clearCache();
	}

	/** Open hidden content from the selected capped block; complete and empty blocks have nothing to open. */
	private openBlock(): void {
		// The rendered stream carries the height-dependent cap the user sees, so it decides what Enter opens.
		const index = this.blockNavigator.selected;
		const block = this.cachedStream?.blocks[index];
		if (block === undefined || block.hiddenLineCount === 0) return;
		this.openBlockIndex = index;
		this.cachedBlockBody = undefined;
		this.previewScroller.reset();
		this.clearCache();
	}

	/** Return to the block stream with the same selected block. */
	private closeBlock(): void {
		this.openBlockIndex = undefined;
		this.cachedBlockBody = undefined;
		this.clearCache();
	}

	/** Drop width- and theme-dependent preview rendering. */
	private clearPreviewContent(): void {
		this.cachedContent = undefined;
		this.cachedStream = undefined;
		this.cachedBlockBody = undefined;
	}

	/** Scrollable chronological block stream for one category. */
	private renderPreview(width: number, terminalRows: number, row: CategoryLegendRow): string[] {
		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const descriptionLines = this.previewDescriptionLines(width, row);
		const descriptionLineCount = descriptionLines.length === 0 ? 0 : descriptionLines.length + 1;
		const stream = this.previewStream(width, previewBlockMaxLines(terminalRows, descriptionLineCount), row);
		const viewport = calculateViewport(
			Math.max(1, stream.layout.lines.length),
			terminalRows,
			PREVIEW_FIXED_LINE_COUNT,
			descriptionLineCount,
		);
		this.blockNavigator.setExtent(stream.layout, viewport.visibleCount);

		const lines: string[] = [border, "", this.categoryHeaderLine(row, width), ""];
		lines.push(...this.previewStreamLines(stream, viewport.visibleCount, width));
		if (viewport.showScroll) {
			lines.push(
				this.fit(
					theme.fg("dim", `${BODY_INDENT}(${this.blockNavigator.selected + 1}/${stream.blocks.length})`),
					width,
				),
			);
		}
		if (descriptionLines.length > 0) lines.push("", ...descriptionLines);
		lines.push("");
		lines.push(this.fit(hintRow(theme, previewHints(stream.blocks.length)), width));
		lines.push("", border);
		return fitToTerminalHeight(lines, terminalRows, border);
	}

	/** Full, uncapped content of the open block below its identity header. */
	private renderBlockView(
		width: number,
		terminalRows: number,
		row: CategoryLegendRow,
		entry: UsagePreviewEntry,
	): string[] {
		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const body = this.blockBodyLines(width, row, entry);
		const viewport = calculateViewport(body.length, terminalRows, BLOCK_FIXED_LINE_COUNT);
		this.previewScroller.setExtent(body.length, viewport.visibleCount);

		const lines: string[] = [
			border,
			"",
			this.categoryHeaderLine(row, width),
			"",
			this.fit(`${BODY_INDENT}${this.entryHeader(entry)}`, width),
			"",
		];
		const start = this.previewScroller.offset;
		for (let index = start; index < start + viewport.visibleCount; index++) {
			lines.push(body[index] ?? "");
		}
		if (viewport.showScroll) {
			lines.push(
				this.fit(theme.fg("dim", `${BODY_INDENT}(${this.previewScroller.visibleEnd}/${body.length})`), width),
			);
		}
		lines.push("");
		lines.push(
			this.fit(
				hintRow(theme, [
					[STEP_KEY_HINT, "Scroll"],
					["PgUp/PgDn", "Page"],
					["Esc", "Back"],
				]),
				width,
			),
		);
		lines.push("", border);
		return fitToTerminalHeight(lines, terminalRows, border);
	}

	/** Accent category title with its token and percentage metadata, shared by both preview levels. */
	private categoryHeaderLine(row: CategoryLegendRow, width: number): string {
		const theme = this.theme;
		const title = theme.fg("accent", theme.bold(normalizeInlineText(row.category.label)));
		const percent = this.plainLegendPercent(row.category.tokens);
		const meta = theme.fg(
			"muted",
			`${formatTokens(row.category.tokens)}${percent === "" ? "" : ` · ${percent}`} `,
		);
		return spreadLine(title, meta, width);
	}

	/** Visible window of the block stream, or the message an empty category shows instead. */
	private previewStreamLines(stream: PreviewStream, visibleCount: number, width: number): string[] {
		if (stream.blocks.length === 0) {
			const message = this.theme.fg("muted", `${BODY_INDENT}No content captured for this category.`);
			return Array.from({ length: visibleCount }, (_, index) => index === 0 ? this.fit(message, width) : "");
		}
		const start = this.blockNavigator.offset;
		return Array.from(
			{ length: visibleCount },
			(_, index) => this.previewStreamLine(stream, start + index, width),
		);
	}

	/** One stream line: blank separator, block content, or the block's truncation marker. */
	private previewStreamLine(stream: PreviewStream, index: number, width: number): string {
		const ref = stream.layout.lines[index];
		if (ref === undefined) return "";
		const block = stream.blocks[ref.blockIndex];
		if (block === undefined) return "";
		const selected = ref.blockIndex === this.blockNavigator.selected;
		const line = ref.lineIndex < block.lines.length
			? block.lines[ref.lineIndex] ?? ""
			: this.truncationMarker(block.hiddenLineCount, selected);
		const gutter = this.blockGutter(selected, line === "");
		return this.fit(`${gutter}${line}`, width);
	}

	/** Accent bar marking the selected block, or the plain two-column indent. */
	private blockGutter(selected: boolean, blankLine: boolean): string {
		if (!selected) return blankLine ? "" : BODY_INDENT;
		return this.theme.fg("accent", blankLine ? BLOCK_GUTTER : `${BLOCK_GUTTER} `);
	}

	/** Left-aligned truncation marker with a brighter action label on the selected block only. */
	private truncationMarker(hiddenLineCount: number, selected: boolean): string {
		const marker = `${BODY_INDENT}${this.theme.fg("dim", `… +${hiddenLineCount} lines`)}`;
		if (!selected) return marker;
		const separator = this.theme.fg("dim", " · ");
		const action = this.theme.fg("accent", "Enter - View Block");
		return `${marker}${separator}${action}`;
	}

	/** Cached blocks and their flattened line layout: bracket headers plus capped sanitized content. */
	private previewStream(width: number, maxLines: number, row: CategoryLegendRow): PreviewStream {
		const wrapWidth = previewWrapWidth(width);
		const cached = this.cachedStream;
		if (cached !== undefined && cached.wrapWidth === wrapWidth && cached.maxLines === maxLines) return cached;
		const content = this.previewContent(width, row);
		const blocks = this.previewEntries(row).map((entry, index) => {
			const lines = content[index] ?? [];
			return {
				lines: [this.entryHeader(entry), ...lines.slice(0, maxLines)],
				hiddenLineCount: Math.max(0, lines.length - maxLines),
			};
		});
		this.cachedStream = {
			wrapWidth,
			maxLines,
			blocks,
			layout: layoutPreviewBlocks(blocks.map(blockHeight)),
		};
		return this.cachedStream;
	}

	/**
	 * Cached uncapped content of the open category, one wrapped array per entry.
	 * Wrapping is the expensive step and depends on width alone, so a cap that
	 * shrinks with terminal height re-slices these lines instead of redoing it.
	 */
	private previewContent(width: number, row: CategoryLegendRow): readonly EntryLines[] {
		const wrapWidth = previewWrapWidth(width);
		if (this.cachedContent !== undefined && this.cachedContent.wrapWidth === wrapWidth) {
			return this.cachedContent.entries;
		}
		const compactSkills = row.rootId === "user-messages";
		const entries = this.previewEntries(row)
			.map((entry) => this.entryContentLines(entry, wrapWidth, compactSkills));
		this.cachedContent = { wrapWidth, entries };
		return entries;
	}

	/**
	 * Cached uncapped content of the open block, indented in place of the stream gutter. These lines
	 * are already fitted, so the cache key is the terminal width: narrow widths share a clamped wrap
	 * width while still needing their own truncation.
	 */
	private blockBodyLines(width: number, row: CategoryLegendRow, entry: UsagePreviewEntry): readonly string[] {
		if (this.cachedBlockBody !== undefined && this.cachedBlockBody.width === width) {
			return this.cachedBlockBody.lines;
		}
		const wrapWidth = previewWrapWidth(width);
		const content = this.entryContentLines(entry, wrapWidth, row.rootId === "user-messages");
		const lines = content.map((line) => line === "" ? "" : this.fit(`${BODY_INDENT}${line}`, width));
		this.cachedBlockBody = { width, lines };
		return lines;
	}

	/** Entry behind the open block, or undefined while the block view is inactive. */
	private openBlockEntry(row: CategoryLegendRow): UsagePreviewEntry | undefined {
		if (this.openBlockIndex === undefined) return undefined;
		return this.previewEntries(row)[this.openBlockIndex];
	}

	/** Collect and cache the immutable entries shared by preview body and description rendering. */
	private previewEntries(row: CategoryLegendRow): readonly UsagePreviewEntry[] {
		this.cachedPreviewEntries ??= collectPreviewEntries(row.category);
		return this.cachedPreviewEntries;
	}

	/** Bracketed entry header: dim datetime, breadcrumbs, visible tokens, and optional invisible reasoning. */
	private entryHeader(entry: UsagePreviewEntry): string {
		const theme = this.theme;
		const cells: string[] = [];
		if (entry.timestamp !== undefined) {
			cells.push(theme.fg("dim", `[${formatEntryTimestamp(entry.timestamp)}]`));
		}
		entry.breadcrumb.forEach((cell, index) => {
			const color: ThemeColor = index === 0 ? "mdHeading" : "muted";
			cells.push(
				`${theme.fg("dim", "[")}${theme.fg(color, normalizeInlineText(cell))}${theme.fg("dim", "]")}`,
			);
		});
		cells.push(theme.fg("dim", formatTokens(entry.visibleTokens ?? entry.tokens)));
		if (entry.invisibleReasoning !== undefined) {
			const { tokens, basis, encoded } = entry.invisibleReasoning;
			const marker = basis === "provider-reported" ? "≈" : "~";
			const label = encoded ? "Encoded" : "Reasoning";
			const total = (entry.visibleTokens ?? entry.tokens) + tokens;
			cells.push(
				theme.fg("dim", `+ ${label} ${marker}${formatTokens(tokens)} (${marker}${formatTokens(total)})`),
			);
		}
		return cells.join(" ");
	}

	/** Fixed explanation shown only when the thinking preview contains invisible-reasoning metadata. */
	private previewDescriptionLines(width: number, row: CategoryLegendRow): string[] {
		if (row.rootId !== "agent-thinking-messages") return [];
		const hasInvisibleReasoning = this.previewEntries(row)
			.some((entry) => entry.invisibleReasoning !== undefined);
		return hasInvisibleReasoning
			? wrapDescriptionLines(this.theme, INVISIBLE_REASONING_DESCRIPTION, "dim", width)
			: [];
	}

	/** Complete sanitized, wrapped content lines indented under the entry header. */
	private entryContentLines(entry: UsagePreviewEntry, wrapWidth: number, compactSkills: boolean): string[] {
		const lines: string[] = [];
		for (const paragraph of this.entryPreviewText(entry.text, compactSkills).split("\n")) {
			const wrapped = wrapTextWithAnsi(paragraph, wrapWidth);
			const paragraphLines = wrapped.length === 0 ? [""] : wrapped;
			for (const line of paragraphLines) lines.push(line === "" ? "" : `${BODY_INDENT}${line}`);
		}
		return lines;
	}

	/** Sanitize raw entry text and replace complete attached skills with pi-colored badges. */
	private entryPreviewText(text: string, compactSkills: boolean): string {
		const sanitized = normalizePreviewText(text);
		if (!compactSkills) return sanitized;
		return splitSkillPreview(sanitized)
			.map((segment) => segment.type === "text" ? segment.text : this.skillBadge(segment.name))
			.join("");
	}

	/** Render the same collapsed skill label/name colors used by pi's transcript component. */
	private skillBadge(name: string): string {
		const label = this.theme.fg("customMessageLabel", this.theme.bold("[skill]"));
		const safeName = normalizeInlineText(name);
		if (safeName === "") return label;
		return `${label} ${this.theme.fg("customMessageText", safeName)}`;
	}

	/** Truncate one rendered line to the supplied width. */
	private fit(line: string, width: number): string {
		return fitLine(line, width);
	}

	/** Clear render-cache keys after data, theme, or input changes. */
	private clearCache(): void {
		this.cachedWidth = undefined;
		this.cachedTerminalRows = undefined;
		this.cachedLines = undefined;
	}
}

/** Show top-level categories plus Tool Output's direct per-tool breakdown. */
function buildCategoryLegendRows(categories: readonly UsageCategory[]): CategoryLegendRow[] {
	const rows: CategoryLegendRow[] = [];
	for (const category of categories) {
		rows.push({ type: "category", category, depth: 0, rootId: category.id });
		if (category.id !== "tool-output") continue;
		for (const child of category.children ?? []) {
			rows.push({ type: "category", category: child, depth: 1, rootId: category.id });
		}
	}
	return rows;
}

/**
 * Content wrap width shared by both preview levels: gutter, inner indent, and one spare column.
 * The block view keeps the stream's narrower width, so the `… +N lines` count it opens stays exact.
 */
function previewWrapWidth(width: number): number {
	return Math.max(10, width - BODY_INDENT.length * 2 - 1);
}

/**
 * Content lines one block may show at this terminal height: enough for two whole
 * blocks, clamped between the readable floor and the standard cap. Derived from
 * the height alone, never from the viewport, whose scroll counter depends on the
 * stream this cap produces.
 */
function previewBlockMaxLines(terminalRows: number, descriptionLineCount: number): number {
	// Assume the counter row; a stream short enough to drop it loses at most one line per block.
	const visibleCount = terminalRows - PREVIEW_FIXED_LINE_COUNT - descriptionLineCount - 1;
	const fitted = Math.floor((visibleCount - TWO_BLOCK_FRAME_ROWS) / 2);
	return Math.max(PREVIEW_BLOCK_MIN_LINES, Math.min(PREVIEW_BLOCK_MAX_LINES, fitted));
}

/** Block stream hints; the selected block carries the open affordance, and an empty stream moves nowhere. */
function previewHints(blockCount: number): Array<readonly [string, string]> {
	if (blockCount === 0) return [["Esc", "Back"]];
	return [[STEP_KEY_HINT, "Navigate"], ["PgUp/PgDn", "Page"], ["Esc", "Back"]];
}

/** Stream lines one block occupies, including its truncation marker row. */
function blockHeight(block: PreviewBlock): number {
	return block.lines.length + (block.hiddenLineCount > 0 ? 1 : 0);
}

/** Entry-header datetime: DD-MM-YYYY HH:MM:SS in local time. */
function formatEntryTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	const pad = (value: number) => `${value}`.padStart(2, "0");
	return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}` +
		` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Marker distinguishing top-level occupancy, compacted data, and nested breakdowns. */
function categoryMarker(categoryId: string, depth: number): string {
	if (depth > 0) return BREAKDOWN_MARKER;
	return categoryId === "compacted-data" ? COMPACTED_CELL : FULL_CELL;
}

/** Token estimate carried by category, buffer, or free-space legend rows. */
function legendTokens(row: LegendRow): number {
	return row.type === "category" ? row.category.tokens : row.tokens;
}

/** Stable semantic theme color for one category across map cells and legend markers. */
function categoryColor(categoryId: string | undefined): ThemeColor {
	switch (categoryId) {
		case "system-prompt":
		case "system-tools":
			return "mdHeading";
		case "custom-tools":
			return "accent";
		case "mcp-tools":
			return "mdLink";
		case "context-files":
			return "mdCodeBlock";
		case "skills":
			return "customMessageLabel";
		case "user-messages":
			return "syntaxString";
		case "agent-text-messages":
			return "syntaxFunction";
		case "agent-thinking-messages":
			return "thinkingXhigh";
		case "agent-tool-call-messages":
			return "syntaxKeyword";
		case "tool-output":
			return "toolOutput";
		case "extension-messages":
			return "syntaxType";
		case "compacted-data":
			return "thinkingHigh";
		default:
			return "muted";
	}
}

/** Compact token count: 951, 3.7k, 43.8k, 1M. */
export function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}`;
	if (tokens < 1_000_000) return `${trimTrailingZero((tokens / 1_000).toFixed(1))}k`;
	return `${trimTrailingZero((tokens / 1_000_000).toFixed(1))}M`;
}

/** Percentage with one decimal below 10%: 0.4%, 4.2%, 96%. */
export function formatPercent(ratio: number): string {
	const percent = ratio * 100;
	if (percent >= 10) return `${Math.round(percent)}%`;
	return `${trimTrailingZero(percent.toFixed(1))}%`;
}

/** Drop a redundant ".0" fraction from a fixed-point rendering. */
function trimTrailingZero(value: string): string {
	return value.endsWith(".0") ? value.slice(0, -2) : value;
}
