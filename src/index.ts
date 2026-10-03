/**
 * pi-context-view - inspect what occupies the model context.
 *
 * Passively captures the first real turn, or runs one on-demand silent probe
 * when a context view is opened before any real turn. Structured capture also
 * publishes a snapshot of every request to SnapshotStore; the views do not read
 * it yet. On a Pi version older
 * than the supported one, it registers no lifecycle handlers, captures
 * nothing, and `/context` only reports the required version.
 */
import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";

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
	resolveInitialCapture,
} from "./command.ts";
import { buildUsageSnapshot, collectPromptSources, InitialCaptureState } from "./capture.ts";
import { SnapshotBuilder } from "./capture/builder.ts";
import { registerCapture } from "./capture/register.ts";
import { CompactionState, registerCompactionTracking } from "./compaction.ts";
import { isSupportedPiVersion } from "./pi-version.ts";
import { ProbeFilter, registerProbeFilter } from "./probe/filter.ts";
import { registerSilentProbe, SilentProbe } from "./probe/silent-probe.ts";
import { ProbeTrigger } from "./probe/trigger.ts";
import { createProbeView } from "./probe/view.ts";
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
	const capture = new InitialCaptureState();
	const probeFilter = new ProbeFilter();
	const probe = new SilentProbe(probeFilter);
	const probeView = createProbeView(probeFilter, probe);
	const compaction = new CompactionState();
	const trigger = new ProbeTrigger({ pi, probe, snapshots, compaction });
	const configStore = new ConfigStore();
	const supported = isSupportedPiVersion(VERSION);

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
			const initial = await resolveInitialCapture(pi, capture, trigger, ctx);
			// Compaction can start while waiting for idle; refuse instead of showing its fallback
			if (compaction.isActive) {
				reportCompactionInProgress(ctx, command.view);
				return;
			}
			if (command.view === "injections") {
				await showInjectionsView(ctx, {
					snapshot: initial.snapshot,
					degradedReason: initial.degradedReason,
				});
				return;
			}
			// Loaded only for the Usage view, the sole consumer of configured colors.
			const loadedConfig = configStore.load();
			const messages = probeView.filterMessages(ctx.sessionManager.buildSessionProjection().messages);
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
					autoCompactReserveTokens: readAutoCompactReserveTokens(pi, ctx.model),
				}),
				degradedReason: initial.degradedReason,
				// Reported inside the view: a notification would stay hidden behind the fullscreen overlay.
				notices: loadedConfig.warnings,
				categoryColors: loadedConfig.config.categoryColors,
				mapSize: loadedConfig.config.mapSize,
			});
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

	pi.on("before_agent_start", (event) => {
		// The chained prompt here already carries additions from extensions loaded
		// earlier; anything the context event adds came from extensions after us.
		capture.prepare(event.systemPromptOptions, event.systemPrompt);
	});

	pi.on("context", (event, ctx) => {
		// Lazy: this event fires once per LLM request, but only the freezing call
		// reads these inputs, and the baseline rebuild alone is O(session).
		capture.finalize(() => ({
			systemPrompt: ctx.getSystemPrompt(),
			// Initial's own comparison inputs; the request itself is filtered in context_with_system
			messages: probeView.filterMessages(event.messages),
			baselineMessages: probeView.filterMessages(ctx.sessionManager.buildSessionProjection().messages),
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
			promptSources: collectPromptSources(pi.getAllTools(), pi.getCommands()),
			origin: probeView.isCurrentRun ? "synthetic-probe" : "real-turn",
		}));
	});
}
