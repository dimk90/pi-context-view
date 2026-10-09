/** Pi version support check; callers pass pi's exported `VERSION`. */

/**
 * Oldest Pi release whose request lifecycle, probe behavior, and hidden tool
 * reporting (`hiddenTools` in prompt options) this extension relies on.
 */
export const MIN_PI_VERSION = "1.1.0";

/**
 * Whether `version` is MIN_PI_VERSION or newer. Only the numeric
 * `major.minor.patch` core is compared, so a prerelease counts as its release.
 * An unparseable version is assumed supported: there is no evidence to refuse it.
 */
export function isSupportedPiVersion(version: string): boolean {
	const current = parseVersionCore(version);
	const minimum = parseVersionCore(MIN_PI_VERSION);
	if (current === undefined || minimum === undefined) return true;
	for (const [index, part] of current.entries()) {
		if (part !== minimum[index]) return part > minimum[index];
	}
	return true;
}

/** Numeric `[major, minor, patch]` of a version string, or undefined when it has none. */
function parseVersionCore(version: string): [number, number, number] | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (match === null) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}
