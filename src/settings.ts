/**
 * Read Pi's settings for the probe preconditions and the Usage map's
 * auto-compaction reserve.
 */
import { type CacheWarmingMode, type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Identifies the `compaction.modelOverrides` entry pi would apply to a request. */
export interface CompactionModel {
	readonly provider: string;
	readonly id: string;
}

/**
 * Wrap Pi's live merged settings, including unsaved runtime changes, so both
 * the probe preconditions and the Usage map read the same source.
 */
export function readLiveSettings(pi: ExtensionAPI): SettingsManager {
	return SettingsManager.inMemory(pi.getSettings());
}

/**
 * Read the global-only warming mode; a project override must not hide idle warming.
 * Extensions cannot see an SDK host's custom agent directory, so this reads Pi's
 * default one, which honors `PI_CODING_AGENT_DIR`.
 */
export function readGlobalCacheWarmingMode(cwd: string): CacheWarmingMode {
	const settings = SettingsManager.create(cwd, undefined, { projectTrusted: false });
	if (settings.drainErrors().length > 0) throw new Error("Pi settings could not be read.");
	return settings.getCacheWarmingMode();
}

/**
 * Read the auto-compaction reserve from Pi's live settings, or undefined when
 * auto-compaction is disabled. Read at view-open time because `enabled` and the
 * model can change at runtime.
 */
export function readAutoCompactReserveTokens(pi: ExtensionAPI, model?: CompactionModel): number | undefined {
	try {
		return resolveAutoCompactReserveTokens(readLiveSettings(pi), model);
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
