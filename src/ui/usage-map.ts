/**
 * Pure proportional-cell model for the Usage view's 14×14 context map. The
 * map uses estimated category totals against pi's context-window size. Pi's
 * separately reported occupied tokens may differ because of tokenizer,
 * serialization, caching, and last-response timing.
 */
import type { ContextUsageSnapshot } from "../model.ts";

export const DEFAULT_MAP_COLUMNS = 14;
export const DEFAULT_MAP_ROWS = 14;

/** One visual map cell assigned to a category or remaining free space. */
export interface UsageMapCell {
	readonly categoryId?: string;
	readonly fill: "full" | "partial" | "free";
}

/** Rectangular context-usage map in row-major order. */
export interface UsageMap {
	readonly columns: number;
	readonly rows: number;
	readonly cells: readonly UsageMapCell[];
}

interface MapSegment {
	readonly categoryId: string;
	readonly start: number;
	readonly end: number;
}

/**
 * Build a proportional map from estimated categories. Returns undefined
 * without a usable context-window denominator.
 */
export function buildUsageMap(
	usage: ContextUsageSnapshot,
	columns = DEFAULT_MAP_COLUMNS,
	rows = DEFAULT_MAP_ROWS,
): UsageMap | undefined {
	const contextWindow = usage.reported?.contextWindow;
	if (contextWindow === undefined || contextWindow <= 0 || columns <= 0 || rows <= 0) return undefined;

	const cellCount = Math.floor(columns) * Math.floor(rows);
	const estimatedTotal = usage.categories.reduce((sum, category) => sum + category.tokens, 0);
	const occupiedCells = clamp(estimatedTotal, 0, contextWindow) / contextWindow * cellCount;
	const segments = createSegments(usage, estimatedTotal, occupiedCells);
	const cells = Array.from({ length: cellCount }, (_, index) => createCell(index, occupiedCells, segments));
	return { columns: Math.floor(columns), rows: Math.floor(rows), cells };
}

/** Scale estimated category shares into the occupied map range. */
function createSegments(
	usage: ContextUsageSnapshot,
	estimatedTotal: number,
	occupiedCells: number,
): MapSegment[] {
	if (estimatedTotal <= 0 || occupiedCells <= 0) return [];
	const segments: MapSegment[] = [];
	let cursor = 0;
	for (const category of usage.categories) {
		const size = category.tokens / estimatedTotal * occupiedCells;
		segments.push({ categoryId: category.id, start: cursor, end: cursor + size });
		cursor += size;
	}
	return segments;
}

/** Assign one map cell to its largest category overlap and classify its fill. */
function createCell(index: number, occupiedCells: number, segments: readonly MapSegment[]): UsageMapCell {
	const occupiedOverlap = overlap(index, index + 1, 0, occupiedCells);
	if (occupiedOverlap <= 0) return { fill: "free" };

	let categoryId: string | undefined;
	let categoryOverlap = 0;
	for (const segment of segments) {
		const currentOverlap = overlap(index, index + 1, segment.start, segment.end);
		if (currentOverlap > categoryOverlap) {
			categoryId = segment.categoryId;
			categoryOverlap = currentOverlap;
		}
	}
	return {
		categoryId,
		fill: categoryOverlap >= 0.7 ? "full" : "partial",
	};
}

/** Length shared by two half-open numeric ranges. */
function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
	return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Restrict a finite value to an inclusive range. */
function clamp(value: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value)) return minimum;
	return Math.min(maximum, Math.max(minimum, value));
}
