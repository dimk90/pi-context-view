/** Prepare isolated mock configuration without starting a provider or Pi process. */
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MOCK_MODEL, MOCK_PROVIDER } from "./demo-mock-provider.ts";
import { getMockExtensionPaths, resolveMockResources } from "./demo-mock-resources.ts";
import { copySelectedThemes } from "./demo-mock-themes.ts";

const APPEARANCE_SETTINGS = [
	"theme", "quietStartup", "hideThinkingBlock", "showCacheMissNotices", "tuiMode", "fullscreenExitOutput",
	"fullscreenScrollbar", "fullscreenCopyOnSelect", "fullscreenWheelScrollLines", "editorPaddingX", "outputPad",
	"autocompleteMaxVisible", "showHardwareCursor", "terminal", "markdown", "collapseChangelog",
];
const CONFLICTING_ARGS = new Set([
	"--provider", "--model", "--models", "--api-key", "--continue", "-c", "--resume", "-r",
	"--session", "--session-id", "--session-dir", "--fork", "--approve", "-a",
]);
const MODEL = `${MOCK_PROVIDER}/${MOCK_MODEL}`;

/** Inputs for temporary model/session settings and optional global extension discovery. */
export interface MockConfigOptions {
	readonly agentDir: string;
	readonly sourceDir: string;
	readonly baseUrl: string;
	readonly codemodeOnly: boolean;
	readonly localExtensions: boolean;
}

/** Keep startup model selection and session storage inside the mock run. */
export function validateArgs(args: string[]): void {
	for (const arg of args) {
		if (arg === "--") break;
		if (CONFLICTING_ARGS.has(arg.split("=", 1)[0])) {
			throw new Error(`--mock cannot be combined with ${arg}; it uses its own model and an in-memory session.`);
		}
	}
}

/** Write isolated model/session settings, adding installed global extension paths only when requested. */
export async function writeMockConfig({
	agentDir, sourceDir, baseUrl, codemodeOnly, localExtensions,
}: MockConfigOptions): Promise<void> {
	const inherited = await readDisplaySettings(sourceDir);
	const resources = localExtensions ? await resolveMockResources({ agentDir, sourceDir, settings: inherited }) : undefined;
	const appearance = Object.fromEntries(APPEARANCE_SETTINGS.filter((key) => key in inherited)
		.map((key) => [key, inherited[key]]));
	const settings = {
		...appearance, defaultProvider: MOCK_PROVIDER, defaultModel: MOCK_MODEL, enabledModels: [MODEL],
		defaultThinkingLevel: "off", defaultProjectTrust: "never", cacheWarming: "off",
		compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false, enableAnalytics: false,
		...(resources ? { extensions: getMockExtensionPaths(resources) } : {}),
		...(codemodeOnly ? { codemode: { mode: "only" }, defaultTools: ["+codemode"] } : {}),
	};
	const models = {
		providers: {
			[MOCK_PROVIDER]: {
				api: "openai-completions", baseUrl, apiKey: "mock-key",
				models: [{
					id: MOCK_MODEL, name: "Demo Mock", reasoning: false, input: ["text"],
					contextWindow: 100_000, maxTokens: 128,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}],
			},
		},
	};
	await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings, null, "\t"));
	await writeFile(join(agentDir, "models.json"), JSON.stringify(models, null, "\t"));
	await writeFile(join(agentDir, "auth.json"), "{}\n");
	await copySelectedThemes({ sourceDir, agentDir, settings: inherited, resources });
	await copyAppearanceFile(sourceDir, agentDir, "keybindings.json");
}

/** Missing settings are fine; unreadable or invalid settings must not silently change the chosen appearance. */
async function readDisplaySettings(sourceDir: string): Promise<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(sourceDir, "settings.json"), "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Invalid settings");
		return parsed as Record<string, unknown>;
	} catch (error) {
		if (isMissingFile(error)) return {};
		throw new Error(`Cannot read Pi display settings from ${join(sourceDir, "settings.json")}.`);
	}
}

/** Copy instead of linking, so edits during the demo cannot change the original appearance files. */
async function copyAppearanceFile(sourceDir: string, agentDir: string, name: string): Promise<void> {
	try {
		await cp(join(sourceDir, name), join(agentDir, name), { recursive: true, dereference: true });
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}
}

/** Distinguish an optional absent file from permissions and other I/O errors. */
function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
