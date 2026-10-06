/**
 * Capture layer wiring: observes every agent request in `context_with_system`,
 * pairs it with its provider payload in `before_provider_request`, and confirms
 * the dispatch from assistant and provider stream events. Observe only (D5):
 * handlers return nothing and never change provider-bound data. Runs in every
 * run mode, without any consumer, and imports no trigger or consumer code.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ProbeView } from "../probe/view.ts";
import type { Dispatch } from "../snapshot.ts";
import type { SnapshotBuilder } from "./builder.ts";
import { DispatchConfirmer, type IdentitySource } from "./dispatch.ts";
import { PayloadGuard } from "./guard.ts";
import { type CapturedRequest, captureRequest } from "./request.ts";
import { NO_PAYLOAD_REASON, RequestTracker } from "./tracker.ts";

/**
 * Register RequestTracker, ProjectionReader, TranscriptCapture, PayloadGuard,
 * and DispatchConfirmer. Register after ProbeFilter: its `context_with_system`
 * handler must remove probe messages before this one compares and copies the
 * transcript.
 */
export function registerCapture(pi: ExtensionAPI, probe: ProbeView, builder: SnapshotBuilder): void {
	const tracker = new RequestTracker<CapturedRequest>();
	const confirmer = new DispatchConfirmer<number>();
	const guard = new PayloadGuard({ publisher: builder, loadoutCandidates: () => readLoadoutCandidates(pi) });

	/** Settle the latest unpaired capture: no payload reached the monitor for it. */
	function settleUnpaired(): void {
		const capture = tracker.takeUnpaired();
		if (capture === undefined) return;
		builder.settleGuard(capture.id, { status: "incomplete", reason: NO_PAYLOAD_REASON });
		builder.release(capture.id);
	}

	/** Hand the first dispatch identity of the waiting request to the guard. */
	function confirmDispatch(source: IdentitySource, dispatch: Dispatch, ctx: ExtensionContext): void {
		const request = confirmer.confirm(source);
		if (request !== undefined) guard.confirm(request, dispatch, (provider, modelId) => ctx.modelRegistry.find(provider, modelId));
	}

	pi.on("context_with_system", (event, ctx) => {
		settleUnpaired();
		let request: CapturedRequest;
		try {
			request = captureRequest({
				id: tracker.nextId(),
				origin: probe.isCurrentRun ? "synthetic-probe" : "real-turn",
				messages: event.messages,
				sessionManager: ctx.sessionManager,
				effectivePrompt: ctx.getSystemPrompt(),
				probe,
				requestModel: ctx.model,
			});
		} catch {
			// A request whose changes cannot be cloned is not captured; the request itself proceeds unchanged
			return;
		}
		tracker.track(request);
		builder.build(request);
	});

	pi.on("cache_warming_decision", () => {
		tracker.noteWarmDecision();
	});

	pi.on("before_provider_request", (event) => {
		const pairing = tracker.pair(event.payload);
		if (pairing.type === "warm-refresh") confirmer.noteWarmRefresh();
		if (pairing.type !== "paired") return;
		// Later handlers can edit the payload in place, so copy it now
		guard.accept(pairing.capture, event.payload);
		const previous = confirmer.expect(pairing.capture.id);
		if (previous !== undefined) guard.finishUnconfirmed(previous);
	});

	pi.on("message_start", (event, ctx) => {
		const message = event.message;
		if (message.role === "assistant") {
			confirmDispatch("assistant", { provider: message.provider, api: message.api, model: message.model }, ctx);
		}
	});

	pi.on("provider_stream_event", (event, ctx) => {
		// Only the identity is read; event.data belongs to Pi's stream
		confirmDispatch("stream", { provider: event.provider, api: event.api, model: event.model }, ctx);
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role === "assistant") {
			confirmDispatch("assistant", { provider: message.provider, api: message.api, model: message.model }, ctx);
		}
	});

	pi.on("agent_settled", () => {
		settleUnpaired();
		const unconfirmed = confirmer.takeUnconfirmed();
		if (unconfirmed !== undefined) guard.finishUnconfirmed(unconfirmed);
	});

	pi.on("session_shutdown", () => {
		tracker.clear();
		confirmer.clear();
		guard.clear();
		builder.clear();
	});
}

/** Active tools with `model-only` exposure; any of them may hide declarations through `prepareLoadout()` (D7). */
function readLoadoutCandidates(pi: ExtensionAPI): string[] {
	const active = new Set(pi.getActiveTools());
	return pi.getAllTools().filter((tool) => tool.exposure === "model-only" && active.has(tool.name)).map((tool) => tool.name);
}
