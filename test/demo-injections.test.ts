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

for (const after of [false, true]) {
	for (const force of [false, true]) {
		for (const hidden of [false, true]) {
			test(`demo launcher: after=${after}, force=${force}, codemode-only=${hidden}`, async (t) => {
				const flags = [
					...(hidden ? ["--codemode-only"] : []),
					...(force ? ["--force"] : []),
					...(after ? ["--after"] : []),
				];
				const forwarded = ["--model", "provider/model", "--no-session", "a prompt with spaces"];
				const args = await launcherArgs(t, [...flags, ...forwarded]);
				assert.equal(args[0], "--no-extensions");
				assert.deepEqual(args.slice(-forwarded.length), forwarded);
				const extensions = args.slice(1, -forwarded.length).filter((arg) => arg !== "-e");
				assert.equal(extensions.filter((path) => path === MONITOR).length, 1);
				assert.equal(after ? extensions[0] : extensions.at(-1), MONITOR);
				const fixtures = extensions.map((path) => basename(path, ".ts"));
				assert.ok(fixtures.includes("payload-late-edits"));
				assert.ok(fixtures.includes("payload-delete"), "keep the optional marker demo");
				assert.ok(!fixtures.includes("payload-modify") && !fixtures.includes("payload-rewrite"),
					"the automatic fixture replaces these editors rather than duplicating their findings");
				assert.equal(fixtures.includes("hidden-tools"), hidden);
				assert.equal(fixtures.includes("payload-remove-tool"), !hidden);
				assert.equal(fixtures.includes("forced-prompt"), force);
			});
		}
	}
}

test("demo launcher leaves arguments after -- untouched", async (t) => {
	const args = await launcherArgs(t, ["--", "--codemode-only", "--after", "--force"]);
	assert.deepEqual(args.slice(-4), ["--", "--codemode-only", "--after", "--force"]);
	assert.ok(args.includes(MONITOR));
	assert.ok(!args.some((arg) => arg.endsWith("/hidden-tools.ts")));
});

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
