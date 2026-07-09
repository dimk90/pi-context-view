/**
 * Pure report rendering: format measured components as an aligned plain-text
 * table. No pi API access — unit-testable.
 */
import type { MeasuredComponent } from "./measure.ts";

/**
 * Render the report: pi components first, then extension components, each
 * sorted by size descending, followed by a total row. Token counts are
 * estimates (chars/4 heuristic), hence the "est." label.
 */
export function renderReport(components: MeasuredComponent[]): string {
	const ordered = [
		...sortBySizeDescending(components.filter((item) => item.group === "pi")),
		...sortBySizeDescending(components.filter((item) => item.group === "extensions")),
	];
	const total = ordered.reduce((sum, item) => sum + item.tokens, 0);

	const rows: Array<[string, string]> = ordered.map((item) => [item.label, formatTokens(item.tokens)]);
	rows.push(["TOTAL", formatTokens(total)]);

	const labelWidth = Math.max("SOURCE".length, ...rows.map(([label]) => label.length));
	const countWidth = Math.max("TOKENS (est.)".length, ...rows.map(([, count]) => count.length));

	const lines = ["Initial context injections:", ""];
	lines.push(`  ${"SOURCE".padEnd(labelWidth)}  ${"TOKENS (est.)".padStart(countWidth)}`);
	const body = rows.map(([label, count]) => `  ${label.padEnd(labelWidth)}  ${count.padStart(countWidth)}`);
	const totalLine = body.pop() as string;
	lines.push(...body);
	lines.push(`  ${"-".repeat(labelWidth + countWidth + 2)}`);
	lines.push(totalLine);
	return lines.join("\n");
}

function sortBySizeDescending(components: MeasuredComponent[]): MeasuredComponent[] {
	return [...components].sort((a, b) => b.tokens - a.tokens);
}

function formatTokens(tokens: number): string {
	return tokens.toLocaleString("en-US");
}
