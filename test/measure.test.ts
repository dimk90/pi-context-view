import assert from "node:assert/strict";
import { test } from "node:test";

// Deep import bypasses the package barrel, which does not re-export buildSystemPrompt.
import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { analyzeSystemPrompt, type PromptOptionsSlice, textTokens, type ToolSlice } from "../src/measure.ts";
import { buildSnapshot, type InjectionItem } from "../src/model.ts";
import { collectPreviewEntries, computeUsage } from "../src/usage.ts";
import { relocateToolSurface } from "./fixtures/relocated-prompt.ts";

const CWD = "/tmp/context-project";

/** Find a measured item by id, including aggregate sub-items. */
function findItem(items: readonly InjectionItem[], id: string): InjectionItem | undefined {
	for (const item of items) {
		if (item.id === id) return item;
		const child = findItem(item.children ?? [], id);
		if (child !== undefined) return child;
	}
	return undefined;
}

/** Each annotated extension line of a System Prompt part: its text, source label, and tool. */
function annotatedLines(
	part: Pick<InjectionItem, "text" | "injectedReferences"> | undefined,
): Array<[string, string, string | undefined]> | undefined {
	return part?.injectedReferences?.map((reference) =>
		[part.text.slice(reference.start, reference.end), reference.source.label, reference.tool]
	);
}

/** Skill in pi's loader shape; only its name, description, and path reach the prompt. */
function loadedSkill(name: string, description: string) {
	const filePath = `/skills/${name}/SKILL.md`;
	return {
		name, description, filePath, baseDir: `/skills/${name}`, disableModelInvocation: false,
		sourceInfo: { path: filePath, source: "user", scope: "user", origin: "top-level" },
	} as const;
}

test("analyzeSystemPrompt emits stable semantic ids and content-only measurements", () => {
	const append = "APPENDED INSTRUCTION";
	const extensionAddition = "\nEXTENSION INSTRUCTION";
	const systemPrompt = buildSystemPrompt({
		cwd: CWD,
		appendSystemPrompt: append,
		contextFiles: [{ path: "./AGENTS.md", content: "Project rules" }],
		skills: [loadedSkill("testing", "Test & verify"), loadedSkill("docs", "Write docs")],
		selectedTools: ["read", "bash", "search"],
		toolSnippets: { search: "Search the web" },
		promptGuidelines: ["Cite sources"],
	}) + extensionAddition;
	const tools: ToolSlice[] = [
		{
			name: "read",
			description: "Read files",
			parametersJson: "{}",
			guidelines: [],
			source: "builtin",
		},
		{
			name: "bash",
			description: "Run a bash command with a much longer description than read",
			parametersJson: "{}",
			guidelines: [],
			source: "builtin",
		},
		{
			name: "search",
			description: "Search",
			parametersJson: "{}",
			snippet: "Search the web",
			guidelines: ["Cite sources"],
			source: "npm:web",
		},
	];

	const items = analyzeSystemPrompt(systemPrompt, {}, tools);
	assert.deepEqual(
		items.map((entry) => entry.id),
		[
			"base-prompt",
			"tool:npm:web:search",
			"tool:builtin",
			"context-files",
			"skills",
		],
	);
	assert.equal(items.find((entry) => entry.id === "tool:npm:web:search")?.source.id, "tool-source:npm:web");
	const base = items.find((entry) => entry.id === "base-prompt");
	assert.equal(base?.label, "System Prompt");
	assert.doesNotMatch(base?.text ?? "", /project_context|project_instructions|Project-specific instructions/);
	assert.doesNotMatch(base?.text ?? "", /available_skills|The following skills/);
	const instructions = items.find((entry) => entry.id === "context-files");
	assert.equal(instructions?.label, "Instruction Files (1)");
	const contextFile = findItem(items, "context-file:./AGENTS.md");
	assert.equal(contextFile?.kind, "context-file");
	assert.equal(contextFile?.text, "Project rules");
	assert.equal(contextFile?.chars, "Project rules".length);
	// System Prompt counts the addition in its own part, annotated with its source.
	const additionsPart = findItem(items, "base-prompt:additions");
	assert.equal(additionsPart?.label, "Extension Additions");
	assert.equal(additionsPart?.text, extensionAddition);
	assert.ok((additionsPart?.tokens ?? 0) > 0);
	assert.ok(base?.text.endsWith(extensionAddition));
	assert.deepEqual(
		additionsPart?.injectedReferences?.map((reference) => [reference.start, reference.end, reference.source.label]),
		[[0, extensionAddition.length, "unattributed"]],
	);

	const skills = items.find((entry) => entry.id === "skills");
	assert.equal(skills?.label, "Skills (2)");
	assert.deepEqual(
		skills?.children?.map((child) => [child.id, child.label, child.text]),
		[
			["skill:testing", "testing", "testing\nTest & verify\n/skills/testing/SKILL.md"],
			["skill:docs", "docs", "docs\nWrite docs\n/skills/docs/SKILL.md"],
		],
	);
	assert.equal(skills?.chars, skills?.children?.reduce((sum, child) => sum + child.chars, 0));
	assert.equal(skills?.tokens, skills?.children?.reduce((sum, child) => sum + child.tokens, 0));
	assert.doesNotMatch(skills?.text ?? "", /<skill>|<name>|available_skills|Use the read tool/);

	const builtin = items.find((entry) => entry.id === "tool:builtin");
	assert.equal(builtin?.label, "Built-in Tools (2)");
	assert.deepEqual(
		builtin?.children?.map((child) => child.id),
		["tool:builtin:bash", "tool:builtin:read"],
	);
	const childTokens = builtin?.children?.reduce((sum, child) => sum + child.tokens, 0) ?? 0;
	assert.ok(childTokens > 0);
	assert.equal(builtin?.tokens, childTokens);
});

