import assert from "node:assert/strict";
import { test } from "node:test";

import type { SlashCommandInfo, ToolInfo } from "@earendil-works/pi-coding-agent";

import { collectPromptSources, type PromptSourceSlice, splitPromptAdditions } from "../src/prompt-additions.ts";

const CWD_SECTION = "<cwd>\n/tmp/project\n</cwd>";
const ASK: PromptSourceSlice = {
	source: "npm:@eko24ive/pi-ask",
	path: "/home/tester/.pi/agent/npm/node_modules/@eko24ive/pi-ask/dist/index.js",
	baseDir: "/home/tester/.pi/agent/npm/node_modules/@eko24ive/pi-ask",
	names: ["ask_user", "/ask"],
};
const WEB: PromptSourceSlice = {
	source: "npm:pi-web",
	path: "/home/tester/.pi/agent/npm/node_modules/pi-web/index.ts",
	baseDir: "/home/tester/.pi/agent/npm/node_modules/pi-web",
	names: ["web_search", "fetch", "go"],
};
const BUILTIN: PromptSourceSlice = { source: "builtin", path: "<builtin:read>" };

/** Split the unwrapped region a prompt appends after pi's cwd section. */
function split(
	addition: string,
	sources: readonly PromptSourceSlice[] = [],
): Array<[string, string, string | undefined]> {
	const prompt = `${CWD_SECTION}${addition}`;
	const runs = splitPromptAdditions(prompt, CWD_SECTION.length, { sources });
	// Runs must reconstruct the region exactly; no measured text is invented or lost.
	assert.equal(runs.map((run) => run.text).join(""), addition);
	return runs.map((run) => [run.text, run.source.label, run.attribution]);
}

/** Owner of each run: its extension label and the tool or command the text named. */
function owners(
	addition: string,
	sources: readonly PromptSourceSlice[],
): Array<[string, string, string | undefined]> {
	const runs = splitPromptAdditions(`${CWD_SECTION}${addition}`, CWD_SECTION.length, { sources });
	return runs.map((run) => [run.text, run.source.label, run.tool]);
}

test("splitPromptAdditions names a tool or command only on a unique, complete mention", () => {
	assert.deepEqual(
		owners("\n\nCall web_search before answering; see npm:pi-web.", [ASK, WEB]),
		[["\n\nCall web_search before answering; see npm:pi-web.", "npm:pi-web", "web_search"]],
	);
	// A command counts only where it is written with the slash a user types.
	assert.deepEqual(
		owners("\n\nRun /ask before editing @eko24ive/pi-ask config.", [ASK, WEB]),
		[["\n\nRun /ask before editing @eko24ive/pi-ask config.", "npm:@eko24ive/pi-ask", "/ask"]],
	);
	assert.deepEqual(
		owners("\n\nAsk the user first; @eko24ive/pi-ask explains why.", [ASK, WEB]),
		[["\n\nAsk the user first; @eko24ive/pi-ask explains why.", "npm:@eko24ive/pi-ask", undefined]],
	);
});

test("splitPromptAdditions leaves ambiguous, embedded, and short tool names unnamed", () => {
	// Two tools of one extension cannot both own one block, as two packages cannot.
	assert.deepEqual(
		owners("\n\nUse web_search, then fetch. See npm:pi-web.", [WEB]),
		[["\n\nUse web_search, then fetch. See npm:pi-web.", "npm:pi-web", undefined]],
	);
	// A path segment naming the tool is documentation, not a mention.
	assert.deepEqual(
		owners(`\n\nSee ${WEB.baseDir}/docs/web_search.md.`, [WEB]),
		[[`\n\nSee ${WEB.baseDir}/docs/web_search.md.`, "npm:pi-web", undefined]],
	);
	// Two-character names match ordinary prose, so they never qualify a label.
	assert.deepEqual(
		owners("\n\nGo on, npm:pi-web knows the way.", [WEB]),
		[["\n\nGo on, npm:pi-web knows the way.", "npm:pi-web", undefined]],
	);
});

test("splitPromptAdditions keeps blocks naming different tools of one extension apart", () => {
	assert.deepEqual(
		owners("\n\nnpm:pi-web: call web_search.\n\nnpm:pi-web: call fetch.\n\nnpm:pi-web again: fetch.", [WEB]),
		[
			["\n\nnpm:pi-web: call web_search.", "npm:pi-web", "web_search"],
			["\n\nnpm:pi-web: call fetch.\n\nnpm:pi-web again: fetch.", "npm:pi-web", "fetch"],
		],
	);
});

