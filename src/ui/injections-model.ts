/**
 * Pure presentation model for the Injections view: flattened rows and
 * list navigation/scrolling state. No pi or TUI access — unit-testable.
 */
import type { InitialSnapshot, InjectionItem } from "../model.ts";

/** What one selectable list row represents. */
export type InjectionRowKind = "group" | "item" | "total";

/** One flattened list row derived from the snapshot hierarchy. */
export interface InjectionRow {
	readonly kind: InjectionRowKind;
	readonly label: string;
	readonly tokens: number;
	/** Indentation level: 0 for groups/total, 1 for items. */
	readonly depth: number;
	/** Snapshot item id; present only for `kind: "item"` (preview target). */
	readonly itemId?: string;
	readonly native: boolean;
}

/** Index snapshot items by id for preview lookup. */
export function collectItemsById(snapshot: InitialSnapshot): Map<string, InjectionItem> {
	const items = new Map<string, InjectionItem>();
	for (const group of snapshot.groups) {
		for (const item of group.items) items.set(item.id, item);
	}
	return items;
}

/** Normalize raw injection text for terminal display without content changes beyond whitespace. */
export function normalizePreviewText(text: string): string {
	return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ");
}

/** Flatten snapshot groups into display rows, ending with a TOTAL row. */
export function buildInjectionRows(snapshot: InitialSnapshot): InjectionRow[] {
	const rows: InjectionRow[] = [];
	for (const group of snapshot.groups) {
		rows.push({
			kind: "group",
			label: group.source.label,
			tokens: group.totalTokens,
			depth: 0,
			native: group.source.native,
		});
		for (const item of group.items) {
			rows.push({
				kind: "item",
				label: item.label,
				tokens: item.tokens,
				depth: 1,
				itemId: item.id,
				native: item.source.native,
			});
		}
	}
	rows.push({ kind: "total", label: "TOTAL", tokens: snapshot.totalTokens, depth: 0, native: true });
	return rows;
}

/**
 * Selection and scroll-window state over a fixed row list. The window always
 * contains the selected row and never extends past either end.
 */
export class ListNavigator {
	private readonly rowCount: number;
	private visibleCount: number;
	private selectedIndex = 0;
	private scrollOffset = 0;

	public constructor(rowCount: number, visibleCount: number) {
		this.rowCount = Math.max(0, rowCount);
		this.visibleCount = Math.max(1, visibleCount);
	}

	public get selected(): number {
		return this.selectedIndex;
	}

	public get offset(): number {
		return this.scrollOffset;
	}

	public get windowSize(): number {
		return Math.min(this.visibleCount, this.rowCount);
	}

	public get hasOverflow(): boolean {
		return this.rowCount > this.visibleCount;
	}

	public setVisibleCount(count: number): void {
		this.visibleCount = Math.max(1, count);
		this.ensureVisible();
	}

	public moveBy(delta: number): boolean {
		return this.moveTo(this.selectedIndex + delta);
	}

	public moveTo(index: number): boolean {
		if (this.rowCount === 0) return false;
		const next = Math.min(this.rowCount - 1, Math.max(0, index));
		if (next === this.selectedIndex) return false;
		this.selectedIndex = next;
		this.ensureVisible();
		return true;
	}

	public page(direction: -1 | 1): boolean {
		return this.moveBy(direction * Math.max(1, this.visibleCount - 1));
	}

	private ensureVisible(): void {
		const maxOffset = Math.max(0, this.rowCount - this.visibleCount);
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + this.visibleCount) {
			this.scrollOffset = this.selectedIndex - this.visibleCount + 1;
		}
		this.scrollOffset = Math.min(maxOffset, Math.max(0, this.scrollOffset));
	}
}

/**
 * Scroll-only window over wrapped preview lines. Extent is re-declared each
 * render (wrapping depends on width); the offset is clamped to stay valid.
 */
export class PreviewScroller {
	private lineCount = 0;
	private visibleCount = 1;
	private offsetValue = 0;

	public get offset(): number {
		return this.offsetValue;
	}

	public get windowSize(): number {
		return Math.min(this.visibleCount, this.lineCount);
	}

	public get hasOverflow(): boolean {
		return this.lineCount > this.visibleCount;
	}

	public get maxOffset(): number {
		return Math.max(0, this.lineCount - this.visibleCount);
	}

	public setExtent(lineCount: number, visibleCount: number): void {
		this.lineCount = Math.max(0, lineCount);
		this.visibleCount = Math.max(1, visibleCount);
		this.offsetValue = Math.min(this.maxOffset, this.offsetValue);
	}

	public scrollBy(delta: number): boolean {
		return this.scrollTo(this.offsetValue + delta);
	}

	public scrollTo(offset: number): boolean {
		const next = Math.min(this.maxOffset, Math.max(0, offset));
		if (next === this.offsetValue) return false;
		this.offsetValue = next;
		return true;
	}

	public page(direction: -1 | 1): boolean {
		return this.scrollBy(direction * Math.max(1, this.visibleCount - 1));
	}

	public reset(): void {
		this.offsetValue = 0;
	}
}
