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
		mdLink: "#191a1b",
		mdCodeBlock: "#1c1d1e",
		customMessageLabel: "#1f2021",
		syntaxString: "#222324",
		toolOutput: "#252627",
		syntaxType: "#28292a",
		thinkingHigh: "#2b2c2d",
		syntaxFunction: "#2e2f30",
		thinkingXhigh: "#313233",
		syntaxKeyword: "#343536",
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
			{ id: "custom-tools", label: "Custom Tools", tokens: 1_000 },
			{ id: "mcp-tools", label: "MCP Tools", tokens: 1_200 },
			{ id: "context-files", label: "Memory (AGENTS.md)", tokens: 1_500 },
			{ id: "skills", label: "Skills", tokens: 1_000 },
			{ id: "user-messages", label: "User Messages", tokens: 3_000 },
			{ id: "agent-text-messages", label: "Agent Text Messages", tokens: 4_000 },
			{ id: "agent-thinking-messages", label: "Agent Thinking Messages", tokens: 2_000 },
			{ id: "agent-tool-call-messages", label: "Agent Tool Call Messages", tokens: 4_000 },
			{
				id: "tool-output",
				label: "Tool Output",
				tokens: 5_000,
				children: [
					{
						id: "tool-result:read",
						label: "read",
						tokens: 3_000,
						entries: [
							{
								timestamp: Date.UTC(2026, 6, 11, 14, 2, 19),
								breadcrumb: ["read"],
								tokens: 3_000,
								text: "read result content line\nsecond line",
							},
						],
					},
					{
						id: "tool-result:web_search",
						label: "web_search",
						tokens: 2_000,
						entries: [
							{
								timestamp: Date.UTC(2026, 6, 11, 14, 2, 11),
								breadcrumb: ["web_search"],
								tokens: 2_000,
								text: "search result content",
							},
						],
					},
				],
			},
			{ id: "extension-messages", label: "Extensions", tokens: 600 },
			{ id: "compacted-data", label: "Compacted Data", tokens: 5_000 },
		],
		estimatedTokens: 43_800,
	};
}

