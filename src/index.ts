/**
 * pi-context-view - inspect what occupies the model context.
 *
 * Structured capture publishes a snapshot of every request to SnapshotStore,
 * which keeps the latest one. Injections shows that request as it was sent;
 * Usage applies it to the current branch. Either view runs one on-demand
 * silent probe when opened before any request, unless configuration disables it. On a Pi version older than the
 * supported one, it registers no lifecycle handlers, captures nothing, and
 * `/context` only reports the
 * required version.
 */
import { type ExtensionAPI, type ExtensionCommandContext, VERSION } from "@earendil-works/pi-coding-agent";

import { type ConfigLoadResult, ConfigStore, createDefaultConfigFile } from "./config.ts";
import {
	CONTEXT_COMMAND_DESCRIPTION,
	getContextArgumentCompletions,
	parseContextCommand,
	reportCommandMessage,
	reportCompactionInProgress,
	reportConfigCreation,
	reportTuiOnly,
	reportUnsupportedPi,
	type RequestSnapshotResult,
	resolveRequestSnapshot,
} from "./command.ts";
import { SnapshotBuilder } from "./capture/builder.ts";
import { registerCapture } from "./capture/register.ts";
import { CompactionState, registerCompactionTracking } from "./compaction.ts";
import { buildFallbackInjectionsSnapshot, buildInjectionsSnapshot } from "./injections.ts";
import { resolveNextRequestModel } from "./model-identity.ts";
import { isSupportedPiVersion } from "./pi-version.ts";
import { ProbeFilter, registerProbeFilter } from "./probe/filter.ts";
import { registerSilentProbe, SilentProbe } from "./probe/silent-probe.ts";
import { ProbeTrigger } from "./probe/trigger.ts";
import { createProbeView } from "./probe/view.ts";
import { applyRequestSnapshot } from "./projection.ts";
import { collectPromptSources } from "./prompt-additions.ts";
import { buildUsageSnapshot } from "./replay.ts";
import { readAutoCompactReserveTokens } from "./settings.ts";
import { SnapshotStore } from "./snapshot.ts";
import { showInjectionsView } from "./ui/injections-view.ts";
import { showUsageView } from "./ui/usage-view.ts";
import { computeUsage, toReportedUsage } from "./usage.ts";

/**
 * Extension factory. Pi passes only `pi`; in-process tests pass `snapshots` to
 * read what capture publishes, and `configStore` to stay independent of the
 * developer's configuration file.
 */
