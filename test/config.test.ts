import assert from "node:assert/strict";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import {
	AUTO_COMPACT_BUFFER_CATEGORY_ID,
	ConfigStore,
	writeConfigDefaults,
	DEFAULT_CONFIG,
	type ContextViewConfig,
	DEFAULT_ICON_STYLE,
	FREE_SPACE_CATEGORY_ID,
	type IconStyle,
	loadConfigFile,
	resolveCategoryColor,
	saveIconStyleName,
} from "../src/config.ts";

/** Glyphs of the style a loaded configuration selects. */
function selectedIcons(config: ContextViewConfig): IconStyle | undefined {
	return config.iconStyles.get(config.iconStyleName);
}

/** Create one isolated override path and remove its directory after the test. */
function createConfigPath(context: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-context-view-config-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));

	return join(directory, "pi-context-view.json");
}

test("writeConfigDefaults atomically creates every built-in default", (context) => {
	const filePath = join(dirname(createConfigPath(context)), "extensions", "pi-context-view.json");

	assert.deepEqual(writeConfigDefaults(filePath), { type: "created", filePath });
	const text = readFileSync(filePath, "utf8");
	assert.ok(text.endsWith("\n"));

	// The documented example is the exact file, blank lines between key groups included
	const configDoc = readFileSync(new URL("../doc/CONFIG.md", import.meta.url), "utf8");
	const documented = /```json\n([\s\S]*?\n)```/.exec(configDoc);
	assert.equal(text, documented?.[1]);
	// Entries, not the parsed object: the file must also list keys in legend order
	assert.deepEqual(Object.entries(JSON.parse(text)), [
		["systemPromptColor", "mdHeading"],
		["instructionFilesColor", "mdCodeBlock"],
		["skillsColor", "customMessageLabel"],
		["builtInToolsColor", "mdHeading"],
		["customToolsColor", "accent"],
		["mcpToolsColor", "mdLink"],
		["userMessagesColor", "syntaxString"],
		["assistantMessagesColor", "syntaxFunction"],
		["assistantThinkingColor", "thinkingXhigh"],
		["toolCallsColor", "syntaxKeyword"],
		["toolOutputColor", "toolOutput"],
		["extensionsColor", "syntaxType"],
		["compactedDataColor", "thinkingHigh"],
		["autoCompactBufferColor", "dim"],
		["freeSpaceColor", "dim"],
		["mapCols", 16],
		["mapRows", 16],
		["iconStyle", "Square"],
		["iconStyles", {
			CC: "⛝⛶⛂⛃⛃",
			Nerd: "\u{f0157}⛶\u{ede8}\u{f01bc}\u{eb29}",
			Circle: "⮾·◕●♼",
			Square: "⛝⛶◧■▦",
		}],
		["autoProbing", true],
	]);
	assert.deepEqual(readdirSync(dirname(filePath)), ["pi-context-view.json"]);

	const loaded = loadConfigFile(filePath);
	assert.deepEqual(loaded.warnings, []);
	assert.deepEqual(loaded.config.categoryColors, DEFAULT_CONFIG.categoryColors);
	assert.deepEqual(loaded.config.mapSize, DEFAULT_CONFIG.mapSize);
	assert.deepEqual(selectedIcons(loaded.config), DEFAULT_ICON_STYLE);
	assert.equal(loaded.config.autoProbing, true);

	// Repeating the command finds every key present and leaves the file byte for byte
	assert.deepEqual(writeConfigDefaults(filePath), { type: "unchanged", filePath });
	assert.equal(readFileSync(filePath, "utf8"), text);
});

test("writeConfigDefaults reports an unusable path instead of updating a file", (context) => {
	const blockingFile = createConfigPath(context);
	writeFileSync(blockingFile, "not a directory");

	const filePath = join(blockingFile, "pi-context-view.json");

	// mkdir reports EEXIST for a parent that is a file; only the write may mean the file exists
	const result = writeConfigDefaults(filePath);
	assert.equal(result.type, "failed");
	assert.equal(result.filePath, filePath);
});

