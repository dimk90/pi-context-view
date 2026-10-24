/** Per-test themes and assertions about rendered content, not production sentences. */
import assert from "node:assert/strict";

import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { THEME_COLOR_NAMES } from "../../src/config.ts";

/** Independent theme instance; modifications cannot affect concurrently running tests. */
export function createTheme(): Theme {
	const overrides: Partial<Record<ThemeColor, string>> = {
		accent: "#010203", text: "#040506", muted: "#070809", dim: "#101112", warning: "#131415",
		success: "#373839", error: "#3a3b3c", mdHeading: "#161718", mdLink: "#191a1b", mdCodeBlock: "#1c1d1e",
		customMessageLabel: "#1f2021", syntaxString: "#222324", toolOutput: "#252627", syntaxType: "#28292a",
		thinkingHigh: "#2b2c2d", syntaxFunction: "#2e2f30", thinkingXhigh: "#313233", syntaxKeyword: "#343536",
	};
	const colors = Object.fromEntries(THEME_COLOR_NAMES.map((name, index) =>
		[name, overrides[name] ?? `#${(0x808080 + index * 0x010101).toString(16)}`]));
	const theme = new Theme(colors as Record<ThemeColor, string>, {
		selectedBg: "#112233", userMessageBg: "#112233", customMessageBg: "#112233",
		toolPendingBg: "#112233", toolSuccessBg: "#112233", toolErrorBg: "#112233",
	}, "truecolor");
	// Inverse must remain observable when Chalk detects no terminal
	theme.inverse = (text) => `\u001b[7m${text}\u001b[27m`;
	return theme;
}

/** Remove only SGR, so unsafe non-styling controls remain visible to privacy assertions. */
export function stripSgr(text: string): string {
	return text.replace(/\u001b\[[\d;]*m/g, "");
}

/** Remove SGR and pi's fake-cursor markers, which the TUI resolves into reverse video before output. */
export function stripStyle(text: string): string {
	return stripSgr(text).replace(/\u001b_pi:\/?fc\u0007/g, "");
}

/** Compare prose across wrapping without discarding non-whitespace content or controls. */
export function frameText(lines: readonly string[]): string {
	return stripSgr(lines.join("\n")).replace(/\s+/g, " ").trim();
}

/** Whether a nonempty expected block occurs in order, allowing wrapping and indentation changes. */
export function containsBlock(lines: readonly string[], block: readonly string[]): boolean {
	const expected = frameText(block);
	assert.notEqual(expected, "", "an empty block cannot prove rendering");
	return frameText(lines).includes(expected);
}

/** Every nonempty line of the independently rendered block must appear together, or all must be absent. */
export function wholeOrAbsent(lines: readonly string[], block: readonly string[]): boolean {
	const expected = block.map(stripSgr).map((line) => line.trim()).filter(Boolean);
	assert.ok(expected.length > 0, "a collapse assertion needs content");
	const text = frameText(lines);
	const present = containsBlock(lines, block);
	for (const line of expected) {
		assert.equal(text.includes(line.replace(/\s+/g, " ")), present, "partial description block");
	}
	return present;
}

/** Bound the complete frame, using terminal cells rather than string length. */
export function assertFrame(lines: readonly string[], width: number, height: number): void {
	assert.ok(lines.length <= height, `${width}x${height}: height`);
	assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}x${height}: width`);
}