test("analyzeSystemPrompt counts a tool's definition and leaves its prompt lines to System Prompt", () => {
	const guidelines = ["Use search when the user asks for current information", "Cite sources"];
	const systemPrompt = buildSystemPrompt({
		cwd: CWD,
		selectedTools: ["read", "search"],
		toolSnippets: { read: "Read files", search: "Search the web" },
		promptGuidelines: guidelines,
	});
	const tools: ToolSlice[] = [
		{
			name: "read",
			description: "Read files",
			parametersJson: "{}",
			snippet: "Read files",
			guidelines: [],
			source: "builtin",
		},
		{
			name: "search",
			description: "Search",
			parametersJson: '{"q":"string"}',
			snippet: "Search the web",
			guidelines,
			source: "npm:web",
		},
	];

	const items = analyzeSystemPrompt(systemPrompt, {}, tools);
	const search = items.find((entry) => entry.id === "tool:npm:web:search");
	assert.deepEqual(search?.sections?.map((section) => section.label), ["Definition"]);
	assert.equal(search?.text, 'search: Search\n{"q":"string"}');
	assert.equal(search?.sections?.[0]?.tokens, search?.tokens);
	// The schema is marked where it was serialized, so previews expand it without detecting JSON.
	const definition = search?.sections?.[0];
	const schemaSpan = definition?.jsonSpan;
	assert.ok(schemaSpan !== undefined);
	assert.equal(definition?.text.slice(schemaSpan.start, schemaSpan.end), '{"q":"string"}');

	const builtin = items.find((entry) => entry.id === "tool:builtin")?.children?.[0];
	assert.deepEqual(builtin?.sections?.map((section) => section.label), ["Definition"]);
	assert.equal(builtin?.sections?.[0]?.tokens, builtin?.tokens);
	// The lines pi renders for the extension tool count once, in System Prompt.
	const base = items.find((entry) => entry.id === "base-prompt");
	for (const line of ["\n- search: Search the web", `\n- ${guidelines[0]}`, `\n- ${guidelines[1]}`]) {
		assert.equal(base?.text.split(line).length, 2, line);
		assert.equal(items.filter((entry) => entry.text.includes(line)).length, 1, line);
	}
	assert.equal(base?.tokens, textTokens(base?.text ?? ""));
});

test("analyzeSystemPrompt gives each path extension its own source, labelled by path", () => {
	const systemPrompt = buildSystemPrompt({ cwd: CWD, selectedTools: ["codemode", "mark"] });
	const tool = (name: string, sourcePath: string): ToolSlice =>
		({ name, description: name, parametersJson: "{}", guidelines: [], source: "cli", sourcePath });
	const tools = [tool("codemode", "/repo/fixtures/hidden-tools.ts"), tool("mark", "/repo/fixtures/marker/index.ts")];
	const sources = tools.map((entry) => ({ source: entry.source, path: entry.sourcePath ?? "" }));

	const groups = buildSnapshot(analyzeSystemPrompt(systemPrompt, {}, tools, { sources }))
		.groups.filter((group) => !group.source.native);
	assert.deepEqual(groups.map((group) => [group.source.label, group.items.map((item) => item.label)]).sort(), [
		["hidden-tools.ts", ["codemode"]],
		["marker", ["mark"]],
	]);
});

test("analyzeSystemPrompt breaks the System Prompt into the parts pi assembles it from", () => {
	const append = "APPENDED RULE";
	const systemPrompt = buildSystemPrompt({
		cwd: CWD,
		selectedTools: ["read", "bash"],
		toolSnippets: { read: "Read files", bash: "Run commands" },
		appendSystemPrompt: append,
		contextFiles: [{ path: "./AGENTS.md", content: "Project rules" }],
	});
	const tools: ToolSlice[] = [{
		name: "read",
		description: "Read files",
		parametersJson: "{}",
		snippet: "Read files",
		guidelines: [],
		source: "builtin",
	}];

	const items = analyzeSystemPrompt(systemPrompt, {}, tools);
	const base = items.find((entry) => entry.id === "base-prompt");
	const parts = ["Preamble", "Available Tools", "Guidelines", "Documentation", "Appended Prompt", "Current Dir"];
	assert.deepEqual(base?.children?.map((child) => child.label), parts);
	assert.deepEqual(base?.sections?.map((section) => section.label), parts);
	assert.deepEqual(
		base?.children?.map((child) => child.id),
		[
			"base-prompt:preamble",
			"base-prompt:available-tools",
			"base-prompt:guidelines",
			"base-prompt:documentation",
			"base-prompt:appended",
			"base-prompt:current-dir",
		],
	);
	// Parts break the prompt down: they partition its text and its estimate.
	assert.equal(base?.sections?.map((section) => section.text).join(""), base?.text);
	assert.equal(base?.sections?.reduce((sum, section) => sum + section.tokens, 0), base?.tokens);
	assert.equal(base?.children?.reduce((sum, child) => sum + child.tokens, 0), base?.tokens);
	assert.deepEqual(
		base?.children?.map((child) => child.tokens),
		base?.sections?.map((section) => section.tokens),
	);
	// The sections pi renders keep the lines it puts there, cwd included.
	assert.match(findItem(items, "base-prompt:available-tools")?.text ?? "", /^\n- read: Read files/);
	assert.match(findItem(items, "base-prompt:guidelines")?.text ?? "", /^\n- /);
	assert.match(findItem(items, "base-prompt:documentation")?.text ?? "", /^Pi documentation /);
	assert.equal(findItem(items, "base-prompt:appended")?.text, append);
	assert.equal(findItem(items, "base-prompt:current-dir")?.text, CWD);
	assert.doesNotMatch(base?.text ?? "", /<\/?(?:tools|rules|docs|addendum|cwd)>/);
});

