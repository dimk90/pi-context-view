/**
 * Model identity for Pi's cross-model replay: since Pi 1.3.0, a request drops
 * the thinking of assistant messages from another provider, API, or model.
 * Usage and the payload guard share this check. No pi API access.
 */
import type { RequestMessage } from "./snapshot.ts";

/** Pi's API of virtual models; its discriminator is not exported from the package root. */
const VIRTUAL_MODEL_API = "pi-virtual";

/** The fields that decide whether Pi replays an assistant message's thinking. */
export interface ModelIdentity {
	readonly provider: string;
	readonly api: string;
	readonly id: string;
}

/** The identity fields an assistant message records. */
export interface AssistantIdentity {
	readonly provider: string;
	readonly api: string;
	readonly model: string;
}

/** Whether an assistant message came from `model`, as Pi's message transform decides. */
export function isSameModel(message: AssistantIdentity, model: ModelIdentity): boolean {
	return message.provider === model.provider && message.api === model.api && message.model === model.id;
}

/**
 * The model the next request is expected to use. A physical selection is used
 * as is. A virtual selection resolves to the model of the latest reply that is
 * not an error or aborted, as Pi's routed-model lookup does; without one, or
 * without a selection, the result is undefined.
 */
export function resolveNextRequestModel(
	selected: ModelIdentity | undefined,
	messages: readonly RequestMessage[],
): ModelIdentity | undefined {
	if (selected === undefined) return undefined;
	if (selected.api !== VIRTUAL_MODEL_API) {
		return { provider: selected.provider, api: selected.api, id: selected.id };
	}
	const latest = messages.findLast((message) => message.role === "assistant"
		&& message.stopReason !== "error" && message.stopReason !== "aborted");
	if (latest?.role !== "assistant") return undefined;
	return { provider: latest.provider, api: latest.api, id: latest.model };
}
