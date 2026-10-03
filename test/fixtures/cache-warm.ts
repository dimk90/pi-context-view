/**
 * Verification fixture: a `cache_warming_decision` handler that always asks
 * for an idle cache refresh. Pair it with the `"cacheWarming": "idle"` setting
 * and a model `"promptCache": { "short": 12 }`, which schedules the refresh
 * about two seconds after a request.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Override Pi's economic decision with `warm`. */
export default function (pi: ExtensionAPI): void {
	pi.on("cache_warming_decision", () => ({ action: "warm" }));
}
