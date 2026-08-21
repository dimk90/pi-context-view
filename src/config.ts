/**
 * Override-only user configuration.
 *
 * Defaults live in this module; the global
 * `<agent dir>/extensions/pi-context-view.json` carries overrides only. The
 * file is never auto-created and never backfilled with missing defaults, so
 * later default changes still reach users who did not override them. An
 * absent file or omitted value is silent; unreadable, unparseable, and invalid
 * configuration warns and degrades to defaults instead of failing a view.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir, type ThemeColor } from "@earendil-works/pi-coding-agent";

/** Global override file; project-local configuration is intentionally unsupported. */
export const CONFIG_FILE_NAME = "pi-context-view.json";

/** Category id of the legend and map rows tracking the auto-compaction reserve. */
export const AUTO_COMPACT_BUFFER_CATEGORY_ID = "auto-compact-buffer";
/** Category id of the legend and map rows tracking unoccupied context. */
export const FREE_SPACE_CATEGORY_ID = "free-space";

/** Color of a usage category without its own configurable entry, such as a tool-output child. */
const FALLBACK_CATEGORY_COLOR: ThemeColor = "muted";

/** Pi foreground theme color keys a configured category may name. */
const THEME_COLOR_NAMES = [
	"accent", "border", "borderAccent", "borderMuted", "success",
	"error", "warning", "muted", "dim", "text", "thinkingText",
	"searchMatchText", "userMessageText", "customMessageText",
	"customMessageLabel", "toolTitle", "toolOutput", "mdHeading",
	"mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder",
	"mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet", "toolDiffAdded",
	"toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
	"syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber",
	"syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff",
	"thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
	"thinkingXhigh", "thinkingMax", "bashMode",
] as const satisfies readonly ThemeColor[];

/**
 * Every configurable usage color: the category id the view resolves, the flat
 * config key overriding it, and the built-in default.
 */
const CATEGORY_COLOR_SPECS = {
	"system-prompt": { key: "systemPromptColor", color: "mdHeading" },
	"system-tools": { key: "systemToolsColor", color: "mdHeading" },
	"custom-tools": { key: "customToolsColor", color: "accent" },
	"mcp-tools": { key: "mcpToolsColor", color: "mdLink" },
	"context-files": { key: "memoryColor", color: "mdCodeBlock" },
	"skills": { key: "skillsColor", color: "customMessageLabel" },
	"user-messages": { key: "userMessagesColor", color: "syntaxString" },
	"agent-text-messages": { key: "agentTextMessagesColor", color: "syntaxFunction" },
	"agent-thinking-messages": { key: "agentThinkingMessagesColor", color: "thinkingXhigh" },
	"agent-tool-call-messages": { key: "agentToolCallMessagesColor", color: "syntaxKeyword" },
	"tool-output": { key: "toolOutputColor", color: "toolOutput" },
	"extension-messages": { key: "extensionsColor", color: "syntaxType" },
	"compacted-data": { key: "compactedDataColor", color: "thinkingHigh" },
	[AUTO_COMPACT_BUFFER_CATEGORY_ID]: { key: "autoCompactBufferColor", color: "dim" },
	[FREE_SPACE_CATEGORY_ID]: { key: "freeSpaceColor", color: "dim" },
} as const satisfies Record<string, { readonly key: string; readonly color: ThemeColor }>;

/** Config keys mapped to the category they color. */
const CONFIG_KEY_CATEGORIES: ReadonlyMap<string, string> = new Map(
	Object.entries(CATEGORY_COLOR_SPECS).map(([categoryId, spec]) => [spec.key, categoryId]),
);

/** Fast runtime membership check for configured Pi foreground color names. */
const THEME_COLORS: ReadonlySet<string> = new Set(THEME_COLOR_NAMES);

/** Resolved color of each configurable usage category, keyed by category id. */
export type CategoryColors = ReadonlyMap<string, ThemeColor>;

/** All user-configurable state of one runtime. */
export interface ContextViewConfig {
	readonly categoryColors: CategoryColors;
}

/** Configuration for one view open, with the problems that degraded it to defaults. */
export interface ConfigLoadResult {
	readonly config: ContextViewConfig;
	/** Empty when the file is absent or fully valid; reported once per file revision. */
	readonly warnings: readonly string[];
}

