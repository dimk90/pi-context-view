/**
 * Process-local correlation token for the silent probe. The token travels with
 * the async execution context of this extension's own `sendUserMessage()` call,
 * so lifecycle handlers can recognize the probe run itself instead of guessing
 * from prompt text another extension's input transform may have rewritten.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** Opaque per-attempt correlation value. Never persisted, rendered, or logged. */
export type ProbeToken = string;

const PROBE_TOKEN_STORAGE = new AsyncLocalStorage<ProbeToken>();

/** Create the correlation token for one probe attempt. */
export function createProbeToken(): ProbeToken {
	return randomUUID();
}

/** Run `send` so every handler pi invokes from that call observes `token`. */
export function runWithProbeToken<T>(token: ProbeToken, send: () => T): T {
	return PROBE_TOKEN_STORAGE.run(token, send);
}

/** The token of the probe call the current handler runs inside, if any. */
export function readProbeToken(): ProbeToken | undefined {
	return PROBE_TOKEN_STORAGE.getStore();
}
