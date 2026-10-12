/**
 * Word-level comparison of two texts and the token diff it implies. Pure
 * string logic shared by the Injections composition; no pi access.
 */
import { charTokens } from "./measure.ts";
import type { TokenDiff } from "./model.ts";

/** A word, a whitespace run, or one other character; together they cover the whole text. */
const WORD_PATTERN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/**
 * Edit steps after which the comparison stops aligning and counts the rest as
 * replaced. Unrelated texts, such as a forced prompt against pi's, would
 * otherwise cost time proportional to their length times their edit distance.
 */
const MAX_EDIT_STEPS = 2_000;

/** Characters a word-level comparison found only in one of two texts. */
export interface WordChanges {
	/** Characters only in the later text. */
	readonly addedChars: number;
	/** Characters only in the earlier text. */
	readonly removedChars: number;
}

/** One contiguous run in a word comparison; joining each side reconstructs its exact text. */
export interface WordDiffPart {
	readonly type: "unchanged" | "added" | "removed";
	readonly text: string;
}

/** Text and token estimate of one side of a comparison. */
export interface DiffSide {
	readonly text: string;
	readonly tokens: number;
}

/**
 * Tokens `request` gained and lost against `base`, or undefined when neither
 * changed a token. No base means everything was added, and equal texts mean
 * no change, even when a share of a larger estimate rounds differently.
 * Otherwise a word-level comparison supplies the changed characters, rounded
 * up to tokens, and any rounding difference goes to the side with changed
 * characters, so that base tokens plus `added` minus `removed` equals the
 * request tokens. An empty request with no tokens removes the whole base, and
 * no diff removes more than the base or adds more than the request has.
 */
export function measureTokenDiff(base: DiffSide | undefined, request: DiffSide): TokenDiff | undefined {
	if (base === undefined) return nonEmptyDiff({ added: request.tokens, removed: 0 });
	if (base.text === request.text) return undefined;
	const changes = countWordChanges(base.text, request.text);
	return nonEmptyDiff(reconcileTokens(base.tokens, request.tokens, changes));
}

/**
 * Characters only in `before` or only in `after`, aligning words with Myers'
 * shortest edit script after matching the common ends. A difference too large
 * to align within `MAX_EDIT_STEPS` counts its whole middle as replaced.
 */
export function countWordChanges(before: string, after: string): WordChanges {
	if (before === after) return { addedChars: 0, removedChars: 0 };
	const words = comparisonWords(before, after);
	const matchedChars = words.prefix.length + words.suffix.length + matchedMiddleChars(words.before, words.after);
	return { addedChars: after.length - matchedChars, removedChars: before.length - matchedChars };
}

/**
 * Word runs on the same path used by token estimates, with a bounded Myers
 * trace retained only for previews. An unalignable middle is a replacement.
 */
export function diffWords(before: string, after: string): WordDiffPart[] {
	if (before === after) return before.length === 0 ? [] : [{ type: "unchanged", text: before }];
	const words = comparisonWords(before, after);
	const trace: Int32Array[] = [];
	matchedMiddleChars(words.before, words.after, trace);
	const middle = trace.length === 0
		? [{ type: "removed" as const, text: words.before.join("") },
			{ type: "added" as const, text: words.after.join("") }]
		: traceParts(words.before, words.after, trace);
	const parts: WordDiffPart[] = [];
	for (const part of [{ type: "unchanged" as const, text: words.prefix }, ...middle,
		{ type: "unchanged" as const, text: words.suffix }]) {
		if (part.text.length === 0) continue;
		const previous = parts.at(-1);
		if (previous?.type === part.type) parts[parts.length - 1] = { type: part.type, text: previous.text + part.text };
		else parts.push(part);
	}
	return parts;
}

/** Tokenized middle after stripping identical ends, shared by counts and previews. */
interface ComparisonWords {
	readonly before: readonly string[];
	readonly after: readonly string[];
	readonly prefix: string;
	readonly suffix: string;
}

/** Strip common ends before running the bounded comparison. */
function comparisonWords(before: string, after: string): ComparisonWords {
	const beforeWords = before.match(WORD_PATTERN) ?? [];
	const afterWords = after.match(WORD_PATTERN) ?? [];
	let start = 0;
	while (start < beforeWords.length && start < afterWords.length && beforeWords[start] === afterWords[start]) start++;
	let beforeEnd = beforeWords.length;
	let afterEnd = afterWords.length;
	while (beforeEnd > start && afterEnd > start && beforeWords[beforeEnd - 1] === afterWords[afterEnd - 1]) {
		beforeEnd--;
		afterEnd--;
	}
	return {
		before: beforeWords.slice(start, beforeEnd), after: afterWords.slice(start, afterEnd),
		prefix: beforeWords.slice(0, start).join(""), suffix: beforeWords.slice(beforeEnd).join(""),
	};
}

