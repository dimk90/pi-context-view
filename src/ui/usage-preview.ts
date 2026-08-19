/**
 * Pure block model for the Usage category preview: geometry of the flattened
 * line stream plus the selection, paging, and in-block scrolling state shared
 * by every preview width. No pi or TUI access — unit-testable.
 */

/** Absolute line span of one block inside the flattened preview stream. */
export interface PreviewBlockExtent {
	readonly start: number;
	readonly height: number;
}

/** Owner of one flattened preview line; blank separator rows have none. */
export interface PreviewLineRef {
	readonly blockIndex: number;
	readonly lineIndex: number;
}

/** Flattened preview stream: block spans plus per-line ownership. */
export interface PreviewLayout {
	readonly extents: readonly PreviewBlockExtent[];
	readonly lines: ReadonlyArray<PreviewLineRef | undefined>;
}

/** Stack block heights into one line stream separated by a blank row. */
export function layoutPreviewBlocks(heights: readonly number[]): PreviewLayout {
	const extents: PreviewBlockExtent[] = [];
	const lines: Array<PreviewLineRef | undefined> = [];
	for (const [blockIndex, height] of heights.entries()) {
		if (blockIndex > 0) lines.push(undefined);
		extents.push({ start: lines.length, height });
		for (let lineIndex = 0; lineIndex < height; lineIndex++) lines.push({ blockIndex, lineIndex });
	}
	return { extents, lines };
}

/**
 * Selection and scroll state over stacked preview blocks. Steps move block to
 * block, except that a block taller than the viewport scrolls line by line
 * until its far edge is reached. Extent is re-declared each render because
 * wrapping and terminal height both change it.
 */
export class BlockNavigator {
	private extents: readonly PreviewBlockExtent[] = [];
	private lineCount = 0;
	private visibleCount = 1;
	private selectedIndex = 0;
	private offsetValue = 0;

	/** Index of the selected block. */
	public get selected(): number {
		return this.selectedIndex;
	}

	/** Number of navigable blocks in the current stream. */
	public get blockCount(): number {
		return this.extents.length;
	}

	/** First stream line currently visible. */
	public get offset(): number {
		return this.offsetValue;
	}

	/** Highest offset that still fills the viewport. */
	public get maxOffset(): number {
		return Math.max(0, this.lineCount - this.visibleCount);
	}

	/** Adopt new geometry, keeping the scroll position unless it hides the selected block. */
	public setExtent(layout: PreviewLayout, visibleCount: number): void {
		this.extents = layout.extents;
		this.lineCount = layout.lines.length;
		this.visibleCount = Math.max(1, visibleCount);
		this.selectedIndex = clamp(this.selectedIndex, this.extents.length - 1);
		this.offsetValue = clamp(this.offsetValue, this.maxOffset);
		if (!this.isSelectionAnchored()) this.revealSelected();
	}

	/** Step back one block, or one line while the selected block extends above the viewport. */
	public stepBack(): boolean {
		const block = this.extents[this.selectedIndex];
		if (block === undefined) return false;
		if (block.start < this.offsetValue) return this.scrollTo(this.offsetValue - 1);
		return this.selectBlock(this.selectedIndex - 1, -1);
	}

	/** Step forward one block, or one line while the selected block extends below the viewport. */
	public stepForward(): boolean {
		const block = this.extents[this.selectedIndex];
		if (block === undefined) return false;
		if (block.start + block.height > this.offsetValue + this.visibleCount) {
			return this.scrollTo(this.offsetValue + 1);
		}
		return this.selectBlock(this.selectedIndex + 1, 1);
	}

	/** Page by the viewport height, then finish at the stream boundary from its first or last page. */
	public page(direction: -1 | 1): boolean {
		if (this.extents.length === 0) return false;
		const offset = clamp(this.offsetValue + direction * this.visibleCount, this.maxOffset);
		if (offset === this.offsetValue) {
			const boundaryIndex = direction < 0 ? 0 : this.extents.length - 1;
			return this.moveTo(boundaryIndex, offset);
		}
		return this.moveTo(this.firstVisibleBlock(offset), offset);
	}

	/** Select the first block at the top of the stream. */
	public moveToFirst(): boolean {
		return this.moveTo(0, 0);
	}

	/** Select the last block at the end of the stream. */
	public moveToLast(): boolean {
		return this.moveTo(this.extents.length - 1, this.maxOffset);
	}

	/** Start over at the first block after the preview target changes. */
	public reset(): void {
		this.selectedIndex = 0;
		this.offsetValue = 0;
	}

	/** Move selection to an existing block and reveal the edge reached in the navigation direction. */
	private selectBlock(index: number, direction: -1 | 1): boolean {
		if (index < 0 || index >= this.extents.length || index === this.selectedIndex) return false;
		this.selectedIndex = index;
		this.revealSelected(direction);
		return true;
	}

	/** Scroll the stream to a clamped offset. */
	private scrollTo(offset: number): boolean {
		const next = clamp(offset, this.maxOffset);
		if (next === this.offsetValue) return false;
		this.offsetValue = next;
		return true;
	}

	/** Apply a selection and offset pair, reporting whether either changed. */
	private moveTo(index: number, offset: number): boolean {
		const nextIndex = clamp(index, this.extents.length - 1);
		const nextOffset = clamp(offset, this.maxOffset);
		if (nextIndex === this.selectedIndex && nextOffset === this.offsetValue) return false;
		this.selectedIndex = nextIndex;
		this.offsetValue = nextOffset;
		return true;
	}

	/** Whether the selected block is fully shown, or intersects the viewport when too tall to fit. */
	private isSelectionAnchored(): boolean {
		const block = this.extents[this.selectedIndex];
		if (block === undefined) return true;
		const end = block.start + block.height;
		if (block.height <= this.visibleCount) {
			return block.start >= this.offsetValue && end <= this.offsetValue + this.visibleCount;
		}
		return block.start < this.offsetValue + this.visibleCount && end > this.offsetValue;
	}

	/** Scroll minimally to show the selected block; oversized blocks expose the approached edge. */
	private revealSelected(direction?: -1 | 1): void {
		const block = this.extents[this.selectedIndex];
		if (block === undefined) return;
		const end = block.start + block.height;
		if (block.height > this.visibleCount) {
			if (direction === -1) this.scrollTo(end - this.visibleCount);
			else if (direction === 1 || !this.isSelectionAnchored()) this.scrollTo(block.start);
			return;
		}
		if (block.start < this.offsetValue) this.scrollTo(block.start);
		else if (end > this.offsetValue + this.visibleCount) this.scrollTo(end - this.visibleCount);
	}

	/** First block fully inside the viewport, falling back to the first one it intersects. */
	private firstVisibleBlock(offset: number): number {
		const end = offset + this.visibleCount;
		let firstIntersecting: number | undefined;
		for (const [index, block] of this.extents.entries()) {
			const blockEnd = block.start + block.height;
			if (block.start >= offset && blockEnd <= end) return index;
			if (firstIntersecting === undefined && block.start < end && blockEnd > offset) {
				firstIntersecting = index;
			}
		}
		return firstIntersecting ?? this.selectedIndex;
	}
}

/** Restrict a candidate index or offset to a non-negative range. */
function clamp(value: number, max: number): number {
	return Math.max(0, Math.min(max, value));
}
