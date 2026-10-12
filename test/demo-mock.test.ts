/** Mock launcher checks use scratch config and local HTTP only; no real provider or PTY is involved. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { MOCK_REPLY, startDemoMockProvider } from "../scripts/demo-mock-provider.ts";
import { copySelectedThemes } from "../scripts/demo-mock-themes.ts";
import { runCommand } from "./harness/run-command.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/demo-injections.sh", import.meta.url));
const MONITOR = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const MODEL_ARGS = [
	"--offline", "--no-approve", "--no-session", "--model", "demo-mock/demo", "--models", "demo-mock/demo",
];
const SETTINGS = {
	theme: "dark", tuiMode: "regular", outputPad: 0, terminal: { showImages: false }, markdown: { mermaid: "off" },
	defaultProvider: "real-provider", defaultModel: "real-model", enabledModels: ["real-provider/*"],
	defaultTools: ["read"], sessionDir: "/must-not-use", cacheWarming: "idle", httpProxy: "http://must-not-use",
	extensions: ["/must-not-load"], skills: ["/must-not-load"], packages: ["npm:must-not-install"],
};
const KEYBINDINGS = '{"app.interrupt":["ctrl+c"]}\n';
const THEME = '{"name":"demo-test-theme"}\n';
// The launcher builds load order the same way with and without --mock; demo-injections covers both orders
const LAUNCH_CASES = [{ after: false, codemode: false }, { after: true, codemode: true }];
const THEME_TEMPLATE = JSON.parse(await readFile(join(
	dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
	"modes/interactive/theme/dark.json",
), "utf8")) as Record<string, unknown>;

/** Fake Pi records config metadata, tests the endpoint, and edits only its copied appearance files. */
const RECORDER = `
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const agentDir = process.env.PI_CODING_AGENT_DIR;
const read = (name) => readFile(join(agentDir, name), "utf8");
const themeFiles = await readdir(join(agentDir, "themes")).catch(() => []);
const themes = Object.fromEntries(await Promise.all(themeFiles.map(async (name) => [name, await read("themes/" + name)])));
const settings = JSON.parse(await read("settings.json"));
const models = JSON.parse(await read("models.json"));
const baseUrl = models.providers["demo-mock"].baseUrl;
const response = await fetch(baseUrl + "/chat/completions", {
	method: "POST", body: JSON.stringify({ model: "demo", messages: [] }),
});
const record = {
	args: process.argv.slice(2), agentDir, settings, models, auth: JSON.parse(await read("auth.json")),
	keybindings: await read("keybindings.json"), themes,
	reply: await response.text(), offline: process.env.PI_OFFLINE,
	proxies: [process.env.HTTP_PROXY, process.env.HTTPS_PROXY, process.env.ALL_PROXY],
};
await writeFile(join(agentDir, "keybindings.json"), "changed in the demo");
for (const name of themeFiles) await writeFile(join(agentDir, "themes", name), "changed in the demo");
await writeFile(process.env.DEMO_MOCK_RECORD, JSON.stringify(record));
if (process.env.DEMO_MOCK_WAIT === "1") setInterval(() => {}, 1000);
else process.exitCode = Number(process.env.DEMO_MOCK_EXIT ?? 0);
`;

/** Coarse recorder output contains config metadata and the canned response, never prompt bodies. */
interface MockRunRecord {
	readonly args: string[];
	readonly agentDir: string;
	readonly settings: Record<string, unknown>;
	readonly models: { providers: Record<string, { api: string; baseUrl: string; apiKey: string }> };
	readonly auth: Record<string, unknown>;
	readonly keybindings: string;
	readonly themes: Record<string, string>;
	readonly reply: string;
	readonly offline: string;
	readonly proxies: (string | null)[];
}

/** Scratch directories and child environment for one launcher run. */
interface LauncherSetup {
	readonly directory: string;
	readonly agentDir: string;
	readonly temporaryDir: string;
	readonly recordPath: string;
	readonly env: NodeJS.ProcessEnv;
}