/**
 * Characters of the words Myers' shortest edit script keeps in both
 * sequences, or 0 when it needs more than `MAX_EDIT_STEPS`. Each diagonal
 * remembers the kept characters of its furthest path. Only previews request
 * a trace; counts keep linear working memory. A failed alignment clears it.
 */
function matchedMiddleChars(before: readonly string[], after: readonly string[], trace?: Int32Array[]): number {
	const n = before.length;
	const m = after.length;
	if (n === 0 || m === 0) return 0;
	const maxSteps = Math.min(n + m, MAX_EDIT_STEPS);
	const offset = maxSteps + 1;
	// furthest[offset + k]: the furthest x reached on diagonal k = x - y; kept[offset + k]: its kept characters
	const furthest = new Int32Array(2 * offset + 1);
	const kept = new Float64Array(2 * offset + 1);
	for (let steps = 0; steps <= maxSteps; steps++) {
		for (let k = -steps; k <= steps; k += 2) {
			const insertion = k === -steps || (k !== steps && furthest[offset + k - 1] < furthest[offset + k + 1]);
			const from = offset + (insertion ? k + 1 : k - 1);
			let x = insertion ? furthest[from] : furthest[from] + 1;
			let y = x - k;
			let chars = kept[from];
			while (x < n && y < m && before[x] === after[y]) {
				chars += before[x].length;
				x++;
				y++;
			}
			furthest[offset + k] = x;
			kept[offset + k] = chars;
			if (x >= n && y >= m) {
				trace?.push(furthest.slice(offset - steps, offset + steps + 1));
				return chars;
			}
		}
		trace?.push(furthest.slice(offset - steps, offset + steps + 1));
	}
	if (trace !== undefined) trace.length = 0;
	return 0;
}

/** Walk a successful Myers trace backward, then restore word order. */
function traceParts(before: readonly string[], after: readonly string[], trace: readonly Int32Array[]): WordDiffPart[] {
	const parts: WordDiffPart[] = [];
	let x = before.length;
	let y = after.length;
	for (let steps = trace.length - 1; steps > 0; steps--) {
		const previous = trace[steps - 1];
		const k = x - y;
		const offset = steps - 1;
		const insertion = k === -steps || (k !== steps && previous[offset + k - 1] < previous[offset + k + 1]);
		const previousK = insertion ? k + 1 : k - 1;
		const previousX = previous[offset + previousK];
		const previousY = previousX - previousK;
		while (x > previousX && y > previousY) {
			parts.push({ type: "unchanged", text: before[--x] });
			y--;
		}
		parts.push(insertion ? { type: "added", text: after[--y] } : { type: "removed", text: before[--x] });
	}
	while (x > 0 && y > 0) {
		parts.push({ type: "unchanged", text: before[--x] });
		y--;
	}
	return parts.reverse();
}

/**
 * Round changed characters up to tokens, then give the difference to the base
 * estimate to the side with changed characters, so the result reconciles
 * exactly. An image, for example, changes the estimate far more than its text.
 * Text the estimates leave out, such as the JSON around a message's content
 * blocks, can count more changed characters than either side has tokens; the
 * diff then replaces the whole base.
 */
function reconcileTokens(baseTokens: number, requestTokens: number, changes: WordChanges): TokenDiff {
	let added = charTokens(changes.addedChars);
	let removed = charTokens(changes.removedChars);
	const error = requestTokens - baseTokens - (added - removed);
	if (error > 0) {
		const cut = changes.addedChars > 0 ? 0 : Math.min(error, removed);
		removed -= cut;
		added += error - cut;
	} else if (error < 0) {
		const cut = changes.removedChars > 0 ? 0 : Math.min(-error, added);
		added -= cut;
		removed += -error - cut;
	}
	if (added > requestTokens || removed > baseTokens) return { added: requestTokens, removed: baseTokens };
	return { added, removed };
}

/** The diff, or undefined when it neither adds nor removes a token. */
function nonEmptyDiff(diff: TokenDiff): TokenDiff | undefined {
	return diff.added === 0 && diff.removed === 0 ? undefined : diff;
}
