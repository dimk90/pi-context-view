import assert from "node:assert/strict";
import { test } from "node:test";

import { VERSION } from "@earendil-works/pi-coding-agent";

import { isSupportedPiVersion, MIN_PI_VERSION } from "../src/pi-version.ts";

test("isSupportedPiVersion accepts the minimum and newer releases", () => {
	for (const version of [MIN_PI_VERSION, "1.0.1", "1.2.0", "2.0.0", "10.0.0", "v1.0.0", "1.0.0-beta.1"]) {
		assert.equal(isSupportedPiVersion(version), true, version);
	}
	// The pinned development dependency must pass its own check.
	assert.equal(isSupportedPiVersion(VERSION), true);
});

test("isSupportedPiVersion refuses releases before the minimum", () => {
	for (const version of ["0.99.2", "0.87.0", "0.86.1", "0.9.10"]) {
		assert.equal(isSupportedPiVersion(version), false, version);
	}
});

test("isSupportedPiVersion does not refuse a version it cannot parse", () => {
	for (const version of ["", "dev", "1.0"]) assert.equal(isSupportedPiVersion(version), true, version);
});