test("splitPromptAdditions names a package only on a unique, complete match", () => {
	assert.deepEqual(
		split("\n\nRead @eko24ive/pi-ask docs before editing.", [ASK, WEB, BUILTIN]),
		[["\n\nRead @eko24ive/pi-ask docs before editing.", "npm:@eko24ive/pi-ask", "guess"]],
	);
	// A package path is as good a signal as its name.
	assert.deepEqual(
		split(`\n\nSee ${ASK.baseDir}/docs/configuration.md first.`, [ASK, WEB]),
		[[`\n\nSee ${ASK.baseDir}/docs/configuration.md first.`, "npm:@eko24ive/pi-ask", "guess"]],
	);
	assert.deepEqual(
		split(`\n\nLoaded from ${WEB.path}.`, [ASK, WEB]),
		[[`\n\nLoaded from ${WEB.path}.`, "npm:pi-web", "guess"]],
	);
});

test("splitPromptAdditions leaves ambiguous, partial, and unknown text unattributed", () => {
	// Two candidates cannot both own one block.
	assert.deepEqual(
		split("\n\nUse @eko24ive/pi-ask with npm:pi-web.", [ASK, WEB]),
		[["\n\nUse @eko24ive/pi-ask with npm:pi-web.", "unattributed", undefined]],
	);
	// A longer package name only starts with a loaded one.
	assert.deepEqual(
		split("\n\nUse pi-web-providers for search.", [WEB]),
		[["\n\nUse pi-web-providers for search.", "unattributed", undefined]],
	);
	assert.deepEqual(
		split("\n\nRespond like a pirate.", [ASK, WEB]),
		[["\n\nRespond like a pirate.", "unattributed", undefined]],
	);
	// Built-in tools never append prompt text, so they are no candidates.
	assert.deepEqual(split("\n\nread the file", [BUILTIN]), [["\n\nread the file", "unattributed", undefined]]);
});

test("splitPromptAdditions attributes blank-line blocks separately and merges same-source neighbours", () => {
	assert.deepEqual(
		split("\n\nPirate mode.\n\nRead @eko24ive/pi-ask docs.\n\nStill pi-ask territory: @eko24ive/pi-ask.", [ASK]),
		[
			["\n\nPirate mode.", "unattributed", undefined],
			[
				"\n\nRead @eko24ive/pi-ask docs.\n\nStill pi-ask territory: @eko24ive/pi-ask.",
				"npm:@eko24ive/pi-ask",
				"guess",
			],
		],
	);
});

test("section exclusions keep source evidence separate", () => {
	const before = "\n\nRead npm:pi-web docs.";
	const moved = "\n<tools>\n- web_search: Search\n</tools>";
	const after = "\nStill unowned.";
	const prompt = CWD_SECTION + before + moved + after;
	const start = CWD_SECTION.length + before.length;
	const end = start + moved.length;
	const runs = splitPromptAdditions(prompt, CWD_SECTION.length, { sources: [WEB], excluded: [{ start, end }] });
	assert.equal(runs.map((run) => run.text).join(""), before + after);
	assert.deepEqual(runs.map((run) => run.source.label), [WEB.source, "unattributed"]);
});

test("splitPromptAdditions excludes several sections without inventing whitespace owners", () => {
	const first = "\n<tools>\n- read: Read files\n</tools>";
	const second = "\n<rules>\n- Use read\n</rules>";
	const prompt = CWD_SECTION + first + "\n\n" + second;
	assert.deepEqual(splitPromptAdditions(prompt, CWD_SECTION.length, {
		excluded: [
			{ start: CWD_SECTION.length, end: CWD_SECTION.length + first.length },
			{ start: prompt.indexOf(second), end: prompt.length },
		],
	}), []);
});

test("splitPromptAdditions keeps separators and trailing whitespace inside runs", () => {
	assert.deepEqual(
		split("\n\n\nSpaced out.\n \n@eko24ive/pi-ask rules.\n\n  \n", [ASK]),
		[
			["\n\n\nSpaced out.", "unattributed", undefined],
			["\n \n@eko24ive/pi-ask rules.\n\n  \n", "npm:@eko24ive/pi-ask", "guess"],
		],
	);
});

test("collectPromptSources rosters the names of extension tools and commands", () => {
	const tool = (name: string, source: string): ToolInfo => ({
		name,
		description: `${name} description`,
		parameters: {} as ToolInfo["parameters"],
		exposure: "direct",
		sourceInfo: { path: `/tmp/${name}.ts`, source, scope: "temporary", origin: "top-level" },
	});
	const command = (name: string, source: string): SlashCommandInfo => ({
		name,
		source: "extension",
		sourceInfo: { path: `/tmp/${name}.ts`, source, scope: "temporary", origin: "top-level" },
	});
	const sources = collectPromptSources(
		[tool("read", "builtin"), tool("search", "npm:web"), tool("fetch", "npm:web")],
		[command("ask", "npm:ask"), command("/web", "npm:web")],
	);

	// One roster entry per extension file, and commands keep the slash prompts use.
	assert.deepEqual(sources.map((source) => [source.source, source.names]), [
		["npm:web", ["search"]],
		["npm:web", ["fetch"]],
		["npm:ask", ["/ask"]],
		["npm:web", ["/web"]],
	]);
});