test("writeConfigDefaults adds only the missing keys to an existing file", (context) => {
	const filePath = createConfigPath(context);
	// An invalid value, an old key name, and an unknown key must all survive as written
	const existing = '{\n\t"mapCols": 99,\n\n\t"memoryColor": "accent",\n\t"futureSetting": true\n}\n';
	writeFileSync(filePath, existing);

	assert.deepEqual(writeConfigDefaults(filePath), { type: "completed", filePath });
	const text = readFileSync(filePath, "utf8");
	assert.ok(text.startsWith(existing.slice(0, existing.lastIndexOf("\n}"))), "the layout is kept");

	const created = createConfigPath(context);
	writeConfigDefaults(created);
	const expectedAdded = Object.entries(JSON.parse(readFileSync(created, "utf8")))
		.filter(([key]) => key !== "mapCols" && key !== "instructionFilesColor");
	assert.deepEqual(Object.entries(JSON.parse(text)), [
		["mapCols", 99],
		["memoryColor", "accent"],
		["futureSetting", true],
		...expectedAdded,
	]);
	assert.equal(loadConfigFile(filePath).config.categoryColors.get("context-files"), "accent");

	assert.deepEqual(writeConfigDefaults(filePath), { type: "unchanged", filePath });
	assert.equal(readFileSync(filePath, "utf8"), text);
});

test("writeConfigDefaults fills an empty object and a file holding only a saved style", (context) => {
	const filePath = createConfigPath(context);

	writeFileSync(filePath, "{}\n");
	assert.equal(writeConfigDefaults(filePath).type, "completed");
	const filled = loadConfigFile(filePath);
	assert.deepEqual(filled.warnings, []);
	assert.deepEqual(filled.config.categoryColors, DEFAULT_CONFIG.categoryColors);

	// The `i` key creates a file holding only `iconStyle`; the command then completes it
	unlinkSync(filePath);
	assert.equal(saveIconStyleName("Circle", filePath).type, "saved");
	assert.equal(writeConfigDefaults(filePath).type, "completed");
	const completed = loadConfigFile(filePath);
	assert.deepEqual(completed.warnings, []);
	assert.equal(completed.config.iconStyleName, "Circle");
	assert.equal(Object.keys(JSON.parse(readFileSync(filePath, "utf8")))[0], "iconStyle");
});

test("writeConfigDefaults leaves a file it cannot parse untouched", (context) => {
	const filePath = createConfigPath(context);

	for (const text of ["{ not json", "[]", ""]) {
		writeFileSync(filePath, text);
		const result = writeConfigDefaults(filePath);

		assert.equal(result.type, "failed", text);
		assert.equal(readFileSync(filePath, "utf8"), text);
	}
});

test("ConfigStore picks up a file created after its first load", (context) => {
	const filePath = createConfigPath(context);
	const store = new ConfigStore(filePath);
	assert.equal(store.load().config, DEFAULT_CONFIG);

	assert.equal(writeConfigDefaults(filePath).type, "created");

	const created = store.load();
	assert.deepEqual(created.warnings, []);
	assert.deepEqual(created.config.categoryColors, DEFAULT_CONFIG.categoryColors);
	// A re-read builds its own map; the shared default instance would prove a stale cache
	assert.notEqual(created.config, DEFAULT_CONFIG);
});

test("loadConfigFile treats an absent override file as built-in defaults", (context) => {
	const filePath = createConfigPath(context);
	const result = loadConfigFile(filePath);

	assert.equal(result.config, DEFAULT_CONFIG);
	assert.deepEqual(result.warnings, []);
	assert.equal(resolveCategoryColor(result.config.categoryColors, "system-prompt"), "mdHeading");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "built-in-tools"), "mdHeading");
	assert.equal(resolveCategoryColor(result.config.categoryColors, AUTO_COMPACT_BUFFER_CATEGORY_ID), "dim");
	assert.equal(resolveCategoryColor(result.config.categoryColors, FREE_SPACE_CATEGORY_ID), "dim");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "unknown-category"), "muted");
});