/** Built-in colors, used whenever the file omits or misconfigures a category. */
export const DEFAULT_CATEGORY_COLORS: CategoryColors = new Map(
	Object.entries(CATEGORY_COLOR_SPECS).map(([categoryId, spec]) => [categoryId, spec.color] as const),
);

/** Configuration used when no override file exists. */
export const DEFAULT_CONFIG: ContextViewConfig = { categoryColors: DEFAULT_CATEGORY_COLORS };

/** Absolute path of the global override file. */
export function getConfigFilePath(): string {
	return join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
}

/**
 * Per-runtime configuration cache.
 *
 * The file is read lazily on the first view open, then re-read only after its
 * modification time changes, so edits apply without restarting pi.
 */
export class ConfigStore {
	private readonly filePath: string;
	private cached: ContextViewConfig = DEFAULT_CONFIG;
	private cachedModifiedTime: number | undefined;
	private pendingWarnings: readonly string[] = [];
	private loaded = false;

	/** Create a store over the global override file, or an explicit path in tests. */
	public constructor(filePath: string = getConfigFilePath()) {
		this.filePath = filePath;
	}

	/**
	 * Configuration for one view open. Warnings are returned once per file
	 * revision, so reopening a view never repeats a report for an unchanged file.
	 */
	public load(): ConfigLoadResult {
		const modifiedTime = readModifiedTime(this.filePath);
		if (!this.loaded || modifiedTime !== this.cachedModifiedTime) {
			const result = loadConfigFile(this.filePath);
			this.cached = result.config;
			this.pendingWarnings = result.warnings;
			this.cachedModifiedTime = modifiedTime;
			this.loaded = true;
		}
		const warnings = this.pendingWarnings;
		this.pendingWarnings = [];
		return { config: this.cached, warnings };
	}
}

/** Read and validate one override file; a missing file yields defaults without warnings. */
export function loadConfigFile(filePath: string): ConfigLoadResult {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return { config: DEFAULT_CONFIG, warnings: [] };
		return degraded(`Cannot read ${filePath}: ${describeError(error)}.`);
	}
	try {
		return applyOverrides(JSON.parse(text));
	} catch (error) {
		return degraded(`Cannot parse ${filePath}: ${describeError(error)}.`);
	}
}

/** Color of one usage category, falling back for categories without a configurable entry. */
export function resolveCategoryColor(colors: CategoryColors, categoryId: string | undefined): ThemeColor {
	if (categoryId === undefined) return FALLBACK_CATEGORY_COLOR;
	return colors.get(categoryId) ?? FALLBACK_CATEGORY_COLOR;
}

/** Merge valid overrides onto the built-in defaults, reporting every ignored entry. */
function applyOverrides(raw: unknown): ConfigLoadResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return degraded(`${CONFIG_FILE_NAME} must contain a JSON object.`);
	}
	const colors = new Map(DEFAULT_CATEGORY_COLORS);
	const warnings: string[] = [];
	for (const [key, value] of Object.entries(raw)) {
		const categoryId = CONFIG_KEY_CATEGORIES.get(key);
		if (categoryId === undefined) {
			warnings.push(`Ignoring unknown ${CONFIG_FILE_NAME} key "${key}".`);
			continue;
		}
		if (!isThemeColor(value)) {
			warnings.push(`Ignoring invalid theme color for "${key}"; using its default.`);
			continue;
		}
		colors.set(categoryId, value);
	}
	return { config: { categoryColors: colors }, warnings };
}

/** Whole-file failure: built-in defaults plus one explanatory warning. */
function degraded(reason: string): ConfigLoadResult {
	return { config: DEFAULT_CONFIG, warnings: [`${reason} Using default configuration.`] };
}

/** Accept only theme color keys the active theme is guaranteed to define. */
function isThemeColor(value: unknown): value is ThemeColor {
	return typeof value === "string" && THEME_COLORS.has(value);
}

/** Modification time in milliseconds, or undefined while the file is absent or unreadable. */
function readModifiedTime(filePath: string): number | undefined {
	try {
		return statSync(filePath).mtimeMs;
	} catch {
		return undefined;
	}
}

/** Recognize an absent file, the expected state for users who never configured anything. */
function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Normalize an unknown throw into a short reportable reason. */
function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
