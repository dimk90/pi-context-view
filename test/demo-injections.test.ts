/** Demo launcher argument and load-order checks, without starting a provider. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/demo-injections.sh", import.meta.url));
const MONITOR = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const CODEMODE = "builtin:codemode";
const SELECTIONS = [
	{ flag: "--context", fixtures: [
		"context-modify", "context-in-place", "context-delete", "context-reorder", "context-add", "context-add-user",
	] },
	{ flag: "--system", fixtures: [
		"system-append", "section-patch", "section-modify", "section-delete", "in-place-mutation",
	] },
	{ flag: "--payload", fixtures: ["payload-late-edits", "payload-delete", "payload-remove-tool"] },
	{ flag: "--message", fixtures: ["agent-start-message", "system-add-message"] },
	{ flag: "--codemode-only", fixtures: [] },
	{ flag: "--forced", fixtures: ["forced-prompt"] },
];

for (const after of [false, true]) {
	for (let mask = 0; mask < 2 ** SELECTIONS.length; mask++) {
		const selected = SELECTIONS.filter((_, index) => (mask & (1 << index)) !== 0);
		const flags = selected.map(({ flag }) => flag);
		test(`demo launcher: groups=${flags.join(" ") || "none"}, after=${after}`, async (t) => {
			const forwarded = ["--model", "provider/model", "--no-session", "a prompt with spaces"];
			const args = await launcherArgs(t, [...flags, ...(after ? ["--after"] : []), ...forwarded]);
			const fixtures = selected.flatMap((selection) => selection.fixtures);
			const paths = fixtures.map((fixture) => fileURLToPath(new URL(`./fixtures/${fixture}.ts`, import.meta.url)));
			const extensions = [...(after ? [MONITOR, ...paths] : [...paths, MONITOR]),
				...(flags.includes("--codemode-only") ? [CODEMODE] : [])];
			assert.deepEqual(args, ["--no-extensions", ...extensions.flatMap((path) => ["-e", path]), ...forwarded]);
		});
	}

	test(`demo launcher loads groups in flag order, after=${after}`, async (t) => {
		const selected = [...SELECTIONS].reverse();
		const args = await launcherArgs(t, [...(after ? ["--after"] : []), ...selected.map(({ flag }) => flag)]);
		const extensions = args.slice(1).filter((arg) => arg !== "-e");
		const fixtures = selected.flatMap((selection) => selection.fixtures);
		assert.deepEqual(extensions.map((path) => basename(path, ".ts")),
			[...(after ? ["index", ...fixtures] : [...fixtures, "index"]), CODEMODE]);
	});
}

test("demo launcher --codemode-only adds codemode settings in a temporary agent directory", async (t) => {
	const settings = JSON.stringify({ theme: "dark", codemode: { inlineBudget: 5 }, defaultTools: ["read"] });
	const run = await runLauncher(t, ["--codemode-only"], settings);
	assert.notEqual(run.agentDir, run.realAgentDir);
	assert.deepEqual(JSON.parse(run.settings), {
		theme: "dark", codemode: { inlineBudget: 5, mode: "only" }, defaultTools: ["read", "+codemode"],
	});
	assert.equal(run.authLink, join(run.realAgentDir, "auth.json"));
	assert.equal(await readFile(join(run.realAgentDir, "settings.json"), "utf8"), settings);
	await assert.rejects(access(run.agentDir), "the temporary agent directory is removed on exit");
});

test("demo launcher --codemode-only works without a settings file", async (t) => {
	const run = await runLauncher(t, ["--codemode-only"]);
	assert.deepEqual(JSON.parse(run.settings), { codemode: { mode: "only" }, defaultTools: ["+codemode"] });
});

test("demo launcher keeps the real agent directory without --codemode-only", async (t) => {
	const run = await runLauncher(t, ["--forced"]);
	assert.equal(run.agentDir, run.realAgentDir);
});

for (const forwarded of [
	["--", "--context", "--system", "--payload", "--message", "--codemode-only", "--after", "--forced"],
	["--model", "provider/model", "--context", "--system", "--payload", "--message", "--codemode-only", "--forced"],
	["--force"],
	["--context-modify"],
	["--section-patch"],
	["--payload-late-edits"],
]) {
	test(`demo launcher leaves Pi arguments untouched: ${forwarded.join(" ")}`, async (t) => {
		const args = await launcherArgs(t, forwarded);
		assert.deepEqual(args, ["--no-extensions", "-e", MONITOR, ...forwarded]);
	});
}

/** Arguments the launcher passed to pi. */
async function launcherArgs(t: TestContext, args: string[]): Promise<string[]> {
	return (await runLauncher(t, args)).args;
}

/** What a launcher run showed pi, recorded by a fake `pi` while it ran. */
interface LauncherRun {
	/** Arguments passed to pi. */
	readonly args: string[];
	/** The fake real agent directory the launcher started with. */
	readonly realAgentDir: string;
	/** `PI_CODING_AGENT_DIR` as pi saw it. */
	readonly agentDir: string;
	/** `settings.json` in that directory, or empty when missing. */
	readonly settings: string;
	/** Target of the `auth.json` link in that directory, or empty when it is no link. */
	readonly authLink: string;
}

/**
 * Run the launcher with `pi` on PATH replaced by a recorder and a fake real
 * agent directory, so no test reads the user's own one. NUL separation
 * preserves spaces and empty arguments.
 */
async function runLauncher(t: TestContext, args: string[], settings?: string): Promise<LauncherRun> {
	const directory = await mkdtemp(join(tmpdir(), "context-demo-args-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const realAgentDir = join(directory, "agent");
	await mkdir(realAgentDir);
	await writeFile(join(realAgentDir, "auth.json"), "{}");
	if (settings !== undefined) await writeFile(join(realAgentDir, "settings.json"), settings);
	const pi = join(directory, "pi");
	await writeFile(pi, [
		"#!/bin/bash",
		'printf "%s\\0" "$@"',
		'printf "%s" "$PI_CODING_AGENT_DIR" >"$DEMO_TEST_DIR/agent-dir"',
		'cat "$PI_CODING_AGENT_DIR/settings.json" >"$DEMO_TEST_DIR/settings" 2>/dev/null || true',
		'readlink "$PI_CODING_AGENT_DIR/auth.json" >"$DEMO_TEST_DIR/auth-link" || true',
		"",
	].join("\n"));
	await chmod(pi, 0o755);
	const env = {
		...process.env,
		PATH: `${directory}:${process.env.PATH}`,
		PI_CODING_AGENT_DIR: realAgentDir,
		DEMO_TEST_DIR: directory,
	};
	const result = spawnSync("bash", [SCRIPT, ...args], { cwd: directory, env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.error, undefined);
	const recorded = (name: string) => readFile(join(directory, name), "utf8");
	return {
		args: result.stdout.split("\0").slice(0, -1),
		realAgentDir,
		agentDir: await recorded("agent-dir"),
		settings: await recorded("settings"),
		authLink: (await recorded("auth-link")).trim(),
	};
}
