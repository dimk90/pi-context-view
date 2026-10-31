/**
 * Capture layer wiring: reads Pi's hidden tools in `before_agent_start`,
 * observes every agent request in `context_with_system`, pairs it with its
 * provider payload in `before_provider_request`, and confirms
 * the dispatch from assistant message events. Observe only:
 * handlers return nothing and never change provider-bound data. Captures only
 * in TUI mode, where the views can show snapshots, but without waiting for a
 * consumer; imports no trigger or consumer code.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ProbeView } from "../probe/view.ts";
import type { SnapshotBuilder } from "./builder.ts";
import { DispatchConfirmer } from "./dispatch.ts";
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
	const guard = new PayloadGuard({
		publisher: builder,
		blockImages: () => readBlockImages(pi),
	});
	/**
	 * Pi's hidden declarations, as every run's `before_agent_start` reports them.
	 * Only a later handler or a mid-run tool change can make this copy stale.
	 */
	let hiddenTools: readonly string[] = [];

	/** Settle the latest unpaired capture: no payload reached the monitor for it. */
	function settleUnpaired(): void {
		const capture = tracker.takeUnpaired();
		if (capture === undefined) return;
		builder.settleGuard(capture.id, { status: "incomplete", reason: NO_PAYLOAD_REASON });
		builder.release(capture.id);
	}

	/** Hand the first assistant dispatch identity of the waiting request to the guard. */
	function confirmDispatch(message: AgentMessage, ctx: ExtensionContext): void {
		if (message.role !== "assistant") return;
		const request = confirmer.take();
		if (request === undefined) return;
		const dispatch = { provider: message.provider, api: message.api, model: message.model };
		guard.confirm(request, dispatch, (provider, modelId) => ctx.modelRegistry.find(provider, modelId));
	}

	pi.on("before_agent_start", (event) => {
		// Pi before 1.0.4 leaves `hiddenTools` out of the options
		hiddenTools = [...(event.systemPromptOptions.hiddenTools ?? [])];
	});

	pi.on("context_with_system", (event, ctx) => {
		// No view can show a snapshot in other modes. Without a tracked capture, the
		// payload, dispatch, and settle handlers have nothing to do.
		if (ctx.mode !== "tui") return;
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
				hiddenTools,
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
		if (pairing.type !== "paired") return;
		// Later handlers can edit the payload in place, so copy it now
		guard.accept(pairing.capture, event.payload);
		const previous = confirmer.expect(pairing.capture.id);
		if (previous !== undefined) guard.finishUnconfirmed(previous);
	});

	// No provider_stream_event handler: Pi emits that event, with an awaited emit per chunk, only when one exists
	pi.on("message_start", (event, ctx) => {
		confirmDispatch(event.message, ctx);
	});

	pi.on("message_end", (event, ctx) => {
		confirmDispatch(event.message, ctx);
	});

	pi.on("agent_settled", () => {
		settleUnpaired();
		const unconfirmed = confirmer.take();
		if (unconfirmed !== undefined) guard.finishUnconfirmed(unconfirmed);
	});

	pi.on("session_shutdown", () => {
		hiddenTools = [];
		tracker.clear();
		confirmer.clear();
		guard.clear();
		builder.clear();
	});
}

/**
 * Pi's live `images.blockImages` setting: the evidence for its blocked-image
 * text in a payload. Unreadable settings count as off, so that text is reported.
 */
function readBlockImages(pi: ExtensionAPI): boolean {
	try {
		return pi.getSettings().images?.blockImages === true;
	} catch {
		return false;
	}
}
