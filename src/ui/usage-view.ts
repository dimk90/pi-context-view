/**
 * Focused `/context usage` view: read-only estimated context composition with
 * a proportional context-window map and pi-reported metadata.
 */
import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { ContextUsageSnapshot, UsageCategory } from "../model.ts";
import {
	BODY_INDENT,
	DEFAULT_TERMINAL_ROWS,
	fitLine,
	fitToTerminalHeight,
	hintRow,
	normalizeTerminalRows,
	spreadLine,
} from "./layout.ts";
import { buildUsageMap, type UsageMapCell } from "./usage-map.ts";

const USAGE_DESCRIPTION = "The map estimates next-request usage; provider token counts may differ.";
const USAGE_TAIL_LINE_COUNT = 6;
const DETAIL_HEADER_LINE_COUNT = 4;
const MAX_LEGEND_VALUE_COLUMN = 28;
const LEGEND_VALUE_GAP = 2;
const MAP_SIDE_BY_SIDE_MIN_WIDTH = 52;
const SPACED_MAP_MIN_WIDTH = 72;
const MAP_COLUMN_GAP = 2;
const SPACED_MAP_COLUMN_GAP = 3;
const FULL_CELL = "■";
const PARTIAL_CELL = "◧";
const COMPACTED_CELL = "▦";
const FREE_CELL = "⛶";

/** Everything the Usage view renders, classified once when the view opens. */
export interface UsageViewInput {
	readonly usage: ContextUsageSnapshot;
	readonly degradedReason?: string;
}

interface CategoryLegendRow {
	readonly type: "category";
	readonly category: UsageCategory;
	readonly depth: number;
	readonly rootId: string;
}

interface FreeLegendRow {
	readonly type: "free";
	readonly tokens: number;
}

type LegendRow = CategoryLegendRow | FreeLegendRow;

