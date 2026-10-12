/**
 * Pure presentation model for the Injections view: flattened rows, what the
 * status bar tells about each, and list navigation/scrolling state. No pi or
 * TUI access — unit-testable.
 */
import {
	type ChangeEditor,
	type InjectionItem,
	type InjectionSnapshot,
	type RequestChange,
	sumTokenDiffs,
	type TokenDiff,
} from "../model.ts";

/** Editor of every change no extension line explains. */
const UNKNOWN_EDITOR: ChangeEditor = { type: "unknown" };

/** Prefix of a tool row outside `Built-in Tools (N)`, whose group does not name it a tool. */
const TOOL_LABEL_PREFIX = "tool:";

/**
 * Where a row's changes live, one status-bar phrase each:
 *   saved            the session keeps every change
 *   saved-and-edit   a leaf with saved changes and an edit only in this request
 *   partly           an aggregate whose changes are partly only in this request
 *   request          an aggregate whose changes are all only in this request
 *   request-edit     a leaf changed only in this request; the session keeps the original
 *   request-new      a leaf only this request has
 *   payload          only in the provider payload
 * Aggregates are parents, groups, and the `system prompt`, `messages (N)`,
 * and `payload changes (N)` rows.
 */
export type ChangeScope =
	| "saved"
	| "saved-and-edit"
	| "partly"
	| "request"
	| "request-edit"
	| "request-new"
	| "payload";

/** One flattened list row derived from the snapshot hierarchy. */
export type InjectionRow =
	| {
		readonly kind: "group";
		readonly label: string;
		readonly tokens: number;
		readonly depth: 0;
		/** Sum of the group's token diffs. */
		readonly diff?: TokenDiff;
		/** Where the changes of the rows it counts live; absent when none changed. */
		readonly scope?: ChangeScope;
	}
	| {
		readonly kind: "item";
		readonly label: string;
		/** Dim prefix before the label: `tool:` on a tool row outside `Built-in Tools (N)`. */
		readonly labelPrefix?: string;
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
		/** Request-only change of this contribution. */
		readonly change?: RequestChange;
		/** Tokens this contribution gained and lost against its base. */
		readonly diff?: TokenDiff;
		/** Whether the request sent other content than the session keeps. */
		readonly requestOnly?: boolean;
		/** Whether the row shows only a diff of text other rows count, without a value. */
		readonly diffOnly?: boolean;
		/** Where the row's changes live; absent when it has none. */
		readonly scope?: ChangeScope;
		/** Who made a changed leaf row's change; absent on parents, groups, diff-only rows, and unchanged rows. */
		readonly editors?: readonly ChangeEditor[];
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
		readonly label: "TOTAL (Prompt, Tools, Injections)";
		readonly tokens: number;
		readonly depth: 0;
	};

/** Index snapshot items (including sub-items) by id for preview lookup. */
export function collectItemsById(snapshot: InjectionSnapshot): Map<string, InjectionItem> {
	const items = new Map<string, InjectionItem>();
	for (const group of snapshot.groups) {
		for (const item of group.items) {
			items.set(item.id, item);
			for (const child of item.children ?? []) items.set(child.id, child);
		}
	}
	return items;
}

/** Flatten snapshot groups into rows separated from the non-selectable snapshot total. */
export function buildInjectionRows(snapshot: InjectionSnapshot): InjectionRow[] {
	const rows: InjectionRow[] = [];
	for (const group of snapshot.groups) {
		rows.push({
			kind: "group",
			label: group.source.label,
			tokens: group.totalTokens,
			depth: 0,
			diff: group.diff,
			scope: combineScopes(group.items.filter((item) => item.diffOnly !== true).map(itemScope)),
		});
		group.items.forEach((item, itemIndex) => {
			const isLastItem = itemIndex === group.items.length - 1;
			rows.push({
				kind: "item",
				label: item.label,
				// Built-in tools are pi's children of Built-in Tools (N)
				...(item.kind === "tool" && !item.source.native ? { labelPrefix: TOOL_LABEL_PREFIX } : {}),
				tokens: item.tokens,
				depth: 1,
				isLast: isLastItem,
				dropped: item.dropped,
				moved: item.moved,
				change: item.change,
				diff: item.diff,
				requestOnly: item.requestOnly,
				diffOnly: item.diffOnly,
				...rowStatus(item),
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
					dropped: child.dropped,
					moved: child.moved,
					change: child.change,
					diff: child.diff,
					requestOnly: child.requestOnly,
					...rowStatus(child),
					itemId: child.id,
				});
			});
		});
	}
	rows.push({ kind: "separator", label: "", tokens: 0, depth: 0 });
	rows.push({ kind: "total", label: "TOTAL (Prompt, Tools, Injections)", tokens: snapshot.totalTokens, depth: 0 });
	return rows;
}

/**
 * Status-bar fields of one item row: where its changes live and, for a
 * changed leaf other than a `system prompt` row, who made them. An editor pi
 * does not report is unknown, never the row's source group.
 */
function rowStatus(item: InjectionItem): { scope?: ChangeScope; editors?: readonly ChangeEditor[] } {
	const scope = itemScope(item);
	if (scope === undefined) return {};
	const leaf = (item.children ?? []).length === 0 && item.diffOnly !== true;
	return leaf ? { scope, editors: item.editors ?? [UNKNOWN_EDITOR] } : { scope };
}

/**
 * Where one item's changes live. A parent combines its children and the
 * removal of children only the session has, which is request-only. A
 * `system prompt` row combines its saved and request-only changes like a
 * parent. Every message change is only in this request, so the messages row
 * has no saved ones. A forced prompt without parts exists only in this request.
 */
function itemScope(item: InjectionItem): ChangeScope | undefined {
	const children = item.children ?? [];
	if (children.length > 0) return combineScopes(children.map(itemScope), removesChildren(item, children));
	if (item.kind === "payload-change") return "payload";
	if (item.kind === "message") return item.requestOnly === true ? "request" : undefined;
	if (item.diffOnly === true) {
		if (item.requestOnly !== true) return item.diff === undefined ? undefined : "saved";
		return item.savedChange === true ? "partly" : "request";
	}
	if (item.requestOnly === true) {
		if (item.savedChange === true) return "saved-and-edit";
		return item.change === "added" || item.sessionOriginal === false ? "request-new" : "request-edit";
	}
	if (item.change === "forced") return "request-edit";
	return item.diff === undefined ? undefined : "saved";
}

/** Whether a parent's diff removes more than its children's: children only the session has. */
function removesChildren(parent: InjectionItem, children: readonly InjectionItem[]): boolean {
	const shown = sumTokenDiffs(children.map((child) => child.diff));
	return (parent.diff?.added ?? 0) > (shown?.added ?? 0) || (parent.diff?.removed ?? 0) > (shown?.removed ?? 0);
}

/**
 * One aggregate scope: saved, request-only, or partly both. Payload changes
 * mixed with other changes count as request-only, since the session keeps
 * neither.
 */
function combineScopes(scopes: ReadonlyArray<ChangeScope | undefined>, request = false): ChangeScope | undefined {
	let saved = false;
	let payload = false;
	for (const scope of scopes) {
		if (scope === undefined) continue;
		if (scope === "payload") {
			payload = true;
			continue;
		}
		if (scope === "saved" || scope === "saved-and-edit" || scope === "partly") saved = true;
		if (scope !== "saved") request = true;
	}
	if (saved) return request || payload ? "partly" : "saved";
	if (request) return "request";
	return payload ? "payload" : undefined;
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

	public reset(): void {
		this.offsetValue = 0;
	}
}