for (const { after, codemode } of LAUNCH_CASES) {
	test(`--mock selects a local model with appearance-only config, after=${after}, codemode=${codemode}`, async (t) => {
		const setup = await prepareLauncher(t);
		const flags = ["--mock", "--payload", ...(after ? ["--after"] : []), ...(codemode ? ["--codemode-only"] : [])];
		const result = await runCommand("bash", [SCRIPT, ...flags, "a prompt with spaces"], {
			cwd: setup.directory, env: setup.env,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "");
		const record = await readRecord(setup);
		const fixtures = ["payload-changes", "payload-remove-tool"].map((fixture) =>
			fileURLToPath(new URL(`../scripts/fixtures/${fixture}.ts`, import.meta.url)));
		const paths = after ? [MONITOR, ...fixtures] : [...fixtures, MONITOR];
		assert.deepEqual(record.args, [...MODEL_ARGS, "--no-extensions", ...paths.flatMap((path) => ["-e", path]),
			...(codemode ? ["-e", "builtin:codemode"] : []), "a prompt with spaces"]);
		assert.equal(record.settings.theme, "dark");
		assert.equal(record.settings.tuiMode, "regular");
		assert.equal(record.settings.outputPad, 0);
		assert.deepEqual(record.settings.terminal, SETTINGS.terminal);
		assert.deepEqual(record.settings.markdown, SETTINGS.markdown);
		assert.equal(record.settings.defaultProvider, "demo-mock");
		assert.equal(record.settings.defaultModel, "demo");
		assert.deepEqual(record.settings.enabledModels, ["demo-mock/demo"]);
		assert.equal(record.settings.cacheWarming, "off");
		assert.deepEqual(record.settings.compaction, { enabled: false });
		assert.deepEqual(record.settings.retry, { enabled: false });
		for (const key of ["sessionDir", "extensions", "skills", "packages", "httpProxy"]) {
			assert.equal(record.settings[key], undefined, key);
		}
		assert.deepEqual(record.settings.defaultTools, codemode ? ["+codemode"] : undefined);
		assert.deepEqual(record.settings.codemode, codemode ? { mode: "only" } : undefined);
		assert.deepEqual(record.auth, {});
		assert.deepEqual(Object.keys(record.models.providers), ["demo-mock"]);
		assert.equal(record.models.providers["demo-mock"].api, "openai-completions");
		assert.match(record.models.providers["demo-mock"].baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
		assert.equal(record.models.providers["demo-mock"].apiKey, "mock-key");
		assert.equal(record.keybindings, KEYBINDINGS);
		assert.deepEqual(record.themes, {}, "the built-in dark theme needs no copied assets");
		assert.match(record.reply, /"content":"ok"/);
		assert.equal(record.offline, "1");
		assert.deepEqual(record.proxies, [null, null, null]);
		await assertCleanedUp(setup, record);
	});
}

for (const { after, codemode } of LAUNCH_CASES) {
	test(`--mock --local discovers global extensions only, after=${after}, codemode=${codemode}`, async (t) => {
		const setup = await prepareLauncher(t);
		const inherited = await prepareLocalExtensions(setup);
		const flags = after ? ["--local", "--mock", "--after"] : ["--mock", "--local"];
		const result = await runCommand("bash", [SCRIPT, ...flags, "--payload", ...(codemode ? ["--codemode-only"] : []),
			"a prompt with spaces"], { cwd: setup.directory, env: setup.env });
		assert.equal(result.status, 0, result.stderr);
		const record = await readRecord(setup);
		const fixtures = ["payload-changes", "payload-remove-tool"].map((fixture) =>
			fileURLToPath(new URL(`../scripts/fixtures/${fixture}.ts`, import.meta.url)));
		const paths = after ? [MONITOR, ...fixtures] : [...fixtures, MONITOR];
		assert.deepEqual(record.args, [...MODEL_ARGS, ...paths.flatMap((path) => ["-e", path]),
			...(codemode ? ["-e", "builtin:codemode"] : []), "a prompt with spaces"]);
		assert.deepEqual(record.settings.extensions, [
			join(setup.agentDir, "configured/index.ts"), join(setup.agentDir, "extensions/auto.ts"),
			join(setup.agentDir, "npm/node_modules/@demo/extensions/global.ts"),
			"-builtin:mcp", "-builtin:llama.cpp", "builtin:codemode", "builtin:tool-search",
		]);
		assert.equal(record.settings.theme, "one-dark");
		assert.deepEqual(record.themes, { "one-dark.json": themeJson("one-dark") });
		assert.equal(await readFile(join(setup.agentDir, "npm/node_modules/@demo/extensions/palette.json"), "utf8"),
			themeJson("one-dark"));
		for (const key of ["skills", "packages", "sessionDir", "httpProxy"]) {
			assert.equal(record.settings[key], undefined, key);
		}
		assert.equal(record.settings.defaultProjectTrust, "never");
		assert.deepEqual(record.settings.enabledModels, ["demo-mock/demo"]);
		assert.deepEqual(record.auth, {});
		assert.deepEqual(Object.keys(record.models.providers), ["demo-mock"]);
		await assert.rejects(readFile(join(setup.directory, "local-events.jsonl")),
			"discovery must not run extension lifecycle hooks before Pi starts");
		await assertCleanedUp(setup, record, inherited);
	});
}

test("--mock preserves a selected installed package theme without loading package code", async (t) => {
	const setup = await prepareLauncher(t);
	const packageRoot = join(setup.agentDir, "npm/node_modules/@demo/themes");
	await writeThemePackage(packageRoot);
	const settings = {
		...SETTINGS, theme: "one-dark", packages: [{ source: "npm:@demo/themes", themes: ["-palettes/unused.json"] }],
	};
	await writeFile(join(setup.agentDir, "settings.json"), JSON.stringify(settings));
	const result = await runCommand("bash", [SCRIPT, "--mock"], { cwd: setup.directory, env: setup.env });
	assert.equal(result.status, 0, result.stderr);
	const record = await readRecord(setup);
	assert.equal(record.settings.theme, "one-dark");
	assert.deepEqual(record.themes, { "one-dark.json": themeJson("one-dark") });
	assert.equal(record.settings.packages, undefined);
	assert.equal(record.settings.extensions, undefined);
	assert.equal(await readFile(join(packageRoot, "palettes/dark-palette.json"), "utf8"), themeJson("one-dark"));
	await assert.rejects(readFile(join(packageRoot, "extension-loaded")), "package code must not execute");
	assert.equal(await readFile(join(setup.agentDir, "settings.json"), "utf8"), JSON.stringify(settings));
	assert.deepEqual(await readdir(setup.temporaryDir), []);
});

test("--mock works without inherited settings", async (t) => {
	const setup = await prepareLauncher(t);
	await rm(join(setup.agentDir, "settings.json"));
	const result = await runCommand("bash", [SCRIPT, "--mock"], { env: setup.env });
	assert.equal(result.status, 0, result.stderr);
	const record = await readRecord(setup);
	assert.equal(record.settings.theme, undefined);
	assert.deepEqual(await readdir(setup.temporaryDir), []);
});

test("--mock --local discovers global extensions without inherited settings", async (t) => {
	const setup = await prepareLauncher(t);
	await rm(join(setup.agentDir, "settings.json"));
	await writeLocalExtension(join(setup.agentDir, "extensions/auto.ts"), "auto");
	const result = await runCommand("bash", [SCRIPT, "--mock", "--local"], { cwd: setup.directory, env: setup.env });
	assert.equal(result.status, 0, result.stderr);
	const record = await readRecord(setup);
	assert.deepEqual(record.settings.extensions, [join(setup.agentDir, "extensions/auto.ts"),
		"builtin:mcp", "builtin:llama.cpp", "builtin:codemode", "builtin:tool-search"]);
	assert.equal(record.settings.theme, undefined);
	assert.equal(record.args.includes("--no-extensions"), false);
	assert.deepEqual(await readdir(setup.temporaryDir), []);
	await assert.rejects(readFile(join(setup.agentDir, "settings.json")));
});

// One long flag in `=` form and one short alias; the rest share the same set lookup
for (const conflict of ["--model=real/model", "-c"]) {
	test(`--mock rejects ${conflict} rather than overriding isolation`, async (t) => {
		const setup = await prepareLauncher(t);
		const result = await runCommand("bash", [SCRIPT, "--mock", conflict, "unused"], { env: setup.env });
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /--mock cannot be combined/);
		assert.deepEqual(await readdir(setup.temporaryDir), []);
		await assert.rejects(readRecord(setup));
	});
}

test("--mock respects -- before literal prompt text", async (t) => {
	const setup = await prepareLauncher(t);
	const result = await runCommand("bash", [SCRIPT, "--mock", "--", "--model"], { env: setup.env });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual((await readRecord(setup)).args.slice(-2), ["--", "--model"]);
});

test("--mock cleans up when Pi fails and preserves its exit code", async (t) => {
	const setup = await prepareLauncher(t);
	const result = await runCommand("bash", [SCRIPT, "--mock"], { env: { ...setup.env, DEMO_MOCK_EXIT: "42" } });
	assert.equal(result.status, 42, result.stderr);
	await assertCleanedUp(setup, await readRecord(setup));
});

test("--mock cleans up on invalid inherited settings", async (t) => {
	const setup = await prepareLauncher(t);
	await writeFile(join(setup.agentDir, "settings.json"), "invalid JSON");
	const result = await runCommand("bash", [SCRIPT, "--mock"], { env: setup.env });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Cannot read Pi display settings/);
	assert.deepEqual(await readdir(setup.temporaryDir), []);
});

