/**
 * The `system prompt` rows of the Injections tree: the changes to pi's prompt
 * text against pi's default prompt, split by available ownership signals. Each
 * extension gets the diff of the lines measured as its own: its tools' prompt
 * lines and the additions guessed to be its own. `unattributed` gets every
 * other change to the System Prompt, instruction files, and skills. The rows
 * repeat diffs that System Prompt and its siblings already count, so they
 * carry no estimate of their own. The same split names the editors of each
 * System Prompt part's diff. Pure; no pi access.
 */
import { charTokens, isPiPromptPart, SYSTEM_PROMPT_ITEM_ID } from "./measure.ts";
import {
	AGGREGATE_SOURCE,
	AGGREGATE_SOURCE_ID,
	type ChangeEditor,
	type InjectionItem,
	type InjectionSection,
	type InjectionSource,
	sumTokenDiffs,
	type TokenDiff,
} from "./model.ts";

/** Label of every `system prompt` row; lower case, like the other rows under a source. */
const SYSTEM_PROMPT_ROW_LABEL = "system prompt";

/**
 * One diff-only `system prompt` row per extension with lines in the System
 * Prompt diff, in prompt order, then one `unattributed` row for every other
 * prompt change. `items` are the request's prompt and tool items with their
 * diffs; `session` holds the session's, which tell whether an extension's
 * lines are only in this request. The extension rows and the unattributed row
 * together add up to the diffs of System Prompt, Instruction Files, and
 * Skills. No row is built without a diff.
 */
export function buildSystemPromptRows(
	items: readonly InjectionItem[],
	session: readonly InjectionItem[],
): InjectionItem[] {
	const owners = new Map<string, RowDraft>();
	const unattributed = createRowDraft(AGGREGATE_SOURCE);
	const sessionById = new Map(session.map((item) => [item.id, item]));
	for (const item of items) {
		if (item.id === SYSTEM_PROMPT_ITEM_ID) splitPromptDiff(item, owners, unattributed, sessionById.get(item.id));
		else if (item.source.native && (item.kind === "context-file" || item.kind === "skills")) {
			collectUnattributedDiffs(item, unattributed, sessionById.get(item.id));
		}
	}
	const requestLines = extensionLines(items);
	const sessionLines = extensionLines(session);
	const rows = [...owners.values()].map((owner) => {
		const id = owner.source.id;
		// The session keeps the lines it has, whatever this request changed
		owner.saved = sessionLines.has(id);
		return createRow(owner, requestLines.get(id) !== sessionLines.get(id));
	});
	rows.push(createRow(unattributed, unattributed.sections.some((section) => section.requestOnly === true)));
	return rows.filter((row) => row.diff !== undefined);
}

/**
 * Who made a saved System Prompt part's diff, as the `system prompt` rows
 * split it: extensions whose lines take a share of the added tokens, in
 * prompt order, then `unknown` for any other addition and every removal.
 * A request-only part's editor is always unknown. Undefined without a diff.
 */
export function partEditors(part: InjectionItem): ChangeEditor[] | undefined {
	if (part.diff === undefined) return undefined;
	// References name contributed lines, never who edited them in this request
	if (part.requestOnly === true) return [{ type: "unknown" }];
	const shares = ownerShares(part, part.diff.added);
	const editors: ChangeEditor[] = shares.map(({ source, guess }) => ({
		type: "extension",
		source,
		...(guess ? { attribution: "guess" as const } : {}),
	}));
	const known = shares.reduce((sum, share) => sum + share.added, 0);
	if (known < part.diff.added || part.diff.removed > 0) editors.push({ type: "unknown" });
	return editors;
}

/** Parts and diffs collected for one `system prompt` row before it is built. */
interface RowDraft {
	readonly source: InjectionSource;
	/** One preview part per changed prompt part, in prompt order. */
	readonly sections: InjectionSection[];
	/** True when the session keeps some of the row's changes. */
	saved: boolean;
}

