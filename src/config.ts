/**
 * Override-only user configuration.
 *
 * Defaults live in this module; the global
 * `<agent dir>/extensions/pi-context-view.json` carries overrides only. The
 * file is never auto-created and never backfilled automatically, so later
 * default changes still reach users who did not override them. Only the
 * explicit `/context config` writes defaults: it creates the file or adds the
 * missing keys. Saving an icon style the user picked in a view writes that one
 * override. An
 * absent file or omitted value is silent; unreadable, unparseable, and invalid
 * configuration warns and degrades to defaults instead of failing a view.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

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
	"scrollbarTrack", "scrollbarThumb",
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
	"assistant-messages": { key: "assistantMessagesColor", color: "syntaxFunction" },
	"assistant-thinking": { key: "assistantThinkingColor", color: "thinkingXhigh" },
	"tool-calls": { key: "toolCallsColor", color: "syntaxKeyword" },
	"tool-output": { key: "toolOutputColor", color: "toolOutput" },
	"extensions": { key: "extensionsColor", color: "syntaxType" },
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

/** Cell counts a configured map dimension may request; the viewport clamps further at render time. */
const MINIMUM_MAP_CELLS = 4;
const MAXIMUM_MAP_CELLS = 64;

/**
 * Both configurable map dimensions: the geometry field, the flat config key
 * overriding it, and the built-in default a created override file reproduces.
 */
const MAP_SIZE_SPECS = {
	columns: { key: "mapCols", cells: 16 },
	rows: { key: "mapRows", cells: 16 },
} as const satisfies Record<string, { readonly key: string; readonly cells: number }>;

/** Geometry field of one configurable map dimension. */
type MapSizeField = keyof typeof MAP_SIZE_SPECS;

/** Config keys mapped to the map dimension they size. */
const CONFIG_KEY_MAP_FIELDS: ReadonlyMap<string, MapSizeField> = new Map(
	Object.entries(MAP_SIZE_SPECS).map(([field, spec]) => [spec.key, field as MapSizeField]),
);

/** Config key naming the icon style the usage map draws with. */
const ICON_STYLE_KEY = "iconStyle";
/** Config key listing every selectable icon style by name. */
const ICON_STYLES_KEY = "iconStyles";

/** Map roles in the order an icon style's glyph string lists them. */
const ICON_ROLES = ["buffer", "free", "partial", "full", "compacted"] as const;

/** Pre-defined icon styles as written to a created override file, one glyph per role. */
const DEFAULT_ICON_STYLE_GLYPHS = {
	CC: "⛝⛶⛂⛃⛃",
	// Nerd Font private-use glyphs, escaped because they render blank without such a font
	Nerd: "\u{f0157}⛶\u{ede8}\u{f01bc}\u{eb29}",
	Circle: "⮾·◕●♼",
	Square: "⛝⛶◧■▦",
} as const satisfies Record<string, string>;

/** Name of the built-in icon style, also preferred when a configured list still carries it. */
export const DEFAULT_ICON_STYLE_NAME = "Square" satisfies keyof typeof DEFAULT_ICON_STYLE_GLYPHS;

/** The `iconStyle` entry of an override file with a string value; the group holds everything before the value. */
const ICON_STYLE_ENTRY_PATTERN = new RegExp(`("${ICON_STYLE_KEY}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`);

/** Content a saved override starts from while no file exists. */
const EMPTY_CONFIG_TEXT = "{}\n";

/** Splits a glyph string into user-perceived characters, so a combined glyph counts once. */
const GLYPH_SEGMENTER = new Intl.Segmenter();

/** Config key of the switch that lets a view start the silent probe on its own. */
const AUTO_PROBING_KEY = "autoProbing";

/** Built-in probing switch: enabled, so a view opened before any request can still capture one. */
const DEFAULT_AUTO_PROBING = true;

/**
 * Renamed keys still honored, mapped to their current name, so a rename never
 * silently drops an override an existing file already carries. The value type
 * fails the build when a rename points at a key no category declares.
 */
