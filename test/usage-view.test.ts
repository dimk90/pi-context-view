import assert from "node:assert/strict";
import { test } from "node:test";

import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { ContextUsageSnapshot } from "../src/model.ts";
import { formatPercent, formatTokens, UsageView } from "../src/ui/usage-view.ts";

const FG_COLORS: ThemeColor[] = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
	"thinkingText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
	"mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
	"mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
	"syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
	"syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
	"thinkingXhigh", "thinkingMax", "bashMode",
];
const BG_COLORS = [
	"selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
] as const;

/** Theme with recognizable semantic foreground sequences. */
function createTheme(): Theme {
	const foregroundOverrides: Partial<Record<ThemeColor, string>> = {
		accent: "#010203",
		text: "#040506",
		muted: "#070809",
		dim: "#101112",
		warning: "#131415",
		mdHeading: "#161718",
	};
	const fgColors = Object.fromEntries(FG_COLORS.map((color) => [color, foregroundOverrides[color] ?? "#aabbcc"]));
	const bgColors = Object.fromEntries(BG_COLORS.map((color) => [color, "#112233"]));
	return new Theme(
		fgColors as ConstructorParameters<typeof Theme>[0],
		bgColors as ConstructorParameters<typeof Theme>[1],
		"truecolor",
	);
}

/** Usage fixture with pi-reported metadata and representative categories. */
function usage(tokens = 43_800): ContextUsageSnapshot {
	return {
		computedAt: new Date("2026-07-11T12:00:00Z"),
		modelLabel: "claude-opus-4-8",
		reported: { tokens, contextWindow: 1_000_000, percent: tokens / 10_000 },
		categories: [
			{ id: "system-prompt", label: "System Prompt", tokens: 3_700 },
			{ id: "system-tools", label: "System Tools", tokens: 11_800 },
			{ id: "messages", label: "Messages", tokens: 23_700 },
			{ id: "extensions", label: "Extensions", tokens: 600 },
			{ id: "compacted", label: "Compacted Data", tokens: 4_000 },
		],
		estimatedTokens: 43_800,
	};
}

/** Remove SGR sequences so tests can inspect visual columns. */
function stripSgr(text: string): string {
	return text.replace(/\u001b\[[\d;]*m/g, "");
}

test("UsageView renders pi-reported metadata and estimated categories with semantic colors", () => {
	const view = new UsageView(createTheme(), { compute: () => usage() }, () => {}, () => 24);
	const lines = view.render(80);
	const plain = lines.map(stripSgr);

	assert.equal(lines.length, 24);
	assert.match(plain[2] ?? "", /^Context Usage.*Model: claude-opus-4-8/);
	assert.match(lines[2] ?? "", /\u001b\[38;2;1;2;3m.*Context Usage/);
	assert.ok(plain.some((line) => line.includes("43.8k/1m tokens (4.4%)")));
	const estimatedHeader = lines.find((line) => stripSgr(line) === "[ESTIMATED]");
	assert.match(estimatedHeader ?? "", /\u001b\[38;2;22;23;24m\[ESTIMATED\]/);
	assert.ok(plain.some((line) => /  System Prompt\s+3.7k 0.4%/.test(line)));
	assert.ok(plain.some((line) => /  Free Space\s+956.2k 96%/.test(line)));
	assert.ok(plain.some((line) => /  TOTAL \(estimated\)\s+43.8k/.test(line)));
	const descriptionIndex = plain.findIndex((line) => line.includes("Estimated current/next-request composition"));
	const hintsIndex = plain.findIndex((line) => line.includes("R Refresh"));
	assert.ok(descriptionIndex > 0 && hintsIndex === descriptionIndex + 2);
	assert.equal(plain[descriptionIndex]?.indexOf("Estimated"), 2);
	assert.equal(plain[hintsIndex]?.indexOf("R"), 2);
	assert.match(lines[hintsIndex] ?? "", /\u001b\[38;2;16;17;18mR/);
	assert.match(lines[hintsIndex] ?? "", /\u001b\[38;2;7;8;9m Refresh/);
});

test("UsageView refreshes on r, reports unknown post-compaction usage, and closes on Escape", () => {
	let computations = 0;
	let closed = false;
	const view = new UsageView(
		createTheme(),
		{
			compute: () => {
				computations++;
				if (computations === 1) return usage();
				return {
					...usage(),
					reported: { contextWindow: 1_000_000 },
					categories: [{ id: "messages", label: "Messages", tokens: 50_000 }],
					estimatedTokens: 50_000,
				};
			},
		},
		() => {
			closed = true;
		},
		() => 24,
	);

	assert.equal(computations, 1);
	assert.match(stripSgr(view.render(80).join("\n")), /TOTAL \(estimated\).*43\.8k/);
	view.handleInput("r");
	assert.equal(computations, 2);
	const refreshed = stripSgr(view.render(80).join("\n"));
	assert.match(refreshed, /Usage unknown until the next response · 1m token window/);
	assert.match(refreshed, /TOTAL \(estimated\).*50k/);
	assert.doesNotMatch(refreshed, /Free Space/);

	view.handleInput("\u001b");
	assert.equal(closed, true);
});

test("UsageView respects width and height changes", () => {
	let rows = 30;
	const reason = "Silent probe unavailable: no model is selected. Extension additions were not observed.";
	const view = new UsageView(createTheme(), { compute: () => usage(), degradedReason: reason }, () => {}, () => rows);

	for (const width of [24, 40, 80, 120]) {
		for (const line of view.render(width)) {
			assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
		}
	}

	const tall = view.render(40);
	assert.equal(tall.length, 30);
	rows = 12;
	const short = view.render(40);
	assert.equal(short.length, 12);
	assert.notStrictEqual(short, tall);
	assert.match(stripSgr(short[0] ?? ""), /^─+$/);
	assert.match(stripSgr(short.at(-1) ?? ""), /^─+$/);
});

test("formatTokens and formatPercent keep compact readable precision", () => {
	assert.equal(formatTokens(951), "951");
	assert.equal(formatTokens(3_700), "3.7k");
	assert.equal(formatTokens(50_000), "50k");
	assert.equal(formatTokens(1_000_000), "1m");
	assert.equal(formatPercent(0.004), "0.4%");
	assert.equal(formatPercent(0.042), "4.2%");
	assert.equal(formatPercent(0.956), "96%");
});
