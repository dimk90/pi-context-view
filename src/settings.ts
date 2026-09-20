/**
 * Read pi's own compaction settings for the Usage map. Only the auto-compaction
 * reserve is needed: it is the headroom content can never occupy.
 */
import { type ExtensionCommandContext, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Identifies the `compaction.modelOverrides` entry pi would apply to a request. */
export interface CompactionModel {
	readonly provider: string;
	readonly id: string;
}

/**
 * Read the auto-compaction reserve from the same merged settings files pi uses,
 * or undefined when auto-compaction is disabled. Read at view-open time because
 * `reserveTokens` has no runtime setter but `enabled` and the model can change.
 */
export function readAutoCompactReserveTokens(context: ExtensionCommandContext): number | undefined {
	try {
		const settings = SettingsManager.create(context.cwd, undefined, {
			projectTrusted: context.isProjectTrusted(),
		});
		return resolveAutoCompactReserveTokens(settings, context.model);
	} catch {
		// Unreadable settings degrade to a map without the buffer, not a failed view.
		return undefined;
	}
}

/**
 * Resolve the reserve pi would apply to `model`: its `compaction.modelOverrides`
 * entry, else the ordinary `compaction.reserveTokens`, else pi's default.
 * Returns undefined when auto-compaction is disabled or a setting is invalid.
 */
export function resolveAutoCompactReserveTokens(
	settings: SettingsManager,
	model?: CompactionModel,
): number | undefined {
	try {
		if (!settings.getCompactionEnabled()) return undefined;
		return settings.getCompactionReserveTokens(model);
	} catch {
		// Pi rejects invalid reserve values; show no buffer rather than a wrong one.
		return undefined;
	}
}
