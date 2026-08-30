import assert from "node:assert/strict";
import { test } from "node:test";

import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";

import { THEME_COLOR_NAMES } from "../src/config.ts";
import { colorize } from "../src/ui/color.ts";

const BG_COLORS = [
	"selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
] as const;

/** Theme painting every foreground slot with one recognizable color. */
function createTheme(mode: "truecolor" | "256color"): Theme {
	const fgColors = Object.fromEntries(THEME_COLOR_NAMES.map((color: ThemeColor) => [color, "#aabbcc"]));
	const bgColors = Object.fromEntries(BG_COLORS.map((color) => [color, "#112233"]));
	return new Theme(
		fgColors as ConstructorParameters<typeof Theme>[0],
		bgColors as ConstructorParameters<typeof Theme>[1],
		mode,
	);
}

test("colorize paints a theme color through the active theme", () => {
	const theme = createTheme("truecolor");

	assert.equal(colorize(theme, "accent", "■"), theme.fg("accent", "■"));
	assert.equal(colorize(theme, "accent", "■"), "\u001b[38;2;170;187;204m■\u001b[39m");
});

test("colorize paints a literal color independently of the theme", () => {
	const theme = createTheme("truecolor");

	assert.equal(colorize(theme, "#80ff01", "■"), "\u001b[38;2;128;255;1m■\u001b[39m");
	// Repeating a color reuses the cached literal theme instead of rebuilding it.
	assert.equal(colorize(theme, "#80ff01", "⛶"), "\u001b[38;2;128;255;1m⛶\u001b[39m");
});

test("colorize down-converts a literal color for a 256-color terminal", () => {
	const limited = createTheme("256color");

	// pi's own conversion: the closest 6x6x6 cube entry, here (2, 5, 0).
	assert.equal(colorize(limited, "#80ff01", "■"), "\u001b[38;5;118m■\u001b[39m");
	assert.equal(colorize(limited, "#000000", "■"), "\u001b[38;5;16m■\u001b[39m");
	assert.equal(colorize(limited, "accent", "■"), limited.fg("accent", "■"));
});
