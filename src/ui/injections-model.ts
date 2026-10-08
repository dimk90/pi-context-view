/**
 * Pure presentation model for the Injections view: flattened rows and
 * list navigation/scrolling state. No pi or TUI access — unit-testable.
 */
import type { InitialSnapshot, InjectionGroup, InjectionItem } from "../model.ts";

/** What a list filter compares the query against. */
export type InjectionFilterMode = "name" | "content";

/** A non-blank list filter; the view owns how text is normalized and compared. */
export interface InjectionFilter {
	readonly mode: InjectionFilterMode;
	/** Whether a group or item label contains the query. */
	readonly nameMatches: (label: string) => boolean;
	/** Whether an item's content contains the query. */
	readonly contentMatches: (item: InjectionItem) => boolean;
}

/** Snapshot pruned to a filter, plus which groups and items matched themselves. */
export interface FilteredInjections {
	readonly snapshot: InitialSnapshot;
	/** Item ids and `source:<id>` group keys of rows that matched directly, not as context. */
	readonly matched: ReadonlySet<string>;
}

/** One flattened list row derived from the snapshot hierarchy. */
export type InjectionRow =
	| {
		readonly kind: "group";
		readonly label: string;
		readonly tokens: number;
		readonly depth: 0;
		/** Whether an active filter matched this row itself rather than keeping it as context. */
		readonly matched?: boolean;
	}
	| {
		readonly kind: "item";
		readonly label: string;
		readonly tokens: number;
		/** One for items and two for constituent sub-items. */
		readonly depth: 1 | 2;
		/** Whether this row is the final sibling at its depth. */
		readonly isLast: boolean;
		/** Whether a depth-two row's parent has a following sibling. */
		readonly parentContinues?: boolean;
		/** Whether a `--system-prompt` replacement dropped this contribution. */
		readonly dropped?: boolean;
		/** Whether an extension moved this part out of the region pi renders it into. */
		readonly moved?: boolean;
		/** Stable preview target id from the snapshot. */
		readonly itemId: string;
		/** Whether an active filter matched this row itself rather than keeping it as context. */
		readonly matched?: boolean;
	}
	| {
		readonly kind: "separator";
		readonly label: "";
		readonly tokens: 0;
		readonly depth: 0;
	}
	| {
		readonly kind: "total";
		readonly label: "TOTAL";
		readonly tokens: number;
		readonly depth: 0;
	};

/** Index snapshot items (including sub-items) by id for preview lookup. */
export function collectItemsById(snapshot: InitialSnapshot): Map<string, InjectionItem> {
	const items = new Map<string, InjectionItem>();
	for (const group of snapshot.groups) {
		for (const item of group.items) {
			items.set(item.id, item);
			for (const child of item.children ?? []) items.set(child.id, child);
		}
	}
	return items;
}

/**
 * Prune the snapshot to rows the filter matches, keeping each match's
 * ancestors as context. In name mode a matching group or item keeps its whole
 * subtree, since naming a container asks for its contents. In content mode an
 * item with children matches through them: its own text concatenates theirs,
 * so it stands alone only when no child matches. Estimates stay unchanged.
 */
export function filterInjections(snapshot: InitialSnapshot, filter: InjectionFilter): FilteredInjections {
	const matched = new Set<string>();
	const matches = (item: InjectionItem): boolean => filter.mode === "name"
		? filter.nameMatches(item.label)
		: filter.contentMatches(item);
	const groups: InjectionGroup[] = [];
	for (const group of snapshot.groups) {
		if (filter.mode === "name" && filter.nameMatches(group.source.label)) {
			matched.add(groupKey(group));
			for (const item of group.items) filterItem(item, "name", matches, matched);
			groups.push(group);
			continue;
		}
		const items: InjectionItem[] = [];
		for (const item of group.items) {
			const kept = filterItem(item, filter.mode, matches, matched);
			if (kept !== undefined) items.push(kept);
		}
		if (items.length > 0) groups.push({ ...group, items });
	}
	return { snapshot: { ...snapshot, groups }, matched };
}