interface LegendColumns {
	readonly value: number;
	readonly tokenWidth: number;
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
	private detailOffset = 0;
	private detailRowCount = 0;
	private detailViewportRows = 1;
	private detailHasOverflow = false;
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
	}

	/** Handle category scrolling and close keys; other input is ignored. */
	public handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.up)) this.scrollDetails(-1);
		else if (matchesKey(data, Key.down)) this.scrollDetails(1);
		else if (matchesKey(data, Key.pageUp)) this.scrollDetails(-this.detailViewportRows);
		else if (matchesKey(data, Key.pageDown)) this.scrollDetails(this.detailViewportRows);
		else if (matchesKey(data, Key.home)) this.scrollDetails(-this.detailRowCount);
		else if (matchesKey(data, Key.end)) this.scrollDetails(this.detailRowCount);
	}

	/** Render a cached fullscreen frame for the current width and terminal height. */
	public render(width: number): string[] {
		const terminalRows = normalizeTerminalRows(this.getTerminalRows());
		if (
			this.cachedLines !== undefined &&
			this.cachedWidth === width &&
			this.cachedTerminalRows === terminalRows
		) {
			return this.cachedLines;
		}

		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const prefix = [border, "", this.headerLine(width), "", ...this.degradedWarningLines(width)];
		const availableDashboardRows = Math.max(1, terminalRows - prefix.length - USAGE_TAIL_LINE_COUNT);
		const dashboard = this.dashboardLines(width, availableDashboardRows).slice(0, availableDashboardRows);
		while (dashboard.length < availableDashboardRows) dashboard.push("");
		const hints: Array<readonly [string, string]> = [];
		if (this.detailHasOverflow) hints.push(["↑↓", "Scroll"]);
		hints.push(["Esc", "Close"]);
		const tail = [
			"",
			this.fit(theme.fg("muted", `${BODY_INDENT}${USAGE_DESCRIPTION}`), width),
			"",
			this.fit(hintRow(theme, hints), width),
			"",
			border,
		];
		const lines = fitToTerminalHeight([...prefix, ...dashboard, ...tail], terminalRows, border);

		this.cachedWidth = width;
		this.cachedTerminalRows = terminalRows;
		this.cachedLines = lines;
		return lines;
	}

	/** Invalidate theme-dependent rendered output. */
	public invalidate(): void {
		this.clearCache();
	}

	/** Accent title at the top of the fullscreen view. */
	private headerLine(width: number): string {
		return this.fit(this.theme.fg("accent", this.theme.bold("Context Usage")), width);
	}

	/** Render the map and legend side by side, or only details when width/window data is insufficient. */
	private dashboardLines(width: number, rows: number): string[] {
		const map = buildUsageMap(this.usage);
		if (map === undefined || width < MAP_SIDE_BY_SIDE_MIN_WIDTH) {
			const detailWidth = Math.max(1, width - BODY_INDENT.length);
			return this.detailLines(detailWidth, rows).map((line) => this.fit(`${BODY_INDENT}${line}`, width));
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
		const details = this.detailLines(detailWidth, rows);
		const lineCount = Math.max(mapLines.length, details.length);
		return Array.from({ length: lineCount }, (_, index) => {
			const mapLine = mapLines[index] ?? " ".repeat(mapWidth);
			const detail = this.fit(details[index] ?? "", detailWidth);
			return this.fit(`${mapLine}${" ".repeat(gap)}${detail}`, width);
		});
	}

	/** Model/usage metadata, top-level categories, and direct Tool Output children. */
	private detailLines(width: number, rows: number): string[] {
		const theme = this.theme;
		const legendRows: LegendRow[] = buildCategoryLegendRows(this.usage.categories);
		const freeTokens = this.freeSpaceTokens();
		if (freeTokens !== undefined) legendRows.push({ type: "free", tokens: freeTokens });
		const viewportRows = Math.max(0, rows - DETAIL_HEADER_LINE_COUNT);
		this.detailRowCount = legendRows.length;
		this.detailViewportRows = Math.max(1, viewportRows);
		this.detailOffset = Math.min(this.detailOffset, this.maximumDetailOffset());
		this.detailHasOverflow = legendRows.length > viewportRows;

		const heading = theme.fg("mdHeading", theme.bold("Category:"));
		const counter = this.detailHasOverflow
			? theme.fg("dim", `(${this.detailOffset + 1}/${legendRows.length})`)
			: "";
		const columns = this.legendColumns(legendRows, width);
		const visibleRows = legendRows
			.slice(this.detailOffset, this.detailOffset + viewportRows)
			.map((row) => this.legendLine(row, columns, width));
		return [
			`${theme.fg("dim", "Model:")} ${theme.fg("muted", this.usage.modelLabel ?? "Unavailable")}`,
			this.reportedSummary(width),
			"",
			counter === "" ? heading : spreadLine(heading, counter, width),
			...visibleRows,
		].slice(0, rows);
	}

	/** Pi-reported usage/window metadata, including the unknown-after-compaction state. */
	private reportedSummary(width: number): string {
		const reported = this.usage.reported;
		if (reported === undefined) return this.fit(this.theme.fg("muted", "Context usage unavailable."), width);
		const contextWindow = formatTokens(reported.contextWindow);
		if (reported.tokens === undefined) {
			return this.fit(this.theme.fg("muted", `Usage unknown · ${contextWindow} token window`), width);
		}
		const percent = reported.percent === undefined ? "" : ` (${formatPercent(reported.percent / 100)})`;
		return this.fit(
			this.theme.fg("text", `${formatTokens(reported.tokens)}/${contextWindow} tokens${percent}`),
			width,
		);
	}

	/** Estimated remaining space, or undefined without a usable context window. */
	private freeSpaceTokens(): number | undefined {
		const contextWindow = this.usage.reported?.contextWindow;
		if (contextWindow === undefined || contextWindow <= 0) return undefined;
		return Math.max(0, contextWindow - this.usage.estimatedTokens);
	}

	/** Earliest shared token column plus the width needed to align percentages. */
	private legendColumns(rows: readonly LegendRow[], width: number): LegendColumns {
		const labelWidth = Math.max(1, ...rows.map((row) => this.plainLegendLabel(row).length));
		const tokenWidth = Math.max(1, ...rows.map((row) => formatTokens(legendTokens(row)).length));
		const percentWidth = Math.max(0, ...rows.map((row) => this.plainLegendPercent(legendTokens(row)).length));
		const rightWidth = tokenWidth + (percentWidth > 0 ? LEGEND_VALUE_GAP + percentWidth : 0);
		const idealValue = Math.min(MAX_LEGEND_VALUE_COLUMN, labelWidth + LEGEND_VALUE_GAP);
		return {
			value: Math.max(1, Math.min(idealValue, width - rightWidth)),
			tokenWidth,
		};
	}

	/** One aligned hierarchy row with independent token and percentage columns. */
	private legendLine(row: LegendRow, columns: LegendColumns, width: number): string {
		const left = fitLine(this.styledLegendLabel(row), columns.value);
		const leftPadding = " ".repeat(Math.max(0, columns.value - visibleWidth(left)));
		const tokens = formatTokens(legendTokens(row));
		const valueColor = row.type === "category" && row.depth > 1 ? "dim" : "muted";
		const tokenPadding = " ".repeat(Math.max(0, columns.tokenWidth - tokens.length));
		const percent = this.plainLegendPercent(legendTokens(row));
		const percentPart = percent === ""
			? ""
			: `${" ".repeat(LEGEND_VALUE_GAP)}${this.theme.fg("dim", percent)}`;
		return fitLine(
			`${left}${leftPadding}${this.theme.fg(valueColor, tokens)}${tokenPadding}${percentPart}`,
			width,
		);
	}

	/** Unstyled hierarchy label used to choose the shared value column. */
	private plainLegendLabel(row: LegendRow): string {
		if (row.type === "free") return `${FREE_CELL} Free Space:`;
		const indent = "  ".repeat(row.depth);
		return `${indent}${categoryMarker(row.category.id, row.depth)} ${row.category.label}:`;
	}

	/** Themed hierarchy label; child values remain breakdowns of their top-level parent. */
	private styledLegendLabel(row: LegendRow): string {
		if (row.type === "free") {
			return `${this.theme.fg("dim", FREE_CELL)} ${this.theme.fg("text", "Free Space:")}`;
		}
		const indent = "  ".repeat(row.depth);
		const color = categoryColor(row.rootId);
		const marker = this.theme.fg(color, categoryMarker(row.category.id, row.depth));
		const labelColor = row.depth === 0 ? "text" : row.depth === 1 ? "muted" : "dim";
		return `${indent}${marker} ${this.theme.fg(labelColor, `${row.category.label}:`)}`;
	}

	/** Percentage text used by the independently aligned rightmost column. */
	private plainLegendPercent(tokens: number): string {
		const contextWindow = this.usage.reported?.contextWindow;
		if (contextWindow === undefined || contextWindow <= 0) return "";
		return formatPercent(tokens / contextWindow);
	}

	/** Colored occupied/partial/free glyph for one map cell. */
	private mapCell(cell: UsageMapCell): string {
		if (cell.fill === "free") return this.theme.fg("dim", FREE_CELL);
		const glyph = cell.categoryId === "compacted-data"
			? COMPACTED_CELL
			: cell.fill === "full" ? FULL_CELL : PARTIAL_CELL;
		return this.theme.fg(categoryColor(cell.categoryId), glyph);
	}

	/** Move the category viewport while preserving its current bounds. */
	private scrollDetails(delta: number): void {
		const nextOffset = Math.max(0, Math.min(this.maximumDetailOffset(), this.detailOffset + delta));
		if (nextOffset === this.detailOffset) return;
		this.detailOffset = nextOffset;
		this.clearCache();
	}

	/** Last valid first row for the current category viewport. */
	private maximumDetailOffset(): number {
		return Math.max(0, this.detailRowCount - this.detailViewportRows);
	}

	/** Wrapped degraded-capture warning placed above the dashboard. */
	private degradedWarningLines(width: number): string[] {
		if (this.input.degradedReason === undefined) return [];
		return wrapTextWithAnsi(this.theme.fg("warning", `${BODY_INDENT}${this.input.degradedReason}`), width);
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

/** Marker distinguishing top-level occupancy, compacted data, and nested breakdowns. */
function categoryMarker(categoryId: string, depth: number): string {
	if (depth > 0) return "·";
	return categoryId === "compacted-data" ? COMPACTED_CELL : FULL_CELL;
}

/** Token estimate carried by either category or free-space legend rows. */
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

/** Compact token count: 951, 3.7k, 43.8k, 1m. */
export function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}`;
	if (tokens < 1_000_000) return `${trimTrailingZero((tokens / 1_000).toFixed(1))}k`;
	return `${trimTrailingZero((tokens / 1_000_000).toFixed(1))}m`;
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
