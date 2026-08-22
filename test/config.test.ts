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
	createDefaultConfigFile,
	DEFAULT_CONFIG,
	FREE_SPACE_CATEGORY_ID,
	loadConfigFile,
	resolveCategoryColor,
} from "../src/config.ts";

/** Create one isolated override path and remove its directory after the test. */
function createConfigPath(context: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-context-view-config-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	return join(directory, "pi-context-view.json");
}

test("createDefaultConfigFile atomically creates every built-in default", (context) => {
	const filePath = join(dirname(createConfigPath(context)), "extensions", "pi-context-view.json");

	assert.deepEqual(createDefaultConfigFile(filePath), { type: "created", filePath });
	const text = readFileSync(filePath, "utf8");
	assert.ok(text.endsWith("\n"));
	assert.deepEqual(JSON.parse(text), {
		systemPromptColor: "mdHeading",
		systemToolsColor: "mdHeading",
		customToolsColor: "accent",
		mcpToolsColor: "mdLink",
		memoryColor: "mdCodeBlock",
		skillsColor: "customMessageLabel",
		userMessagesColor: "syntaxString",
		agentTextMessagesColor: "syntaxFunction",
		agentThinkingMessagesColor: "thinkingXhigh",
		agentToolCallMessagesColor: "syntaxKeyword",
		toolOutputColor: "toolOutput",
		extensionsColor: "syntaxType",
		compactedDataColor: "thinkingHigh",
		autoCompactBufferColor: "dim",
		freeSpaceColor: "dim",
	});
	assert.deepEqual(readdirSync(dirname(filePath)), ["pi-context-view.json"]);

	const loaded = loadConfigFile(filePath);
	assert.deepEqual(loaded.warnings, []);
	assert.deepEqual(loaded.config.categoryColors, DEFAULT_CONFIG.categoryColors);

	// Repeating the command hits the write's EEXIST, the only branch that may report "exists".
	assert.deepEqual(createDefaultConfigFile(filePath), { type: "exists", filePath });
	assert.equal(readFileSync(filePath, "utf8"), text);
});

test("createDefaultConfigFile reports an unusable path instead of claiming the file exists", (context) => {
	const blockingFile = createConfigPath(context);
	writeFileSync(blockingFile, "not a directory");
	const filePath = join(blockingFile, "pi-context-view.json");

	// mkdir reports EEXIST for a parent that is a file; only the write may mean "exists".
	const result = createDefaultConfigFile(filePath);
	assert.equal(result.type, "failed");
	assert.equal(result.filePath, filePath);
});

test("createDefaultConfigFile refuses to overwrite an existing file", (context) => {
	const filePath = createConfigPath(context);
	const existing = '{"futureSetting":true}\n';
	writeFileSync(filePath, existing);

	assert.deepEqual(createDefaultConfigFile(filePath), { type: "exists", filePath });
	assert.equal(readFileSync(filePath, "utf8"), existing);
});

test("ConfigStore picks up a file created after its first load", (context) => {
	const filePath = createConfigPath(context);
	const store = new ConfigStore(filePath);
	assert.equal(store.load().config, DEFAULT_CONFIG);

	assert.equal(createDefaultConfigFile(filePath).type, "created");

	const created = store.load();
	assert.deepEqual(created.warnings, []);
	assert.deepEqual(created.config.categoryColors, DEFAULT_CONFIG.categoryColors);
	// A re-read builds its own map; the shared default instance would prove a stale cache.
	assert.notEqual(created.config, DEFAULT_CONFIG);
});

test("loadConfigFile treats an absent override file as built-in defaults", (context) => {
	const filePath = createConfigPath(context);
	const result = loadConfigFile(filePath);

	assert.equal(result.config, DEFAULT_CONFIG);
	assert.deepEqual(result.warnings, []);
	assert.equal(resolveCategoryColor(result.config.categoryColors, "system-prompt"), "mdHeading");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "system-tools"), "mdHeading");
	assert.equal(resolveCategoryColor(result.config.categoryColors, AUTO_COMPACT_BUFFER_CATEGORY_ID), "dim");
	assert.equal(resolveCategoryColor(result.config.categoryColors, FREE_SPACE_CATEGORY_ID), "dim");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "unknown-category"), "muted");
});

test("loadConfigFile applies every valid flat category color override", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, JSON.stringify({
		systemPromptColor: "success",
		systemToolsColor: "error",
		customToolsColor: "warning",
		mcpToolsColor: "muted",
		memoryColor: "dim",
		skillsColor: "text",
		userMessagesColor: "thinkingText",
		agentTextMessagesColor: "searchMatchText",
		agentThinkingMessagesColor: "thinkingMax",
		agentToolCallMessagesColor: "mdCode",
		toolOutputColor: "syntaxNumber",
		extensionsColor: "syntaxOperator",
		compactedDataColor: "thinkingLow",
		autoCompactBufferColor: "borderMuted",
		freeSpaceColor: "accent",
	}));

	const result = loadConfigFile(filePath);

	assert.deepEqual(result.warnings, []);
	assert.equal(resolveCategoryColor(result.config.categoryColors, "system-prompt"), "success");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "system-tools"), "error");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "custom-tools"), "warning");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "mcp-tools"), "muted");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "context-files"), "dim");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "skills"), "text");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "user-messages"), "thinkingText");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "agent-text-messages"), "searchMatchText");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "agent-thinking-messages"), "thinkingMax");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "agent-tool-call-messages"), "mdCode");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "tool-output"), "syntaxNumber");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "extension-messages"), "syntaxOperator");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "compacted-data"), "thinkingLow");
	assert.equal(resolveCategoryColor(result.config.categoryColors, AUTO_COMPACT_BUFFER_CATEGORY_ID), "borderMuted");
	assert.equal(resolveCategoryColor(result.config.categoryColors, FREE_SPACE_CATEGORY_ID), "accent");
});

test("loadConfigFile ignores invalid entries without discarding valid siblings", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, JSON.stringify({
		systemPromptColor: "success",
		skillsColor: "#ff00ff",
		userMessagesColor: 42,
		unknownColor: "accent",
	}));

	const result = loadConfigFile(filePath);

	assert.equal(resolveCategoryColor(result.config.categoryColors, "system-prompt"), "success");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "skills"), "customMessageLabel");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "user-messages"), "syntaxString");
	assert.equal(result.warnings.length, 3);
	assert.ok(result.warnings.some((warning) => warning.includes("skillsColor")));
	assert.ok(result.warnings.some((warning) => warning.includes("userMessagesColor")));
	assert.ok(result.warnings.some((warning) => warning.includes("unknownColor")));
});

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
