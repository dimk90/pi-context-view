/**
 * ProjectionReader and TranscriptCapture: the synchronous part of a structured
 * capture in `context_with_system` (D2, D3). Everything here runs inside the
 * handler, before later handlers can mutate the shared request messages.
 */
import { getCurrentSystemMessage, getCurrentSystemPrompt, type SystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ProbeView } from "../probe/view.ts";
import type { CaptureOrigin, RequestMessage } from "../snapshot.ts";
import { trimMatchedEnds, type UnmatchedMessages } from "./diff.ts";
import type { GuardModel } from "./guard.ts";

/** A baseline message with the session entry that owns it. */
export interface BaselineMessage {
	readonly entryId: string;
	readonly message: RequestMessage;
}

/** Filtered session projection at capture time. */
export interface Baseline {
	/** Session leaf; `buildSessionProjection(entries, leafId)` rebuilds these messages. */
	readonly leafId: string | null;
	readonly messages: readonly BaselineMessage[];
}

/**
 * The parts of a request the deferred diff needs, as this extension's handler
 * saw them. Request-side values are owned copies.
 */
export interface RequestCopy {
	/** The request's replayed system state; undefined when it has none. */
	readonly system?: SystemMessage;
	/**
	 * Non-system messages left after removing the ends both sides share: session
	 * originals on the baseline side, copies on the request side.
	 */
	readonly conversation: UnmatchedMessages;
}

/**
 * Everything the deferred diff needs from one request. Process-local: it holds
 * raw content and is released once its snapshot is built.
 */
export interface CapturedRequest extends RequestCopy {
	readonly id: number;
	readonly origin: CaptureOrigin;
	/** Capture time in epoch milliseconds. */
	readonly capturedAt: number;
	readonly baseline: Baseline;
	readonly forcedPrompt?: string;
	/** `ctx.model` at capture: the dispatched model on a physical selection, the virtual one otherwise. */
	readonly requestModel?: GuardModel;
}

/** Inputs of one capture, read from the `context_with_system` event and its context. */
export interface CaptureInput {
	readonly id: number;
	readonly origin: CaptureOrigin;
	readonly messages: readonly RequestMessage[];
	readonly sessionManager: Pick<ExtensionContext["sessionManager"], "buildSessionProjection" | "getLeafId">;
	/** `ctx.getSystemPrompt()`: Pi's effective prompt for the current run. */
	readonly effectivePrompt: string;
	readonly probe: Pick<ProbeView, "filterMessages">;
	/** `ctx.model`; its identity is copied before later handlers can change it. */
	readonly requestModel?: GuardModel;
	readonly capturedAt?: number;
}

/**
 * Read the baseline, copy what differs from it, and detect a forced prompt.
 * Throws when a differing message cannot be cloned, for example when a handler
 * added a function value to it.
 */
export function captureRequest(input: CaptureInput): CapturedRequest {
	const baseline = readBaseline(input.sessionManager, input.probe);
	return {
		id: input.id,
		origin: input.origin,
		capturedAt: input.capturedAt ?? Date.now(),
		baseline,
		...copyRequest(baseline.messages, input.messages),
		forcedPrompt: detectForcedPrompt(input.effectivePrompt, baseline.messages),
		...(input.requestModel === undefined ? {} : {
			requestModel: {
				provider: input.requestModel.provider, api: input.requestModel.api, id: input.requestModel.id,
			},
		}),
	};
}

/**
 * Copy the request's replayed system state and the messages that differ from
 * the baseline. Messages equal to the baseline at both ends are compared in
 * place and never copied, so an unchanged request copies only its system state.
 */
export function copyRequest(baseline: readonly BaselineMessage[], messages: readonly RequestMessage[]): RequestCopy {
	const unmatched = trimMatchedEnds(baseline, messages);
	// Later handlers share these objects, tool schemas included, and may edit them in place
	const copy = structuredClone({ system: getCurrentSystemMessage(messages), request: unmatched.request });
	return {
		...(copy.system === undefined ? {} : { system: copy.system }),
		conversation: { baseline: unmatched.baseline, request: copy.request },
	};
}

/**
 * Read the canonical session projection Pi rebuilt this request from, without
 * recorded probe messages, keeping each message's source entry. The projection
 * returns stored session objects; they are only read, never changed.
 */
export function readBaseline(
	sessionManager: CaptureInput["sessionManager"],
	probe: CaptureInput["probe"],
): Baseline {
	const projection = sessionManager.buildSessionProjection();
	const messages = projection.entries.flatMap(({ sourceEntry, messages: entryMessages }) =>
		probe.filterMessages(entryMessages).map((message) => ({ entryId: sourceEntry.id, message })));
	return { leafId: sessionManager.getLeafId(), messages };
}

/**
 * The forced prompt of the current run, or undefined when the effective prompt
 * is the one the baseline replays. Pi records structured sections even for a
 * forced prompt and projects the forced text onto the request afterwards.
 */
export function detectForcedPrompt(effectivePrompt: string, baseline: readonly BaselineMessage[]): string | undefined {
	const replayed = getCurrentSystemPrompt(baseline.map(({ message }) => message));
	return effectivePrompt === replayed ? undefined : effectivePrompt;
}
