/**
 * Test-wide stand-in for Pi's `SettingsManager.create()`, which reads the
 * developer's settings files. All test files run concurrently in one process,
 * where a per-test mock of this static method would leak into other tests.
 * Importing this module replaces it once instead: a test registers settings
 * for its own working directory, and any other directory gets empty in-memory
 * settings.
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { ConfigStore } from "../../src/config.ts";

/** The replaced method's signature, for registered answers. */
export type CreateSettings = typeof SettingsManager.create;

const registered = new Map<string, CreateSettings>();

SettingsManager.create = (cwd, agentDir, options) =>
	registered.get(cwd)?.(cwd, agentDir, options) ?? SettingsManager.inMemory();

/**
 * Answer `SettingsManager.create()` for `cwd` with `create` until the test
 * ends. The directory must be unique to the test, such as a temporary one.
 */
export function useSettings(t: TestContext, cwd: string, create: CreateSettings): void {
	assert.ok(!registered.has(cwd), `Settings for ${cwd} are already registered by another test`);
	registered.set(cwd, create);
	t.after(() => { registered.delete(cwd); });
}

/**
 * Config store over a path that never exists, so a test sees built-in
 * defaults instead of the developer's own `pi-context-view.json`.
 */
export function createIsolatedConfigStore(): ConfigStore {
	return new ConfigStore(join(tmpdir(), `pi-context-view-absent-${process.pid}`, "pi-context-view.json"));
}
