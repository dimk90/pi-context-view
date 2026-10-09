/**
 * Semantic data model shared by capture, measurement, and UI. Pure types —
 * no pi access. Hierarchy and provenance live in typed fields; UI code must
 * never parse labels to recover source, kind, or parent/child relationships.
 */

import type { CaptureOrigin, LateEditLine } from "./snapshot.ts";

export const PI_SOURCE_ID = "pi";
export const AGGREGATE_SOURCE_ID = "aggregate:extensions";
export const LATE_EDITS_SOURCE_ID = "late-edits";

/** Everything pi itself assembles: its prompt, context files, skills, and built-in tools. */
export const PI_SOURCE: InjectionSource = { id: PI_SOURCE_ID, label: "pi", native: true };

/** Contributions no available signal attributes to one extension. */
export const AGGREGATE_SOURCE: InjectionSource = {
	id: AGGREGATE_SOURCE_ID,
	label: "unattributed",
	native: false,
};

/**
 * Payload differences the structured capture cannot explain: no structure and
 * no source, so they are grouped instead of staying in place.
 */
export const LATE_EDITS_SOURCE: InjectionSource = {
	id: LATE_EDITS_SOURCE_ID,
	label: "late edits",
	native: false,
};

/** Pi source kinds whose extensions are loose files, identified only by their path. */
const PATH_SOURCE_KINDS: ReadonlySet<string> = new Set(["auto", "local", "cli"]);

/** Provenance Pi reports for an extension's tool or command: its source kind and entry path. */
export interface ExtensionProvenance {
	/** Source kind, e.g. `npm:pi-web-providers`, `cli`, or `local`. */
	readonly source: string;
	readonly path?: string;
}

/**
 * Injection source for one non-builtin extension. A package source such as
 * `npm:pi-web-providers` names itself. Every path extension (`auto`, `local`,
 * `cli`) gets its own source, labelled like Pi's startup list: the shortest
 * path tail no other path extension in `roster` ends with, without a trailing
 * `index.ts` or `index.js`.
 */
export function extensionSource(
	provenance: ExtensionProvenance,
	roster: readonly ExtensionProvenance[] = [],
): InjectionSource {
	const { source, path } = provenance;
	if (!PATH_SOURCE_KINDS.has(source) || path === undefined) {
		return { id: `tool-source:${source}`, label: source, native: false };
	}
	const others = roster
		.filter((entry) => PATH_SOURCE_KINDS.has(entry.source) && entry.path !== undefined && entry.path !== path)
		.map((entry) => pathSegments(entry.path ?? ""));
	return { id: `tool-source:${source}:${path}`, label: compactPathLabel(pathSegments(path), others), native: false };
}

/** Shortest tail of `segments` that no other path ends with; the whole path when none is unique. */
function compactPathLabel(segments: readonly string[], others: readonly string[][]): string {
	for (let count = 1; count <= segments.length; count++) {
		const tail = segments.slice(-count).join("/");
		if (others.every((other) => other.slice(-count).join("/") !== tail)) return tail;
	}
	return segments.join("/");
}

/** Path segments, without a trailing `index.ts` or `index.js` that names no extension. */
function pathSegments(path: string): string[] {
	const segments = path.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0);
	const last = segments.at(-1);
	if (segments.length > 1 && (last === "index.ts" || last === "index.js")) segments.pop();
	return segments;
}

/** Source of a custom-role message: its customType, since the actual injector is unknowable. */
export function messageTypeSource(customType: string): InjectionSource {
	return { id: `message-type:${customType}`, label: customType, native: false };
}

/** Shared name of pi's own prompt; Usage and Injections must present it identically. */
export const SYSTEM_PROMPT_LABEL = "System Prompt";

/** Shared name of pi's context files; Usage and Injections must present it identically. */
export const INSTRUCTION_FILES_LABEL = "Instruction Files";

/** Shared name of pi's skill records; Usage and Injections must present it identically. */
export const SKILLS_LABEL = "Skills";

/** Shared name of pi's built-in tools; Usage and Injections must present it identically. */
export const BUILT_IN_TOOLS_LABEL = "Built-in Tools";