/** An empty row draft for one source. */
function createRowDraft(source: InjectionSource): RowDraft {
	return { source, sections: [], saved: false };
}

/**
 * Split the System Prompt diff part by part: each extension's lines go to its
 * row, the rest of the part's diff to `unattributed`. A System Prompt without
 * parts, such as a forced prompt without sections, has no extension lines.
 */
function splitPromptDiff(
	prompt: InjectionItem,
	owners: Map<string, RowDraft>,
	unattributed: RowDraft,
	session: InjectionItem | undefined,
): void {
	const parts = prompt.children ?? [];
	if (parts.length === 0) {
		if (prompt.diff !== undefined) addUnattributed(unattributed, prompt, prompt.diff, prompt.change === "forced");
		return;
	}
	const sessionParts = new Map(session?.children?.map((part) => [part.id, part]));
	for (const part of parts) {
		if (part.diff === undefined) continue;
		let added = part.diff.added;
		for (const share of ownerShares(part, part.diff.added)) {
			let owner = owners.get(share.source.id);
			if (owner === undefined) {
				owner = createRowDraft(share.source);
				owners.set(share.source.id, owner);
			}
			owner.sections.push({
				label: part.label,
				text: share.text,
				tokens: 0,
				diffOnly: true,
				diff: { added: share.added, removed: 0 },
				...(share.guess ? { attribution: "guess" as const } : {}),
			});
			added -= share.added;
		}
		const rest = { added, removed: part.diff.removed };
		if (rest.added > 0 || rest.removed > 0) {
			addUnattributed(unattributed, part, rest, false, hasSavedUnattributed(part, sessionParts.get(part.id)));
		}
	}
	collectResidual(prompt, parts, unattributed, session);
}

/**
 * Changes to instruction files or skills, which `unattributed` holds whole:
 * one part per changed child, or the item itself without children.
 */
function collectUnattributedDiffs(
	item: InjectionItem,
	unattributed: RowDraft,
	session: InjectionItem | undefined,
): void {
	if (item.diff === undefined) return;
	const children = item.children ?? [];
	if (children.length === 0) {
		addUnattributed(unattributed, item, item.diff, false);
		return;
	}
	for (const child of children) {
		if (child.diff !== undefined) addUnattributed(unattributed, child, child.diff, false);
	}
	collectResidual(item, children, unattributed, session);
}

/**
 * The part of a parent's diff its children do not show: the removal of
 * children only the session has. Preview their session text as one part. The
 * request lacks them, so it is request-only.
 */
function collectResidual(
	parent: InjectionItem,
	children: readonly InjectionItem[],
	row: RowDraft,
	session: InjectionItem | undefined,
): void {
	const shown = sumTokenDiffs(children.map((child) => child.diff));
	const residual = {
		added: (parent.diff?.added ?? 0) - (shown?.added ?? 0),
		removed: (parent.diff?.removed ?? 0) - (shown?.removed ?? 0),
	};
	if (residual.added <= 0 && residual.removed <= 0) return;
	const sent = new Set(children.map((child) => child.id));
	const missing = session?.children?.filter((child) => !sent.has(child.id)) ?? [];
	const reference = missing.length === 1 ? missing[0] : {
		...parent, text: missing.map((child) => child.text).join("\n"), injectedReferences: undefined,
	};
	if (reference !== undefined) addUnattributed(row, reference, residual, true);
}

/**
 * Whether the unattributed share includes saved changes: a saved custom
 * section, or unowned extension lines the session has. Saved lines of known
 * owners go to their own rows, not to the unknown request-only edits beside them.
 */
function hasSavedUnattributed(part: InjectionItem, session: InjectionItem | undefined): boolean {
	if (part.requestOnly !== true) return true;
	if (part.savedChange !== true || session === undefined) return false;
	const references = session.injectedReferences ?? [];
	if (references.length > 0) return references.some((reference) => isUnattributedSource(reference.source));
	return !isPiPromptPart(part.id);
}

