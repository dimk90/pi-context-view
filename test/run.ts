/**
 * Test entry point for `pnpm test`: `node test/run.ts [file...]`, all
 * `test/*.test.ts` files by default.
 *
 * Every file runs in this one process, so Pi is imported once rather than per
 * file, and the top-level tests of all files run concurrently, so tests that
 * wait on timers or child processes overlap. In exchange, a test must not
 * change process-wide state in a way other tests can observe, and a file must
 * not register top-level hooks, which would apply to every file. See "Harness"
 * in doc/architecture/validation.md.
 */
import { globSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";

const ROOT = resolve(import.meta.dirname, "..");

const selected = process.argv.slice(2);
const files = (selected.length > 0 ? selected : globSync("test/*.test.ts", { cwd: ROOT }))
	.map((file) => resolve(ROOT, file));

const stream = run({ files, isolation: "none", concurrency: true });
stream.on("test:fail", () => { process.exitCode = 1; });
stream.compose(spec).pipe(process.stdout);
