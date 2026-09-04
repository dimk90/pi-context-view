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
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir, type ThemeColor } from "@earendil-works/pi-coding-agent";

/** Global override file; project-local configuration is intentionally unsupported. */
export const CONFIG_FILE_NAME = "pi-context-view.json";

/** Category id of the legend and map rows tracking the auto-compaction reserve. */
export const AUTO_COMPACT_BUFFER_CATEGORY_ID = "auto-compact-buffer";
/** Category id of the legend and map rows tracking unoccupied context. */
export const FREE_SPACE_CATEGORY_ID = "free-space";

/** Color of a usage category without its own configurable entry, such as a tool-output child. */
const FALLBACK_CATEGORY_COLOR: ThemeColor = "muted";

/** Literal color values, accepted as `#rgb` or `#rrggbb` in either case. */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Pi foreground theme color keys a configured category may name. */
export const THEME_COLOR_NAMES = [
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

/** Resolves to its argument only for `never`, turning a non-empty type into a compile error. */
type AssertNever<T extends never> = T;

/**
 * Compile-time proof that the list above stays complete. `satisfies` alone
 * rejects only removed or renamed keys; this fails the build when pi adds a
 * theme color, which would otherwise be silently rejected as unconfigurable.
 */
type _EveryThemeColorIsListed = AssertNever<Exclude<ThemeColor, (typeof THEME_COLOR_NAMES)[number]>>;

/**
 * Every configurable usage color: the category id the view resolves, the flat
 * config key overriding it, and the built-in default. Listed in legend order,
 * which a created override file reproduces.
 */
const CATEGORY_COLOR_SPECS = {
	"system-prompt": { key: "systemPromptColor", color: "mdHeading" },
	"context-files": { key: "instructionFilesColor", color: "mdCodeBlock" },
	"skills": { key: "skillsColor", color: "customMessageLabel" },
	"built-in-tools": { key: "builtInToolsColor", color: "mdHeading" },
	"custom-tools": { key: "customToolsColor", color: "accent" },
	"mcp-tools": { key: "mcpToolsColor", color: "mdLink" },
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

/** Flat config key of one configurable category color. */
type ConfigKey = (typeof CATEGORY_COLOR_SPECS)[keyof typeof CATEGORY_COLOR_SPECS]["key"];

/** Config keys mapped to the category they color. */
const CONFIG_KEY_CATEGORIES: ReadonlyMap<string, string> = new Map(
	Object.entries(CATEGORY_COLOR_SPECS).map(([categoryId, spec]) => [spec.key, categoryId]),
);

/**
 * Renamed keys still honored, mapped to their current name, so a rename never
 * silently drops an override an existing file already carries. The value type
 * fails the build when a rename points at a key no category declares.
 */
const RENAMED_CONFIG_KEYS: ReadonlyMap<string, ConfigKey> = new Map([
	["memoryColor", "instructionFilesColor"],
	["systemToolsColor", "builtInToolsColor"],
]);

/** Fast runtime membership check for configured Pi foreground color names. */
const THEME_COLORS: ReadonlySet<string> = new Set(THEME_COLOR_NAMES);

/** Theme-independent color, always stored expanded to a lowercase `#rrggbb`. */
export type HexColor = `#${string}`;

/**
 * One configured color: a pi theme color key, which follows theme changes, or
 * a literal hex value, which stays fixed across themes.
 */
export type CategoryColor = ThemeColor | HexColor;

/** Resolved color of each configurable usage category, keyed by category id. */
export type CategoryColors = ReadonlyMap<string, CategoryColor>;

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

/** Outcome of explicitly creating the defaults-populated override file. */
export type ConfigCreationResult =
	| { readonly type: "created"; readonly filePath: string }
	| { readonly type: "exists"; readonly filePath: string }
	| { readonly type: "failed"; readonly filePath: string; readonly reason: string };

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
 * Create the global override file populated with every built-in default. The
 * single `O_EXCL` write is atomic and never overwrites or modifies an existing
 * path, so a concurrent creator loses the race instead of the file's content.
 */
export function createDefaultConfigFile(filePath: string = getConfigFilePath()): ConfigCreationResult {
	try {
		// Separate from the write below: mkdir also reports EEXIST, for a parent that is a file.
		mkdirSync(dirname(filePath), { recursive: true });
	} catch (error) {
		return { type: "failed", filePath, reason: describeError(error) };
	}
	try {
		writeFileSync(filePath, serializeDefaultConfig(), { encoding: "utf8", flag: "wx" });
		return { type: "created", filePath };
	} catch (error) {
		if (hasErrorCode(error, "EEXIST")) return { type: "exists", filePath };
		return { type: "failed", filePath, reason: describeError(error) };
	}
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
		// An absent file is the expected state for users who never configured anything.
		if (hasErrorCode(error, "ENOENT")) return { config: DEFAULT_CONFIG, warnings: [] };
		return degraded(`Cannot read ${filePath}: ${describeError(error)}.`);
	}
	try {
		return applyOverrides(JSON.parse(text));
	} catch (error) {
		return degraded(`Cannot parse ${filePath}: ${describeError(error)}.`);
	}
}

/** Color of one usage category, falling back for categories without a configurable entry. */
export function resolveCategoryColor(colors: CategoryColors, categoryId: string | undefined): CategoryColor {
	if (categoryId === undefined) return FALLBACK_CATEGORY_COLOR;
	return colors.get(categoryId) ?? FALLBACK_CATEGORY_COLOR;
}

/** Whether a resolved color is a literal value rather than a theme color key. */
export function isHexColor(color: CategoryColor): color is HexColor {
	return color.startsWith("#");
}

/** Serialize every built-in default as an editable, flat override file. */
function serializeDefaultConfig(): string {
	const defaults = Object.fromEntries(
		Object.values(CATEGORY_COLOR_SPECS).map((spec) => [spec.key, spec.color]),
	);
	return `${JSON.stringify(defaults, undefined, 2)}\n`;
}

/** Merge valid overrides onto the built-in defaults, reporting every ignored entry. */
function applyOverrides(raw: unknown): ConfigLoadResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return degraded(`${CONFIG_FILE_NAME} must contain a JSON object.`);
	}
	const colors = new Map(DEFAULT_CATEGORY_COLORS);
	const warnings: string[] = [];
	for (const [key, value] of Object.entries(raw)) {
		const currentKey = RENAMED_CONFIG_KEYS.get(key);
		// The current name always wins, so a file carrying both names loads order-independently.
		if (currentKey !== undefined && currentKey in raw) continue;
		const categoryId = CONFIG_KEY_CATEGORIES.get(currentKey ?? key);
		if (categoryId === undefined) {
			warnings.push(`Ignoring unknown ${CONFIG_FILE_NAME} key "${key}".`);
			continue;
		}
		const color = parseColor(value);
		if (color === undefined) {
			warnings.push(`Ignoring invalid color for "${key}"; expected a theme color name or a hex value.`);
			continue;
		}
		colors.set(categoryId, color);
	}
	return { config: { categoryColors: colors }, warnings };
}

