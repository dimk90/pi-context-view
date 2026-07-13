/**
 * Pure presentation model for the Injections view: flattened rows and
 * list navigation/scrolling state. No pi or TUI access — unit-testable.
 */
import type { InitialSnapshot, InjectionItem } from "../model.ts";

const TERMINAL_STRING_SEQUENCE =
	/(?:\u001B[\]PX^_]|[\u0090\u0098\u009D\u009E\u009F])[\s\S]*?(?:\u0007|\u001B\\|\u009C)/g;
const TERMINAL_CSI_SEQUENCE = /(?:\u001B\[|\u009B)[\u0030-\u003F]*[\u0020-\u002F]*[\u0040-\u007E]/g;
const TERMINAL_ESCAPE_SEQUENCE = /\u001B[\u0020-\u002F]*[\u0030-\u007E]/g;
const TERMINAL_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** One flattened list row derived from the snapshot hierarchy. */
export type InjectionRow =
	| {
		readonly kind: "group";
		readonly label: string;
		readonly tokens: number;
		readonly depth: 0;
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
		/** Stable preview target id from the snapshot. */
		readonly itemId: string;
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

/** Normalize whitespace and remove terminal control sequences from raw preview text. */
export function normalizePreviewText(text: string): string {
	return text
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replaceAll("\t", "    ")
		.replace(TERMINAL_STRING_SEQUENCE, "")
		.replace(TERMINAL_CSI_SEQUENCE, "")
		.replace(TERMINAL_ESCAPE_SEQUENCE, "")
		.replace(TERMINAL_CONTROL_CHARACTER, "");
}

/** Sanitize dynamic text for one terminal line and collapse embedded whitespace. */
export function normalizeInlineText(text: string): string {
	return normalizePreviewText(text).replace(/\s+/g, " ").trim();
}

/** Flatten snapshot groups into rows separated from the non-selectable Initial total. */
export function buildInjectionRows(snapshot: InitialSnapshot): InjectionRow[] {
	const rows: InjectionRow[] = [];
	for (const group of snapshot.groups) {
		rows.push({
			kind: "group",
			label: group.source.label,
			tokens: group.totalTokens,
			depth: 0,
		});
		group.items.forEach((item, itemIndex) => {
			const isLastItem = itemIndex === group.items.length - 1;
			rows.push({
				kind: "item",
				label: item.label,
				tokens: item.tokens,
				depth: 1,
				isLast: isLastItem,
				itemId: item.id,
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
					itemId: child.id,
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

	public reset(): void {
		this.offsetValue = 0;
	}
}
