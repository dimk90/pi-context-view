/**
 * Temporary plain-text renderer retained from v1 for diagnostics while the
 * interactive dialog is built. No pi API access.
 */
import type { InjectionItem } from "./model.ts";

/** Render measured items as an aligned source/token table. */
export function renderReport(items: readonly InjectionItem[]): string {
	const ordered = [
		...sortBySizeDescending(items.filter((item) => item.source.native)),
		...sortBySizeDescending(items.filter((item) => !item.source.native)),
	];
	const total = ordered.reduce((sum, item) => sum + item.tokens, 0);

	const rows: Array<[string, string]> = ordered.map((item) => [formatLabel(item), formatTokens(item.tokens)]);
	rows.push(["TOTAL", formatTokens(total)]);

	const labelWidth = Math.max("SOURCE".length, ...rows.map(([label]) => label.length));
	const countWidth = Math.max("TOKENS (est.)".length, ...rows.map(([, count]) => count.length));

	const lines = ["Initial context injections:", ""];
	lines.push(`  ${"SOURCE".padEnd(labelWidth)}  ${"TOKENS (est.)".padStart(countWidth)}`);
	const body = rows.map(([label, count]) => `  ${label.padEnd(labelWidth)}  ${count.padStart(countWidth)}`);
	const totalLine = body.pop();
	lines.push(...body);
	lines.push(`  ${"-".repeat(labelWidth + countWidth + 2)}`);
	if (totalLine !== undefined) lines.push(totalLine);
	return lines.join("\n");
}

function formatLabel(item: InjectionItem): string {
	return item.source.native ? `pi: ${item.label}` : `${item.source.label}: ${item.label}`;
}

function sortBySizeDescending(items: readonly InjectionItem[]): InjectionItem[] {
	return [...items].sort((a, b) => b.tokens - a.tokens);
}

function formatTokens(tokens: number): string {
	return tokens.toLocaleString("en-US");
}
