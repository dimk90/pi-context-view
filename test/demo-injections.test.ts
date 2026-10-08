/** Demo launcher argument and load-order checks, without starting a provider. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/demo-injections.sh", import.meta.url));
const MONITOR = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const SELECTIONS = [
	{ flag: "--context", fixtures: [
		"context-modify", "context-in-place", "context-delete", "context-reorder", "context-add", "context-add-user",
	] },
	{ flag: "--system", fixtures: [
		"system-append", "section-patch", "section-modify", "section-delete", "in-place-mutation",
	] },
	{ flag: "--payload", fixtures: ["payload-late-edits", "payload-delete", "payload-remove-tool"] },
	{ flag: "--codemode-only", fixtures: ["hidden-tools"] },
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
			const extensions = after ? [MONITOR, ...paths] : [...paths, MONITOR];
			assert.deepEqual(args, ["--no-extensions", ...extensions.flatMap((path) => ["-e", path]), ...forwarded]);
		});
	}

	test(`demo launcher loads groups in flag order, after=${after}`, async (t) => {
		const selected = [...SELECTIONS].reverse();
		const args = await launcherArgs(t, [...(after ? ["--after"] : []), ...selected.map(({ flag }) => flag)]);
		const extensions = args.slice(1).filter((arg) => arg !== "-e");
		const fixtures = selected.flatMap((selection) => selection.fixtures);
		assert.deepEqual(extensions.map((path) => basename(path, ".ts")),
			after ? ["index", ...fixtures] : [...fixtures, "index"]);
	});
}

for (const forwarded of [
	["--", "--context", "--system", "--payload", "--codemode-only", "--after", "--forced"],
	["--model", "provider/model", "--context", "--system", "--payload", "--codemode-only", "--forced"],
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

/** Replace `pi` on PATH with an argv printer; NUL separation preserves spaces and empty arguments. */
async function launcherArgs(t: TestContext, args: string[]): Promise<string[]> {
	const directory = await mkdtemp(join(tmpdir(), "context-demo-args-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const pi = join(directory, "pi");
	await writeFile(pi, '#!/bin/bash\nprintf "%s\\0" "$@"\n');
	await chmod(pi, 0o755);
	const result = spawnSync("bash", [SCRIPT, ...args], {
		cwd: directory, env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.error, undefined);
	return result.stdout.split("\0").slice(0, -1);
}
