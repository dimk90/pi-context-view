/**
 * pi-context-view - inspect what occupies the model context.
 *
 * Passively captures the first real turn, or runs one on-demand silent probe
 * when a context view is opened before any real turn.
 */
import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ConfigStore, createDefaultConfigFile } from "./config.ts";
import {
	CONTEXT_COMMAND_DESCRIPTION,
	getContextArgumentCompletions,
	parseContextCommand,
	reportCommandMessage,
	reportConfigCreation,
	reportTuiOnly,
	resolveInitialCapture,
} from "./command.ts";
import {
	buildUsageSnapshot,
	collectPromptSources,
	CompactionState,
	InitialCaptureState,
	parsePersistedIdentities,
	PROBE_IDENTITIES_CUSTOM_TYPE,
	SilentProbeState,
} from "./capture.ts";
import { readProbeToken } from "./probe-token.ts";
import { readAutoCompactReserveTokens } from "./settings.ts";
import { showInjectionsView } from "./ui/injections-view.ts";
import { showUsageView } from "./ui/usage-view.ts";
import { computeUsage, toReportedUsage } from "./usage.ts";
import { providerMessagesToAgentMessages } from "./provider-payload.ts";
import fs from "node:fs";

export default function (pi: ExtensionAPI) {
	const capture = new InitialCaptureState();
	const probe = new SilentProbeState();
	const compaction = new CompactionState();
	const configStore = new ConfigStore();
	let persistedIdentityCount = 0;

	/** Persist identities (role and timestamp only, never content) not yet written this runtime. */
	function persistProbeIdentities(): void {
		const identities = probe.syntheticMessages;
		if (identities.length <= persistedIdentityCount) return;
		pi.appendEntry(PROBE_IDENTITIES_CUSTOM_TYPE, { messages: identities });
		persistedIdentityCount = identities.length;
	}

	pi.on("session_start", (_event, ctx) => {
		compaction.finish();
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

	pi.on("session_before_compact", (event) => {
		compaction.begin(event.signal);
	});

	// Pi ends every observed compaction with exactly one of these two events.
	pi.on("session_compact", () => {
		compaction.finish();
	});

	pi.on("session_compact_failed", () => {
		compaction.finish();
	});

	pi.on("input", (event) => {
		// Reset text earlier input transforms added to our own synthetic prompt:
		// the probe carries no instructions, and its run is identified by token.
		if (event.text === "" || !probe.isProbeInput(event.source, readProbeToken())) return undefined;
		return { action: "transform", text: "" } as const;
	});

	pi.on("before_agent_start", (event) => {
		probe.beginRun(readProbeToken());
		// The chained prompt here already carries additions from extensions loaded
		// earlier; anything the context event adds came from extensions after us.
		capture.prepare(event.systemPromptOptions, event.systemPrompt);
	});

	pi.on("turn_start", (_event, ctx) => {
		if (probe.isCurrentRun) ctx.abort();
	});

	pi.on("message_start", (event) => {
		probe.recordMessage(event.message);
	});

	pi.on("message_end", (event) => {
		const message = probe.sanitizeMessage(event.message);
		return message === undefined ? undefined : { message };
	});

	// Phase 1 (`context`): filter probe identities for downstream Phase 1 handlers
	// AND freeze the snapshot here so silent-probe turns (which are aborted in
	// `turn_start` and therefore never reach `before_provider_request`) still
	// produce a usable snapshot. For real turns, the `before_provider_request`
	// handler below overwrites this snapshot with full Phase-1+2+3 data.
	pi.on("context", (event, ctx) => {
		const messages = probe.filterMessages(event.messages);
		capture.finalize(() => ({
			systemPrompt: ctx.getSystemPrompt(),
			messages,
			baselineMessages: probe.filterMessages(
				buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
			),
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
			promptSources: collectPromptSources(pi.getAllTools(), pi.getCommands()),
			origin: probe.isCurrentRun ? "synthetic-probe" : "real-turn",
		}));
		return messages === event.messages ? undefined : { messages };
	});

	// Phase 3 (`before_provider_request`): the FINAL hook before the LLM call.
	// It runs after every `context` and `context_with_system` handler, so the
	// payload's `messages` carries every injection this turn produced. The trade-
	// off vs Phase-2 freezing: provider-format conversion is lossy (customType is
	// lost, custom becomes anonymous user-message), but pcv no longer needs to be
	// registered last in any chain. See `provider-payload.ts` for the converter.
	pi.on("before_provider_request", (event, ctx) => {
		// before_provider_request is the LAST event pi fires before sending to
		// the LLM. Its payload IS the provider-format request body — every
		// provider (anthropic/openai/mistral/google/bedrock/pi-messages) calls
		// `options?.onPayload?.(params, model)` where `params` is the built
		// request, so `event.payload` is `{ model, messages, system, tools, ... }`
		// directly — there is no extra `.payload` layer.
		const payload = event.payload as { messages?: unknown; system?: unknown } | undefined;
		const providerMessages = Array.isArray(payload?.messages)
			? (payload.messages as Parameters<typeof providerMessagesToAgentMessages>[0])
			: [];
		const agentMessages = providerMessagesToAgentMessages(providerMessages);
		const chainMessages = probe.filterMessages(agentMessages);
		capture.finalize(() => ({
			systemPrompt: typeof payload?.system === "string"
				? payload.system
				: ctx.getSystemPrompt(),
			messages: chainMessages,
			baselineMessages: probe.filterMessages(
				buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
			),
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
			promptSources: collectPromptSources(pi.getAllTools(), pi.getCommands()),
			origin: probe.isCurrentRun ? "synthetic-probe" : "real-turn",
		}));
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!probe.isCurrentRun) return;
		if (ctx.mode === "tui") ctx.ui.setWorkingVisible(true);
		probe.settle(capture.snapshot !== undefined);
		persistProbeIdentities();
	});

	pi.on("session_shutdown", () => {
		compaction.finish();
		// A shutdown mid-probe can leave probe messages already persisted in the
		// session; write their identities so the next runtime keeps filtering them.
		persistProbeIdentities();
		probe.fail("Session ended before the silent probe completed.");
	});

	pi.registerCommand("context", {
		description: CONTEXT_COMMAND_DESCRIPTION,
		getArgumentCompletions: getContextArgumentCompletions,
		handler: async (args, ctx) => {
			const command = parseContextCommand(args);
			if (command.type === "invalid") {
				reportCommandMessage(ctx, command.message, "error");
				return;
			}
			// Creating the file needs no UI, so it stays available in every run mode.
			if (command.type === "config") {
				reportConfigCreation(ctx, createDefaultConfigFile());
				return;
			}
			if (ctx.mode !== "tui") {
				reportTuiOnly(ctx, command.view);
				return;
			}
			const initial = await resolveInitialCapture(pi, capture, probe, compaction, ctx);
			if (command.view === "injections") {
				await showInjectionsView(ctx, {
					snapshot: initial.snapshot,
					degradedReason: initial.degradedReason,
				});
				return;
			}
			// Loaded only for the Usage view, the sole consumer of configured colors.
			const loadedConfig = configStore.load();
			// ReadonlySessionManager lacks buildSessionContext(); use pi's exported builder.
			const messages = probe.filterMessages(
				buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
			);
			const current = buildUsageSnapshot({
				messages,
				initial: initial.snapshot,
				systemPrompt: ctx.getSystemPrompt(),
				options: ctx.getSystemPromptOptions(),
				allTools: pi.getAllTools(),
				activeToolNames: pi.getActiveTools(),
				promptSources: collectPromptSources(pi.getAllTools(), pi.getCommands()),
			});
			await showUsageView(ctx, {
				usage: computeUsage({
					snapshot: current,
					messages,
					reported: toReportedUsage(ctx.getContextUsage()),
					modelLabel: ctx.model?.id,
					autoCompactReserveTokens: readAutoCompactReserveTokens(ctx),
				}),
				degradedReason: initial.degradedReason,
				// Reported inside the view: a notification would stay hidden behind the fullscreen overlay.
				notices: loadedConfig.warnings,
				categoryColors: loadedConfig.config.categoryColors,
				mapSize: loadedConfig.config.mapSize,
			});
		},
	});
}