for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
	test(`--mock forwards ${signal} and cleans up the server and config`, { timeout: 30_000 }, async (t) => {
		const setup = await prepareLauncher(t);
		const child = spawn("bash", [SCRIPT, "--mock"], {
			env: { ...setup.env, DEMO_MOCK_WAIT: "1" }, stdio: "ignore",
		});
		t.after(() => { child.kill("SIGTERM"); });
		const closed = once(child, "close");
		const record = await waitForRecord(setup);
		child.kill(signal);
		const [code] = await closed;
		assert.equal(code, exitCode);
		await assertCleanedUp(setup, record);
	});
}

for (const [local, codemode] of [[false, false], [true, true]]) {
	test(`--mock completes a prompt with the pinned Pi CLI, local=${local}, codemode=${codemode}`, async (t) => {
		const setup = await prepareLauncher(t);
		const inherited = await prepareLocalExtensions(setup);
		await rm(join(setup.agentDir, "themes"), { recursive: true });
		await rm(join(setup.agentDir, "keybindings.json"));
		const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
		await writeFile(join(setup.directory, "pi"),
			`#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`);
		const eventsPath = join(setup.directory, "local-events.jsonl");
		const result = await runCommand("bash", [SCRIPT, "--mock", ...(local ? ["--local"] : []),
			"--context", "--system", "--payload", "--message", ...(codemode ? ["--codemode-only"] : []),
			"--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--print", "Review a workflow."], {
			cwd: setup.directory, env: { ...setup.env, DEMO_LOCAL_EVENTS: eventsPath }, timeout: 30_000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), MOCK_REPLY);
		if (local) {
			const events = (await readFile(eventsPath, "utf8")).trim().split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			for (const event of ["session_start", "after_provider_response"]) {
				assert.deepEqual(events.filter((record) => record.event === event).map((record) => record.label).sort(),
					["auto", "configured", "package"]);
			}
			assert.equal(events.length, 6, "each global extension runs once; excluded and project extensions do not run");
			for (const record of events) {
				assert.equal(record.model, "demo-mock/demo");
				assert.equal(record.projectTrusted, false);
				assert.equal(record.sessionFile, undefined);
			}
		} else {
			await assert.rejects(readFile(eventsPath), "--mock alone must not run installed extensions");
		}
		assert.deepEqual(await readdir(setup.temporaryDir), []);
		assert.equal(await readFile(join(setup.agentDir, "settings.json"), "utf8"), JSON.stringify(inherited));
		assert.equal(await readFile(join(setup.agentDir, "auth.json"), "utf8"),
			'{"real-provider":{"type":"api_key","key":"must-not-inherit"}}');
	});
}