/** Whole-file failure: built-in defaults plus one explanatory warning. */
function degraded(reason: string): ConfigLoadResult {
	return { config: DEFAULT_CONFIG, warnings: [`${reason} Using default configuration.`] };
}

/** Normalize one configured color value, or reject it as unusable. */
function parseColor(value: unknown): CategoryColor | undefined {
	if (typeof value !== "string") return undefined;
	if (isThemeColor(value)) return value;
	return parseHexColor(value);
}

/** Accept only theme color keys the active theme is guaranteed to define. */
function isThemeColor(value: unknown): value is ThemeColor {
	return typeof value === "string" && THEME_COLORS.has(value);
}

/** Expand shorthand and lowercase, so rendering always resolves six hex digits. */
function parseHexColor(value: string): HexColor | undefined {
	if (!HEX_COLOR_PATTERN.test(value)) return undefined;
	const digits = value.slice(1).toLowerCase();
	if (digits.length === 6) return `#${digits}`;
	return `#${[...digits].map((digit) => `${digit}${digit}`).join("")}`;
}

/** Modification time in milliseconds, or undefined while the file is absent or unreadable. */
function readModifiedTime(filePath: string): number | undefined {
	try {
		return statSync(filePath).mtimeMs;
	} catch {
		return undefined;
	}
}

/** Recognize one errno code: an absent file to read, or a create-only write refusing to clobber. */
function hasErrorCode(error: unknown, code: "ENOENT" | "EEXIST"): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Normalize an unknown throw into a short reportable reason. */
function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