test("analyzeSystemPrompt counts prompt additions in System Prompt and annotates their guessed sources", () => {
	const brief = "\n\nBe brief.";
	const docs = "\n\nRead npm:pi-web docs before searching.";
	const systemPrompt = buildSystemPrompt({ cwd: CWD, selectedTools: [] }) + brief + docs;
	const sources = [{ source: "npm:pi-web", path: "/pkgs/pi-web/index.ts", baseDir: "/pkgs/pi-web" }];

	const items = analyzeSystemPrompt(systemPrompt, {}, [], { sources });

	// No extension item counts the additions again.
	assert.deepEqual(items.map((item) => item.id), ["base-prompt"]);
	const base = findItem(items, "base-prompt");
	const part = base?.children?.at(-1);
	assert.equal(part?.id, "base-prompt:additions");
	assert.equal(part?.kind, "prompt-addition");
	assert.equal(part?.text, brief + docs);
	assert.equal(part?.chars, (brief + docs).length);
	assert.ok((part?.tokens ?? 0) > 0);
	assert.deepEqual(
		part?.injectedReferences?.map((reference) => [
			part.text.slice(reference.start, reference.end), reference.source.label, reference.attribution,
		]),
		[
			[brief, "unattributed", undefined],
			[docs, "npm:pi-web", "guess"],
		],
	);
	assert.ok(base?.text.endsWith(brief + docs));
	assert.equal(base?.tokens, textTokens(base?.text ?? ""));
	assert.equal(base?.tokens, base?.children?.reduce((sum, child) => sum + child.tokens, 0));
});

test("analyzeSystemPrompt exposes each aggregate child as a labeled part carrying its marked JSON", () => {
	const systemPrompt = buildSystemPrompt({ cwd: CWD, selectedTools: ["read", "bash"] });
	const tools: ToolSlice[] = [
		{
			name: "read",
			description: "Read files",
			parametersJson: '{"path":"string"}',
			guidelines: [],
			source: "builtin",
		},
		{
			name: "bash",
			description: "Run a bash command with a much longer description than read",
			parametersJson: '{"command":"string"}',
			guidelines: [],
			source: "builtin",
		},
	];

	const items = analyzeSystemPrompt(systemPrompt, {}, tools);
	const builtin = items.find((entry) => entry.id === "tool:builtin");
	assert.deepEqual(builtin?.sections?.map((section) => section.label), ["bash", "read"]);
	// Parts partition the aggregate text and reconcile with the children they name.
	assert.equal(builtin?.sections?.map((section) => section.text).join(""), builtin?.text);
	assert.deepEqual(
		builtin?.sections?.map((section) => section.tokens),
		builtin?.children?.map((child) => child.tokens),
	);
	// Each part marks the schema of its own tool, including after the joining break.
	assert.deepEqual(
		builtin?.sections?.map((section) => section.text.slice(section.jsonSpan?.start, section.jsonSpan?.end)),
		['{"command":"string"}', '{"path":"string"}'],
	);
});

test("analyzeSystemPrompt gives a repeated guideline bullet to the tool pi renders it for", () => {
	const shared = "Cite sources";
	const systemPrompt = buildSystemPrompt({
		cwd: CWD,
		selectedTools: ["search", "fetch"],
		toolSnippets: { search: "Search the web", fetch: "Fetch a URL" },
		promptGuidelines: [shared, shared],
	});
	const tools: ToolSlice[] = [
		{
			name: "search",
			description: "Search",
			parametersJson: "{}",
			snippet: "Search the web",
			guidelines: [shared],
			source: "npm:web",
		},
		{
			name: "fetch",
			description: "Fetch",
			parametersJson: "{}",
			snippet: "Fetch a URL",
			guidelines: [shared],
			source: "npm:web",
		},
	];

	const items = analyzeSystemPrompt(systemPrompt, {}, tools);
	const guidelines = findItem(items, "base-prompt:guidelines");
	// Pi renders the shared bullet once, so only the first tool declaring it is named.
	assert.deepEqual(
		guidelines?.injectedReferences?.map((reference) => [
			guidelines.text.slice(reference.start, reference.end), reference.tool,
		]),
		[[`\n- ${shared}`, "search"]],
	);
	assert.equal(items.filter((entry) => entry.text.includes(shared)).length, 1);
});

