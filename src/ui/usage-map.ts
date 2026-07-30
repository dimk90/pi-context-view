/**
 * Pure proportional-cell model for the Usage view's 14×14 context map. The
 * map uses estimated category totals against the selected Window/Fit scale.
 * Pi's separately reported occupied tokens may differ because of tokenizer,
 * serialization, caching, and last-response timing.
 */
import type { ContextUsageSnapshot } from "../model.ts";

export const DEFAULT_MAP_COLUMNS = 14;
export const DEFAULT_MAP_ROWS = 14;

const FIT_SCALE_PERCENT = 115;
const PERCENT_DENOMINATOR = 100;
const MINIMUM_FIT_SCALE_TOKENS = 10_000;
const FIT_SCALE_SIGNIFICANT_DIGITS = 2;

/** One visual map cell assigned to a category, the auto-compact buffer, or remaining free space. */
export interface UsageMapCell {
	readonly categoryId?: string;
	readonly fill: "full" | "partial" | "buffer" | "free";
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
 * Calculate a Fit denominator from estimated occupancy: 15% headroom,
 * rounded upward to two significant digits, with the documented floor/cap.
 */
export function calculateFitMapScale(usage: ContextUsageSnapshot): number | undefined {
	const contextWindow = usage.reported?.contextWindow;
	if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;

	const estimatedTotal = usage.categories.reduce((sum, category) => sum + category.tokens, 0);
	const withHeadroom = Math.max(0, estimatedTotal) * FIT_SCALE_PERCENT / PERCENT_DENOMINATOR;
	const rounded = roundUpToSignificantDigits(withHeadroom, FIT_SCALE_SIGNIFICANT_DIGITS);
	return Math.min(contextWindow, Math.max(MINIMUM_FIT_SCALE_TOKENS, rounded));
}

/**
 * Build a proportional map from estimated categories. `scaleTokens` changes
 * only the mapped denominator; buffer placement remains anchored to the true
 * context window. Returns undefined without a usable denominator.
 */
export function buildUsageMap(
	usage: ContextUsageSnapshot,
	columns = DEFAULT_MAP_COLUMNS,
	rows = DEFAULT_MAP_ROWS,
	scaleTokens?: number,
): UsageMap | undefined {
	const contextWindow = usage.reported?.contextWindow;
	if (
		contextWindow === undefined ||
		!Number.isFinite(contextWindow) ||
		contextWindow <= 0 ||
		columns <= 0 ||
		rows <= 0
	) return undefined;

	const requestedScale = scaleTokens ?? contextWindow;
	if (!Number.isFinite(requestedScale) || requestedScale <= 0) return undefined;
	const mapScale = Math.min(contextWindow, requestedScale);
	const cellCount = Math.floor(columns) * Math.floor(rows);
	const estimatedTotal = usage.categories.reduce((sum, category) => sum + category.tokens, 0);
	const occupiedTokens = clamp(estimatedTotal, 0, mapScale);
	const occupiedCells = occupiedTokens / mapScale * cellCount;
	// Fit reserves its headroom as visible free space; the true-window buffer remains outside the mapped range.
	const windowOccupancy = clamp(estimatedTotal, 0, contextWindow);
	const bufferTokens = mapScale < contextWindow
		? 0
		: clamp(usage.autoCompactReserveTokens ?? 0, 0, contextWindow - windowOccupancy);
	const bufferStart = (contextWindow - bufferTokens) / mapScale * cellCount;
	const segments = createSegments(usage, estimatedTotal, occupiedCells);
	const cells = Array.from(
		{ length: cellCount },
		(_, index) => createCell(index, occupiedCells, bufferStart, segments),
	);
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
function createCell(
	index: number,
	occupiedCells: number,
	bufferStart: number,
	segments: readonly MapSegment[],
): UsageMapCell {
	const occupiedOverlap = overlap(index, index + 1, 0, occupiedCells);
	if (occupiedOverlap <= 0) {
		// An unoccupied cell belongs to the buffer when at least half of it lies past the trigger point.
		return overlap(index, index + 1, bufferStart, index + 1) >= 0.5 ? { fill: "buffer" } : { fill: "free" };
	}

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

/** Round a positive value upward at the requested significant-digit boundary. */
function roundUpToSignificantDigits(value: number, significantDigits: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	const boundary = 10 ** (Math.floor(Math.log10(value)) - significantDigits + 1);
	return Math.ceil(value / boundary) * boundary;
}

/** Restrict a finite value to an inclusive range. */
function clamp(value: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value)) return minimum;
	return Math.min(maximum, Math.max(minimum, value));
}
