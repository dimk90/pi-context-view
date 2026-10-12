/** Resolve installed global resources without executing extension code or installing packages. */
import { DefaultPackageManager, type ResolvedPaths, SettingsManager } from "@earendil-works/pi-coding-agent";

// Pi 1.1's CLI built-ins; resolve their enabled state with the same global filters as file extensions
const BUILTIN_EXTENSIONS = ["mcp", "llama.cpp", "codemode", "tool-search"];

/** Original global configuration and an isolated directory to use instead of project discovery. */
export interface MockResourceOptions {
	readonly sourceDir: string;
	readonly agentDir: string;
	readonly settings: Record<string, unknown>;
}

/** Honor Pi manifests, relative paths, and resource filters, but never install a missing configured source. */
export async function resolveMockResources({ sourceDir, agentDir, settings }: MockResourceOptions): Promise<ResolvedPaths> {
	// Only resource declarations are needed; do not inherit executable settings such as npmCommand
	const resources: Record<string, unknown> = {
		packages: settings.packages, extensions: settings.extensions, themes: settings.themes,
	};
	const packageManager = new DefaultPackageManager({
		cwd: agentDir, agentDir: sourceDir, settingsManager: SettingsManager.inMemory(resources),
		builtinExtensions: BUILTIN_EXTENSIONS,
	});
	return packageManager.resolve(async () => "skip");
}

/** Keep global file paths and built-in enable/disable filters, not package declarations or project resources. */
export function getMockExtensionPaths(resources: ResolvedPaths): string[] {
	return resources.extensions.filter((resource) => resource.metadata.scope === "user"
		&& (resource.enabled || resource.path.startsWith("builtin:")))
		.map((resource) => resource.enabled ? resource.path : `-${resource.path}`);
}
