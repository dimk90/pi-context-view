/**
 * Asynchronous child-process runner for launcher tests. Unlike `spawnSync`, it
 * leaves the event loop free, so concurrent tests overlap their processes.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";

/** Default limit for one command; a hung launcher fails the test instead of the run. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Options for one command. */
export interface RunCommandOptions {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	/** Kill the command with SIGTERM after this many milliseconds; defaults to 15 seconds. */
	readonly timeout?: number;
}

/** Output of a finished command; `status` is null when a signal ended it, as with `spawnSync`. */
export interface CommandResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Run a command to completion and collect its UTF-8 output; reject when it cannot start. */
export async function runCommand(
	command: string, args: readonly string[], options: RunCommandOptions = {},
): Promise<CommandResult> {
	const child = spawn(command, args, {
		cwd: options.cwd, env: options.env, timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
	// `once` rejects on the "error" event, such as a missing executable
	const [status] = await once(child, "close") as [number | null];
	return { status, stdout, stderr };
}
