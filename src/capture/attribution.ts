/**
 * Attributor: best-effort sources for conversation changes (D6). Pi exposes
 * no per-handler observation, so only a custom message's own fields can name
 * a source; every other change stays unattributed.
 */
import type { ChangeAttribution, RequestMessage } from "../snapshot.ts";

/**
 * Attribution of one message: its `customType` and any cooperative
 * `details.source` provenance. Only custom messages carry either; tool-result
 * `details` belong to the tool and never name an extension.
 */
export function attributeMessage(message: RequestMessage): ChangeAttribution {
	if (message.role !== "custom") return {};
	const provenance = readProvenance(message.details);
	return provenance === undefined ? { customType: message.customType } : { customType: message.customType, provenance };
}

/** `{ source, reason }` from `details` when `source` is a non-empty string; other shapes are ignored. */
function readProvenance(details: unknown): ChangeAttribution["provenance"] {
	if (typeof details !== "object" || details === null) return undefined;
	const { source, reason } = details as { source?: unknown; reason?: unknown };
	if (typeof source !== "string" || source.length === 0) return undefined;
	return typeof reason === "string" ? { source, reason } : { source };
}
