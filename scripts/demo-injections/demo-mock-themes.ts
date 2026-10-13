/** Copy selected theme assets using Pi's installed-resource discovery, without loading package extensions. */
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { DefaultResourceLoader, type ResolvedPaths, SettingsManager } from "@earendil-works/pi-coding-agent";

import { type MockResourceOptions, resolveMockResources } from "./demo-mock-resources.ts";

/** Theme selection and destination, optionally reusing the global resources resolved for --local. */
export interface MockThemeOptions extends MockResourceOptions {
	readonly resources?: ResolvedPaths;
}

/** Copy the selected custom theme, or both members of an automatic light/dark pair, without installing packages. */
export async function copySelectedThemes({ sourceDir, agentDir, settings, resources }: MockThemeOptions): Promise<void> {
	const selected = new Set(typeof settings.theme === "string" ? settings.theme.split("/").map((name) => name.trim()) : []);
	selected.delete("system");
	selected.delete("");
	if (selected.size === 0) return;
	const resolved = resources ?? await resolveMockResources({ sourceDir, agentDir, settings });
	const loader = new DefaultResourceLoader({
		cwd: agentDir, agentDir, settingsManager: SettingsManager.inMemory(),
		noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
		additionalThemePaths: resolved.themes.filter((resource) => resource.enabled && resource.metadata.scope === "user")
			.map((resource) => resource.path),
	});
	await loader.reload();
	for (const theme of loader.getThemes().themes) {
		if (theme.name === undefined || theme.sourcePath === undefined || !selected.has(theme.name)) continue;
		await mkdir(join(agentDir, "themes"), { recursive: true });
		// Use the declared name for Pi's user-theme lookup and watcher, not a package-specific filename
		await copyFile(theme.sourcePath, join(agentDir, "themes", `${theme.name}.json`));
		selected.delete(theme.name);
		if (selected.size === 0) break;
	}
}