/** Add one changed part and its persistence state to the unattributed row. */
function addUnattributed(
	row: RowDraft,
	part: InjectionItem,
	diff: TokenDiff,
	requestOnly: boolean,
	saved = part.requestOnly !== true && !requestOnly,
): void {
	row.sections.push(diffSection(part, diff, requestOnly));
	row.saved ||= saved;
}

/**
 * One changed part as an unattributed preview part: its whole text, with the
 * extension lines in it still annotated, or the session text of a deleted part.
 */
function diffSection(part: InjectionItem, diff: TokenDiff, requestOnly: boolean): InjectionSection {
	return {
		label: part.label,
		text: part.text,
		tokens: 0,
		diffOnly: true,
		diff,
		...(part.requestOnly === true || requestOnly ? { requestOnly: true } : {}),
		jsonSpan: part.jsonSpan,
		injectedReferences: part.injectedReferences,
	};
}

/** Tokens one extension's lines add to one part, and the lines themselves. */
interface OwnerShare {
	readonly source: InjectionSource;
	readonly added: number;
	/** The extension's lines in the part, in prompt order. */
	readonly text: string;
	/** True when any of the lines has a guessed owner. */
	readonly guess: boolean;
}

/**
 * Each extension's share of the tokens one part added, by the characters of
 * its lines in prompt order. Shares round cumulatively, like section shares,
 * so together they never exceed `added`; unattributed lines take no share.
 */
function ownerShares(part: InjectionItem, added: number): OwnerShare[] {
	const references = (part.injectedReferences ?? [])
		.filter((reference) => !isUnattributedSource(reference.source))
		.sort((a, b) => a.start - b.start);
	let chars = 0;
	let allocated = 0;
	const shares: OwnerShare[] = [];
	for (const owned of Map.groupBy(references, (reference) => reference.source.id).values()) {
		const text = owned.map((reference) => part.text.slice(reference.start, reference.end)).join("");
		chars += text.length;
		const tokens = Math.min(added, charTokens(chars)) - allocated;
		allocated += tokens;
		if (tokens > 0) {
			const guess = owned.some((reference) => reference.attribution === "guess");
			shares.push({ source: owned[0].source, added: tokens, text, guess });
		}
	}
	return shares;
}

/**
 * Every extension's lines in the System Prompt parts pi sent, keyed by source
 * id, with the part each line is in. Equal keys in the request and the session
 * mean the extension's lines are saved.
 */
function extensionLines(items: readonly InjectionItem[]): Map<string, string> {
	const lines = new Map<string, string>();
	const prompt = items.find((item) => item.id === SYSTEM_PROMPT_ITEM_ID);
	for (const part of prompt?.children ?? []) {
		if (part.dropped === true || part.change === "deleted") continue;
		for (const reference of part.injectedReferences ?? []) {
			if (isUnattributedSource(reference.source)) continue;
			const line = `${part.id}\n${part.text.slice(reference.start, reference.end)}\n`;
			lines.set(reference.source.id, (lines.get(reference.source.id) ?? "") + line);
		}
	}
	return lines;
}

/**
 * Whether a reference has no extension provenance, rather than a known or
 * guessed owner, such as an unregistered recorded tool's snippet.
 */
function isUnattributedSource(source: InjectionSource): boolean {
	return source.id === AGGREGATE_SOURCE_ID;
}

/** The diff-only row of one draft: no estimate, the sum of its parts' diffs. */
function createRow(draft: RowDraft, requestOnly: boolean): InjectionItem {
	const diff = sumTokenDiffs(draft.sections.map((section) => section.diff));
	return {
		id: `system-prompt:${draft.source.id}`,
		kind: "prompt-addition",
		source: draft.source,
		label: SYSTEM_PROMPT_ROW_LABEL,
		chars: 0,
		tokens: 0,
		text: draft.sections.map((section) => section.text).join(""),
		sections: draft.sections,
		diffOnly: true,
		...(diff === undefined ? {} : { diff }),
		...(requestOnly ? { requestOnly: true } : {}),
		...(draft.saved ? { savedChange: true } : {}),
	};
}
