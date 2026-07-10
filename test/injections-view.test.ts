import assert from "node:assert/strict";
import { test } from "node:test";

import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

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

function createTheme(): Theme {
	const fgColors = Object.fromEntries(FG_COLORS.map((color) => [color, "#aabbcc"]));
	const bgColors = Object.fromEntries(BG_COLORS.map((color) => [color, "#112233"]));
	return new Theme(
		fgColors as ConstructorParameters<typeof Theme>[0],
		bgColors as ConstructorParameters<typeof Theme>[1],
		"truecolor",
	);
}

import type { InitialSnapshot, InjectionGroup, InjectionItem } from "../src/model.ts";
import { InjectionsView, type RuntimeToggle } from "../src/ui/injections-view.ts";

function item(id: string, sourceId: string, native: boolean, tokens: number): InjectionItem {
	return {
		id,
		phase: "initial",
		kind: "message",
		source: { id: sourceId, label: sourceId, native },
		label: `${id} with a moderately long label for truncation checks`,
		chars: tokens * 4,
		tokens,
		text: id,
	};
}

function group(sourceId: string, native: boolean, items: InjectionItem[]): InjectionGroup {
	return {
		source: { id: sourceId, label: sourceId, native },
		items,
		totalTokens: items.reduce((sum, entry) => sum + entry.tokens, 0),
	};
}

function snapshot(itemsPerGroup: number): InitialSnapshot {
	const piItems = Array.from({ length: itemsPerGroup }, (_, index) => item(`pi-${index}`, "pi", true, 1_234_567));
	const extensionItems = Array.from({ length: itemsPerGroup }, (_, index) => item(`ext-${index}`, "npm:web", false, 42));
	const groups = [group("pi", true, piItems), group("npm:web", false, extensionItems)];
	return {
		origin: "synthetic-probe",
		capturedAt: new Date("2026-07-10T12:00:00Z"),
		groups,
		totalTokens: groups.reduce((sum, entry) => sum + entry.totalTokens, 0),
	};
}

function createRuntime(): RuntimeToggle & { enabled: boolean } {
	return {
		enabled: false,
		isEnabled() {
			return this.enabled;
		},
		setEnabled(enabled: boolean) {
			this.enabled = enabled;
		},
	};
}

function createView(itemsPerGroup = 8, degradedReason?: string): InjectionsView {
	return new InjectionsView(
		createTheme(),
		{ snapshot: snapshot(itemsPerGroup), degradedReason, runtime: createRuntime() },
		() => {},
	);
}

test("InjectionsView keeps every rendered line within the width", () => {
	for (const width of [24, 40, 66, 120]) {
		const view = createView(8, "Silent probe unavailable: no model is selected. Extension additions were not observed.");
		for (const line of view.render(width)) {
			assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
		}
	}
});

test("InjectionsView navigation scrolls and Escape closes", () => {
	let closed = false;
	const runtime = createRuntime();
	const view = new InjectionsView(createTheme(), { snapshot: snapshot(30), runtime }, () => {
		closed = true;
	});

	const before = view.render(80).join("\n");
	view.handleInput("\u001b[B");
	const afterDown = view.render(80).join("\n");
	assert.notEqual(afterDown, before);

	view.handleInput("\u001b[4~"); // End
	const atEnd = view.render(80);
	assert.match(atEnd.join("\n"), /TOTAL/);

	view.handleInput("r");
	assert.equal(runtime.enabled, true);
	assert.match(view.render(80).join("\n"), /logging: on/);

	view.handleInput("\u001b");
	assert.equal(closed, true);
});
