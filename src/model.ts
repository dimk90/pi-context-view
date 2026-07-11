/**
 * Semantic data model shared by capture, measurement, and UI. Pure types —
 * no pi access. Hierarchy and provenance live in typed fields; UI code must
 * never parse labels to recover source, kind, or parent/child relationships.
 */

export const PI_SOURCE_ID = "pi";
export const AGGREGATE_SOURCE_ID = "aggregate:extensions";

/** What produced the captured snapshot. */
export type CaptureOrigin = "real-turn" | "synthetic-probe";

/** Which lifecycle phase an injection belongs to. */
export type InjectionPhase = "initial" | "runtime";

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

/**
 * Group measured items by source. Pi-native components come first, extension
 * sources follow by total size, and the unattributable aggregate comes last.
 * Items inside each group follow a fixed semantic order (base prompt, tools,
 * skills, then everything else by size). Returned objects own all nested data;
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

/** Owned copy of an item, including its nested source and children. */
function copyItem(item: InjectionItem): InjectionItem {
	return {
		...item,
		source: { ...item.source },
		children: item.children?.map((child) => copyItem(child)),
	};
}

/**
 * Order items within a group: base/appended prompt first, then built-in tools,
 * other tools, skills, and finally everything else by size descending.
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
		case "append-prompt":
			return 0;
		case "tool":
			return item.id === "tool:builtin" ? 1 : 2;
		case "skills":
			return 3;
		default:
			return 4;
	}
}

/** Order groups: pi-native first, then extensions by size, aggregate last. */
function compareGroups(a: InjectionGroup, b: InjectionGroup): number {
	if (a.source.native !== b.source.native) return a.source.native ? -1 : 1;
	const aAggregate = a.source.id === AGGREGATE_SOURCE_ID;
	const bAggregate = b.source.id === AGGREGATE_SOURCE_ID;
	if (aAggregate !== bAggregate) return aAggregate ? 1 : -1;
	return b.totalTokens - a.totalTokens;
}
