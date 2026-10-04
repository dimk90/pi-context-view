/**
 * pi-context-view - inspect what occupies the model context.
 *
 * Structured capture publishes a snapshot of every request to SnapshotStore;
 * Injections shows the first one, Usage applies the latest one to the current
 * branch. Either view runs one on-demand silent probe when opened before any
 * request. On a Pi version older than the supported one, it registers no
 * lifecycle handlers, captures nothing, and `/context` only reports the
 * required version.
 */
import { type ExtensionAPI, type ExtensionCommandContext, VERSION } from "@earendil-works/pi-coding-agent";

import { ConfigStore, createDefaultConfigFile } from "./config.ts";
import {
	CONTEXT_COMMAND_DESCRIPTION,
	getContextArgumentCompletions,
	parseContextCommand,
	reportCommandMessage,
	reportCompactionInProgress,
	reportConfigCreation,
	reportTuiOnly,
	reportUnsupportedPi,
	resolveRequestSnapshot,
} from "./command.ts";
import { SnapshotBuilder } from "./capture/builder.ts";
import { registerCapture } from "./capture/register.ts";
import { CompactionState, registerCompactionTracking } from "./compaction.ts";
import { buildInjectionsSnapshot } from "./injections.ts";
import { isSupportedPiVersion } from "./pi-version.ts";
import { ProbeFilter, registerProbeFilter } from "./probe/filter.ts";
import { registerSilentProbe, SilentProbe } from "./probe/silent-probe.ts";
import { ProbeTrigger } from "./probe/trigger.ts";
import { createProbeView } from "./probe/view.ts";
import { applyRequestSnapshot } from "./projection.ts";
import { collectPromptSources } from "./prompt-additions.ts";
import { buildNativeSnapshot, buildUsageSnapshot } from "./replay.ts";
import { readAutoCompactReserveTokens } from "./settings.ts";
import { SnapshotStore } from "./snapshot.ts";
import { showInjectionsView } from "./ui/injections-view.ts";
import { showUsageView } from "./ui/usage-view.ts";
import { computeUsage, toReportedUsage } from "./usage.ts";

/**
 * Extension factory. Pi passes only `pi`; in-process tests pass `snapshots` to
 * read what capture publishes.
 */
export default function (pi: ExtensionAPI, snapshots = new SnapshotStore()) {
	const probeFilter = new ProbeFilter();
	const probe = new SilentProbe(probeFilter);
	const probeView = createProbeView(probeFilter, probe);
	const compaction = new CompactionState();
	const trigger = new ProbeTrigger({ pi, probe, snapshots, compaction });
	const configStore = new ConfigStore();
	const supported = isSupportedPiVersion(VERSION);

	/** Open Injections on the first request snapshot, or on the degraded fallback without one. */
	async function openInjections(ctx: ExtensionCommandContext): Promise<void> {
		const initial = await resolveRequestSnapshot(snapshots, trigger, ctx, "first");
		// Compaction can start while waiting for idle; refuse instead of showing its fallback
		if (compaction.isActive) {
			reportCompactionInProgress(ctx, "injections");
			return;
		}
		if (initial.type === "missing") {
			await showInjectionsView(ctx, {
				snapshot: buildNativeSnapshot({
					systemPrompt: ctx.getSystemPrompt(),
					options: ctx.getSystemPromptOptions(),
					allTools: pi.getAllTools(),
					activeToolNames: pi.getActiveTools(),
				}),
				degradedReason: initial.degradedReason,
			});
			return;
		}
		const snapshot = initial.snapshot;
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
		});
	}

	/** Open Usage on the current branch with the latest request snapshot's changes applied. */
	async function openUsage(ctx: ExtensionCommandContext): Promise<void> {
		const latest = await resolveRequestSnapshot(snapshots, trigger, ctx, "latest");
		// Compaction can start while waiting for idle; refuse instead of showing its fallback
		if (compaction.isActive) {
			reportCompactionInProgress(ctx, "usage");
			return;
		}
		// Loaded only for the Usage view, the sole consumer of configured colors.
		const loadedConfig = configStore.load();
		const { messages, systemChanges, forcedPrompt } = applyRequestSnapshot({
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
				autoCompactReserveTokens: readAutoCompactReserveTokens(pi, ctx.model),
			}),
			degradedReason: latest.type === "missing" ? latest.degradedReason : undefined,
			// Reported inside the view: a notification would stay hidden behind the fullscreen overlay.
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
			// Creating the file needs no UI, so it stays available in every run mode.
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
			if (command.view === "injections") await openInjections(ctx);
			else await openUsage(ctx);
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