/**
 * How a request-only change touched a contribution, relative to the session:
 *   added      only the request has it; counted
 *   modified   the request version differs from the session; the request version is counted
 *   deleted    the request removed it; reads 0 tokens, text is the session original
 *   forced     the request carried an extension's forced system prompt instead of pi's; counted
 *   hidden     the request kept a tool active but did not declare it to the model; reads 0 tokens
 */
export type RequestChange = "added" | "modified" | "deleted" | "forced" | "hidden";

/** The frozen lifecycle phase represented by the v0.2.0 injection model. */
export type InjectionPhase = "initial";

/** What kind of context data an injection item is. */
export type InjectionKind =
	| "base-prompt"
	| "append-prompt"
	| "context-file"
	| "skills"
	| "tool"
	| "prompt-addition"
	| "message";

/** Who contributed one or more injection items. */
export interface InjectionSource {
	/** Stable internal id, namespaced by source kind. */
	readonly id: string;
	/** Human-readable group label. */
	readonly label: string;
	/** True for pi-native components. */
	readonly native: boolean;
}

/** Half-open `[start, end)` character range within captured text. */
export interface TextSpan {
	readonly start: number;
	readonly end: number;
}

/**
 * Character range of a JSON document embedded in preview text, known from how
 * the text was built rather than from inspecting it. Full-content previews
 * expand the run; the compact provider-bound form still backs every estimate.
 */
export interface JsonSpan {
	readonly start: number;
	readonly end: number;
}

/** A rendered prompt line counted by its owning tool, inserted only for prompt previews. */
export interface InjectedReference {
	/** Insertion offset in the containing item's or section's counted text, in prompt order. */
	readonly offset: number;
	/** Captured line including its leading line break; never additional counted text. */
	readonly text: string;
	/** Stable id of the item that counts this text. */
	readonly itemId: string;
	readonly source: InjectionSource;
	/**
	 * Tool or slash command of `source` this text belongs to, e.g. `web_search`
	 * or `/ask`. Qualifies the rendered source label only: `itemId` still names
	 * the item that counts the text.
	 */
	readonly tool?: string;
	/**
	 * Present when the source was inferred from the text itself. Pi reports no
	 * per-extension provenance for chained prompt edits, so such an attribution
	 * is a guess and must be rendered as one.
	 */
	readonly attribution?: "guess";
}

/** One labeled part of an item's raw text, used only to shape its preview. */
export interface InjectionSection {
	/** Section name rendered as a preview subheader. */
	readonly label: string;
	/** Slice of the parent item's text; sections concatenate back to it, except when dropped. */
	readonly text: string;
	/** Share of the parent estimate; sections sum exactly to the item total. */
	readonly tokens: number;
	/**
	 * True when a `--system-prompt` replacement suppressed this part: pi never
	 * sent its text, so it carries no counted characters and always reads 0 tokens.
	 */
	readonly dropped?: boolean;
	/**
	 * True when an extension moved this part out of the region pi renders it
	 * into. Pi still sends the text, so it counts exactly as an unmoved part.
	 */
	readonly moved?: boolean;
	/** Request-only change of this part; a deleted part carries no counted characters. */
	readonly change?: RequestChange;
	/** Serialized JSON inside `text`, e.g. a tool's parameter schema. */
	readonly jsonSpan?: JsonSpan;
	/** Preview-only extension prompt lines; their owning tools count them instead. */
	readonly injectedReferences?: readonly InjectedReference[];
}

