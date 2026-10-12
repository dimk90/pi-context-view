/** Private runner: node demo-mock.ts <codemode-only: true|false> <local: true|false> <Pi arguments...>. */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants, homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { MOCK_MODEL, MOCK_PROVIDER, type DemoMockProvider, startDemoMockProvider } from "./demo-mock-provider.ts";
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

/** Keep startup model selection and session storage inside the mock run. */
function validateArgs(args: string[]): void {
	for (const arg of args) {
		if (arg === "--") break;
		if (CONFLICTING_ARGS.has(arg.split("=", 1)[0])) {
			throw new Error(`--mock cannot be combined with ${arg}; it uses its own model and an in-memory session.`);
		}
	}
}

/** Start the mock and Pi, forwarding signals and releasing resources even on startup failure. */
async function runMock(codemodeOnly: boolean, localExtensions: boolean, args: string[]): Promise<number> {
	validateArgs(args);
	const configured = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const sourceDir = configured === "~" ? homedir() : configured.replace(/^~\//, `${homedir()}/`);
	let agentDir: string | undefined;
	let provider: DemoMockProvider | undefined;
	let child: ChildProcess | undefined;
	let interrupted: NodeJS.Signals | undefined;
	/** A signal received before Pi starts still goes through the same cleanup path. */
	function interrupt(signal: NodeJS.Signals): void {
		interrupted = signal;
		child?.kill(signal);
	}
	const onInterrupt = () => interrupt("SIGINT");
	const onTerminate = () => interrupt("SIGTERM");
	process.on("SIGINT", onInterrupt);
	process.on("SIGTERM", onTerminate);
	try {
		agentDir = await mkdtemp(join(tmpdir(), "context-demo-mock-"));
		// Installed-package discovery can run local npm queries; keep their caches inside the run too
		process.env.TMPDIR = agentDir;
		process.env.PI_OFFLINE = "1";
		provider = await startDemoMockProvider();
		await writeMockConfig({ agentDir, sourceDir, baseUrl: provider.baseUrl, codemodeOnly, localExtensions });
		if (interrupted) return 128 + constants.signals[interrupted];
		child = spawn("pi", [
			"--offline", "--no-approve", "--no-session", "--model", MODEL, "--models", MODEL, ...args,
		], { stdio: "inherit", env: mockEnvironment(agentDir) });
		const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
		return code ?? (signal ? 128 + constants.signals[signal] : 1);
	} finally {
		process.off("SIGINT", onInterrupt);
		process.off("SIGTERM", onTerminate);
		try {
			await provider?.close();
		} finally {
			if (agentDir) await rm(agentDir, { recursive: true, force: true });
		}
	}
}

/** Inputs for temporary model/session settings and optional global extension discovery. */
interface MockConfigOptions {
	readonly agentDir: string;
	readonly sourceDir: string;
	readonly baseUrl: string;
	readonly codemodeOnly: boolean;
	readonly localExtensions: boolean;
}

/** Write isolated model/session settings, adding installed global extension paths only when requested. */
async function writeMockConfig({
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

/** Keep child temporary files local, disable startup network activity, and bypass inherited HTTP proxies. */
function mockEnvironment(agentDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
		TMPDIR: agentDir,
	};
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
	return env;
}

try {
	const codemodeOnly = process.argv[2];
	const localExtensions = process.argv[3];
	if (![codemodeOnly, localExtensions].every((value) => value === "true" || value === "false")) {
		throw new Error("Run this helper through demo-injections.sh.");
	}
	process.exitCode = await runMock(codemodeOnly === "true", localExtensions === "true", process.argv.slice(4));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