test("Available Tools annotates extension snippets inside the text it counts", () => {
	const tools: ToolSlice[] = [
		{
			name: "read",
			description: "Read",
			parametersJson: "{}",
			snippet: "Read files",
			guidelines: [],
			source: "builtin",
		},
		{
			name: "search",
			description: "Search",
			parametersJson: "{}",
			snippet: "Search the web",
			guidelines: ["Cite sources"],
			source: "npm:web",
		},
	];
	const prompt = buildSystemPrompt({
		cwd: CWD,
		selectedTools: ["read", "search"],
		toolSnippets: { read: "Read files", search: "Search the web" },
		promptGuidelines: ["Cite sources"],
	});
	const items = analyzeSystemPrompt(prompt, {}, tools);
	const base = findItem(items, "base-prompt");
	const availableTools = findItem(items, "base-prompt:available-tools");
	assert.ok(base !== undefined && availableTools !== undefined);
	assert.deepEqual(annotatedLines(availableTools), [["\n- search: Search the web", "npm:web", "search"]]);
	assert.deepEqual(
		base.sections?.find((section) => section.text === findItem(items, "base-prompt:available-tools")?.text)?.injectedReferences,
		availableTools.injectedReferences,
	);
	// The part counts its whole body: pi's own bullets and the extension snippet alike.
	const start = prompt.indexOf("<tools>\n") + "<tools>".length;
	assert.equal(availableTools.text, prompt.slice(start, prompt.indexOf("\n</tools>", start)));
	assert.equal(availableTools.chars, availableTools.text.length);
	// The snippet counts once, in System Prompt, never also on its tool.
	assert.deepEqual(findItem(items, "tool:npm:web:search")?.sections?.map((section) => section.label), ["Definition"]);
	assert.equal(base.tokens, textTokens(base.text));
	assert.equal(base.sections?.reduce((sum, section) => sum + section.tokens, 0), base.tokens);
	assert.equal(base.sections?.map((section) => section.text).join(""), base.text);
	assert.equal(findItem(items, "base-prompt:preamble")?.injectedReferences, undefined);
});

test("Guidelines annotates extension bullets in prompt order and counts them in System Prompt", () => {
	const shared = "Cite sources";
	const native = "Use read for files";
	const other = "Use fetch for links";
	const tools: ToolSlice[] = [
		{ name: "search", description: "Search", parametersJson: "{}", guidelines: [shared], source: "npm:web" },
		{ name: "read", description: "Read", parametersJson: "{}", guidelines: [native], source: "builtin" },
		{ name: "fetch", description: "Fetch", parametersJson: "{}", guidelines: [shared, other], source: "npm:fetch" },
	];
	const prompt = buildSystemPrompt({
		cwd: CWD,
		selectedTools: tools.map((tool) => tool.name),
		toolSnippets: { search: "Search", fetch: "Fetch" },
		promptGuidelines: [shared, native, shared, other],
		appendSystemPrompt: `Repeated text: ${shared}`,
	});
	const items = analyzeSystemPrompt(prompt, {}, tools);
	const base = findItem(items, "base-prompt");
	const guidelines = findItem(items, "base-prompt:guidelines");
	assert.ok(base !== undefined && guidelines !== undefined);
	assert.deepEqual(annotatedLines(guidelines), [
		[`\n- ${shared}`, "npm:web", "search"],
		[`\n- ${other}`, "npm:fetch", "fetch"],
	]);
	assert.deepEqual(
		base.sections?.find((section) => section.text === findItem(items, "base-prompt:guidelines")?.text)?.injectedReferences,
		guidelines.injectedReferences,
	);
	const start = prompt.indexOf("<rules>\n") + "<rules>".length;
	assert.equal(guidelines.text, prompt.slice(start, prompt.indexOf("\n</rules>", start)));
	assert.equal(base.tokens, textTokens(base.text));
	assert.equal(base.chars, base.text.length);
	assert.equal(base.sections?.reduce((sum, section) => sum + section.tokens, 0), base.tokens);
	assert.equal(base.children?.reduce((sum, child) => sum + child.tokens, 0), base.tokens);
	assert.equal(base.sections?.map((section) => section.text).join(""), base.text);

	const snapshot = buildSnapshot(items);
	const usage = computeUsage({ snapshot, messages: [] });
	assert.equal(usage.estimatedTokens, snapshot.totalTokens);
	const category = usage.categories.find((category) => category.id === "system-prompt");
	assert.ok(category !== undefined);
	assert.equal(category.tokens, base.tokens);
	assert.deepEqual(collectPreviewEntries(category)[0]?.sections, snapshot.groups[0]?.items[0]?.sections);
	assert.equal(usage.categories.find((category) => category.id === "custom-tools")?.tokens,
		items.filter((item) => item.kind === "tool" && !item.source.native).reduce((sum, item) => sum + item.tokens, 0));
});