test("loadConfigFile applies every valid flat category color override", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, JSON.stringify({
		systemPromptColor: "success",
		builtInToolsColor: "error",
		customToolsColor: "warning",
		mcpToolsColor: "muted",
		instructionFilesColor: "dim",
		skillsColor: "text",
		userMessagesColor: "thinkingText",
		assistantMessagesColor: "searchMatchText",
		assistantThinkingColor: "thinkingMax",
		toolCallsColor: "mdCode",
		toolOutputColor: "syntaxNumber",
		extensionsColor: "syntaxOperator",
		compactedDataColor: "thinkingLow",
		autoCompactBufferColor: "borderMuted",
		freeSpaceColor: "accent",
	}));

	const result = loadConfigFile(filePath);

	assert.deepEqual(result.warnings, []);
	assert.equal(resolveCategoryColor(result.config.categoryColors, "system-prompt"), "success");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "built-in-tools"), "error");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "custom-tools"), "warning");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "mcp-tools"), "muted");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "context-files"), "dim");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "skills"), "text");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "user-messages"), "thinkingText");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "assistant-messages"), "searchMatchText");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "assistant-thinking"), "thinkingMax");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "tool-calls"), "mdCode");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "tool-output"), "syntaxNumber");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "extensions"), "syntaxOperator");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "compacted-data"), "thinkingLow");
	assert.equal(resolveCategoryColor(result.config.categoryColors, AUTO_COMPACT_BUFFER_CATEGORY_ID), "borderMuted");
	assert.equal(resolveCategoryColor(result.config.categoryColors, FREE_SPACE_CATEGORY_ID), "accent");
});

test("loadConfigFile accepts scrollbar theme colors without warnings", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, JSON.stringify({
		systemPromptColor: "scrollbarTrack",
		skillsColor: "scrollbarThumb",
	}));

	const result = loadConfigFile(filePath);

	assert.deepEqual(result.warnings, []);
	assert.equal(resolveCategoryColor(result.config.categoryColors, "system-prompt"), "scrollbarTrack");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "skills"), "scrollbarThumb");
});

test("loadConfigFile accepts literal hex colors and normalizes them", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, JSON.stringify({
		systemPromptColor: "#7AA2F7",
		skillsColor: "#f0a",
		freeSpaceColor: "#000000",
	}));

	const result = loadConfigFile(filePath);

	assert.deepEqual(result.warnings, []);
	assert.equal(resolveCategoryColor(result.config.categoryColors, "system-prompt"), "#7aa2f7");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "skills"), "#ff00aa");
	assert.equal(resolveCategoryColor(result.config.categoryColors, FREE_SPACE_CATEGORY_ID), "#000000");
});

test("loadConfigFile ignores invalid entries without discarding valid siblings", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, JSON.stringify({
		systemPromptColor: "success",
		skillsColor: "#ff00f",
		instructionFilesColor: "crimson",
		userMessagesColor: 42,
		unknownColor: "accent",
	}));

	const result = loadConfigFile(filePath);

	assert.equal(resolveCategoryColor(result.config.categoryColors, "system-prompt"), "success");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "skills"), "customMessageLabel");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "context-files"), "mdCodeBlock");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "user-messages"), "syntaxString");
	assert.equal(result.warnings.length, 4);
	assert.ok(result.warnings.some((warning) => warning.includes("skillsColor")));
	assert.ok(result.warnings.some((warning) => warning.includes("instructionFilesColor")));
	assert.ok(result.warnings.some((warning) => warning.includes("userMessagesColor")));
	assert.ok(result.warnings.some((warning) => warning.includes("unknownColor")));
});

test("loadConfigFile applies map size overrides", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, JSON.stringify({ mapCols: 24, mapRows: 8 }));

	const result = loadConfigFile(filePath);

	assert.deepEqual(result.warnings, []);
	assert.deepEqual(result.config.mapSize, { columns: 24, rows: 8 });
});

