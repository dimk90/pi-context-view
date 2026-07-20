/**
 * pi-context-view — inspect what occupies the model context.
 *
 * Passively captures the first real turn, or runs one on-demand silent probe
 * when a context view is opened before any real turn.
 */
import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	getContextArgumentCompletions,
	parseContextCommand,
	reportCommandMessage,
	resolveInitialCapture,
} from "./command.ts";
import {
	buildNativeSnapshot,
	InitialCaptureState,
	mergeContextOnlyMessages,
	parsePersistedIdentities,
	PROBE_IDENTITIES_CUSTOM_TYPE,
	SilentProbeState,
} from "./capture.ts";
import { showInjectionsView } from "./ui/injections-view.ts";
import { showUsageView } from "./ui/usage-view.ts";
import { computeUsage, toReportedUsage } from "./usage.ts";

export default function (pi: ExtensionAPI) {
	const capture = new InitialCaptureState();
	const probe = new SilentProbeState();
	let persistedIdentityCount = 0;

	/** Persist identities (role and timestamp only, never content) not yet written this runtime. */
	function persistProbeIdentities(): void {
		const identities = probe.syntheticMessages;
		if (identities.length <= persistedIdentityCount) return;
		pi.appendEntry(PROBE_IDENTITIES_CUSTOM_TYPE, { messages: identities });
		persistedIdentityCount = identities.length;
	}

	pi.on("session_start", (_event, ctx) => {
		// Rehydrate probe identities from all prior runtimes so persisted probe
		// messages stay out of later model contexts and Usage after resume,
		// reload, or fork. Restored identities are already persisted.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === PROBE_IDENTITIES_CUSTOM_TYPE) {
				probe.restoreIdentities(parsePersistedIdentities(entry.data));
			}
		}
		persistedIdentityCount = probe.syntheticMessages.length;
	});

	pi.on("input", (event) => {
		probe.observeInput(event.source, event.text);
	});

	pi.on("before_agent_start", (event) => {
		probe.beginRun(event.prompt);
		capture.prepare(event.systemPromptOptions);
	});

	pi.on("turn_start", (_event, ctx) => {
		if (probe.isCurrentRun) ctx.abort();
	});

	pi.on("message_start", (event) => {
		probe.recordMessage(event.message);
	});

	pi.on("message_end", (event) => {
		const message = probe.sanitizeAssistant(event.message);
		return message === undefined ? undefined : { message };
	});

	pi.on("context", (event, ctx) => {
		const messages = probe.filterMessages(event.messages);
		const baselineMessages = probe.filterMessages(
			buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
		);
		capture.finalize({
			systemPrompt: ctx.getSystemPrompt(),
			messages,
			baselineMessages,
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
			origin: probe.isCurrentRun ? "synthetic-probe" : "real-turn",
		});
		return messages === event.messages ? undefined : { messages };
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!probe.isCurrentRun) return;
		if (ctx.mode === "tui") ctx.ui.setWorkingVisible(true);
		probe.settle(capture.snapshot !== undefined);
		persistProbeIdentities();
	});

	pi.on("session_shutdown", () => {
		// A shutdown mid-probe can leave probe messages already persisted in the
		// session; write their identities so the next runtime keeps filtering them.
		persistProbeIdentities();
		probe.fail("Session ended before the silent probe completed.");
	});

	pi.registerCommand("context", {
		// RegisteredCommand has no argumentHint; mimic pi's `<hint> — <description>` style.
		description: "[usage|injections] — Inspect context usage or injections",
		getArgumentCompletions: getContextArgumentCompletions,
		handler: async (args, ctx) => {
			const command = parseContextCommand(args);
			if (command.type === "invalid") {
				reportCommandMessage(ctx, command.message, "error");
				return;
			}
			if (ctx.mode !== "tui") {
				reportCommandMessage(ctx, "/context requires TUI mode.", "warning");
				return;
			}
			const initial = await resolveInitialCapture(pi, capture, probe, ctx);
			if (command.view === "injections") {
				await showInjectionsView(ctx, {
					snapshot: initial.snapshot,
					degradedReason: initial.degradedReason,
				});
				return;
			}
			const current = buildNativeSnapshot({
				systemPrompt: ctx.getSystemPrompt(),
				options: ctx.getSystemPromptOptions(),
				allTools: pi.getAllTools(),
				activeToolNames: pi.getActiveTools(),
			});
			await showUsageView(ctx, {
				usage: computeUsage({
					snapshot: mergeContextOnlyMessages(current, initial.snapshot),
					// ReadonlySessionManager lacks buildSessionContext(); use pi's exported builder.
					messages: probe.filterMessages(
						buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
					),
					reported: toReportedUsage(ctx.getContextUsage()),
					modelLabel: ctx.model?.id,
				}),
				degradedReason: initial.degradedReason,
			});
		},
	});
}