/** One item pruned to its matching children, or undefined when nothing in it matches. */
function filterItem(
	item: InjectionItem,
	mode: InjectionFilterMode,
	matches: (item: InjectionItem) => boolean,
	matched: Set<string>,
): InjectionItem | undefined {
	const children = item.children ?? [];
	const keptChildren = children.filter(matches);
	if (mode === "name" && matches(item)) {
		for (const id of [item.id, ...keptChildren.map((child) => child.id)]) matched.add(id);
		return item;
	}
	for (const child of keptChildren) matched.add(child.id);
	if (keptChildren.length > 0) return { ...item, children: keptChildren };
	if (mode === "content" && matches(item)) {
		matched.add(item.id);
		return { ...item, children: undefined };
	}
	return undefined;
}

/** Match key of a group row, kept apart from item ids. */
function groupKey(group: InjectionGroup): string {
	return `source:${group.source.id}`;
}

/**
 * Flatten snapshot groups into rows separated from the non-selectable Initial
 * total, flagging the rows a filter matched directly.
 */
export function buildInjectionRows(snapshot: InitialSnapshot, matched?: ReadonlySet<string>): InjectionRow[] {
	const rows: InjectionRow[] = [];
	for (const group of snapshot.groups) {
		rows.push({
			kind: "group",
			label: group.source.label,
			tokens: group.totalTokens,
			depth: 0,
			matched: matched?.has(groupKey(group)),
		});
		group.items.forEach((item, itemIndex) => {
			const isLastItem = itemIndex === group.items.length - 1;
			rows.push({
				kind: "item",
				label: item.label,
				tokens: item.tokens,
				depth: 1,
				isLast: isLastItem,
				dropped: item.dropped,
				moved: item.moved,
				itemId: item.id,
				matched: matched?.has(item.id),
			});
			const children = item.children ?? [];
			children.forEach((child, childIndex) => {
				rows.push({
					kind: "item",
					label: child.label,
					tokens: child.tokens,
					depth: 2,
					isLast: childIndex === children.length - 1,
					parentContinues: !isLastItem,
					dropped: child.dropped,
					moved: child.moved,
					itemId: child.id,
					matched: matched?.has(child.id),
				});
			});
		});
	}
	rows.push({ kind: "separator", label: "", tokens: 0, depth: 0 });
	rows.push({ kind: "total", label: "TOTAL", tokens: snapshot.totalTokens, depth: 0 });
	return rows;
}

/**
 * Selection and scroll-window state over fixed rows. A trailing summary can
 * participate in scrolling without being included in selection navigation.
 */
export class ListNavigator {
	private readonly rowCount: number;
	private readonly selectableRowCount: number;
	private visibleCount: number;
	private selectedIndex = 0;
	private scrollOffset = 0;

	public constructor(rowCount: number, visibleCount: number, selectableRowCount = rowCount) {
		this.rowCount = Math.max(0, rowCount);
		this.selectableRowCount = Math.min(this.rowCount, Math.max(0, selectableRowCount));
		this.visibleCount = Math.max(1, visibleCount);
	}

	public get selected(): number {
		return this.selectedIndex;
	}

	public get selectedOrdinal(): number {
		return this.selectedIndex;
	}

	public get selectableCount(): number {
		return this.selectableRowCount;
	}

	public get offset(): number {
		return this.scrollOffset;
	}

	public get windowSize(): number {
		return Math.min(this.visibleCount, this.rowCount);
	}

	/** One-based final row currently visible, suitable for a scroll counter. */
	public get visibleEnd(): number {
		return Math.min(this.rowCount, this.scrollOffset + this.windowSize);
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
		if (this.selectableRowCount === 0) return false;
		const next = Math.min(this.selectableRowCount - 1, Math.max(0, index));
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

		const trailingRows = this.rowCount - this.selectedIndex - 1;
		if (this.selectedIndex === this.selectableRowCount - 1 && trailingRows < this.visibleCount) {
			this.scrollOffset = maxOffset;
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

	/** One-based final line currently visible, suitable for a progress counter. */
	public get visibleEnd(): number {
		return Math.min(this.lineCount, this.offsetValue + this.windowSize);
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

	/** Leave a visible line in place; otherwise scroll it near the top, below `context` lines. */
	public reveal(line: number, context: number): boolean {
		if (line >= this.offsetValue && line < this.offsetValue + this.visibleCount) return false;
		return this.scrollTo(line - context);
	}

	public reset(): void {
		this.offsetValue = 0;
	}
}