test("loadConfigFile keeps the default for an unusable map size and warns once", (context) => {
	const filePath = createConfigPath(context);
	const cases: Array<readonly [string, unknown]> = [
		["below the minimum", 1],
		["above the maximum", 65],
		["fractional", 12.5],
		["a numeric string", "12"],
	];

	for (const [reason, value] of cases) {
		writeFileSync(filePath, JSON.stringify({ mapCols: value, mapRows: 12 }));
		const result = loadConfigFile(filePath);

		assert.deepEqual(result.config.mapSize, { columns: DEFAULT_CONFIG.mapSize.columns, rows: 12 }, reason);
		assert.deepEqual(result.warnings, [
			'Ignoring invalid size for "mapCols". Expected an integer between 4 and 64.',
		], reason);
	}
});

test("loadConfigFile applies autoProbing and keeps the default for a non-boolean value", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, JSON.stringify({ autoProbing: false }));

	const disabled = loadConfigFile(filePath);
	assert.deepEqual(disabled.warnings, []);
	assert.equal(disabled.config.autoProbing, false);

	writeFileSync(filePath, JSON.stringify({ autoProbing: "false" }));
	const invalid = loadConfigFile(filePath);
	assert.equal(invalid.config.autoProbing, true);
	assert.equal(invalid.warnings.length, 1);
	assert.ok(invalid.warnings[0]?.includes('"autoProbing"'), "the warning names the ignored key");
});

test("loadConfigFile selects a pre-defined or configured icon style", (context) => {
	const filePath = createConfigPath(context);
	assert.deepEqual(DEFAULT_ICON_STYLE, { buffer: "⛝", free: "⛶", partial: "◧", full: "■", compacted: "▦" });

	writeFileSync(filePath, JSON.stringify({ iconStyle: "Circle" }));
	const predefined = loadConfigFile(filePath);
	assert.deepEqual(predefined.warnings, []);
	assert.deepEqual(selectedIcons(predefined.config), { buffer: "⮾", free: "·", partial: "◕", full: "●", compacted: "♼" });

	// Listed before the style it names: the selection must not depend on key order
	writeFileSync(filePath, JSON.stringify({ iconStyle: "Mine", iconStyles: { Other: "12345", Mine: "abcde" } }));
	const custom = loadConfigFile(filePath);
	assert.deepEqual(custom.warnings, []);
	assert.deepEqual(selectedIcons(custom.config), { buffer: "a", free: "b", partial: "c", full: "d", compacted: "e" });
});

test("loadConfigFile replaces the icon style list and falls back within it", (context) => {
	const filePath = createConfigPath(context);

	// The list no longer has the built-in style, so an unselected view draws the first listed one
	writeFileSync(filePath, JSON.stringify({ iconStyles: { Mine: "abcde", Other: "12345" } }));
	const unselected = loadConfigFile(filePath);
	assert.deepEqual(unselected.warnings, []);
	assert.equal(selectedIcons(unselected.config)?.full, "d");

	writeFileSync(filePath, JSON.stringify({ iconStyle: "Circle", iconStyles: { Mine: "abcde", Square: "12345" } }));
	const removed = loadConfigFile(filePath);
	assert.equal(selectedIcons(removed.config)?.full, "4", "a listed Square stays the fallback");
	assert.equal(removed.warnings.length, 1);
	assert.ok(removed.warnings[0]?.includes('"Circle"'), "the warning names the unknown style");
	assert.ok(removed.warnings[0]?.includes('"Mine", "Square"'), "the warning lists the selectable styles");
});