/** Remove SGR sequences so tests can inspect visual columns. */
function stripSgr(text: string): string {
	return text.replace(/\u001b\[[\d;]*m/g, "");
}

test("UsageView renders the 14x14 map and matching category legend with semantic colors", () => {
	const view = new UsageView(createTheme(), { usage: usage() }, () => {}, () => 30);
	const lines = view.render(80);
	const plain = lines.map(stripSgr);

	assert.equal(lines.length, 30);
	assert.equal(plain[2], "Context Usage");
	assert.match(lines[2] ?? "", /\u001b\[38;2;1;2;3m.*Context Usage/);
	const modelIndex = plain.findIndex((line) => line.includes("Model:"));
	assert.equal(modelIndex, 4);
	assert.match(plain[modelIndex] ?? "", /^  [■◧▦⛶]( [■◧▦⛶]){13}\s+Model:/);
	assert.equal(plain.filter((line) => /^  [■◧▦⛶]( [■◧▦⛶]){13}/.test(line)).length, 14);
	assert.ok(plain.some((line) => line.includes("claude-opus-4-8")));
	assert.ok(plain.some((line) => line.includes("43.8k/1m tokens (4.4%)")));
	assert.ok(plain.some((line) => line.includes("Category:")));
	assert.ok(plain.some((line) => /■ System Prompt:\s+3.7k\s+0.4%/.test(line)));
	assert.ok(plain.some((line) => /■ Tool Output:\s+5k\s+0.5%/.test(line)));
	assert.ok(plain.some((line) => /⛶ Free Space:\s+956.2k\s+96%/.test(line)));
	const categoryColors: Array<readonly [string, string]> = [
		["22;23;24", "■"], // System Prompt and System Tools intentionally share one color.
		["1;2;3", "■"],
		["25;26;27", "■"],
		["28;29;30", "■"],
		["31;32;33", "■"],
		["34;35;36", "■"],
		["37;38;39", "■"],
		["40;41;42", "■"],
		["43;44;45", "▦"],
		["46;47;48", "■"],
		["49;50;51", "■"],
		["52;53;54", "■"],
	];
	for (const [color, marker] of categoryColors) {
		assert.ok(lines.some((line) => line.includes(`\u001b[38;2;${color}m${marker}`)),
			`missing category color ${color}`);
	}
	assert.ok(lines.some((line) => /\u001b\[38;2;16;17;18m⛶/.test(line)));
	const valueColumns = [
		["System Prompt", "3.7k"],
		["System Tools", "11.8k"],
		["Memory (AGENTS.md)", "1.5k"],
		["Tool Output", "5k"],
		["Free Space", "956.2k"],
	].map(([label, value]) => {
		const line = plain.find((candidate) => candidate.includes(`${label}:`));
		assert.ok(line !== undefined);
		return line.indexOf(value);
	});
	assert.equal(new Set(valueColumns).size, 1);
	const percentColumns = ["0.4%", "1.2%", "0.1%", "0.5%", "96%"].map((percent) => {
		const line = plain.find((candidate) => candidate.includes(percent));
		assert.ok(line !== undefined);
		return line.indexOf(percent);
	});
	assert.equal(new Set(percentColumns).size, 1);
	const memoryLine = plain.find((line) => line.includes("Memory (AGENTS.md):"));
	assert.match(memoryLine ?? "", /Memory \(AGENTS\.md\):\s+1\.5k/);
	const descriptionIndex = plain.findIndex((line) => line.includes("The map estimates next-request usage"));
	const hintsIndex = plain.findIndex((line) => line.includes("Esc Close"));
	assert.ok(descriptionIndex > 0 && hintsIndex === descriptionIndex + 2);
	assert.equal(plain[descriptionIndex]?.indexOf("The map"), 2);
	assert.equal(plain[hintsIndex]?.indexOf("↑↓"), 2);
	assert.match(plain[hintsIndex] ?? "", /↑↓ Navigate · Enter Preview · Esc Close/);
	assert.match(lines[hintsIndex] ?? "", /\u001b\[38;2;16;17;18mEsc/);
	assert.match(lines[hintsIndex] ?? "", /\u001b\[38;2;7;8;9m Close/);

	// The first category row starts selected: fixed-column accent cursor and accent label/values.
	const selectedRow = lines.find((line) => stripSgr(line).includes("→ "));
	assert.ok(selectedRow !== undefined);
	assert.match(stripSgr(selectedRow), /→ ■ System Prompt:/);
	assert.match(selectedRow, /\u001b\[38;2;1;2;3m→ /);
	assert.match(selectedRow, /\u001b\[38;2;1;2;3mSystem Prompt:/);
	assert.match(selectedRow, /\u001b\[38;2;1;2;3m3\.7k/);
	assert.doesNotMatch(selectedRow, /\u001b\[48;/);
});

test("UsageView reports unknown post-compaction usage and closes on Escape", () => {
	let closed = false;
	const view = new UsageView(
		createTheme(),
		{
			usage: {
				...usage(),
				reported: { contextWindow: 1_000_000 },
				categories: [{ id: "user-messages", label: "User Messages", tokens: 50_000 }],
				estimatedTokens: 50_000,
			},
		},
		() => {
			closed = true;
		},
		() => 24,
	);

	const rendered = stripSgr(view.render(80).join("\n"));
	assert.match(rendered, /Usage unknown · 1m token window/);
	assert.match(rendered, /■ User Messages:\s+50k/);
	assert.match(rendered, /⛶ Free Space:\s+950k/);

	view.handleInput("\u001b");
	assert.equal(closed, true);
});

test("UsageView expands only direct Tool Output children and scrolls long tool lists", () => {
	const tools = Array.from({ length: 15 }, (_, index) => ({
		id: `tool-result:tool_${index + 1}`,
		label: `tool_${index + 1}`,
		tokens: 100,
	}));
	const nestedUsage: ContextUsageSnapshot = {
		...usage(1_600),
		categories: [
			{
				id: "system-tools",
				label: "System Tools",
				tokens: 100,
				children: [{ id: "item:read", label: "read should stay collapsed", tokens: 100 }],
			},
			{ id: "tool-output", label: "Tool Output", tokens: 1_500, children: tools },
		],
		estimatedTokens: 1_600,
	};
	const view = new UsageView(createTheme(), { usage: nestedUsage }, () => {}, () => 24);
	const initial = view.render(80).map(stripSgr);
	assert.ok(initial.some((line) => /· tool_1:\s+100\s+0%/.test(line)));
	assert.ok(!initial.some((line) => line.includes("tool_15:")));
	assert.ok(!initial.some((line) => line.includes("read should stay collapsed")));
	assert.ok(!initial.some((line) => line.includes("Tool Results:")));
	assert.ok(initial.some((line) => /\(1\/\d+\)/.test(line)));

	view.handleInput("\u001b[4~"); // End
	const ending = view.render(80).map(stripSgr);
	assert.ok(ending.some((line) => /· tool_15:\s+100\s+0%/.test(line)));
	assert.ok(ending.some((line) => /→ ⛶ Free Space:\s+998\.4k\s+100%/.test(line)));
});

test("UsageView keeps the selection inside the viewport across height reflows", () => {
	let rows = 24;
	const tools = Array.from({ length: 15 }, (_, index) => ({
		id: `tool-result:tool_${index + 1}`,
		label: `tool_${index + 1}`,
		tokens: 100,
	}));
	const overflowUsage: ContextUsageSnapshot = {
		...usage(1_500),
		categories: [{ id: "tool-output", label: "Tool Output", tokens: 1_500, children: tools }],
		estimatedTokens: 1_500,
	};
	const view = new UsageView(createTheme(), { usage: overflowUsage }, () => {}, () => rows);

	view.render(80);
	for (let step = 0; step < 9; step++) view.handleInput("\u001b[B");
	assert.ok(view.render(80).some((line) => /→\s+· tool_9:/.test(stripSgr(line))));

	rows = 16;
	assert.ok(view.render(80).some((line) => /→\s+· tool_9:/.test(stripSgr(line))));
	rows = 24;
	assert.ok(view.render(80).some((line) => /→\s+· tool_9:/.test(stripSgr(line))));
	for (const width of [40, 60, 120]) {
		assert.ok(view.render(width).some((line) => /→\s+· tool_9:/.test(stripSgr(line))), `width ${width}`);
	}
});

test("UsageView opens a category content preview and returns to the same row", () => {
	let closed = false;
	const view = new UsageView(createTheme(), { usage: usage() }, () => {
		closed = true;
	}, () => 24);

	// Select Tool Output (aggregate) and open it.
	view.render(80);
	for (let step = 0; step < 10; step++) view.handleInput("\u001b[B");
	const listBefore = view.render(80).join("\n");
	assert.match(stripSgr(listBefore), /→ ■ Tool Output:/);

	view.handleInput("\r");
	const preview = view.render(80);
	const plain = preview.map(stripSgr);
	assert.equal(plain[2]?.indexOf("Tool Output"), 0);
	assert.match(preview[2] ?? "", /\u001b\[38;2;1;2;3m.*Tool Output/);
	assert.match(plain[2] ?? "", /5k tokens · 0\.5%/);
	assert.equal(preview[3], "");

	// Entries render chronologically: bracketed dim datetime + muted breadcrumb + dim tokens.
	const searchHeader = plain.findIndex((line) =>
		/^  \[\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}\] \[web_search\] 2k$/.test(line)
	);
	const readHeader = plain.findIndex((line) =>
		/^  \[\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}\] \[read\] 3k$/.test(line)
	);
	assert.ok(searchHeader >= 0 && readHeader >= 0);
	assert.ok(searchHeader < readHeader, "entries are chronological, not size-ordered");
	assert.match(preview[readHeader] ?? "", /\u001b\[38;2;16;17;18m\[\d{2}-\d{2}-\d{4}/);
	assert.match(preview[readHeader] ?? "", /\u001b\[38;2;7;8;9mread/);
	// Content indented two spaces past the header; blank row between entries.
	assert.equal(plain[searchHeader + 1], "    search result content");
	assert.equal(plain[searchHeader + 2], "");
	assert.equal(plain[readHeader + 1], "    read result content line");
	assert.equal(plain[readHeader + 2], "    second line");
	assert.ok(!plain.some((line) => /[■◧▦⛶]( [■◧▦⛶]){13}/.test(line)));
	const hintIndex = plain.findIndex((line) => line.includes("↑↓ Scroll"));
	assert.ok(hintIndex > 0);
	assert.match(plain[hintIndex] ?? "", /↑↓ Scroll · PgUp\/PgDn Page · Esc Back/);

	// First Escape returns to the same selected list row; second closes the view.
	view.handleInput("\u001b");
	assert.equal(closed, false);
	assert.equal(view.render(80).join("\n"), listBefore);
	view.handleInput("\u001b");
	assert.equal(closed, true);
});

test("UsageView previews empty categories, free space, and long content safely", () => {
	const tools = Array.from({ length: 30 }, (_, index) => ({
		id: `tool-result:tool_${index + 1}`,
		label: `tool_${index + 1}`,
		tokens: 100,
		entries: [
			{
				timestamp: Date.UTC(2026, 6, 11, 14, 0, index + 1),
				breadcrumb: [`tool_${index + 1}`],
				tokens: 100,
				text: `tool_${index + 1} output`,
			},
		],
	}));
	const mixedUsage: ContextUsageSnapshot = {
		...usage(4_000),
		categories: [
			{ id: "user-messages", label: "User Messages", tokens: 1_000 },
			{ id: "tool-output", label: "Tool Output", tokens: 3_000, children: tools },
		],
		estimatedTokens: 4_000,
	};
	const view = new UsageView(createTheme(), { usage: mixedUsage }, () => {}, () => 20);

	// Category without entries: explicit empty message instead of raw content.
	view.render(80);
	view.handleInput("\r");
	const leafPreview = view.render(80).map(stripSgr);
	assert.equal(leafPreview[2]?.indexOf("User Messages"), 0);
	assert.ok(leafPreview.some((line) => line.includes("No content captured for this category.")));
	view.handleInput("\u001b");

	// Aggregate overflow: entry stream scrolls and stays bounded.
	view.handleInput("\u001b[B");
	view.handleInput("\r");
	const top = view.render(80).map(stripSgr);
	assert.ok(top.some((line) => line.includes("[tool_1]")));
	assert.ok(!top.some((line) => line.includes("[tool_30]")));
	assert.ok(top.some((line) => /\(1\/\d+\)/.test(line)));
	view.handleInput("\u001b[4~"); // End
	const bottom = view.render(80).map(stripSgr);
	assert.ok(bottom.some((line) => line.includes("[tool_30]")));
	assert.ok(!bottom.some((line) => line.includes("[tool_1]")));
	view.handleInput("\u001b[1~"); // Home
	assert.ok(view.render(80).map(stripSgr).some((line) => line.includes("[tool_1]")));
	view.handleInput("\u001b");

	// Enter on the free-space row opens nothing.
	view.handleInput("\u001b[4~"); // End → Free Space
	const freeSelected = view.render(80).join("\n");
	assert.match(stripSgr(freeSelected), /→ ⛶ Free Space:/);
	view.handleInput("\r");
	assert.equal(view.render(80).join("\n"), freeSelected);

	// Preview lines respect narrow widths and short terminals.
	view.handleInput("\u001b[1~");
	view.handleInput("\u001b[B");
	view.handleInput("\r");
	for (const width of [24, 40, 66]) {
		for (const line of view.render(width)) {
			assert.ok(visibleWidth(line) <= width, `preview line exceeds width ${width}: ${JSON.stringify(line)}`);
		}
	}
});

test("UsageView caps long entries, sanitizes content, and omits snapshot datetimes", () => {
	const longText = Array.from({ length: 30 }, (_, line) => `line ${line + 1}`).join("\n");
	const cappedUsage: ContextUsageSnapshot = {
		...usage(2_000),
		categories: [
			{
				id: "tool-output",
				label: "Tool Output",
				tokens: 1_000,
				children: [
					{
						id: "tool-result:bash",
						label: "bash",
						tokens: 1_000,
						entries: [
							{
								timestamp: Date.UTC(2026, 6, 11, 15, 0, 0),
								breadcrumb: ["bash"],
								tokens: 1_000,
								text: `\u001b]0;evil\u0007${longText}`,
							},
						],
					},
				],
			},
			{
				id: "system-prompt",
				label: "System Prompt",
				tokens: 1_000,
				entries: [{ breadcrumb: ["Base Prompt"], tokens: 1_000, text: "You are pi." }],
			},
		],
		estimatedTokens: 2_000,
	};
	const view = new UsageView(createTheme(), { usage: cappedUsage }, () => {}, () => 40);

	// Tool Output: 20 content lines then a dim overflow marker; escapes stripped.
	view.render(100);
	view.handleInput("\r");
	const capped = view.render(100);
	const plainCapped = capped.map(stripSgr);
	assert.ok(plainCapped.some((line) => line === "    line 20"));
	assert.ok(!plainCapped.some((line) => line.includes("line 21")));
	const marker = plainCapped.findIndex((line) => line === "    … +10 lines");
	assert.ok(marker >= 0);
	assert.match(capped[marker] ?? "", /\u001b\[38;2;16;17;18m… \+10 lines/);
	assert.ok(!capped.some((line) => line.includes("\u0007") || line.includes("evil")));
	view.handleInput("\u001b");

	// Snapshot-backed category: breadcrumb-only header without a datetime cell.
	// Two rows down: past the expanded `bash` child row to System Prompt.
	view.handleInput("\u001b[B");
	view.handleInput("\u001b[B");
	view.handleInput("\r");
	const snapshotPreview = view.render(100).map(stripSgr);
	const header = snapshotPreview.findIndex((line) => /^  \[Base Prompt\] 1k$/.test(line));
	assert.ok(header >= 0, "snapshot entry header has no datetime cell");
	assert.equal(snapshotPreview[header + 1], "    You are pi.");
});

test("UsageView respects width and height changes", () => {
	let rows = 30;
	const reason = "Silent probe unavailable: no model is selected. Extension additions were not observed.";
	const view = new UsageView(createTheme(), { usage: usage(), degradedReason: reason }, () => {}, () => rows);

	for (const width of [24, 40, 60, 80, 120]) {
		for (const line of view.render(width)) {
			assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
		}
	}
	const compactMap = view.render(60).map(stripSgr);
	assert.ok(compactMap.some((line) => /^  [■◧▦⛶]{14}\s+Model:/.test(line)));
	const categoryOnly = view.render(40).map(stripSgr);
	assert.ok(categoryOnly.some((line) => /^  Model: claude-opus-4-8$/.test(line)));
	assert.ok(!categoryOnly.some((line) => /[■◧▦⛶]{14}/.test(line)));

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
