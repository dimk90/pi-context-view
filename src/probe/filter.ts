/**
 * ProbeFilter: the identities of recorded probe messages and the filter that
 * removes those messages from every request and capture baseline. It stays
 * active without a probe of this runtime, because sessions keep probe messages
 * from earlier runtimes.
 */
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Session custom-entry type persisting probe message identities across extension runtimes. */
export const PROBE_IDENTITIES_CUSTOM_TYPE = "pi-context-view:probe-identities";

/** Exact identity used to remove only synthetic probe messages. */
export interface SyntheticMessageIdentity {
	readonly role: "user" | "assistant";
	readonly timestamp: number;
}

/** Data of one persisted identities entry: role and timestamp only, never content. */
export interface PersistedIdentities {
	readonly messages: readonly SyntheticMessageIdentity[];
}

/** Known probe message identities of this runtime, restored ones included. */
export class ProbeFilter {
	private readonly identities = new Map<string, SyntheticMessageIdentity>();

	/** Defensive copies of every known probe message identity. */
	public get syntheticMessages(): SyntheticMessageIdentity[] {
		return [...this.identities.values()].map((identity) => ({ ...identity }));
	}

	/**
	 * Merge probe identities persisted by an earlier extension runtime so prior
	 * probe messages stay excluded after resume, reload, or fork.
	 */
	public restoreIdentities(identities: readonly SyntheticMessageIdentity[]): void {
		for (const identity of identities) this.record(identity);
	}

	/** Record one probe message identity; returns false when it was already known. */
	public record(identity: SyntheticMessageIdentity): boolean {
		const key = identityKey(identity);
		if (this.identities.has(key)) return false;
		this.identities.set(key, { role: identity.role, timestamp: identity.timestamp });
		return true;
	}

	/** Whether this exact role and timestamp was recorded for a probe. */
	public has(message: SyntheticMessageIdentity): boolean {
		return this.identities.has(identityKey(message));
	}

	/**
	 * Remove only messages whose exact role+timestamp identity belongs to a probe.
	 * Returns the same array when no message matches.
	 */
	public filterMessages(messages: ContextEvent["messages"]): ContextEvent["messages"] {
		if (this.identities.size === 0) return messages;
		const filtered = messages.filter((message) => {
			if (message.role !== "user" && message.role !== "assistant") return true;
			return !this.has(message);
		});
		return filtered.length === messages.length ? messages : filtered;
	}
}

/**
 * Restore persisted identities on `session_start` and filter every request in
 * `context_with_system`. Register before capture: capture's own
 * `context_with_system` handler must see the filtered messages.
 */
export function registerProbeFilter(pi: ExtensionAPI, filter: ProbeFilter): void {
	pi.on("session_start", (_event, ctx) => {
		// Identities from all prior runtimes keep persisted probe messages out of
		// later model contexts and Usage after resume, reload, or fork
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === PROBE_IDENTITIES_CUSTOM_TYPE) {
				filter.restoreIdentities(parsePersistedIdentities(entry.data));
			}
		}
	});

	pi.on("context_with_system", (event) => {
		// Filtering here preserves system-message positions and cached prefixes
		const messages = filter.filterMessages(event.messages);
		return messages === event.messages ? undefined : { messages };
	});
}

/**
 * Parse one persisted probe-identities entry payload. Malformed or foreign
 * records are ignored so a corrupt entry can never suppress genuine messages.
 */
export function parsePersistedIdentities(data: unknown): SyntheticMessageIdentity[] {
	if (typeof data !== "object" || data === null) return [];
	const messages = (data as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return [];
	const identities: SyntheticMessageIdentity[] = [];
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const { role, timestamp } = message as { role?: unknown; timestamp?: unknown };
		if ((role === "user" || role === "assistant") && typeof timestamp === "number" && Number.isFinite(timestamp)) {
			identities.push({ role, timestamp });
		}
	}
	return identities;
}

/** Map key uniquely identifying one probe message by role and timestamp. */
function identityKey(identity: SyntheticMessageIdentity): string {
	return `${identity.role}:${identity.timestamp}`;
}
