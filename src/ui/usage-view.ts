/**
 * Focused `/context usage` view: read-only estimated context composition with
 * pi-reported usage metadata and on-demand `r` recomputation.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

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

const USAGE_DESCRIPTION = "Estimated current/next-request composition; not exact provider accounting.";
const USAGE_TAIL_LINE_COUNT = 8;

/** Everything the Usage view renders; `compute` re-runs classification on demand. */
export interface UsageViewInput {
	compute(): ContextUsageSnapshot;
	readonly degradedReason?: string;
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
	private usage: ContextUsageSnapshot;
	private cachedWidth: number | undefined;
	private cachedTerminalRows: number | undefined;
	private cachedLines: string[] | undefined;

	/** Create a view and compute its first on-demand snapshot. */
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
		this.usage = input.compute();
	}

	/** Handle refresh and close keys; other input is ignored. */
	public handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
			return;
		}
		if (data === "r") {
			this.usage = this.input.compute();
			this.clearCache();
		}
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
		const lines: string[] = [border, ""];
		lines.push(this.headerLine(width));
		lines.push("");
		lines.push(this.reportedLine(width));
		if (this.input.degradedReason !== undefined) {
			lines.push(this.fit(theme.fg("warning", `${BODY_INDENT}${this.input.degradedReason}`), width));
		}
		lines.push("");
		lines.push(this.fit(theme.fg("mdHeading", theme.bold("[ESTIMATED]")), width));
		for (const category of this.usage.categories) {
			lines.push(this.categoryLine(category, width));
		}
		const freeSpace = this.freeSpaceLine(width);
		if (freeSpace !== undefined) lines.push(freeSpace);
		const paddingCount = Math.max(0, terminalRows - lines.length - USAGE_TAIL_LINE_COUNT);
		for (let pad = 0; pad < paddingCount; pad++) lines.push("");
		lines.push("");
		lines.push(this.totalLine(width));
		lines.push("");
		lines.push(this.fit(theme.fg("muted", `${BODY_INDENT}${USAGE_DESCRIPTION}`), width));
		lines.push("");
		lines.push(
			this.fit(
				hintRow(theme, [
					["R", "Refresh"],
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

	/** Invalidate theme-dependent rendered output. */
	public invalidate(): void {
		this.clearCache();
	}

	/** Accent title with current model metadata aligned right when available. */
	private headerLine(width: number): string {
		const theme = this.theme;
		const title = theme.fg("accent", theme.bold("Context Usage"));
		if (this.usage.modelLabel === undefined) return this.fit(title, width);
		const model = `${theme.fg("dim", "Model:")} ${theme.fg("muted", this.usage.modelLabel)} `;
		return spreadLine(title, model, width);
	}

	/** Pi-reported usage/window metadata, including the unknown-after-compaction state. */
	private reportedLine(width: number): string {
		const theme = this.theme;
		const reported = this.usage.reported;
		if (reported === undefined) {
			return this.fit(theme.fg("muted", `${BODY_INDENT}Context window usage unavailable.`), width);
		}
		const window = formatTokens(reported.contextWindow);
		if (reported.tokens === undefined) {
			const note = `Usage unknown until the next response · ${window} token window`;
			return this.fit(theme.fg("muted", `${BODY_INDENT}${note}`), width);
		}
		const percent = reported.percent === undefined ? "" : ` (${formatPercent(reported.percent / 100)})`;
		const summary = `${formatTokens(reported.tokens)}/${window} tokens${percent}`;
		return this.fit(`${BODY_INDENT}${theme.fg("text", summary)}`, width);
	}

	/** One top-level category row; constituent breakdown remains in the semantic model. */
	private categoryLine(category: UsageCategory, width: number): string {
		const theme = this.theme;
		const label = theme.fg("text", category.label);
		const value = `${theme.fg("muted", formatTokens(category.tokens))}${this.percentSuffix(category.tokens)}  `;
		return spreadLine(`${BODY_INDENT}${label}`, value, width);
	}

	/** Remaining window estimate; requires pi-reported tokens and window. */
	private freeSpaceLine(width: number): string | undefined {
		const reported = this.usage.reported;
		if (reported?.tokens === undefined) return undefined;
		const free = Math.max(0, reported.contextWindow - reported.tokens);
		const theme = this.theme;
		const label = theme.fg("text", "Free Space");
		const value = `${theme.fg("muted", formatTokens(free))}${this.percentSuffix(free)}  `;
		return spreadLine(`${BODY_INDENT}${label}`, value, width);
	}

	/** Fixed estimated-total summary below the category list. */
	private totalLine(width: number): string {
		const theme = this.theme;
		const label = theme.bold(theme.fg("text", "TOTAL (estimated)"));
		const value = theme.bold(theme.fg("text", formatTokens(this.usage.estimatedTokens)));
		return spreadLine(`${BODY_INDENT}${label}`, `${value}  `, width);
	}

	/** Dim share of the pi-reported context window, or empty when the window is unknown. */
	private percentSuffix(tokens: number): string {
		const window = this.usage.reported?.contextWindow;
		if (window === undefined || window <= 0) return "";
		return this.theme.fg("dim", ` ${formatPercent(tokens / window)}`);
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
