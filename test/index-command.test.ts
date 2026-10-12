import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

import type { ContextView } from "../src/command.ts";
import registerExtension from "../src/index.ts";

type CommandHandler = RegisteredCommand["handler"];

/** Extension wired to a fake Pi: the `/context` handler and a way to emit lifecycle events. */
interface RegisteredExtension {
	readonly runCommand: CommandHandler;
	readonly emit: (event: { type: string } & Record<string, unknown>) => void;
	readonly sentUserMessages: () => number;
}

/** Register the extension against a minimal Pi stub that records its handlers. */
function registerWithFakePi(): RegisteredExtension {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	let commandHandler: CommandHandler | undefined;
	let sent = 0;
	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, [...handlers.get(event) ?? [], handler]);
		},
		registerCommand: (_name: string, options: { handler: CommandHandler }) => {
			commandHandler = options.handler;
		},
		sendUserMessage: () => {
			sent++;
		},
		getAllTools: () => [],
		getActiveTools: () => [],
		getCommands: () => [],
	} as unknown as ExtensionAPI;

	registerExtension(pi);
	assert.ok(commandHandler, "the extension registers /context");
	return {
		runCommand: commandHandler,
		emit: (event) => {
			for (const handler of handlers.get(event.type) ?? []) handler(event, {});
		},
		sentUserMessages: () => sent,
	};
}

/** TUI command context that records notifications and whether a view or idle wait was requested. */
function createTuiContext(onWaitForIdle: () => void = () => undefined): {
	context: ExtensionCommandContext;
	notified: Array<{ message: string; type: string }>;
	opened: () => boolean;
} {
	const notified: Array<{ message: string; type: string }> = [];
	let viewOpened = false;
	const context = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (message: string, type: string) => notified.push({ message, type }),
			custom: async () => {
				viewOpened = true;
			},
		},
		waitForIdle: async () => onWaitForIdle(),
		// Read by the probe fallback that the refusal then discards
		getSystemPrompt: () => "base prompt",
		getSystemPromptOptions: () => ({ cwd: "/tmp" }),
	} as unknown as ExtensionCommandContext;
	return { context, notified, opened: () => viewOpened };
}

for (const view of ["usage", "injections"] satisfies ContextView[]) {
	const refusal = { message: `/context ${view} is unavailable while compaction is in progress.`, type: "warning" };

	test(`/context ${view} refuses at once while compaction is active`, async () => {
		const extension = registerWithFakePi();
		extension.emit({ type: "session_before_compact", signal: new AbortController().signal });
		let waitedForIdle = false;
		const { context, notified, opened } = createTuiContext(() => {
			waitedForIdle = true;
		});

		await extension.runCommand(view, context);

		assert.deepEqual(notified, [refusal]);
		assert.equal(opened(), false, "no view opens on a projection about to be replaced");
		assert.equal(waitedForIdle, false, "the refusal must not wait for compaction to finish");
	});

	test(`/context ${view} refuses when compaction starts while waiting for idle`, async () => {
		const extension = registerWithFakePi();
		const { context, notified, opened } = createTuiContext(() => {
			extension.emit({ type: "session_before_compact", signal: new AbortController().signal });
		});

		await extension.runCommand(view, context);

		assert.deepEqual(notified, [refusal], "the refusal replaces the degraded fallback");
		assert.equal(opened(), false);
		assert.equal(extension.sentUserMessages(), 0, "no probe starts during compaction");
	});
}
