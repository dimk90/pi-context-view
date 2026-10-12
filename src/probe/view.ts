/**
 * ProbeView: all that capture reads from the probe layer. Capture never sees
 * how or when a probe starts.
 */
import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import type { ProbeFilter } from "./filter.ts";
import type { SilentProbe } from "./silent-probe.ts";

/** Run origin and probe-message filter, read by capture. */
export interface ProbeView {
	/** True while SilentProbe owns the current run. */
	readonly isCurrentRun: boolean;
	/** Remove recorded probe messages; returns the same array when none match. */
	filterMessages(messages: ContextEvent["messages"]): ContextEvent["messages"];
}

/** Combine ProbeFilter and SilentProbe into the one view capture depends on. */
export function createProbeView(filter: ProbeFilter, probe: SilentProbe): ProbeView {
	return {
		get isCurrentRun() {
			return probe.isCurrentRun;
		},
		filterMessages: (messages) => filter.filterMessages(messages),
	};
}