test("loadConfigFile ignores unusable icon styles and warns", (context) => {
	const filePath = createConfigPath(context);
	const unusableStyles: Array<readonly [string, unknown]> = [
		["too few glyphs", "abcd"],
		["too many glyphs", "abcdef"],
		["a wide glyph", "abcd😀"],
		["a zero-width glyph", "abcd\u200b"],
		["an array of glyphs", ["a", "b", "c", "d", "e"]],
	];

	for (const [reason, glyphs] of unusableStyles) {
		writeFileSync(filePath, JSON.stringify({ iconStyle: "Bad", iconStyles: { Bad: glyphs, Good: "abcde" } }));
		const mixed = loadConfigFile(filePath);

		assert.equal(selectedIcons(mixed.config)?.full, "d", reason);
		assert.equal(mixed.warnings.length, 2, reason);
		assert.ok(mixed.warnings.every((warning) => warning.includes('"Bad"')), reason);

		// Without one valid style the pre-defined list stays, so the map always has glyphs
		writeFileSync(filePath, JSON.stringify({ iconStyle: "Circle", iconStyles: { Bad: glyphs } }));
		const empty = loadConfigFile(filePath);

		assert.equal(selectedIcons(empty.config)?.full, "●", reason);
		assert.equal(empty.warnings.length, 1, reason);
		assert.ok(empty.warnings[0]?.includes('"iconStyles"'), reason);
	}

	for (const value of [["abcde"], "abcde", null, {}]) {
		writeFileSync(filePath, JSON.stringify({ iconStyles: value, iconStyle: 4 }));
		const invalid = loadConfigFile(filePath);

		assert.deepEqual(selectedIcons(invalid.config), DEFAULT_ICON_STYLE);
		assert.equal(invalid.warnings.length, 2);
		assert.ok(invalid.warnings.some((warning) => warning.includes('"iconStyles"')));
		assert.ok(invalid.warnings.some((warning) => warning.includes('"iconStyle"')));
	}
});

/** Every renamed config key with the current name and the category both color. */
const RENAMED_KEY_CASES = [
	{ old: "memoryColor", current: "instructionFilesColor", categoryId: "context-files" },
	{ old: "systemToolsColor", current: "builtInToolsColor", categoryId: "built-in-tools" },
	{ old: "agentTextMessagesColor", current: "assistantMessagesColor", categoryId: "assistant-messages" },
	{ old: "agentThinkingMessagesColor", current: "assistantThinkingColor", categoryId: "assistant-thinking" },
	{ old: "agentToolCallMessagesColor", current: "toolCallsColor", categoryId: "tool-calls" },
	{ old: "extensionMessagesColor", current: "extensionsColor", categoryId: "extensions" },
] as const;

for (const { old, current, categoryId } of RENAMED_KEY_CASES) {
	test(`loadConfigFile honors the renamed ${old} key without warning`, (context) => {
		const filePath = createConfigPath(context);
		writeFileSync(filePath, JSON.stringify({ [old]: "warning" }));

		const renamed = loadConfigFile(filePath);
		assert.deepEqual(renamed.warnings, []);
		assert.equal(resolveCategoryColor(renamed.config.categoryColors, categoryId), "warning");

		// Both names present: the current one wins whichever order the file lists them in
		writeFileSync(filePath, `{"${current}":"success","${old}":"warning"}`);
		assert.equal(resolveCategoryColor(loadConfigFile(filePath).config.categoryColors, categoryId), "success");
		writeFileSync(filePath, `{"${old}":"warning","${current}":"success"}`);
		assert.equal(resolveCategoryColor(loadConfigFile(filePath).config.categoryColors, categoryId), "success");
	});
}

test("loadConfigFile degrades invalid JSON and non-object roots to defaults", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, "{");

	const invalidJson = loadConfigFile(filePath);
	assert.equal(invalidJson.config, DEFAULT_CONFIG);
	assert.equal(invalidJson.warnings.length, 1);
	assert.match(invalidJson.warnings[0] ?? "", /Cannot parse/);

	writeFileSync(filePath, "[]");
	const invalidRoot = loadConfigFile(filePath);
	assert.equal(invalidRoot.config, DEFAULT_CONFIG);
	assert.deepEqual(invalidRoot.warnings, [
		"pi-context-view.json must contain a JSON object. Using default configuration.",
	]);
});