test("guideline attribution matches complete bullets rather than shorter prefixes", () => {
	const tools: ToolSlice[] = [
		{ name: "short", description: "Short", parametersJson: "{}", guidelines: ["Cite"], source: "npm:short" },
		{ name: "long", description: "Long", parametersJson: "{}", guidelines: ["Cite sources"], source: "npm:long" },
	];
	const prompt = buildSystemPrompt({ cwd: CWD, selectedTools: ["short", "long"], promptGuidelines: ["Cite sources", "Cite"] });
	const items = analyzeSystemPrompt(prompt, {}, tools);
	assert.deepEqual(annotatedLines(findItem(items, "base-prompt:guidelines")), [
		["\n- Cite sources", "npm:long", "long"],
		["\n- Cite", "npm:short", "short"],
	]);
	const missing = analyzeSystemPrompt(prompt.replace("\n- Cite\n", "\n"), {}, tools);
	assert.equal(findItem(missing, "base-prompt:guidelines")?.injectedReferences?.length, 1);
});

test("analyzeSystemPrompt names no extension tool for pi's own and built-in tool bullets", () => {
	const builtinGuideline = "Use read to examine files instead of cat or sed.";
	const piGuideline = "Use bash for file operations like ls, rg, find";
	const systemPrompt = buildSystemPrompt({
		cwd: CWD,
		selectedTools: ["read", "bash", "search"],
		toolSnippets: { read: "Read files", bash: "Run commands", search: "Search the web" },
		promptGuidelines: [builtinGuideline, builtinGuideline, piGuideline],
	});
	const tools: ToolSlice[] = [
		{
			name: "read",
			description: "Read files",
			parametersJson: "{}",
			snippet: "Read files",
			guidelines: [builtinGuideline],
			source: "builtin",
		},
		{
			name: "bash",
			description: "Run commands",
			parametersJson: "{}",
			snippet: "Run commands",
			guidelines: [],
			source: "builtin",
		},
		{
			name: "search",
			description: "Search",
			parametersJson: "{}",
			snippet: "Search the web",
			guidelines: [builtinGuideline, piGuideline],
			source: "npm:web",
		},
	];

	const items = analyzeSystemPrompt(systemPrompt, {}, tools);
	assert.deepEqual(annotatedLines(findItem(items, "base-prompt:available-tools")), [
		["\n- search: Search the web", "npm:web", "search"],
	]);
	// Pi credits one bullet to the built-in tool that declared it first and adds
	// the file-exploration bullet itself, so the extension tool is named on neither.
	const base = items.find((entry) => entry.id === "base-prompt");
	assert.ok(base?.text.includes(`\n- ${builtinGuideline}`));
	assert.ok(base?.text.includes(`\n- ${piGuideline}`));
	assert.equal(findItem(items, "base-prompt:guidelines")?.injectedReferences, undefined);
});

test("analyzeSystemPrompt annotates tool lines only in the blocks pi renders them into", () => {
	const filePath = "./AGENTS.md";
	const content = "- search: Search the web\n- Cite sources";
	const systemPrompt = buildSystemPrompt({
		cwd: CWD,
		selectedTools: ["search"],
		toolSnippets: { search: "Search the web" },
		contextFiles: [{ path: filePath, content }],
	});
	const tools: ToolSlice[] = [{
		name: "search",
		description: "Search",
		parametersJson: "{}",
		snippet: "Search the web",
		guidelines: ["Cite sources"],
		source: "npm:web",
	}];

	const items = analyzeSystemPrompt(systemPrompt, {}, tools);
	// The guideline never reached the Guidelines block, so the identical context
	// file line stays with the file and names no tool.
	assert.deepEqual(annotatedLines(findItem(items, "base-prompt:available-tools")), [
		["\n- search: Search the web", "npm:web", "search"],
	]);
	assert.equal(findItem(items, `context-file:${filePath}`)?.text, content);
	assert.equal(findItem(items, "base-prompt:guidelines")?.injectedReferences, undefined);
});

test("analyzeSystemPrompt does not attribute context-file lines as custom-prompt tool guidance", () => {
	const filePath = "./AGENTS.md";
	const systemPrompt = buildSystemPrompt({
		cwd: CWD,
		customPrompt: "CUSTOM PROMPT",
		contextFiles: [{ path: filePath, content: "- search: Search the web\n- Cite sources" }],
		selectedTools: ["search"],
		toolSnippets: { search: "Search the web" },
		promptGuidelines: ["Cite sources"],
	});
	const tools: ToolSlice[] = [{
		name: "search",
		description: "Search",
		parametersJson: "{}",
		snippet: "Search the web",
		guidelines: ["Cite sources"],
		source: "npm:web",
	}];

	const items = analyzeSystemPrompt(systemPrompt, { customPrompt: "CUSTOM PROMPT" }, tools);
	const search = items.find((entry) => entry.id === "tool:npm:web:search");
	// The dropped lines stay out of the counted text, so the context file keeps them.
	assert.equal(search?.text, "search: Search\n{}");
	assert.equal(findItem(items, `context-file:${filePath}`)?.text.includes("- Cite sources"), true);
	assert.equal(findItem(items, "base-prompt:preamble")?.text.trim(), "CUSTOM PROMPT");
});

