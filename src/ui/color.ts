/**
 * Rendering of configured colors.
 *
 * A theme color key is painted by the active theme, so it keeps following
 * theme changes. A literal hex value is painted through a pi `Theme` built
 * over that single color, which reuses pi's own conversion: truecolor escapes
 * where the terminal supports them, and the closest 256-color index otherwise.
 */
import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";

import { type CategoryColor, type HexColor, isHexColor, THEME_COLOR_NAMES } from "../config.ts";

/** Foreground slot read back from a literal theme, whose slots all hold one color. */
const LITERAL_SLOT: ThemeColor = "text";

/** Backgrounds a literal theme never paints; pi maps the empty value to its reset sequence. */
const LITERAL_BACKGROUNDS = {
	selectedBg: "",
	userMessageBg: "",
	customMessageBg: "",
	toolPendingBg: "",
	toolSuccessBg: "",
	toolErrorBg: "",
} as const;

/**
 * Literal themes, keyed by color and color mode. A map render paints hundreds
 * of cells, so the themes are built once instead of per painted cell; a
 * runtime configures at most one per category.
 */
const literalThemes = new Map<string, Theme>();

/** Paint text with one configured color, whether it names a theme color or a literal value. */
export function colorize(theme: Theme, color: CategoryColor, text: string): string {
	if (!isHexColor(color)) return theme.fg(color, text);
	return literalTheme(color, theme.getColorMode()).fg(LITERAL_SLOT, text);
}

/** Cached single-color theme converting one hex value for the active color mode. */
function literalTheme(color: HexColor, mode: ReturnType<Theme["getColorMode"]>): Theme {
	const key = `${mode} ${color}`;
	const cached = literalThemes.get(key);
	if (cached !== undefined) return cached;
	const created = new Theme(uniformForeground(color), LITERAL_BACKGROUNDS, mode);
	literalThemes.set(key, created);
	return created;
}

/** Every foreground slot set to one color; the cast rests on the compile-checked key list. */
function uniformForeground(color: HexColor): Record<ThemeColor, HexColor> {
	return Object.fromEntries(THEME_COLOR_NAMES.map((name) => [name, color])) as Record<ThemeColor, HexColor>;
}
