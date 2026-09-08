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

/** Today's date formatted like pi's base-prompt "Current date:" line. */
function currentDate(): string {
	const now = new Date();
	return [
		now.getFullYear(),
		String(now.getMonth() + 1).padStart(2, "0"),
		String(now.getDate()).padStart(2, "0"),
	].join("-");
}

test("analyzeSystemPrompt emits stable semantic ids and content-only measurements", () => {
	const contextBlock = [
		"<project_context>",
		"",
		"Project-specific instructions and guidelines:",
		"",
		'<project_instructions path="./AGENTS.md">',
		"Project rules",
		"</project_instructions>",
		"",
		"</project_context>",
	].join("\n");
	const skillsBlock = [
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"<available_skills>",
		"  <skill>",
		"    <name>testing</name>",
		"    <description>Test &amp; verify</description>",
		"    <location>/skills/testing/SKILL.md</location>",
		"  </skill>",
		"  <skill>",
		"    <name>docs</name>",
		"    <description>Write docs</description>",
		"    <location>/skills/docs/SKILL.md</location>",
		"  </skill>",
		"</available_skills>",
	].join("\n");
	const append = "APPENDED INSTRUCTION";
	const extensionAddition = "\nEXTENSION INSTRUCTION";
	const systemPrompt = [
		"BASE PROMPT",
		"",
		"Available tools:",
		"- search: Search the web",
		"",
		"Guidelines:",
		"- Cite sources",
		"",
		contextBlock,
		skillsBlock,
		append,
		"Current date: 2001-02-03",
		`Current working directory: ${CWD}`,
	].join("\n") + extensionAddition;
	const options: PromptOptionsSlice = {
		cwd: CWD,
		appendSystemPrompt: append,
		contextFilePaths: ["./AGENTS.md"],
		skills: [
			{ name: "testing", description: "Test & verify", filePath: "/skills/testing/SKILL.md" },
			{ name: "docs", description: "Write docs", filePath: "/skills/docs/SKILL.md" },
		],
	};
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

	const items = analyzeSystemPrompt(systemPrompt, options, tools);
	assert.deepEqual(
		items.map((entry) => entry.id),
		[
			"base-prompt",
			"tool:npm:web:search",
			"tool:builtin",
			"context-files",
			"skills",
			"prompt-addition:unattributed",
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
	const additions = items.find((entry) => entry.id === "prompt-addition:unattributed");
	assert.equal(additions?.text, extensionAddition);
	assert.equal(additions?.source.label, "unattributed");
	// The addition is presented inside System Prompt, but never counted there.
	const additionsPart = findItem(items, "base-prompt:additions");
	assert.equal(additionsPart?.label, "Extension Additions");
	assert.equal(additionsPart?.tokens, 0);
	assert.deepEqual(
		additionsPart?.injectedReferences?.map((reference) => [reference.text, reference.itemId]),
		[[extensionAddition, "prompt-addition:unattributed"]],
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

test("analyzeSystemPrompt breaks tool items into reconciling prompt and definition sections", () => {
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

	const items = analyzeSystemPrompt(systemPrompt, { cwd: CWD }, tools);
	const search = items.find((entry) => entry.id === "tool:npm:web:search");
	assert.deepEqual(
		search?.sections?.map((section) => section.label),
		["Available Tools", "Guidelines", "Definition"],
	);
	assert.equal(search?.sections?.[0]?.text, "\n- search: Search the web");
	assert.equal(search?.sections?.[1]?.text, `\n- ${guidelines[0]}\n- ${guidelines[1]}`);
	assert.equal(search?.sections?.[2]?.text, 'search: Search\n{"q":"string"}');
	// The schema is marked where it was serialized, so previews expand it without detecting JSON.
	const definition = search?.sections?.[2];
	const schemaSpan = definition?.jsonSpan;
	assert.ok(schemaSpan !== undefined);
	assert.equal(definition?.text.slice(schemaSpan.start, schemaSpan.end), '{"q":"string"}');
	assert.equal(search?.sections?.[0]?.jsonSpan, undefined);
	// Sections partition the item without changing what it contributes.
	assert.equal(search?.sections?.map((section) => section.text).join(""), search?.text);
	assert.equal(search?.sections?.reduce((sum, section) => sum + section.tokens, 0), search?.tokens);

	const builtin = items.find((entry) => entry.id === "tool:builtin")?.children?.[0];
	assert.deepEqual(builtin?.sections?.map((section) => section.label), ["Definition"]);
	assert.equal(builtin?.sections?.[0]?.tokens, builtin?.tokens);
	const base = items.find((entry) => entry.id === "base-prompt");
	assert.doesNotMatch(base?.text ?? "", /Cite sources|search: Search the web/);
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

	const items = analyzeSystemPrompt(systemPrompt, {
		cwd: CWD,
		appendSystemPrompt: append,
		contextFilePaths: ["./AGENTS.md"],
	}, tools);
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
	// The blocks pi renders keep the lines it puts there, footer included.
	assert.match(findItem(items, "base-prompt:available-tools")?.text ?? "", /^\nAvailable tools:\n- read: Read files/);
	assert.match(findItem(items, "base-prompt:guidelines")?.text ?? "", /^\nGuidelines:\n- /);
	assert.match(findItem(items, "base-prompt:documentation")?.text ?? "", /^\nPi documentation /);
	assert.equal(findItem(items, "base-prompt:appended")?.text, append);
	assert.equal(findItem(items, "base-prompt:current-dir")?.text, `\nCurrent working directory: ${CWD}`);
	assert.doesNotMatch(findItem(items, "base-prompt:preamble")?.text ?? "", /Available tools:|Guidelines:/);
});

test("analyzeSystemPrompt gives guessed prompt additions to their extension and the rest to unattributed", () => {
	const systemPrompt = buildSystemPrompt({ cwd: CWD, selectedTools: [] }) +
		"\n\nBe brief." +
		"\n\nRead npm:pi-web docs before searching.";
	const sources = [{ source: "npm:pi-web", path: "/pkgs/pi-web/index.ts", baseDir: "/pkgs/pi-web" }];

	const items = analyzeSystemPrompt(systemPrompt, { cwd: CWD }, [], { sources });

	const attributed = findItem(items, "prompt-addition:npm:pi-web");
	const unattributed = findItem(items, "prompt-addition:unattributed");
	assert.equal(attributed?.text, "\n\nRead npm:pi-web docs before searching.");
	assert.equal(attributed?.source.id, "tool-source:npm:pi-web");
	assert.equal(attributed?.label, "system prompt additions");
	assert.equal(unattributed?.text, "\n\nBe brief.");
	assert.equal(unattributed?.tokens, textTokens("\n\nBe brief."));

	// System Prompt presents both runs in prompt order without counting either.
	const base = findItem(items, "base-prompt");
	const part = base?.children?.at(-1);
	assert.equal(part?.id, "base-prompt:additions");
	assert.equal(part?.text, "");
	assert.equal(part?.tokens, 0);
	assert.deepEqual(
		part?.injectedReferences?.map((reference) => [reference.text, reference.source.label, reference.attribution]),
		[
			["\n\nBe brief.", "unattributed", undefined],
			["\n\nRead npm:pi-web docs before searching.", "npm:pi-web", "guess"],
		],
	);
	assert.doesNotMatch(base?.text ?? "", /Be brief|pi-web/);
	assert.equal(base?.tokens, base?.children?.reduce((sum, child) => sum + child.tokens, 0));
});

test("analyzeSystemPrompt bounds prompt-addition attribution at this extension's own handler", () => {
	const base = buildSystemPrompt({ cwd: CWD, selectedTools: [] });
	const before = "\n\nShared wording.";
	const after = "\n\nShared wording.";

	const items = analyzeSystemPrompt(`${base}${before}${after}`, { cwd: CWD }, [], {
		promptAtHandler: `${base}${before}`,
	});

	// Identical text on both sides has two authors, so the preview keeps two runs.
	assert.deepEqual(
		findItem(items, "base-prompt:additions")?.injectedReferences?.map((reference) => reference.text),
		[before, after],
	);
	// They remain unattributable, so one item still counts them exactly once.
	assert.equal(findItem(items, "prompt-addition:unattributed")?.text, `${before}${after}`);
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

	const items = analyzeSystemPrompt(systemPrompt, { cwd: CWD }, tools);
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

	const items = analyzeSystemPrompt(systemPrompt, { cwd: CWD }, tools);
	const search = items.find((entry) => entry.id === "tool:npm:web:search");
	const fetch = items.find((entry) => entry.id === "tool:npm:web:fetch");
	assert.deepEqual(
		search?.sections?.map((section) => section.label),
		["Available Tools", "Guidelines", "Definition"],
	);
	assert.equal(search?.sections?.[1]?.text, `\n- ${shared}`);
	// Pi renders the shared bullet once, so the later tool contributes no bullet.
	assert.deepEqual(fetch?.sections?.map((section) => section.label), ["Available Tools", "Definition"]);
	assert.equal(items.filter((entry) => entry.text.includes(shared)).length, 1);
});

test("Available Tools references restore extension snippets without changing counted text", () => {
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
	const items = analyzeSystemPrompt(prompt, { cwd: CWD }, tools);
	const base = findItem(items, "base-prompt");
	const availableTools = findItem(items, "base-prompt:available-tools");
	assert.ok(base !== undefined && availableTools !== undefined);
	const references = availableTools.injectedReferences ?? [];
	assert.deepEqual(references.map((reference) => [reference.text, reference.itemId, reference.source.label]), [
		["\n- search: Search the web", "tool:npm:web:search", "npm:web"],
	]);
	assert.deepEqual(
		base.sections?.find((section) => section.label === "Available Tools")?.injectedReferences,
		references,
	);
	// Pi renders its own bullet for a built-in tool, so that line stays counted here.
	assert.match(availableTools.text, /- read: Read files/);
	assert.doesNotMatch(availableTools.text, /Search the web/);
	let restored = availableTools.text;
	for (const reference of [...references].reverse()) {
		restored = restored.slice(0, reference.offset) + reference.text + restored.slice(reference.offset);
	}
	const start = prompt.indexOf("\nAvailable tools:\n");
	assert.equal(restored, prompt.slice(start, prompt.indexOf("\nGuidelines:\n", start)));
	// The carved snippet keeps its tokens on the owning tool, never in both places.
	assert.equal(findItem(items, "tool:npm:web:search")?.sections?.[0]?.text, "\n- search: Search the web");
	assert.equal(base.tokens, textTokens(base.text));
	assert.equal(base.sections?.reduce((sum, section) => sum + section.tokens, 0), base.tokens);
	assert.equal(base.sections?.map((section) => section.text).join(""), base.text);
	assert.equal(findItem(items, "base-prompt:preamble")?.injectedReferences, undefined);
});

test("guideline references restore prompt order without changing counted text or token shares", () => {
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
	const items = analyzeSystemPrompt(prompt, { cwd: CWD, appendSystemPrompt: `Repeated text: ${shared}` }, tools);
	const base = findItem(items, "base-prompt");
	const guidelines = findItem(items, "base-prompt:guidelines");
	assert.ok(base !== undefined && guidelines !== undefined);
	const references = guidelines.injectedReferences ?? [];
	assert.deepEqual(references.map((reference) => [reference.text, reference.itemId, reference.source.label]), [
		[`\n- ${shared}`, "tool:npm:web:search", "npm:web"],
		[`\n- ${other}`, "tool:npm:fetch:fetch", "npm:fetch"],
	]);
	assert.deepEqual(base.sections?.find((section) => section.label === "Guidelines")?.injectedReferences, references);
	let restored = guidelines.text;
	for (const reference of [...references].reverse()) {
		restored = restored.slice(0, reference.offset) + reference.text + restored.slice(reference.offset);
	}
	const start = prompt.indexOf("\nGuidelines:\n");
	assert.equal(restored, prompt.slice(start, prompt.indexOf("\nPi documentation", start)));
	assert.doesNotMatch(guidelines.text, /Cite sources|Use fetch/);
	assert.match(guidelines.text, /Use read/);
	assert.equal(base.tokens, textTokens(base.text));
	assert.equal(base.chars, base.text.length);
	assert.equal(base.sections?.reduce((sum, section) => sum + section.tokens, 0), base.tokens);
	assert.equal(base.children?.reduce((sum, child) => sum + child.tokens, 0), base.tokens);
	assert.equal(base.sections?.map((section) => section.text).join(""), base.text);

	const snapshot = buildSnapshot(items, "real-turn", new Date());
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
	const items = analyzeSystemPrompt(prompt, { cwd: CWD }, tools);
	const references = findItem(items, "base-prompt:guidelines")?.injectedReferences;
	assert.deepEqual(references?.map((reference) => reference.source.label), ["npm:long", "npm:short"]);
	assert.equal(references?.[0]?.offset, references?.[1]?.offset);
	assert.doesNotMatch(findItem(items, "base-prompt:guidelines")?.text ?? "", /Cite|sources/);
	const missing = analyzeSystemPrompt(prompt.replace("\n- Cite\n", "\n"), { cwd: CWD }, tools);
	assert.deepEqual(findItem(missing, "tool:npm:short:short")?.sections?.map((section) => section.label), ["Definition"]);
	assert.equal(findItem(missing, "base-prompt:guidelines")?.injectedReferences?.length, 1);
});

test("analyzeSystemPrompt leaves pi's own and built-in tool bullets in the base prompt", () => {
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

	const items = analyzeSystemPrompt(systemPrompt, { cwd: CWD }, tools);
	const search = items.find((entry) => entry.id === "tool:npm:web:search");
	// Pi credits one bullet to the built-in tool that declared it first and adds
	// the file-exploration bullet itself, so the extension tool carves neither.
	assert.deepEqual(search?.sections?.map((section) => section.label), ["Available Tools", "Definition"]);
	const base = items.find((entry) => entry.id === "base-prompt");
	assert.ok(base?.text.includes(`\n- ${builtinGuideline}`));
	assert.ok(base?.text.includes(`\n- ${piGuideline}`));
	assert.equal(findItem(items, "base-prompt:guidelines")?.injectedReferences, undefined);
});

test("analyzeSystemPrompt carves tool lines only from the blocks pi renders them into", () => {
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

	const items = analyzeSystemPrompt(systemPrompt, { cwd: CWD, contextFilePaths: [filePath] }, tools);
	const search = items.find((entry) => entry.id === "tool:npm:web:search");
	// The guideline never reached the Guidelines block, so the identical context
	// file line stays with the file instead of being counted twice.
	assert.deepEqual(search?.sections?.map((section) => section.label), ["Available Tools", "Definition"]);
	assert.equal(search?.sections?.[0]?.text, "\n- search: Search the web");
	assert.equal(findItem(items, `context-file:${filePath}`)?.text, content);
	assert.equal(findItem(items, "base-prompt:guidelines")?.injectedReferences, undefined);
});

test("analyzeSystemPrompt does not attribute context-file lines as custom-prompt tool guidance", () => {
	const filePath = "./AGENTS.md";
	const contextBlock = [
		"<project_context>",
		`<project_instructions path="${filePath}">`,
		"- search: Search the web",
		"- Cite sources",
		"</project_instructions>",
		"</project_context>",
	].join("\n");
	const systemPrompt = [
		"CUSTOM PROMPT",
		contextBlock,
		`Current date: ${currentDate()}`,
		`Current working directory: ${CWD}`,
	].join("\n");
	const tools: ToolSlice[] = [{
		name: "search",
		description: "Search",
		parametersJson: "{}",
		snippet: "Search the web",
		guidelines: ["Cite sources"],
		source: "npm:web",
	}];

	const items = analyzeSystemPrompt(systemPrompt, {
		cwd: CWD,
		customPrompt: "CUSTOM PROMPT",
		contextFilePaths: [filePath],
	}, tools);
	const search = items.find((entry) => entry.id === "tool:npm:web:search");
	// The dropped lines stay out of the counted text, so the context file keeps them.
	assert.equal(search?.text, "search: Search\n{}");
	assert.equal(findItem(items, `context-file:${filePath}`)?.text.includes("- Cite sources"), true);
	assert.equal(findItem(items, "base-prompt:preamble")?.text.trim(), "CUSTOM PROMPT");
});

test("analyzeSystemPrompt measures a replaced prompt as the content pi actually sends", () => {
	const customPrompt = "You are a terse reviewer.\nAnswer in one sentence.";
	const skill = { name: "commit", description: "Commit changes", filePath: "/skills/commit/SKILL.md" };
	// Pi's loader shape; only the slice above reaches measurement.
	const loadedSkill = {
		...skill,
		baseDir: "/skills/commit",
		sourceInfo: { path: skill.filePath, source: "user", scope: "user", origin: "top-level" },
		disableModelInvocation: false,
	} as const;
	const guidelines = ["Cite sources"];
	// Pi builds the custom branch, which ignores toolSnippets and promptGuidelines entirely.
	const systemPrompt = buildSystemPrompt({
		cwd: CWD,
		customPrompt,
		appendSystemPrompt: "APPENDED RULE",
		contextFiles: [{ path: "./AGENTS.md", content: "Project rules" }],
		skills: [loadedSkill],
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

	const items = analyzeSystemPrompt(systemPrompt, {
		cwd: CWD,
		customPrompt,
		appendSystemPrompt: "APPENDED RULE",
		contextFilePaths: ["./AGENTS.md"],
		skills: [skill],
	}, tools);

	// System Prompt carries the replacement text itself, not pi's replaced base prompt.
	assert.equal(findItem(items, "base-prompt:preamble")?.text.trim(), customPrompt);
	assert.equal(findItem(items, "base-prompt:appended")?.text, "APPENDED RULE");
	// The blocks the replacement gave up stay visible, at no cost, instead of vanishing.
	assert.deepEqual(
		findItem(items, "base-prompt")?.children?.map((child) => child.label),
		["Preamble", "Available Tools", "Guidelines", "Documentation", "Appended Prompt", "Current Dir"],
	);
	assert.equal(findItem(items, "context-file:./AGENTS.md")?.text, "Project rules");
	assert.equal(findItem(items, "skills")?.children?.length, 1);
	// The custom branch ends its cwd footer with a newline, which is not an extension addition.
	assert.equal(findItem(items, "prompt-addition:unattributed"), undefined);
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

	const items = analyzeSystemPrompt(systemPrompt, { cwd: CWD, customPrompt }, tools);
	const basePrompt = findItem(items, "base-prompt");
	const droppedChildren = (basePrompt?.children ?? []).filter((child) => child.dropped === true);

	// Every dropped block is present, empty of pi's own text, and free.
	assert.deepEqual(droppedChildren.map((child) => child.label), ["Available Tools", "Guidelines", "Documentation"]);
	assert.ok(droppedChildren.every((child) => child.text === "" && child.tokens === 0));
	assert.equal(findItem(items, "base-prompt:documentation")?.injectedReferences, undefined);
	assert.equal(basePrompt?.tokens, textTokens(basePrompt?.text ?? ""));
	assert.equal(
		basePrompt?.tokens,
		(basePrompt?.sections ?? []).reduce((sum, section) => sum + section.tokens, 0),
	);

	// Only extension lines stay visible in a dropped block, attributed to their tool.
	assert.deepEqual(
		findItem(items, "base-prompt:available-tools")?.injectedReferences?.map((reference) => ({
			text: reference.text,
			source: reference.source.label,
			tool: reference.tool,
		})),
		[{ text: "\n- search: Search the web", source: "npm:web", tool: "search" }],
	);
	assert.deepEqual(
		findItem(items, "base-prompt:guidelines")?.injectedReferences?.map((reference) => reference.text),
		["\n- Cite sources"],
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

test("analyzeSystemPrompt recovers the prompt blocks an extension relocated past the footer", () => {
	const addition = "EXTENSION INSTRUCTION";
	const systemPrompt = relocateToolSurface(buildRelocationPrompt())
		.replace(/\n\nAvailable tools:/, `\n\n${addition}\n\nAvailable tools:`);

	const items = analyzeSystemPrompt(systemPrompt, { cwd: CWD }, RELOCATION_TOOLS);
	const basePrompt = findItem(items, "base-prompt");

	// The moved blocks are pi's parts again, following the footer they now sit behind.
	assert.deepEqual(
		basePrompt?.children?.map((child) => child.label),
		["Preamble", "Documentation", "Current Dir", "Available Tools", "Guidelines", "Extension Additions"],
	);
	assert.deepEqual(
		basePrompt?.children?.filter((child) => child.moved === true).map((child) => child.label),
		["Available Tools", "Guidelines"],
	);
	assert.deepEqual(
		basePrompt?.sections?.filter((section) => section.moved === true).map((section) => section.label),
		["Available Tools", "Guidelines"],
	);

	// A moved block counts exactly like an unmoved one: shares still reconcile.
	assert.equal(basePrompt?.tokens, textTokens(basePrompt?.text ?? ""));
	assert.equal(
		basePrompt?.tokens,
		(basePrompt?.sections ?? []).reduce((sum, section) => sum + section.tokens, 0),
	);
	assert.equal(findItem(items, "base-prompt:available-tools")?.text.includes("- read: Read files"), true);
	assert.equal(findItem(items, "base-prompt:guidelines")?.text.includes("- Be concise in your responses"), true);

	// Extension lines are carved out of the moved blocks and attributed as usual.
	assert.deepEqual(
		findItem(items, "base-prompt:available-tools")?.injectedReferences?.map((reference) => ({
			text: reference.text,
			source: reference.source.label,
			tool: reference.tool,
		})),
		[{ text: "\n- search: Search the web", source: "npm:web", tool: "search" }],
	);
	assert.deepEqual(
		findItem(items, "tool:npm:web:search")?.sections?.map((section) => section.label),
		["Available Tools", "Guidelines", "Definition"],
	);

	// Pi's own text stays pi's: only the real addition is attributed to an extension.
	assert.equal(findItem(items, "prompt-addition:unattributed")?.text.trim(), addition);
});

test("recovered references retain exact offsets when every tool line is extension-owned", () => {
	const tool = RELOCATION_TOOLS[1];
	assert.ok(tool);
	const surface = "\nAvailable tools:\n- search: Search the web\n\nGuidelines:\n- Cite sources";
	const prompt = `Preamble\nPi documentation:\n- Manual\nCurrent working directory: ${CWD}${surface}`;
	const items = analyzeSystemPrompt(prompt, { cwd: CWD }, [tool]);
	assert.equal(findItem(items, "prompt-addition:unattributed"), undefined);
	for (const [id, expected] of [
		["base-prompt:available-tools", "\nAvailable tools:\n- search: Search the web"],
		["base-prompt:guidelines", "\nGuidelines:\n- Cite sources"],
	]) {
		const part = findItem(items, id);
		assert.ok(part);
		let restored = part.text;
		for (const reference of [...part.injectedReferences ?? []].reverse()) {
			assert.ok(reference.offset >= 0 && reference.offset <= part.text.length);
			restored = restored.slice(0, reference.offset) + reference.text + restored.slice(reference.offset);
		}
		assert.equal(restored, expected);
	}
});

test("rearranged pre-footer blocks and appended instructions retain their real order", () => {
	const append = "APPEND RULE";
	const surface = "\nAvailable tools:\n- read: Read files\n\nGuidelines:\n- Cite sources";
	const prompt = `Preamble\nPi documentation:\n- Manual\n\n${append}${surface}\nCurrent working directory: ${CWD}`;
	const items = analyzeSystemPrompt(prompt, { cwd: CWD, appendSystemPrompt: append }, RELOCATION_TOOLS);
	const base = findItem(items, "base-prompt");
	assert.deepEqual(base?.children?.map((child) => child.label), [
		"Preamble", "Documentation", "Appended Prompt", "Available Tools", "Guidelines", "Current Dir",
	]);
	assert.equal(findItem(items, "base-prompt:available-tools")?.moved, true);
	assert.equal(findItem(items, "base-prompt:guidelines")?.moved, true);
	assert.equal(base?.text, base?.sections?.map((section) => section.text).join(""));
	assert.equal(base?.tokens, base?.children?.reduce((sum, child) => sum + child.tokens, 0));
});

test("separated relocated blocks preserve additions on both sides and never recreate withheld tools", () => {
	const prompt = `Preamble\nPi documentation:\n- Manual\nCurrent working directory: ${CWD}` +
		"\n\nFirst addition.\n\nAvailable tools:\n- read: Read files" +
		"\n\nMiddle addition.\n\nGuidelines:\n- Be concise in your responses\n\nLast addition.";
	const items = analyzeSystemPrompt(prompt, { cwd: CWD }, RELOCATION_TOOLS.slice(0, 1));
	const addition = findItem(items, "prompt-addition:unattributed");
	assert.ok(addition);
	for (const word of ["First addition.", "Middle addition.", "Last addition."]) assert.ok(addition.text.includes(word));
	assert.doesNotMatch(addition.text, /Available tools:|Guidelines:|Read files/);
	assert.equal(findItem(items, "tool:npm:web:search"), undefined);
	assert.equal(findItem(items, "base-prompt:available-tools")?.moved, true);
	assert.equal(findItem(items, "base-prompt:guidelines")?.moved, true);
});

test("instruction-file header examples cannot capture or suppress moved tool lines", () => {
	const example = "Available tools:\n- search: Search the web\n\nGuidelines:\n- Cite sources";
	const prompt = `Preamble\nPi documentation:\n- Manual\n\n<project_context>\n` +
		`<project_instructions path=\"./AGENTS.md\">\n${example}\n</project_instructions>\n</project_context>` +
		`\nCurrent working directory: ${CWD}\n\n${example}`;
	const items = analyzeSystemPrompt(prompt, { cwd: CWD, contextFilePaths: ["./AGENTS.md"] }, RELOCATION_TOOLS);
	assert.equal(findItem(items, "context-file:./AGENTS.md")?.text, example);
	assert.equal(findItem(items, "base-prompt:available-tools")?.moved, true);
	assert.equal(findItem(items, "base-prompt:guidelines")?.moved, true);
});

test("analyzeSystemPrompt keeps block-shaped additions out of pi's own prompt", () => {
	// Shaped exactly like a relocated run, bullets pi could have written included.
	const surface = ["Available tools:", "- read: Read files", "", "Guidelines:", "- Cite sources"].join("\n");
	const rendered = `${buildRelocationPrompt()}\n\n${surface}`;
	const replaced = ["CUSTOM PROMPT", `Current working directory: ${CWD}`, "", surface].join("\n");

	// Pi rendered its own blocks, so nothing was moved and the later run is an addition.
	const renderedItems = analyzeSystemPrompt(rendered, { cwd: CWD }, RELOCATION_TOOLS);
	assert.equal(
		(findItem(renderedItems, "base-prompt")?.children ?? []).some((child) => child.moved === true),
		false,
	);
	assert.equal(findItem(renderedItems, "prompt-addition:unattributed")?.text.includes("Available tools:"), true);

	// A replacement makes pi render no blocks, so an identical run is the extension's own text.
	const replacedItems = analyzeSystemPrompt(replaced, { cwd: CWD, customPrompt: "CUSTOM PROMPT" }, RELOCATION_TOOLS);
	assert.equal(
		(findItem(replacedItems, "base-prompt")?.children ?? []).some((child) => child.moved === true),
		false,
	);
	assert.equal(findItem(replacedItems, "prompt-addition:unattributed")?.text.includes("Available tools:"), true);
});

test("analyzeSystemPrompt recognizes the pi 0.81 CWD-only footer", () => {
	const extensionAddition = "\nEXTENSION INSTRUCTION";
	const systemPrompt = [
		"BASE PROMPT",
		`Current working directory: ${CWD}`,
	].join("\n") + extensionAddition;

	const items = analyzeSystemPrompt(systemPrompt, { cwd: CWD });
	const base = items.find((entry) => entry.id === "base-prompt");
	assert.equal(base?.text, `BASE PROMPT\nCurrent working directory: ${CWD}`);
	assert.equal(items.find((entry) => entry.id === "prompt-addition:unattributed")?.text, extensionAddition);
});

test("analyzeSystemPrompt rejects CWD lines that are not the exact footer line", () => {
	const systemPrompt = [
		"BASE PROMPT",
		// Prefix of a longer path: not followed by a line boundary.
		`Current working directory: ${CWD}/subdir`,
		// Different cwd entirely.
		"Current working directory: /tmp/other-project",
		"TRAILING BASE TEXT",
	].join("\n");

	const items = analyzeSystemPrompt(systemPrompt, { cwd: CWD });
	assert.equal(items.length, 1);
	assert.equal(items[0]?.id, "base-prompt");
	assert.equal(items[0]?.text, systemPrompt);
	// One part is no breakdown: an undivided prompt exposes no sub-items.
	assert.equal(items[0]?.children, undefined);
	assert.equal(items[0]?.sections, undefined);
});

test("analyzeSystemPrompt finds the footer in real buildSystemPrompt output", () => {
	const append = "APPENDED INSTRUCTION";
	const systemPrompt = buildSystemPrompt({
		cwd: CWD,
		appendSystemPrompt: append,
		contextFiles: [{ path: "./AGENTS.md", content: "Project rules" }],
	});
	const extensionAddition = "\nEXTENSION INSTRUCTION";
	const options: PromptOptionsSlice = {
		cwd: CWD,
		appendSystemPrompt: append,
		contextFilePaths: ["./AGENTS.md"],
	};

	const items = analyzeSystemPrompt(systemPrompt + extensionAddition, options);
	const base = items.find((entry) => entry.id === "base-prompt");
	assert.ok(base !== undefined);
	assert.equal(findItem(items, "base-prompt:current-dir")?.text, `\nCurrent working directory: ${CWD}`);
	assert.equal(findItem(items, "context-file:./AGENTS.md")?.text, "Project rules");
	assert.equal(findItem(items, "base-prompt:appended")?.text, append);
	assert.equal(items.find((entry) => entry.id === "prompt-addition:unattributed")?.text, extensionAddition);
});

test("analyzeSystemPrompt abbreviates home-directory context-file labels with ~", () => {
	const homeDir = "/home/tester";
	const filePath = `${homeDir}/.pi/agent/AGENTS.md`;
	const contextBlock = [
		"<project_context>",
		`<project_instructions path="${filePath}">`,
		"Global rules",
		"</project_instructions>",
		"</project_context>",
	].join("\n");
	const systemPrompt = [
		"BASE PROMPT",
		contextBlock,
		`Current date: ${currentDate()}`,
		`Current working directory: ${CWD}`,
	].join("\n");
	const options: PromptOptionsSlice = {
		cwd: CWD,
		homeDir,
		contextFilePaths: [filePath],
	};

	const items = analyzeSystemPrompt(systemPrompt, options);
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
	const options: PromptOptionsSlice = {
		cwd: CWD,
		homeDir: "/home/tester",
		contextFilePaths: [globalPath, projectPath],
	};

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
