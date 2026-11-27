import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	parsePersistedIdentities,
	PROBE_IDENTITIES_CUSTOM_TYPE,
	ProbeFilter,
	registerProbeFilter,
} from "../src/probe/filter.ts";

test("ProbeFilter leaves unmatched message arrays unchanged", () => {
	const filter = new ProbeFilter();
	const messages = [{ role: "user", content: [], timestamp: 11 }] satisfies ContextEvent["messages"];
	assert.strictEqual(filter.filterMessages(messages), messages);
	filter.restoreIdentities([{ role: "user", timestamp: 10 }]);
	assert.strictEqual(filter.filterMessages(messages), messages);
});

test("ProbeFilter removes only exact role and timestamp matches", () => {
	const filter = new ProbeFilter();
	filter.restoreIdentities([{ role: "user", timestamp: 10 }]);

	const probeUser = { role: "user", content: [], timestamp: 10 } satisfies ContextEvent["messages"][number];
	const sameTimeCustom = {
		role: "custom", customType: "other", content: "keep", display: false, timestamp: 10,
	} satisfies ContextEvent["messages"][number];
	const realUser = { role: "user", content: [], timestamp: 11 } satisfies ContextEvent["messages"][number];
	assert.deepEqual(filter.filterMessages([probeUser, sameTimeCustom, realUser]), [sameTimeCustom, realUser]);
});

test("ProbeFilter matches a recorded user identity only for a blank message", () => {
	const filter = new ProbeFilter();
	filter.restoreIdentities([{ role: "user", timestamp: 10 }]);

	// SilentProbe stores its prompt without parts; older versions kept Pi's one empty text part
	const blankPrompts = [
		{ role: "user", content: [], timestamp: 10 },
		{ role: "user", content: [{ type: "text", text: "" }], timestamp: 10 },
		{ role: "user", content: "", timestamp: 10 },
	] satisfies ContextEvent["messages"];
	// A message sent while the probe run started can share the prompt's millisecond
	const sameTimeGenuine = [
		{ role: "user", content: "queued", timestamp: 10 },
		{ role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }], timestamp: 10 },
	] satisfies ContextEvent["messages"];
	assert.deepEqual(filter.filterMessages([...blankPrompts, ...sameTimeGenuine]), sameTimeGenuine);
});

test("registerProbeFilter merges the identities of every persisted entry on session_start", () => {
	// An older cumulative entry, then incremental ones that repeat nothing
	const persisted = [
		{ messages: [{ role: "user", timestamp: 10 }, { role: "assistant", timestamp: 11 }] },
		{ messages: [{ role: "user", timestamp: 20 }] },
		{ messages: [{ role: "assistant", timestamp: 21 }] },
	];
	const entries = persisted.map((data) => ({ type: "custom", customType: PROBE_IDENTITIES_CUSTOM_TYPE, data }));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = { on: (name: string, handler: never) => handlers.set(name, handler) } as unknown as ExtensionAPI;
	const ctx = { sessionManager: { getEntries: () => entries } } as unknown as ExtensionContext;

	const filter = new ProbeFilter();
	registerProbeFilter(pi, filter);
	handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx);
	assert.deepEqual(filter.syntheticMessages, persisted.flatMap((data) => data.messages));
});

test("parsePersistedIdentities accepts only exact role/timestamp records", () => {
	assert.deepEqual(
		parsePersistedIdentities({
			messages: [
				{ role: "user", timestamp: 10 },
				{ role: "assistant", timestamp: 12 },
				{ role: "custom", timestamp: 13 },
				{ role: "user", timestamp: "10" },
				{ role: "user" },
				"garbage",
				null,
			],
		}),
		[
			{ role: "user", timestamp: 10 },
			{ role: "assistant", timestamp: 12 },
		],
	);
	assert.deepEqual(parsePersistedIdentities(undefined), []);
	assert.deepEqual(parsePersistedIdentities(null), []);
	assert.deepEqual(parsePersistedIdentities({ messages: "not-an-array" }), []);
	assert.deepEqual(parsePersistedIdentities([]), []);
});
