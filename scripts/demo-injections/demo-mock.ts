/** Private runner: node demo-mock.ts <codemode-only: true|false> <local: true|false> <Pi arguments...>. */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { constants, homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { MOCK_MODEL, MOCK_PROVIDER, type DemoMockProvider, startDemoMockProvider } from "./demo-mock-provider.ts";
import { validateArgs, writeMockConfig } from "./demo-mock-config.ts";

const MODEL = `${MOCK_PROVIDER}/${MOCK_MODEL}`;

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