test("--mock cleans up when the Pi executable is unavailable", async (t) => {
	const setup = await prepareLauncher(t);
	const runner = fileURLToPath(new URL("../scripts/demo-mock.ts", import.meta.url));
	const result = await runCommand(process.execPath, [runner, "false", "false"], {
		env: { ...setup.env, PATH: setup.temporaryDir },
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /spawn pi ENOENT/);
	assert.deepEqual(await readdir(setup.temporaryDir), []);
});

test("demo endpoint returns only a canned text stream and closes idempotently", async (t) => {
	const provider = await startDemoMockProvider();
	t.after(() => provider.close());
	for (let index = 0; index < 2; index++) {
		const response = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", body: "discard this" });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "text/event-stream");
		const body = await response.text();
		assert.match(body, /"content":"ok"/);
		assert.match(body, /"finish_reason":"stop"/);
		assert.ok(!body.includes("discard this"));
		assert.ok(!body.includes("tool_calls"));
	}
	assert.equal((await fetch(`${provider.baseUrl}/chat/completions`)).status, 404);
	assert.equal((await fetch(`${provider.baseUrl}/responses`, { method: "POST" })).status, 404);
	await provider.close();
	await provider.close();
	await assert.rejects(fetch(`${provider.baseUrl}/chat/completions`, { signal: AbortSignal.timeout(1_000) }));
});

test("mock theme copying keeps only the selected light/dark pair from an installed package", async (t) => {
	const setup = await prepareLauncher(t);
	const destination = join(setup.temporaryDir, "themes-copy");
	await mkdir(destination);
	const packageRoot = join(setup.agentDir, "npm/node_modules/@demo/themes");
	await writeThemePackage(packageRoot);
	await copySelectedThemes({
		sourceDir: setup.agentDir, agentDir: destination,
		settings: { theme: "day / one-dark", packages: ["npm:@demo/themes", "npm:must-not-install"] },
	});
	assert.deepEqual((await readdir(join(destination, "themes"))).sort(), ["day.json", "one-dark.json"]);
	assert.equal(await readFile(join(destination, "themes/day.json"), "utf8"), themeJson("day"));
	assert.equal(await readFile(join(destination, "themes/one-dark.json"), "utf8"), themeJson("one-dark"));
	assert.deepEqual((await readdir(destination)).sort(), ["themes"], "no package code or settings are copied");
});

test("mock theme copying respects package exclusions", async (t) => {
	const setup = await prepareLauncher(t);
	const destination = join(setup.temporaryDir, "themes-copy");
	await mkdir(destination);
	await writeThemePackage(join(setup.agentDir, "npm/node_modules/@demo/themes"));
	await copySelectedThemes({
		sourceDir: setup.agentDir, agentDir: destination,
		settings: { theme: "one-dark", packages: [{ source: "npm:@demo/themes", themes: ["-palettes/dark-palette.json"] }] },
	});
	assert.deepEqual(await readdir(destination), []);
});

test("mock theme copying supports local packages and configured theme paths", async (t) => {
	const setup = await prepareLauncher(t);
	const destination = join(setup.temporaryDir, "themes-copy");
	await mkdir(destination);
	const localPackage = join(setup.agentDir, "local-package");
	await writeThemePackage(localPackage);
	await mkdir(join(setup.agentDir, "extra-themes"));
	await writeFile(join(setup.agentDir, "extra-themes/renamed.json"), themeJson("extra"));
	await copySelectedThemes({
		sourceDir: setup.agentDir, agentDir: destination,
		settings: { theme: "one-dark/extra", packages: ["./local-package"], themes: ["./extra-themes"] },
	});
	assert.deepEqual((await readdir(join(destination, "themes"))).sort(), ["extra.json", "one-dark.json"]);
});

test("mock theme copying finds a selected agent-directory theme by its declared name", async (t) => {
	const setup = await prepareLauncher(t);
	const destination = join(setup.temporaryDir, "themes-copy");
	await mkdir(destination);
	await writeFile(join(setup.agentDir, "themes/custom.json"), themeJson("custom"));
	await writeFile(join(setup.agentDir, "themes/unselected.json"), themeJson("unused"));
	await copySelectedThemes({ sourceDir: setup.agentDir, agentDir: destination, settings: { theme: "custom" } });
	assert.deepEqual(await readdir(join(destination, "themes")), ["custom.json"]);
	assert.equal(await readFile(join(destination, "themes/custom.json"), "utf8"), themeJson("custom"));
});

/** Global discovery includes configured paths, package entries, and auto-discovery; project and excluded code stay out. */
async function prepareLocalExtensions(setup: LauncherSetup): Promise<Record<string, unknown>> {
	const packageRoot = join(setup.agentDir, "npm/node_modules/@demo/extensions");
	await mkdir(packageRoot, { recursive: true });
	await writeFile(join(packageRoot, "package.json"), JSON.stringify({
		name: "@demo/extensions", version: "1.0.0", pi: { extensions: ["global.ts", "skip.ts"], themes: ["palette.json"] },
	}));
	await writeFile(join(packageRoot, "palette.json"), themeJson("one-dark"));
	await writeFile(join(packageRoot, "label.ts"), 'export const label = "package";');
	await writeLocalExtension(join(packageRoot, "global.ts"), "package", true);
	await writeLocalExtension(join(packageRoot, "skip.ts"), "excluded-package");
	await writeLocalExtension(join(setup.agentDir, "extensions/auto.ts"), "auto");
	await writeLocalExtension(join(setup.agentDir, "extensions/skip.ts"), "excluded-auto");
	await writeLocalExtension(join(setup.agentDir, "configured/index.ts"), "configured");
	await writeLocalExtension(join(setup.directory, ".pi/extensions/project.ts"), "project");
	await writeFile(join(setup.directory, ".pi/settings.json"), JSON.stringify({ defaultModel: "project-must-not-use" }));
	const settings = {
		...SETTINGS, theme: "one-dark", extensions: ["./configured", "-extensions/skip.ts", "-builtin:mcp", "!builtin:llama.*"],
		packages: [{ source: "npm:@demo/extensions", extensions: ["-skip.ts"] }, "npm:must-not-install"],
	};
	await writeFile(join(setup.agentDir, "settings.json"), JSON.stringify(settings));
	return settings;
}

/** Synthetic extensions record only coarse lifecycle metadata; package imports must keep their original module root. */
async function writeLocalExtension(path: string, label: string, siblingImport = false): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `
import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
${siblingImport ? 'import { label } from "./label.ts";' : `const label = ${JSON.stringify(label)};`}
/** Register controlled metadata sentinels without reading or recording prompts. */
export default function (pi: ExtensionAPI) {
	/** Record model selection, project trust, and session persistence, never message content. */
	function record(event: string, ctx: ExtensionContext): void {
		appendFileSync(process.env.DEMO_LOCAL_EVENTS, JSON.stringify({
			label, event, model: ctx.model ? ctx.model.provider + "/" + ctx.model.id : undefined,
			projectTrusted: ctx.isProjectTrusted(), sessionFile: ctx.sessionManager.getSessionFile(),
		}) + "\\n");
	}
	pi.on("project_trust", () => ({ trusted: "yes" }));
	pi.on("session_start", (_event, ctx) => record("session_start", ctx));
	pi.on("after_provider_response", (_event, ctx) => record("after_provider_response", ctx));
}
`);
}

