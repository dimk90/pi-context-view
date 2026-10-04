/**
 * Capture layer wiring: observes every agent request in `context_with_system`
 * and hands it to SnapshotBuilder. Observe only (D5): handlers return nothing
 * and never change provider-bound data. Runs in every run mode, without any
 * consumer, and imports no trigger or consumer code.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ProbeView } from "../probe/view.ts";
import type { SnapshotBuilder } from "./builder.ts";
import { type CapturedRequest, captureRequest } from "./request.ts";
import { NO_PAYLOAD_REASON, RequestTracker } from "./tracker.ts";

/**
 * Register RequestTracker, ProjectionReader, and TranscriptCapture. Register
 * after ProbeFilter: its `context_with_system` handler must remove probe
 * messages before this one compares and copies the transcript.
 */
export function registerCapture(pi: ExtensionAPI, probe: ProbeView, builder: SnapshotBuilder): void {
	const tracker = new RequestTracker();

	/** Settle the latest unpaired capture: no payload reached the monitor for it. */
	function settleUnpaired(): void {
		const id = tracker.takeUnpaired();
		if (id !== undefined) builder.settleGuard(id, { status: "incomplete", reason: NO_PAYLOAD_REASON });
	}

	pi.on("context_with_system", (event, ctx) => {
		settleUnpaired();
		let request: CapturedRequest;
		try {
			request = captureRequest({
				id: tracker.begin(),
				origin: probe.isCurrentRun ? "synthetic-probe" : "real-turn",
				messages: event.messages,
				sessionManager: ctx.sessionManager,
				effectivePrompt: ctx.getSystemPrompt(),
				probe,
			});
		} catch {
			// A request whose changes cannot be cloned is not captured; the request itself proceeds unchanged
			tracker.takeUnpaired();
			return;
		}
		builder.build(request);
	});

	pi.on("agent_settled", () => {
		settleUnpaired();
	});

	pi.on("session_shutdown", () => {
		tracker.takeUnpaired();
		builder.clear();
	});
}
