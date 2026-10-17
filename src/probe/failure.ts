/** Probe failure identity is separate from its user-facing explanation. */
export type ProbeFailureCause =
	| "compaction" | "pending-messages" | "missing-model" | "virtual-model" | "missing-auth"
	| "idle-warming" | "context-limit" | "settings" | "timeout" | "foreign-run" | "nested-send"
	| "shutdown" | "startup" | "missing-snapshot";

/** Process-local failure metadata; never persisted with probe identities. */
export interface ProbeFailure {
	readonly status: "failed";
	readonly cause: ProbeFailureCause;
	readonly reason: string;
}

/** Keep diagnostic wording at one boundary; detail names a provider or an existing startup error. */
export function probeFailure(cause: ProbeFailureCause, detail = ""): ProbeFailure {
	const reasons: Record<ProbeFailureCause, string> = {
		compaction: "Silent probe unavailable: context compaction is in progress.",
		"pending-messages": "Silent probe unavailable: messages are waiting to be delivered.",
		"missing-model": "Silent probe unavailable: no model is selected.",
		"virtual-model": "Silent probe unavailable: a virtual model is selected.",
		"missing-auth": `Silent probe unavailable: ${detail} has no configured authentication.`,
		"idle-warming": "Silent probe unavailable: idle cache warming is enabled.",
		"context-limit": "Silent probe unavailable: context exceeds the auto-compaction threshold.",
		settings: "Silent probe unavailable: Pi settings could not be checked.",
		timeout: "Silent probe timed out.",
		"foreign-run": "Another agent run started before the silent probe was recognized.",
		"nested-send": "Another extension sent a user message during the silent probe; neither run was stopped, " +
			"so the empty probe prompt may reach the model.",
		shutdown: "Session ended before the silent probe completed.",
		startup: detail,
		"missing-snapshot": "Silent probe settled without a request snapshot.",
	};
	return { status: "failed", cause, reason: reasons[cause] };
}