export default function (pi: ExtensionAPI, snapshots = new SnapshotStore(), configStore = new ConfigStore()) {
	const probeFilter = new ProbeFilter();
	const probe = new SilentProbe(probeFilter);
	const probeView = createProbeView(probeFilter, probe);
	const compaction = new CompactionState();
	const trigger = new ProbeTrigger({ pi, probe, snapshots, compaction });
	const supported = isSupportedPiVersion(VERSION);

	/** Open Injections on the latest request snapshot, or on the pi-native fallback without one. */
	async function openInjections(
		ctx: ExtensionCommandContext,
		latest: RequestSnapshotResult,
		loadedConfig: ConfigLoadResult,
	): Promise<void> {
		if (latest.type !== "snapshot") {
			await showInjectionsView(ctx, {
				snapshot: buildFallbackInjectionsSnapshot({
					systemPrompt: ctx.getSystemPrompt(),
					options: ctx.getSystemPromptOptions(),
					allTools: pi.getAllTools(),
					activeToolNames: pi.getActiveTools(),
					promptSources: collectPromptSources(pi.getAllTools(), pi.getCommands()),
				}),
				degradedReason: latest.type === "missing" ? latest.degradedReason : undefined,
				probingDisabled: latest.type === "unprobed",
				notices: loadedConfig.warnings,
			});
			return;
		}
		const snapshot = latest.snapshot;
		await showInjectionsView(ctx, {
			snapshot: buildInjectionsSnapshot({
				snapshot,
				entries: ctx.sessionManager.getEntries(),
				filterMessages: (messages) => probeView.filterMessages(messages),
				options: ctx.getSystemPromptOptions(),
				allTools: pi.getAllTools(),
				promptSources: collectPromptSources(pi.getAllTools(), pi.getCommands()),
				systemPrompt: ctx.getSystemPrompt(),
				activeToolNames: pi.getActiveTools(),
			}),
			probe: snapshot.origin === "synthetic-probe",
			guard: snapshot.guard,
			notices: loadedConfig.warnings,
		});
	}

	/** Open Usage on the current branch with the latest request snapshot's changes applied. */
	async function openUsage(
		ctx: ExtensionCommandContext,
		latest: RequestSnapshotResult,
		loadedConfig: ConfigLoadResult,
	): Promise<void> {
		const { messages, branchMessages, systemChanges, forcedPrompt } = applyRequestSnapshot({
			snapshot: latest.type === "snapshot" ? latest.snapshot : undefined,
			entries: ctx.sessionManager.getEntries(),
			leafId: ctx.sessionManager.getLeafId(),
			filterMessages: (projected) => probeView.filterMessages(projected),
		});
		const current = buildUsageSnapshot({
			messages,
			systemChanges,
			forcedPrompt,
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
				// Pi's routed-model lookup reads its session messages, not the request's changes
				nextRequestModel: resolveNextRequestModel(ctx.model, branchMessages),
				autoCompactReserveTokens: readAutoCompactReserveTokens(pi, ctx.model),
			}),
			degradedReason: latest.type === "missing" ? latest.degradedReason : undefined,
			probingDisabled: latest.type === "unprobed",
			// Reported inside the view: a notification would stay hidden behind the fullscreen overlay
			notices: loadedConfig.warnings,
			categoryColors: loadedConfig.config.categoryColors,
			mapSize: loadedConfig.config.mapSize,
		});
	}

	pi.registerCommand("context", {
		description: CONTEXT_COMMAND_DESCRIPTION,
		getArgumentCompletions: getContextArgumentCompletions,
		handler: async (args, ctx) => {
			// Every form, config included, would describe a lifecycle this Pi does not have
			if (!supported) {
				reportUnsupportedPi(ctx, VERSION);
				return;
			}
			const command = parseContextCommand(args);
			if (command.type === "invalid") {
				reportCommandMessage(ctx, command.message, "error");
				return;
			}
			// Creating the file needs no UI, so it stays available in every run mode
			if (command.type === "config") {
				reportConfigCreation(ctx, createDefaultConfigFile());
				return;
			}
			if (ctx.mode !== "tui") {
				reportTuiOnly(ctx, command.view);
				return;
			}
			if (compaction.isActive) {
				reportCompactionInProgress(ctx, command.view);
				return;
			}
			// Loaded only when a view opens: the factory also runs where no view can
			const loadedConfig = configStore.load();
			const latest = await resolveRequestSnapshot(snapshots, trigger, ctx, loadedConfig.config.autoProbing);
			// Compaction can start while waiting for idle; refuse instead of showing its fallback
			if (compaction.isActive) {
				reportCompactionInProgress(ctx, command.view);
				return;
			}
			if (command.view === "injections") await openInjections(ctx, latest, loadedConfig);
			else await openUsage(ctx, latest, loadedConfig);
		},
	});

	// Older Pi lacks events the capture and the probe rely on, so observe nothing there
	if (!supported) return;

	// Probe layer first: ProbeFilter's context_with_system handler must run before capture's
	registerProbeFilter(pi, probeFilter);
	registerSilentProbe(pi, probe);
	registerCapture(pi, probeView, new SnapshotBuilder(snapshots));
	registerCompactionTracking(pi, compaction);

	pi.on("session_shutdown", () => {
		snapshots.clear();
	});
}