/** One measured context injection. */
export interface InjectionItem {
	/** Stable id, unique within a snapshot. */
	readonly id: string;
	readonly phase: InjectionPhase;
	readonly kind: InjectionKind;
	readonly source: InjectionSource;
	/** Human-readable item label without embedded hierarchy or source. */
	readonly label: string;
	readonly chars: number;
	/** Estimated tokens (chars/4 heuristic unless measured as a message). */
	readonly tokens: number;
	/** Raw injected text for preview. Process-local; never log or persist. */
	readonly text: string;
	/** Serialized JSON inside `text`, e.g. non-string message content. */
	readonly jsonSpan?: JsonSpan;
	/** Labeled parts of `text`, e.g. a tool's prompt lines and definition; never extra tokens. */
	readonly sections?: readonly InjectionSection[];
	/** True when a `--system-prompt` replacement suppressed this item; it reads 0 tokens. */
	readonly dropped?: boolean;
	/** True when an extension moved this part out of the region pi renders it into. */
	readonly moved?: boolean;
	/** Request-only change of this contribution; a deleted or hidden one reads 0 tokens. */
	readonly change?: RequestChange;
	/**
	 * Changed lines of a late edit, in payload order. `text` holds only the
	 * added lines, which the estimate counts.
	 */
	readonly changedLines?: readonly LateEditLine[];
	/** Preview-only extension prompt lines for a standalone System Prompt part child. */
	readonly injectedReferences?: readonly InjectedReference[];
	/** Constituent sub-items (e.g. individual built-in tools or skills), largest first. */
	readonly children?: readonly InjectionItem[];
}

/** Items of one source, with a precomputed total. */
export interface InjectionGroup {
	readonly source: InjectionSource;
	readonly items: readonly InjectionItem[];
	readonly totalTokens: number;
}

/** The frozen Initial snapshot presented by the Injections view. */
export interface InitialSnapshot {
	readonly origin: CaptureOrigin;
	readonly capturedAt: Date;
	readonly groups: readonly InjectionGroup[];
	readonly totalTokens: number;
}

/** How an invisible reasoning-token estimate was derived without retaining raw signature bytes. */
export interface InvisibleReasoningEstimate {
	/** Invisible-token estimate; signature-size proxies are not added to category totals. */
	readonly tokens: number;
	/** Whether the estimate came from a provider usage breakdown or opaque signature length. */
	readonly basis: "provider-reported" | "signature-proxy";
	/** Whether the message carries an opaque replay signature. */
	readonly encoded: boolean;
}

/** One estimated usage category, optionally with a constituent breakdown. */
export interface UsageCategory {
	/** Stable id, unique within a usage snapshot level. */
	readonly id: string;
	readonly label: string;
	/** Estimated tokens (chars/4 heuristic unless provider-reported reasoning is available). */
	readonly tokens: number;
	/** Breakdown of the parent (e.g. per tool or per customType), not additional totals. */
	readonly children?: readonly UsageCategory[];
	/** Content entries backing the category preview; leaves only. */
	readonly entries?: readonly UsagePreviewEntry[];
}

/** One content entry shown in a Usage category preview. */
export interface UsagePreviewEntry {
	/** Message time (epoch ms); absent for Initial-snapshot components. */
	readonly timestamp?: number;
	/** Bracket header cells, e.g. ["assistant", "read"] or ["code-style"]. */
	readonly breadcrumb: readonly string[];
	/** Tokens this entry contributes to its category, including any counted invisible reasoning. */
	readonly tokens: number;
	/** Visible-text share shown before invisible reasoning metadata. */
	readonly visibleTokens?: number;
	/** Message-level invisible reasoning metadata, attached once without retaining raw signature bytes. */
	readonly invisibleReasoning?: InvisibleReasoningEstimate;
	/** Raw content for preview. Process-local; never log or persist. */
	readonly text: string;
	/** Serialized JSON inside `text`, e.g. tool-call arguments. */
	readonly jsonSpan?: JsonSpan;
	/** Labeled parts of `text`, carried from the measured item; never extra tokens. */
	readonly sections?: readonly InjectionSection[];
	/** Request-only change of the measured item; Usage measures only `forced`. */
	readonly change?: RequestChange;
}

/** Pi-reported usage; tokens/percent are omitted when unknown (e.g. right after compaction). */
export interface ReportedContextUsage {
	readonly tokens?: number;
	readonly contextWindow: number;
	readonly percent?: number;
}

/** On-demand estimated context composition presented by the Usage view. */
export interface ContextUsageSnapshot {
	readonly computedAt: Date;
	readonly modelLabel?: string;
	readonly reported?: ReportedContextUsage;
	readonly categories: readonly UsageCategory[];
	/** Sum of the top-level category estimates. */
	readonly estimatedTokens: number;
	/** Auto-compaction reserve (settings `reserveTokens`); absent when auto-compaction is disabled. */
	readonly autoCompactReserveTokens?: number;
}