test("analyzeSystemPrompt measures a replaced prompt as the content pi actually sends", () => {
	const customPrompt = "You are a terse reviewer.\nAnswer in one sentence.";
	const guidelines = ["Cite sources"];
	// Pi builds the custom branch, which ignores toolSnippets and promptGuidelines entirely.
	const systemPrompt = buildSystemPrompt({
		cwd: CWD,
		customPrompt,
		appendSystemPrompt: "APPENDED RULE",
		contextFiles: [{ path: "./AGENTS.md", content: "Project rules" }],
		skills: [loadedSkill("commit", "Commit changes")],
		selectedTools: ["read", "search"],
		toolSnippets: { read: "Read files", search: "Search the web" },
		promptGuidelines: guidelines,
	});
	const tools: ToolSlice[] = [
		{
			name: "read",
			description: "Read files",
			parametersJson: "{}",
			snippet: "Read files",
			guidelines: [],
			source: "builtin",
		},
		{
			name: "search",
			description: "Search",
			parametersJson: "{}",
			snippet: "Search the web",
			guidelines,
			source: "npm:web",
		},
	];

	const items = analyzeSystemPrompt(systemPrompt, { customPrompt }, tools);

	// System Prompt carries the replacement text itself, not pi's replaced base prompt.
	assert.equal(findItem(items, "base-prompt:preamble")?.text.trim(), customPrompt);
	assert.equal(findItem(items, "base-prompt:appended")?.text, "APPENDED RULE");
	// The blocks the replacement gave up stay visible, at no cost, instead of vanishing.
	assert.deepEqual(
		findItem(items, "base-prompt")?.children?.map((child) => child.id),
		["preamble", "available-tools", "guidelines", "documentation", "appended", "current-dir"].map((id) => `base-prompt:${id}`),
	);
	assert.equal(findItem(items, "context-file:./AGENTS.md")?.text, "Project rules");
	assert.equal(findItem(items, "skills")?.children?.length, 1);
	// Nothing outside the sections remains, so no text is an extension addition.
	assert.equal(findItem(items, "base-prompt:additions"), undefined);
});

test("analyzeSystemPrompt marks the parts a replaced prompt drops without counting them", () => {
	const customPrompt = "You are a terse reviewer.";
	const guidelines = ["Cite sources"];
	const systemPrompt = buildSystemPrompt({
		cwd: CWD,
		customPrompt,
		selectedTools: ["read", "search"],
		toolSnippets: { read: "Read files", search: "Search the web" },
		promptGuidelines: guidelines,
	});
	const tools: ToolSlice[] = [
		{
			name: "read",
			description: "Read files",
			parametersJson: "{}",
			snippet: "Read files",
			guidelines: [],
			source: "builtin",
		},
		{
			name: "search",
			description: "Search",
			parametersJson: "{}",
			snippet: "Search the web",
			guidelines,
			source: "npm:web",
		},
	];

	const items = analyzeSystemPrompt(systemPrompt, { customPrompt }, tools);
	const basePrompt = findItem(items, "base-prompt");
	const droppedChildren = (basePrompt?.children ?? []).filter((child) => child.dropped === true);

	// Every dropped block is present, empty of pi's own text, and free.
	assert.deepEqual(droppedChildren.map((child) => child.id),
		["available-tools", "guidelines", "documentation"].map((id) => `base-prompt:${id}`));
	assert.ok(droppedChildren.every((child) => child.chars === 0 && child.tokens === 0));
	assert.equal(findItem(items, "base-prompt:documentation")?.text, "");
	assert.equal(findItem(items, "base-prompt:documentation")?.injectedReferences, undefined);
	assert.doesNotMatch(basePrompt?.text ?? "", /Search the web|Cite sources/);
	assert.equal(basePrompt?.tokens, textTokens(basePrompt?.text ?? ""));
	assert.equal(
		basePrompt?.tokens,
		(basePrompt?.sections ?? []).reduce((sum, section) => sum + section.tokens, 0),
	);

	// Only extension lines stay visible in a dropped block, attributed to their tool.
	const availableTools = findItem(items, "base-prompt:available-tools");
	assert.equal(availableTools?.text, "\n- search: Search the web");
	assert.deepEqual(annotatedLines(availableTools), [["\n- search: Search the web", "npm:web", "search"]]);
	assert.deepEqual(annotatedLines(findItem(items, "base-prompt:guidelines")), [
		["\n- Cite sources", "npm:web", "search"],
	]);
	assert.deepEqual(
		basePrompt?.sections?.filter((section) => section.dropped === true).map((section) => section.text),
		["\n- search: Search the web", "\n- Cite sources", ""],
	);

	// Each tool keeps its own dropped lines, at 0 tokens, outside its counted text.
	for (const id of ["tool:npm:web:search", "tool:builtin:read"]) {
		const tool = findItem(items, id);
		const dropped = (tool?.sections ?? []).filter((section) => section.dropped === true);
		assert.ok(dropped.length > 0, `${id} shows the prompt lines the replacement dropped`);
		assert.ok(dropped.every((section) => section.tokens === 0));
		assert.equal(tool?.text.includes("Search the web"), false);
		assert.equal(tool?.tokens, textTokens(tool?.text ?? ""));
	}
	assert.deepEqual(
		findItem(items, "tool:npm:web:search")?.sections?.map((section) => section.label),
		["Available Tools", "Guidelines", "Definition"],
	);
	assert.deepEqual(
		findItem(items, "tool:builtin:read")?.sections?.map((section) => section.label),
		["Available Tools", "Definition"],
	);
});

