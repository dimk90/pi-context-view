import assert from "node:assert/strict";
import { test } from "node:test";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { type CompactionModel, resolveAutoCompactReserveTokens } from "../src/settings.ts";

/** Pi's built-in reserve, used when neither an override nor an ordinary setting applies. */
const PI_DEFAULT_RESERVE_TOKENS = 16_384;

const SONNET: CompactionModel = { provider: "anthropic", id: "claude-sonnet-4-5" };
const GEMINI: CompactionModel = { provider: "google", id: "gemini-3-pro" };

/** Settings shape accepted by the in-memory manager; the barrel exports no `Settings` type. */
type SettingsOverrides = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

function settingsWith(settings: SettingsOverrides): SettingsManager {
	return SettingsManager.inMemory(settings);
}

test("resolveAutoCompactReserveTokens prefers the model override over the ordinary setting", () => {
	const settings = settingsWith({
		compaction: {
			reserveTokens: 20_000,
			modelOverrides: { "anthropic/claude-sonnet-4-5": { reserveTokens: 50_000 } },
		},
	});
	assert.equal(resolveAutoCompactReserveTokens(settings, SONNET), 50_000);
});

test("resolveAutoCompactReserveTokens falls back through the ordinary setting to pi's default", () => {
	const configured = settingsWith({
		compaction: {
			reserveTokens: 20_000,
			modelOverrides: { "anthropic/claude-sonnet-4-5": { reserveTokens: 50_000 } },
		},
	});
	// A model without its own override, and a session with no model selected yet.
	assert.equal(resolveAutoCompactReserveTokens(configured, GEMINI), 20_000);
	assert.equal(resolveAutoCompactReserveTokens(configured, undefined), 20_000);

	const empty = settingsWith({});
	assert.equal(resolveAutoCompactReserveTokens(empty, GEMINI), PI_DEFAULT_RESERVE_TOKENS);
	assert.equal(resolveAutoCompactReserveTokens(empty, undefined), PI_DEFAULT_RESERVE_TOKENS);
});

test("resolveAutoCompactReserveTokens follows a model switch within one session", () => {
	const settings = settingsWith({
		compaction: {
			modelOverrides: {
				"anthropic/claude-sonnet-4-5": { reserveTokens: 50_000 },
				"google/gemini-3-pro": { reserveTokens: 120_000 },
			},
		},
	});
	// The view re-reads per open, so switching models changes the reserve.
	assert.equal(resolveAutoCompactReserveTokens(settings, SONNET), 50_000);
	assert.equal(resolveAutoCompactReserveTokens(settings, GEMINI), 120_000);
});

test("resolveAutoCompactReserveTokens ignores overrides for a different setting", () => {
	const settings = settingsWith({
		compaction: {
			reserveTokens: 20_000,
			modelOverrides: { "anthropic/claude-sonnet-4-5": { keepRecentTokens: 90_000 } },
		},
	});
	assert.equal(resolveAutoCompactReserveTokens(settings, SONNET), 20_000);
});

test("resolveAutoCompactReserveTokens reports no reserve when auto-compaction is disabled", () => {
	const settings = settingsWith({
		compaction: {
			enabled: false,
			reserveTokens: 20_000,
			modelOverrides: { "anthropic/claude-sonnet-4-5": { reserveTokens: 50_000 } },
		},
	});
	assert.equal(resolveAutoCompactReserveTokens(settings, SONNET), undefined);
	assert.equal(resolveAutoCompactReserveTokens(settings, undefined), undefined);
});

test("resolveAutoCompactReserveTokens reports no reserve for invalid settings", () => {
	const invalidOverride = settingsWith({
		compaction: {
			reserveTokens: 20_000,
			modelOverrides: { "anthropic/claude-sonnet-4-5": { reserveTokens: -1 } },
		},
	});
	assert.equal(resolveAutoCompactReserveTokens(invalidOverride, SONNET), undefined);
	// Only the override is invalid: other models keep the ordinary setting.
	assert.equal(resolveAutoCompactReserveTokens(invalidOverride, GEMINI), 20_000);

	const invalidOrdinary = settingsWith({
		compaction: { reserveTokens: "large" as unknown as number },
	});
	assert.equal(resolveAutoCompactReserveTokens(invalidOrdinary, SONNET), undefined);
});
