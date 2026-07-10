/**
 * Pure presentation model for the Injections view: flattened rows and
 * list navigation/scrolling state. No pi or TUI access — unit-testable.
 */
import type { InitialSnapshot } from "../model.ts";

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