const RENAMED_CONFIG_KEYS: ReadonlyMap<string, ConfigKey> = new Map([
	["memoryColor", "instructionFilesColor"],
	["systemToolsColor", "builtInToolsColor"],
	["agentTextMessagesColor", "assistantMessagesColor"],
	["agentThinkingMessagesColor", "assistantThinkingColor"],
	["agentToolCallMessagesColor", "toolCallsColor"],
	["extensionMessagesColor", "extensionsColor"],
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

/** Requested context-map geometry in cells, before the viewport clamps it. */
export interface MapSize {
	readonly columns: number;
	readonly rows: number;
}

/** Glyphs of one icon style, each exactly one terminal cell wide. */
export interface IconStyle {
	/** Cell inside the auto-compaction reserve. */
	readonly buffer: string;
	/** Unoccupied cell. */
	readonly free: string;
	/** Cell shared by several categories. */
	readonly partial: string;
	/** Cell holding a single category. */
	readonly full: string;
	/** Cell of compacted data. */
	readonly compacted: string;
}

/** Selectable icon styles by name, in the order the Usage view cycles through them. */
export type IconStyles = ReadonlyMap<string, IconStyle>;

/** All user-configurable state of one runtime. */
export interface ContextViewConfig {
	readonly categoryColors: CategoryColors;
	readonly mapSize: MapSize;
	/** Never empty: the pre-defined styles, or the valid ones of a configured list. */
	readonly iconStyles: IconStyles;
	/** Name of the selected icon style, always one of `iconStyles`. */
	readonly iconStyleName: string;
	/** Whether a view opened before any captured request may start the silent probe. */
	readonly autoProbing: boolean;
}

/** Configuration for one view open, with the problems that degraded it to defaults. */
export interface ConfigLoadResult {
	readonly config: ContextViewConfig;
	/** Empty when the file is absent or fully valid; reported once per file revision. */
	readonly warnings: readonly string[];
}

/**
 * Outcome of explicitly writing the built-in defaults:
 *   created     no file existed, so one holding every default was created
 *   completed   the existing file gained the keys it was missing
 *   unchanged   the existing file already had every key
 *   failed      nothing was written
 */
export type ConfigDefaultsResult =
	| { readonly type: "created"; readonly filePath: string }
	| { readonly type: "completed"; readonly filePath: string }
	| { readonly type: "unchanged"; readonly filePath: string }
	| { readonly type: "failed"; readonly filePath: string; readonly reason: string };

/** Outcome of saving one override into the override file. */
export type ConfigSaveResult =
	| { readonly type: "saved"; readonly filePath: string }
	| { readonly type: "failed"; readonly filePath: string; readonly reason: string };

/** Built-in colors, used whenever the file omits or misconfigures a category. */
export const DEFAULT_CATEGORY_COLORS: CategoryColors = new Map(
	Object.entries(CATEGORY_COLOR_SPECS).map(([categoryId, spec]) => [categoryId, spec.color] as const),
);

/** Built-in map geometry, used whenever the file omits or misconfigures a dimension. */
export const DEFAULT_MAP_SIZE: MapSize = {
	columns: MAP_SIZE_SPECS.columns.cells,
	rows: MAP_SIZE_SPECS.rows.cells,
};

/** Pre-defined icon styles by name, used whenever the file omits or misconfigures the list. */
export const DEFAULT_ICON_STYLES: IconStyles = new Map(
	Object.entries(DEFAULT_ICON_STYLE_GLYPHS).map(([name, glyphs]) => [name, toIconStyle(splitGlyphs(glyphs))]),
);

/** Built-in icon style, used whenever the file selects none. */
export const DEFAULT_ICON_STYLE: IconStyle = toIconStyle(
	splitGlyphs(DEFAULT_ICON_STYLE_GLYPHS[DEFAULT_ICON_STYLE_NAME]),
);

/** Configuration used when no override file exists. */
export const DEFAULT_CONFIG: ContextViewConfig = {
	categoryColors: DEFAULT_CATEGORY_COLORS,
	mapSize: DEFAULT_MAP_SIZE,
	iconStyles: DEFAULT_ICON_STYLES,
	iconStyleName: DEFAULT_ICON_STYLE_NAME,
	autoProbing: DEFAULT_AUTO_PROBING,
};

/** Absolute path of the global override file. */
export function getConfigFilePath(): string {
	return join(getAgentDir(), "extensions", CONFIG_FILE_NAME);
}

/**
 * Write every built-in default the global override file lacks. Without a
 * file, a single atomic `O_EXCL` write creates it with every default, so a
 * concurrent creator loses the race instead of the file's content. An existing
 * file only gains its missing keys: present values stay as they are, even
 * invalid ones, and a renamed key's old name counts as present.
 */
export function writeConfigDefaults(filePath: string = getConfigFilePath()): ConfigDefaultsResult {
	try {
		// Separate from the write below: mkdir also reports EEXIST, for a parent that is a file
		mkdirSync(dirname(filePath), { recursive: true });
	} catch (error) {
		return { type: "failed", filePath, reason: describeError(error) };
	}
	try {
		writeFileSync(filePath, serializeDefaultConfig(), { encoding: "utf8", flag: "wx" });
		return { type: "created", filePath };
	} catch (error) {
		if (!hasErrorCode(error, "EEXIST"))
			return { type: "failed", filePath, reason: describeError(error) };
	}

	return addMissingDefaults(filePath);
}

/**
 * Save the selected icon style as the file's `iconStyle` override, creating a
 * file that holds only this entry when none exists. The entry is merged over a
 * fresh read, so every other key and the file's layout survive. An unparseable
 * file is left untouched and reported as a failure.
 */
export function saveIconStyleName(name: string, filePath: string = getConfigFilePath()): ConfigSaveResult {
	try {
		const text = setIconStyleEntry(readConfigText(filePath) ?? EMPTY_CONFIG_TEXT, name);
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, text, "utf8");

		return { type: "saved", filePath };
	} catch (error) {
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
	/** Icon style picked in a view and not yet saved. */
	private pendingIconStyleName: string | undefined;

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

	/**
	 * Remember the icon style picked in a view. Nothing is written until
	 * `flush()`, so cycling through several styles costs one write.
	 */
	public selectIconStyle(name: string): void {
		this.pendingIconStyleName = name;
	}

	/**
	 * Save the remembered icon style. Returns `undefined` without touching the
	 * file when no style was picked or the pick is the style already loaded.
	 */
	public flush(): ConfigSaveResult | undefined {
		const name = this.pendingIconStyleName;
		this.pendingIconStyleName = undefined;
		if (name === undefined || name === this.cached.iconStyleName)
			return undefined;

		return saveIconStyleName(name, this.filePath);
	}
}

/** Read and validate one override file; a missing file yields defaults without warnings. */
export function loadConfigFile(filePath: string): ConfigLoadResult {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (error) {
		// An absent file is the expected state for users who never configured anything
		if (hasErrorCode(error, "ENOENT"))
			return { config: DEFAULT_CONFIG, warnings: [] };
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
	if (categoryId === undefined)
		return FALLBACK_CATEGORY_COLOR;

	return colors.get(categoryId) ?? FALLBACK_CATEGORY_COLOR;
}

/** Whether a resolved color is a literal value rather than a theme color key. */
export function isHexColor(color: CategoryColor): color is HexColor {
	return color.startsWith("#");
}

/**
 * Append the built-in defaults an existing file lacks, keeping its layout. An
 * unparseable file is left untouched and reported as a failure.
 */
function addMissingDefaults(filePath: string): ConfigDefaultsResult {
	try {
		const text = readConfigText(filePath);
		if (text === undefined)
			throw new Error("the file was removed while it was being updated");

		const raw = parseConfigObject(text);
		const missing = listMissingDefaults(raw);
		if (missing.length === 0)
			return { type: "unchanged", filePath };

		writeFileSync(filePath, appendEntries(text, raw, missing), "utf8");

		return { type: "completed", filePath };
	} catch (error) {
		return { type: "failed", filePath, reason: describeError(error) };
	}
}

/**
 * Default entries whose key the file lacks, in the order a created file lists
 * them. An old name of a renamed key counts as its current name, so the added
 * default never overrides the value the alias already sets.
 */
function listMissingDefaults(raw: object): ConfigEntry[] {
	const present = new Set(Object.keys(raw).map((key) => RENAMED_CONFIG_KEYS.get(key) ?? key));
	return listDefaultEntryGroups().flat().filter(([key]) => !present.has(key));
}

/** Text of the override file, or `undefined` while it does not exist. */
function readConfigText(filePath: string): string | undefined {
	try {
		return readFileSync(filePath, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT"))
			return undefined;
		throw error;
	}
}

/** One key and value of the override file. */
type ConfigEntry = readonly [string, unknown];

/** Parse override file text, throwing for text that is not a JSON object. */
function parseConfigObject(text: string): object {
	const raw: unknown = JSON.parse(text);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new Error(`${CONFIG_FILE_NAME} must contain a JSON object`);

	return raw;
}

/**
 * Override file text with `iconStyle` set to `name`. Edits the text in place
 * to keep the user's layout. Throws for text that is not a JSON object.
 */
function setIconStyleEntry(text: string, name: string): string {
	const raw = parseConfigObject(text);
	if (!(ICON_STYLE_KEY in raw))
		return appendEntries(text, raw, [[ICON_STYLE_KEY, name]]);

	return keepEditOrSerialize(replaceIconStyleValue(text, name), { ...raw, [ICON_STYLE_KEY]: name });
}

/** Add entries after the last one of the root object, keeping the layout before them. */
function appendEntries(text: string, raw: object, entries: readonly ConfigEntry[]): string {
	const end = text.lastIndexOf("}");
	const head = text.slice(0, end).trimEnd();
	const separator = head.endsWith("{") ? "" : ",";
	const body = entries.map(serializeConfigEntry).join(",\n");
	const edited = `${head}${separator}\n${body}\n${text.slice(end)}`;

	return keepEditOrSerialize(edited, { ...raw, ...Object.fromEntries(entries) });
}

/**
 * The in-place edit when it produces exactly the intended content, otherwise
 * the whole object serialized again, which loses the user's layout.
 */
function keepEditOrSerialize(edited: string, expected: object): string {
	if (parsesTo(edited, expected))
		return edited;

	return `${JSON.stringify(expected, undefined, 2)}\n`;
}

/** Swap the value of the first `iconStyle` entry, leaving the text unchanged when it holds no string. */
function replaceIconStyleValue(text: string, name: string): string {
	return text.replace(ICON_STYLE_ENTRY_PATTERN, (_entry, prefix: string) => `${prefix}${JSON.stringify(name)}`);
}

/** Whether edited text parses to exactly the expected entries, in the same order. */
function parsesTo(text: string, expected: object): boolean {
	try {
		return JSON.stringify(JSON.parse(text)) === JSON.stringify(expected);
	} catch {
		return false;
	}
}

/** Every built-in default as file entries, in related groups and legend order. */
function listDefaultEntryGroups(): ConfigEntry[][] {
	return [
		Object.values(CATEGORY_COLOR_SPECS).map((spec) => [spec.key, spec.color]),
		Object.values(MAP_SIZE_SPECS).map((spec) => [spec.key, spec.cells]),
		[[ICON_STYLE_KEY, DEFAULT_ICON_STYLE_NAME], [ICON_STYLES_KEY, DEFAULT_ICON_STYLE_GLYPHS]],
		[[AUTO_PROBING_KEY, DEFAULT_AUTO_PROBING]],
	];
}

/** Serialize every built-in default as an editable override file. */
function serializeDefaultConfig(): string {
	// Written by hand: JSON.stringify cannot leave the blank lines that separate the groups
	const body = listDefaultEntryGroups()
		.map((entries) => entries.map(serializeConfigEntry).join(",\n"))
		.join(",\n\n");

	return `{\n${body}\n}\n`;
}

/** One indented entry of the override file; an object value spreads over indented lines, one entry each. */
function serializeConfigEntry([key, value]: ConfigEntry): string {
	return `  ${JSON.stringify(key)}: ${JSON.stringify(value, undefined, 2).replaceAll("\n", "\n  ")}`;
}

/** Merge valid overrides onto the built-in defaults, reporting every ignored entry. */
function applyOverrides(raw: unknown): ConfigLoadResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return degraded(`${CONFIG_FILE_NAME} must contain a JSON object.`);
	}

	const config: ConfigDraft = {
		categoryColors: new Map(DEFAULT_CATEGORY_COLORS),
		mapSize: { ...DEFAULT_MAP_SIZE },
		autoProbing: DEFAULT_AUTO_PROBING,
		iconStyles: DEFAULT_ICON_STYLES,
		iconStyleName: undefined,
	};
	const warnings: string[] = [];
	for (const [key, value] of Object.entries(raw)) {
		const currentKey = RENAMED_CONFIG_KEYS.get(key);
		// The current name always wins, so a file carrying both names loads order-independently
		if (currentKey !== undefined && currentKey in raw)
			continue;

		const warning = applyOverride(currentKey ?? key, key, value, config);
		if (warning !== undefined)
			warnings.push(warning);
	}

	// Resolved after the loop, so the selection never depends on the order of the two icon keys
	if (config.iconStyleName !== undefined && !config.iconStyles.has(config.iconStyleName)) {
		const names = [...config.iconStyles.keys()].map((name) => `"${name}"`).join(", ");
		warnings.push(`Ignoring unknown icon style "${config.iconStyleName}" for "${ICON_STYLE_KEY}". ` +
			`Expected one of: ${names}.`);
	}

	return {
		config: {
			categoryColors: config.categoryColors,
			mapSize: config.mapSize,
			autoProbing: config.autoProbing,
			iconStyles: config.iconStyles,
			iconStyleName: selectIconStyleName(config.iconStyles, config.iconStyleName),
		},
		warnings,
	};
}

/** Configuration being assembled from the defaults, before it is returned read-only. */
interface ConfigDraft {
	categoryColors: Map<string, CategoryColor>;
	mapSize: Record<MapSizeField, number>;
	autoProbing: boolean;
	/** Selectable styles: the pre-defined ones until a valid configured list replaces them. */
	iconStyles: IconStyles;
	/** Configured style name, not yet checked against the list. */
	iconStyleName: string | undefined;
}

/**
 * Apply one entry onto the mutable defaults, returning the reason it was
 * ignored. Reports name `configuredKey`, the name the file carries, which an
 * accepted alias makes differ from the `resolvedKey` the entry configures.
 */
function applyOverride(
	resolvedKey: string,
	configuredKey: string,
	value: unknown,
	config: ConfigDraft,
): string | undefined {
	const categoryId = CONFIG_KEY_CATEGORIES.get(resolvedKey);
	if (categoryId !== undefined) {
		const color = parseColor(value);
		if (color === undefined) {
			return `Ignoring invalid color for "${configuredKey}". Expected a theme color name or a hex value.`;
		}
		config.categoryColors.set(categoryId, color);
		return undefined;
	}

	const field = CONFIG_KEY_MAP_FIELDS.get(resolvedKey);
	if (field !== undefined) {
		const cells = parseMapDimension(value);
		if (cells === undefined) {
			return `Ignoring invalid size for "${configuredKey}". ` +
				`Expected an integer between ${MINIMUM_MAP_CELLS} and ${MAXIMUM_MAP_CELLS}.`;
		}
		config.mapSize[field] = cells;
		return undefined;
	}
	if (resolvedKey === AUTO_PROBING_KEY) {
		if (typeof value !== "boolean")
			return `Ignoring invalid value for "${configuredKey}". Expected true or false.`;
		config.autoProbing = value;
		return undefined;
	}
	if (resolvedKey === ICON_STYLE_KEY) {
		if (typeof value !== "string")
			return `Ignoring invalid value for "${configuredKey}". Expected an icon style name.`;
		config.iconStyleName = value;
		return undefined;
	}
	if (resolvedKey === ICON_STYLES_KEY)
		return applyIconStyles(configuredKey, value, config);

	return `Ignoring unknown ${CONFIG_FILE_NAME} key "${configuredKey}".`;
}

/**
 * Replace the selectable styles with the configured list, returning the reason
 * any of it was ignored. A list without one valid style keeps the pre-defined
 * styles, so the map always has glyphs to draw.
 */
function applyIconStyles(configuredKey: string, value: unknown, config: ConfigDraft): string | undefined {
	const expectation = `Expected ${ICON_ROLES.length} glyphs, each one cell wide`;
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return `Ignoring invalid value for "${configuredKey}". Expected an object of named icon styles.`;

	const styles = new Map<string, IconStyle>();
	const invalidNames: string[] = [];
	for (const [name, glyphs] of Object.entries(value)) {
		const style = parseIconStyle(glyphs);
		if (style === undefined)
			invalidNames.push(`"${name}"`);
		else
			styles.set(name, style);
	}
	if (styles.size === 0)
		return `Ignoring "${configuredKey}" without a valid icon style. ${expectation}.`;

	config.iconStyles = styles;
	if (invalidNames.length === 0)
		return undefined;

	return `Ignoring invalid icon style ${invalidNames.join(", ")} in "${configuredKey}". ${expectation}.`;
}

/** Accept only a string of one glyph per map role, each one cell wide so the map grid stays aligned. */
function parseIconStyle(value: unknown): IconStyle | undefined {
	if (typeof value !== "string")
		return undefined;

	const glyphs = splitGlyphs(value);
	if (glyphs.length !== ICON_ROLES.length || glyphs.some((glyph) => visibleWidth(glyph) !== 1))
		return undefined;

	return toIconStyle(glyphs);
}

/** User-perceived characters of one glyph string. */
function splitGlyphs(glyphs: string): string[] {
	return [...GLYPH_SEGMENTER.segment(glyphs)].map((part) => part.segment);
}

/** Assign glyphs to map roles by position; callers pass one glyph per role. */
function toIconStyle(glyphs: readonly string[]): IconStyle {
	const [buffer = "", free = "", partial = "", full = "", compacted = ""] = glyphs;
	return { buffer, free, partial, full, compacted };
}

/**
 * Name of the style to draw with. An omitted or unknown name falls back to the
 * built-in style, or to the first listed one when the list no longer has it.
 */
function selectIconStyleName(styles: IconStyles, name: string | undefined): string {
	if (name !== undefined && styles.has(name))
		return name;
	if (styles.has(DEFAULT_ICON_STYLE_NAME))
		return DEFAULT_ICON_STYLE_NAME;

	const [first] = styles.keys();

	return first ?? DEFAULT_ICON_STYLE_NAME;
}

/** Whole-file failure: built-in defaults plus one explanatory warning. */
function degraded(reason: string): ConfigLoadResult {
	return { config: DEFAULT_CONFIG, warnings: [`${reason} Using default configuration.`] };
}

/** Normalize one configured color value, or reject it as unusable. */
function parseColor(value: unknown): CategoryColor | undefined {
	if (typeof value !== "string")
		return undefined;
	if (isThemeColor(value))
		return value;

	return parseHexColor(value);
}

/** Accept only whole in-range cell counts; the viewport still clamps what it cannot render. */
function parseMapDimension(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value))
		return undefined;
	if (value < MINIMUM_MAP_CELLS || value > MAXIMUM_MAP_CELLS)
		return undefined;

	return value;
}

/** Accept only theme color keys the active theme is guaranteed to define. */
function isThemeColor(value: unknown): value is ThemeColor {
	return typeof value === "string" && THEME_COLORS.has(value);
}

/** Expand shorthand and lowercase, so rendering always resolves six hex digits. */
function parseHexColor(value: string): HexColor | undefined {
	if (!HEX_COLOR_PATTERN.test(value))
		return undefined;

	const digits = value.slice(1).toLowerCase();
	if (digits.length === 6)
		return `#${digits}`;

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
