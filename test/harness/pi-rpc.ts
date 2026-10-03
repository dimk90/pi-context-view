/**
 * RPC driver for the validation harness. It starts the pinned Pi CLI from
 * `node_modules` in RPC mode with an isolated `PI_CODING_AGENT_DIR`, a scratch
 * working directory, no discovered resources, and the mock provider as the
 * only configured endpoint.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RpcClient } from "@earendil-works/pi-coding-agent";

import type { MockApi, MockProvider } from "./mock-provider.ts";

/** Providers in `models.json`, one per mock API. */
export const MOCK_PROVIDERS = {
	"openai-completions": "mock-openai",
	"anthropic-messages": "mock-anthropic",
} as const satisfies Record<MockApi, string>;

/**
 * Models of every mock provider:
 *   vision   accepts text and images
 *   text     text only, for image-omission adjustments
 */
export const MOCK_MODELS = ["vision", "text"] as const;

/** Model selected when a test names none. */
export const DEFAULT_MODEL = `${MOCK_PROVIDERS["openai-completions"]}/vision`;

/** Settings that keep runs deterministic; `PiOptions.settings` overrides them per key. */
const DEFAULT_SETTINGS = {
	cacheWarming: "off",
	compaction: { enabled: false },
	retry: { enabled: false },
	quietStartup: true,
};

/** Arguments that disable every discovered resource; `-e` paths still load. */
const ISOLATION_ARGS = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];

/** Options for one isolated Pi process. */
export interface PiOptions {
	readonly provider: MockProvider;
	/** Extension paths or `builtin:<name>` entries, in load order. */
	readonly extensions: readonly string[];
	/** `provider/model`; defaults to `DEFAULT_MODEL`. */
	readonly model?: string;
	/** Top-level `settings.json` keys that replace the defaults. */
	readonly settings?: Record<string, unknown>;
	/** Fields merged into every mock model definition, such as `promptCache` or `compat`. */
	readonly modelFields?: Record<string, unknown>;
	/** Extra CLI arguments, such as `--no-session`. */
	readonly args?: readonly string[];
}

/** Running Pi process with its scratch directories. */
export interface PiProcess {
	readonly client: RpcClient;
	readonly agentDir: string;
	readonly cwd: string;
	/** Stop Pi and remove the scratch directories. */
	stop(): Promise<void>;
}

/** Write an isolated agent directory and start Pi in RPC mode against the mock provider. */
export async function startPi(options: PiOptions): Promise<PiProcess> {
	const root = await mkdtemp(join(tmpdir(), "context-view-harness-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	try {
		await writeAgentDir(agentDir, options);
		await mkdir(cwd);
		const client = new RpcClient({
			cliPath: resolveCliPath(),
			cwd,
			env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
			model: options.model ?? DEFAULT_MODEL,
			args: [
				...ISOLATION_ARGS,
				...options.extensions.flatMap((extension) => ["-e", extension]),
				...(options.args ?? []),
			],
		});
		await client.start();
		return {
			client, agentDir, cwd,
			stop: async () => {
				await client.stop();
				await rm(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

/** Pinned CLI entry point next to the package's resolved `dist/index.js`. */
function resolveCliPath(): string {
	return join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
}

/** Write `settings.json` and `models.json`; no `auth.json`, so no real credentials exist. */
async function writeAgentDir(agentDir: string, options: PiOptions): Promise<void> {
	await mkdir(agentDir);
	const settings = { ...DEFAULT_SETTINGS, ...options.settings };
	await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings, null, "\t"));
	await writeFile(join(agentDir, "models.json"), JSON.stringify(buildModelsConfig(options), null, "\t"));
}

/** One provider per mock API, each with the same model IDs. */
function buildModelsConfig({ provider, modelFields }: PiOptions): unknown {
	const providers = Object.fromEntries(Object.entries(MOCK_PROVIDERS).map(([api, name]) => [name, {
		api,
		baseUrl: provider.baseUrls[api as MockApi],
		apiKey: "mock-key",
		models: MOCK_MODELS.map((id) => ({
			id,
			name: `Mock ${id}`,
			input: id === "vision" ? ["text", "image"] : ["text"],
			contextWindow: 100_000,
			maxTokens: 1024,
			...modelFields,
		})),
	}]));
	return { providers };
}