/** Active tools of a session whose tool-surface blocks an extension relocates. */
const RELOCATION_TOOLS: ToolSlice[] = [
	{
		name: "read",
		description: "Read files",
		parametersJson: "{}",
		snippet: "Read files",
		guidelines: [],
		source: "builtin",
	},
	{
		name: "search",
		description: "Search",
		parametersJson: "{}",
		snippet: "Search the web",
		guidelines: ["Cite sources"],
		source: "npm:web",
	},
];

/** Pi's own prompt for the tools above, before any extension rewrites it. */
function buildRelocationPrompt(): string {
	return buildSystemPrompt({
		cwd: CWD,
		selectedTools: ["read", "search"],
		toolSnippets: { read: "Read files", search: "Search the web" },
		promptGuidelines: ["Cite sources"],
	});
}

test("analyzeSystemPrompt marks the tool sections an extension relocated past cwd as moved", () => {
	const addition = "EXTENSION INSTRUCTION";
	const systemPrompt = relocateToolSurface(buildRelocationPrompt())
		.replace(/\n\n<tools>/, `\n\n${addition}\n\n<tools>`);

	const items = analyzeSystemPrompt(systemPrompt, {}, RELOCATION_TOOLS);
	const basePrompt = findItem(items, "base-prompt");

	// The moved sections stay pi's parts, following the cwd section they now sit behind.
	assert.deepEqual(
		basePrompt?.children?.map((child) => child.id),
		["preamble", "documentation", "current-dir", "available-tools", "guidelines", "additions"].map((id) => `base-prompt:${id}`),
	);
	assert.deepEqual(
		basePrompt?.children?.filter((child) => child.moved === true).map((child) => child.id),
		["base-prompt:available-tools", "base-prompt:guidelines"],
	);
	assert.deepEqual(
		basePrompt?.sections?.filter((section) => section.moved === true).map((section) => section.text),
		basePrompt?.children?.filter((child) => child.moved === true).map((child) => child.text),
	);

	// A moved block counts exactly like an unmoved one: shares still reconcile.
	assert.equal(basePrompt?.tokens, textTokens(basePrompt?.text ?? ""));
	assert.equal(
		basePrompt?.tokens,
		(basePrompt?.sections ?? []).reduce((sum, section) => sum + section.tokens, 0),
	);
	assert.equal(findItem(items, "base-prompt:available-tools")?.text.includes("- read: Read files"), true);
	assert.equal(findItem(items, "base-prompt:guidelines")?.text.includes("- Be concise in your responses"), true);

	// Extension lines in the moved blocks are annotated as usual.
	assert.deepEqual(annotatedLines(findItem(items, "base-prompt:available-tools")), [
		["\n- search: Search the web", "npm:web", "search"],
	]);
	assert.deepEqual(annotatedLines(findItem(items, "base-prompt:guidelines")), [
		["\n- Cite sources", "npm:web", "search"],
	]);

	// Pi's own text stays pi's: only the real addition is attributed to an extension.
	assert.equal(findItem(items, "base-prompt:additions")?.text.trim(), addition);
});

test("moved section annotations cover whole parts when every tool line is extension-owned", () => {
	const tool = RELOCATION_TOOLS[1];
	assert.ok(tool);
	const prompt = `Preamble\n\n<docs>\nManual\n</docs>\n\n<cwd>\n${CWD}\n</cwd>` +
		"\n\n<tools>\n- search: Search the web\n</tools>\n\n<rules>\n- Cite sources\n</rules>";
	const items = analyzeSystemPrompt(prompt, {}, [tool]);
	assert.equal(findItem(items, "base-prompt:additions"), undefined);
	for (const [id, expected] of [
		["base-prompt:available-tools", "\n- search: Search the web"],
		["base-prompt:guidelines", "\n- Cite sources"],
	]) {
		const part = findItem(items, id);
		assert.ok(part);
		assert.equal(part.moved, true);
		assert.equal(part.text, expected);
		assert.deepEqual(annotatedLines(part), [[expected, "npm:web", "search"]]);
	}
});

test("rearranged sections and appended instructions retain their real order", () => {
	const prompt = "Preamble\n\n<docs>\nManual\n</docs>\n\n<addendum>\nAPPEND RULE\n</addendum>" +
		"\n\n<tools>\n- read: Read files\n</tools>\n\n<rules>\n- Cite sources\n</rules>" +
		`\n\n<cwd>\n${CWD}\n</cwd>`;
	const items = analyzeSystemPrompt(prompt, {}, RELOCATION_TOOLS);
	const base = findItem(items, "base-prompt");
	assert.deepEqual(base?.children?.map((child) => child.id),
		["preamble", "documentation", "appended", "available-tools", "guidelines", "current-dir"].map((id) => `base-prompt:${id}`));
	assert.equal(findItem(items, "base-prompt:available-tools")?.moved, true);
	assert.equal(findItem(items, "base-prompt:guidelines")?.moved, true);
	assert.equal(base?.text, base?.sections?.map((section) => section.text).join(""));
	assert.equal(base?.tokens, base?.children?.reduce((sum, child) => sum + child.tokens, 0));
});

