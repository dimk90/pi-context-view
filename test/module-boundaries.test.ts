/**
 * Consumers read the store, never capture or probe internals ("Layers" in
 * doc/ARCHITECTURE.md). Demo fixtures stay independent from regular tests.
 * The check follows repository imports transitively, so an indirect dependency
 * fails too; installed packages are outside these boundaries.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_DIRECTORIES = ["src/capture/", "src/probe/"];
const DEMO_FIXTURES = "scripts/fixtures/";

/** Relative repository imports of one module, type-only imports included. */
function relativeImports(file: string): string[] {
	const source = readFileSync(file, "utf8");
	const specifiers = [...source.matchAll(/^(?:import|export)\b[^;]*?["'](\.{1,2}\/[^"']+)["']/gms)];
	return specifiers.map((match) => resolve(dirname(file), match[1]))
		.filter((path) => !relative(ROOT, path).startsWith("node_modules/"));
}

/** Every module reachable from `entry` through relative imports, as repository paths. */
function reachableModules(entry: string): Set<string> {
	const seen = new Set<string>();
	const pending = [resolve(ROOT, entry)];
	while (pending.length > 0) {
		const file = pending.pop();
		if (file === undefined || seen.has(file)) continue;
		seen.add(file);
		pending.push(...relativeImports(file));
	}
	return new Set([...seen].map((file) => relative(ROOT, file)));
}

const CONSUMERS = [
	"src/usage.ts",
	...readdirSync(join(ROOT, "src/ui")).filter((name) => name.endsWith(".ts")).map((name) => `src/ui/${name}`),
];

test("demo fixtures import no regular test or harness module", () => {
	for (const name of readdirSync(join(ROOT, DEMO_FIXTURES)).filter((name) => name.endsWith(".ts"))) {
		const fixture = `${DEMO_FIXTURES}${name}`;
		assert.deepEqual([...reachableModules(fixture)].filter((path) => path.startsWith("test/")), [], fixture);
	}
});

test("regular tests, fixtures, and harness import no demo fixture", () => {
	const modules = readdirSync(join(ROOT, "test"), { recursive: true })
		.filter((name): name is string => typeof name === "string" && name.endsWith(".ts"));
	for (const name of modules) {
		const entry = `test/${name}`;
		assert.deepEqual([...reachableModules(entry)].filter((path) => path.startsWith(DEMO_FIXTURES)), [], entry);
	}
});

for (const consumer of CONSUMERS) {
	test(`${consumer} imports no capture or probe module`, () => {
		const reached = [...reachableModules(consumer)];
		assert.ok(reached.length > 0);
		assert.deepEqual(reached.filter((path) =>
			FORBIDDEN_DIRECTORIES.some((directory) => path.startsWith(directory))), []);
	});
}