/** A valid custom theme derived from Pi's built-in palette, independent of the user's installed themes. */
function themeJson(name: string): string {
	return JSON.stringify({ ...THEME_TEMPLATE, name });
}

/** Installed-package metadata deliberately puts themes outside themes/ and includes code that must never execute. */
async function writeThemePackage(root: string): Promise<void> {
	await mkdir(join(root, "palettes"), { recursive: true });
	await writeFile(join(root, "package.json"), JSON.stringify({
		name: "@demo/themes", version: "1.0.0",
		pi: { themes: ["palettes/*.json"], extensions: ["index.ts"] },
	}));
	await writeFile(join(root, "index.ts"), 'import { writeFileSync } from "node:fs";\n'
		+ `writeFileSync(${JSON.stringify(join(root, "extension-loaded"))}, "loaded");\n`
		+ 'throw new Error("Package extensions must not load in mock mode");');
	await writeFile(join(root, "palettes/dark-palette.json"), themeJson("one-dark"));
	await writeFile(join(root, "palettes/day.json"), themeJson("day"));
	await writeFile(join(root, "palettes/unused.json"), themeJson("unused"));
}

/** Prepare a fake home and Pi executable; none of these tests reads the real agent directory. */
async function prepareLauncher(t: TestContext): Promise<LauncherSetup> {
	const directory = await mkdtemp(join(tmpdir(), "context-demo-mock-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDir = join(directory, "agent");
	const temporaryDir = join(directory, "temporary");
	const recordPath = join(directory, "record.json");
	await mkdir(join(agentDir, "themes"), { recursive: true });
	await mkdir(temporaryDir);
	await writeFile(join(agentDir, "settings.json"), JSON.stringify(SETTINGS));
	await writeFile(join(agentDir, "auth.json"), '{"real-provider":{"type":"api_key","key":"must-not-inherit"}}');
	await writeFile(join(agentDir, "models.json"), '{"providers":{"must-not-inherit":{}}}');
	await writeFile(join(agentDir, "keybindings.json"), KEYBINDINGS);
	await writeFile(join(agentDir, "themes/custom.json"), THEME);
	const recorder = join(directory, "recorder.mjs");
	await writeFile(recorder, RECORDER);
	const pi = join(directory, "pi");
	await writeFile(pi, `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} "$@"\n`);
	await chmod(pi, 0o755);
	const env = {
		...process.env, PATH: `${directory}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agentDir,
		TMPDIR: temporaryDir, DEMO_MOCK_RECORD: recordPath,
		HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1",
	};
	return { directory, agentDir, temporaryDir, recordPath, env };
}

/** Read config metadata recorded while fake Pi was running. */
async function readRecord(setup: LauncherSetup): Promise<MockRunRecord> {
	return JSON.parse(await readFile(setup.recordPath, "utf8")) as MockRunRecord;
}

/** Wait for the recorder to prove Pi has started before signaling the launcher. */
async function waitForRecord(setup: LauncherSetup): Promise<MockRunRecord> {
	// Concurrent tests slow the launcher's start; stay within the 30-second test timeout
	for (let attempt = 0; attempt < 1_000; attempt++) {
		try {
			return await readRecord(setup);
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	throw new Error("Mock Pi did not start");
}

/**
 * Verify the temporary config was removed and all inherited files stayed
 * unchanged. The mock server lives in the exited launcher process, so it is
 * gone too; probing its port could reach another concurrent test's server.
 */
async function assertCleanedUp(
	setup: LauncherSetup, record: MockRunRecord, settings: Record<string, unknown> = SETTINGS,
): Promise<void> {
	assert.notEqual(record.agentDir, setup.agentDir);
	assert.deepEqual(await readdir(setup.temporaryDir), []);
	assert.equal(await readFile(join(setup.agentDir, "settings.json"), "utf8"), JSON.stringify(settings));
	assert.equal(await readFile(join(setup.agentDir, "keybindings.json"), "utf8"), KEYBINDINGS);
	assert.equal(await readFile(join(setup.agentDir, "themes/custom.json"), "utf8"), THEME);
	assert.equal(await readFile(join(setup.agentDir, "auth.json"), "utf8"),
		'{"real-provider":{"type":"api_key","key":"must-not-inherit"}}');
}