/**
 * Group measured items by source. Pi-native components come first, extension
 * sources follow by total size, then the unattributable aggregate, and late
 * edits come last.
 * Items inside each group follow the order pi assembles them into a request
 * (base prompt, appended prompt, context files, skills, built-in tools, other
 * tools, then everything else by size). Returned objects own all nested data;
 * later mutation of the input cannot change the groups.
 */
export function groupInjections(items: readonly InjectionItem[]): InjectionGroup[] {
	const groups = new Map<string, MutableGroup>();
	for (const input of items) {
		const item = copyItem(input);
		let group = groups.get(item.source.id);
		if (group === undefined) {
			group = { source: item.source, items: [], totalTokens: 0 };
			groups.set(item.source.id, group);
		}
		group.items.push(item);
		group.totalTokens += item.tokens;
	}
	for (const group of groups.values()) {
		group.items.sort(compareItems);
	}
	return [...groups.values()].sort(compareGroups);
}

/** Build an owned Initial snapshot from measured items. */
export function buildSnapshot(
	items: readonly InjectionItem[],
	origin: CaptureOrigin,
	capturedAt: Date,
): InitialSnapshot {
	const groups = groupInjections(items);
	return {
		origin,
		capturedAt: new Date(capturedAt),
		groups,
		totalTokens: groups.reduce((sum, group) => sum + group.totalTokens, 0),
	};
}

/** Internal accumulator for groupInjections before freezing into InjectionGroup. */
interface MutableGroup {
	source: InjectionSource;
	items: InjectionItem[];
	totalTokens: number;
}

/** Owned copy of an item, including its nested source, spans, and children. */
function copyItem(item: InjectionItem): InjectionItem {
	return {
		...item,
		source: { ...item.source },
		jsonSpan: copyJsonSpan(item.jsonSpan),
		injectedReferences: copyInjectedReferences(item.injectedReferences),
		changedLines: item.changedLines?.map((line) => ({ ...line })),
		sections: item.sections?.map((section) => ({
			...section,
			jsonSpan: copyJsonSpan(section.jsonSpan),
			injectedReferences: copyInjectedReferences(section.injectedReferences),
		})),
		children: item.children?.map((child) => copyItem(child)),
	};
}

/** Own reference records and their nested provenance without adding their text to totals. */
function copyInjectedReferences(
	references: readonly InjectedReference[] | undefined,
): InjectedReference[] | undefined {
	return references?.map((reference) => ({ ...reference, source: { ...reference.source } }));
}

/** Owned copy of an optional span. */
function copyJsonSpan(span: JsonSpan | undefined): JsonSpan | undefined {
	return span === undefined ? undefined : { ...span };
}

/**
 * Order items within a group by the order pi assembles them into a request:
 * base prompt, appended prompt, context files, skills, built-in tools, other
 * tools, and finally everything else by size descending.
 */
function compareItems(a: InjectionItem, b: InjectionItem): number {
	const rankDelta = itemRank(a) - itemRank(b);
	if (rankDelta !== 0) return rankDelta;
	return b.tokens - a.tokens;
}

/** Fixed display rank by kind; built-in tools precede other tools. */
function itemRank(item: InjectionItem): number {
	switch (item.kind) {
		case "base-prompt":
			return 0;
		case "append-prompt":
			return 1;
		case "context-file":
			return 2;
		case "skills":
			return 3;
		case "tool":
			return item.id === "tool:builtin" ? 4 : 5;
		default:
			return 6;
	}
}

/** Order groups: pi-native first, then extensions by size, the aggregate, and late edits last. */
function compareGroups(a: InjectionGroup, b: InjectionGroup): number {
	const rankDelta = groupRank(a.source) - groupRank(b.source);
	if (rankDelta !== 0) return rankDelta;
	return b.totalTokens - a.totalTokens;
}

/** Fixed display rank by source kind; extension sources share one rank. */
function groupRank(source: InjectionSource): number {
	if (source.native) return 0;
	if (source.id === AGGREGATE_SOURCE_ID) return 2;
	return source.id === LATE_EDITS_SOURCE_ID ? 3 : 1;
}