test("ConfigStore warns once per revision and reloads after mtime changes", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, JSON.stringify({ unknownColor: "accent" }));

	const store = new ConfigStore(filePath);

	const first = store.load();
	assert.equal(first.warnings.length, 1);
	assert.deepEqual(store.load().warnings, []);

	writeFileSync(filePath, JSON.stringify({ systemPromptColor: "success" }));
	const future = new Date(Date.now() + 2_000);
	utimesSync(filePath, future, future);

	const changed = store.load();
	assert.deepEqual(changed.warnings, []);
	assert.equal(resolveCategoryColor(changed.config.categoryColors, "system-prompt"), "success");

	unlinkSync(filePath);
	const removed = store.load();
	assert.equal(removed.config, DEFAULT_CONFIG);
	assert.deepEqual(removed.warnings, []);
});

test("saveIconStyleName creates a file holding only the selected style", (context) => {
	const filePath = join(dirname(createConfigPath(context)), "extensions", "pi-context-view.json");

	assert.deepEqual(saveIconStyleName("Circle", filePath), { type: "saved", filePath });
	assert.equal(readFileSync(filePath, "utf8"), '{\n  "iconStyle": "Circle"\n}\n');

	const loaded = loadConfigFile(filePath);
	assert.deepEqual(loaded.warnings, []);
	assert.equal(loaded.config.iconStyleName, "Circle");
});

test("saveIconStyleName changes only the style in an existing file", (context) => {
	const filePath = createConfigPath(context);
	assert.equal(writeConfigDefaults(filePath).type, "created");
	const created = readFileSync(filePath, "utf8");

	assert.equal(saveIconStyleName("CC", filePath).type, "saved");
	assert.equal(readFileSync(filePath, "utf8"), created.replace('"iconStyle": "Square"', '"iconStyle": "CC"'));

	// Without the key the entry is appended, and keys this version does not know survive
	const withoutStyle = '{\n\t"futureSetting": { "iconStyle": "x" },\n\n\t"mapCols": 20\n}\n';
	writeFileSync(filePath, withoutStyle);
	assert.equal(saveIconStyleName('Qu"ote', filePath).type, "saved");
	const appended = readFileSync(filePath, "utf8");
	assert.ok(appended.startsWith(withoutStyle.slice(0, withoutStyle.lastIndexOf("\n}"))), "the layout is kept");
	assert.deepEqual(Object.entries(JSON.parse(appended)), [
		["futureSetting", { iconStyle: "x" }],
		["mapCols", 20],
		["iconStyle", 'Qu"ote'],
	]);

	// A value the in-place edit cannot swap still ends up saved
	writeFileSync(filePath, '{"iconStyle": 4, "mapCols": 20}');
	assert.equal(saveIconStyleName("Circle", filePath).type, "saved");
	assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), { iconStyle: "Circle", mapCols: 20 });
});

test("saveIconStyleName leaves a file it cannot parse untouched", (context) => {
	const filePath = createConfigPath(context);

	for (const text of ["{ not json", "[]"]) {
		writeFileSync(filePath, text);
		const result = saveIconStyleName("Circle", filePath);

		assert.equal(result.type, "failed", text);
		assert.equal(readFileSync(filePath, "utf8"), text);
	}
});

test("ConfigStore saves only the last selected icon style that differs from the loaded one", (context) => {
	const filePath = createConfigPath(context);
	const store = new ConfigStore(filePath);
	const loadedName = store.load().config.iconStyleName;

	assert.equal(store.flush(), undefined, "nothing was selected");

	// Cycling back to the loaded style must not create an override
	store.selectIconStyle("Circle");
	store.selectIconStyle(loadedName);
	assert.equal(store.flush(), undefined);
	assert.deepEqual(readdirSync(dirname(filePath)), []);

	store.selectIconStyle("CC");
	store.selectIconStyle("Circle");
	assert.deepEqual(store.flush(), { type: "saved", filePath });
	assert.equal(store.flush(), undefined, "a saved selection is not written twice");
	assert.equal(store.load().config.iconStyleName, "Circle");
});