test("separated moved sections preserve additions on both sides and never recreate withheld tools", () => {
	const prompt = `Preamble\n\n<docs>\nManual\n</docs>\n\n<cwd>\n${CWD}\n</cwd>` +
		"\n\nFirst addition.\n\n<tools>\n- read: Read files\n</tools>" +
		"\n\nMiddle addition.\n\n<rules>\n- Be concise in your responses\n</rules>\n\nLast addition.";
	const items = analyzeSystemPrompt(prompt, {}, RELOCATION_TOOLS.slice(0, 1));
	const addition = findItem(items, "base-prompt:additions");
	assert.ok(addition);
	assert.deepEqual(addition.injectedReferences?.map((reference) => reference.source.label),
		["unattributed", "unattributed", "unattributed"]);
	for (const word of ["First addition.", "Middle addition.", "Last addition."]) assert.ok(addition.text.includes(word));
	assert.doesNotMatch(addition.text, /<\/?tools>|<\/?rules>|Read files/);
	assert.equal(findItem(items, "tool:npm:web:search"), undefined);
	assert.equal(findItem(items, "base-prompt:available-tools")?.moved, true);
	assert.equal(findItem(items, "base-prompt:guidelines")?.moved, true);
});

test("analyzeSystemPrompt measures a forced prompt without sections as one undivided part", () => {
	const systemPrompt = [
		"FORCED PROMPT",
		// Text shaped like pi's own blocks is not evidence of them without XML sections.
		"Available tools:",
		"- search: Search the web",
		`Current working directory: ${CWD}`,
		"",
		"Read npm:web docs before searching.",
	].join("\n");
	const sources = [{ source: "npm:web", path: "/pkgs/web/index.ts" }];

	const items = analyzeSystemPrompt(systemPrompt, {}, RELOCATION_TOOLS.slice(1), { sources });
	assert.deepEqual(items.map((entry) => entry.id), ["base-prompt", "tool:npm:web:search"]);
	assert.equal(items[0]?.text, systemPrompt);
	assert.equal(items[0]?.tokens, textTokens(systemPrompt));
	// One part is no breakdown: an undivided prompt exposes no sub-items.
	assert.equal(items[0]?.children, undefined);
	assert.equal(items[0]?.sections, undefined);
	// Tool declarations still reach the provider; no prompt line is carved for them.
	assert.deepEqual(items[1]?.sections?.map((section) => section.label), ["Definition"]);
});

test("analyzeSystemPrompt measures cwd, addendum, and instruction files in real buildSystemPrompt output", () => {
	const append = "APPENDED INSTRUCTION";
	const systemPrompt = buildSystemPrompt({
		cwd: CWD,
		appendSystemPrompt: append,
		contextFiles: [{ path: "./AGENTS.md", content: "Project rules" }],
	});
	const extensionAddition = "\nEXTENSION INSTRUCTION";

	const items = analyzeSystemPrompt(systemPrompt + extensionAddition, {});
	const base = items.find((entry) => entry.id === "base-prompt");
	assert.ok(base !== undefined);
	assert.equal(findItem(items, "base-prompt:current-dir")?.text, CWD);
	assert.equal(findItem(items, "context-file:./AGENTS.md")?.text, "Project rules");
	assert.equal(findItem(items, "base-prompt:appended")?.text, append);
	assert.equal(findItem(items, "base-prompt:additions")?.text, extensionAddition);
});

test("analyzeSystemPrompt abbreviates home-directory context-file labels with ~", () => {
	const homeDir = "/home/tester";
	const filePath = `${homeDir}/.pi/agent/AGENTS.md`;
	const systemPrompt = buildSystemPrompt({ cwd: CWD, contextFiles: [{ path: filePath, content: "Global rules" }] });

	const items = analyzeSystemPrompt(systemPrompt, { homeDir });
	const contextFile = findItem(items, `context-file:${filePath}`);
	assert.equal(contextFile?.label, "~/.pi/agent/AGENTS.md");
});

test("analyzeSystemPrompt groups every context file under one Instruction Files aggregate", () => {
	const globalPath = "/home/tester/.pi/agent/AGENTS.md";
	const projectPath = "./AGENTS.md";
	const systemPrompt = buildSystemPrompt({
		cwd: CWD,
		contextFiles: [
			{ path: globalPath, content: "Global rules" },
			{ path: projectPath, content: "Much longer project rules for this repository" },
		],
	});
	const options: PromptOptionsSlice = { homeDir: "/home/tester" };

	const items = analyzeSystemPrompt(systemPrompt, options);
	const instructions = items.find((entry) => entry.id === "context-files");
	assert.equal(instructions?.label, "Instruction Files (2)");
	assert.deepEqual(
		instructions?.children?.map((child) => [child.id, child.label]),
		[
			[`context-file:${projectPath}`, projectPath],
			[`context-file:${globalPath}`, "~/.pi/agent/AGENTS.md"],
		],
	);
	assert.deepEqual(instructions?.sections?.map((section) => section.label), [
		projectPath,
		"~/.pi/agent/AGENTS.md",
	]);
	assert.equal(instructions?.chars, instructions?.children?.reduce((sum, child) => sum + child.chars, 0));
	assert.equal(instructions?.tokens, instructions?.children?.reduce((sum, child) => sum + child.tokens, 0));
	assert.equal(items.filter((entry) => entry.kind === "context-file").length, 1);
});
