/**
 * Differ: compares a captured request with its baseline. System state and
 * conversation are compared separately (see "Diff" in
 * doc/architecture/capture.md). Pure functions over process-local data.
 */
import { declarationsEqual, getCurrentSystemMessage, type SystemMessage, type Tool } from "@earendil-works/pi-ai";

import type { RequestMessage, SystemChange } from "../snapshot.ts";
import type { BaselineMessage } from "./request.ts";

/** Nesting depth beyond which a comparison leaves the decision to message keys. */
const MAX_COMPARE_DEPTH = 64;

/**
 * A conversation edit before attribution and redaction. Messages are the
 * process-local originals: `message` from the request, `baseline` from the
 * session projection.
 */
export type ConversationEdit =
	| { readonly type: "added"; readonly message: RequestMessage }
	| { readonly type: "modified"; readonly baseline: BaselineMessage; readonly message: RequestMessage }
	| { readonly type: "deleted"; readonly baseline: BaselineMessage };

/** Non-system messages of both sides that remain after their equal ends are removed. */
export interface UnmatchedMessages {
	/** Number of non-system messages both sides share at the start. */
	readonly prefix: number;
	readonly baseline: readonly BaselineMessage[];
	readonly request: readonly RequestMessage[];
}

/**
 * Compare the replayed system state of both sides. Replay makes Pi's collapsed
 * leading system message equivalent to the sequence it replaced, so only a
 * real difference in content, a section, or a declaration is reported.
 */
export function diffSystemState(
	baseline: readonly RequestMessage[],
	captured: readonly RequestMessage[],
): SystemChange[] {
	const before = getCurrentSystemMessage(baseline);
	const after = getCurrentSystemMessage(captured);
	const changes: SystemChange[] = [];
	const beforeContent = before === undefined ? "" : contentText(before.content);
	const afterContent = after === undefined ? "" : contentText(after.content);
	if (beforeContent !== afterContent) changes.push({ type: "content", text: afterContent });
	changes.push(...diffSections(before?.sections ?? {}, after?.sections ?? {}));
	changes.push(...diffTools(before?.toolsAdded ?? [], after?.toolsAdded ?? []));
	return changes;
}

/**
 * Align the non-system messages of both sides and classify the rest:
 *   unmatched request message           addition
 *   unmatched baseline message          deletion
 *   both with one role in one gap       modification
 *   an exact copy of a deleted message  deletion plus addition, as for a reorder
 */
export function diffConversation(
	baseline: readonly BaselineMessage[],
	captured: readonly RequestMessage[],
): ConversationEdit[] {
	const before = baseline.filter(({ message }) => message.role !== "system");
	const after = captured.filter((message) => message.role !== "system");
	const keys = new MessageKeys();
	const beforeKeys = before.map(({ message }) => keys.of(message));
	const afterKeys = after.map((message) => keys.of(message));
	const matches = alignSequences(beforeKeys, afterKeys);
	const moved = findMovedKeys(beforeKeys, afterKeys, matches);

	const edits: ConversationEdit[] = [];
	let beforeIndex = 0;
	let afterIndex = 0;
	// A sentinel match after both ends closes the last gap
	for (const match of [...matches, { before: before.length, after: after.length }]) {
		const gap = { deleted: range(beforeIndex, match.before), added: range(afterIndex, match.after) };
		edits.push(...classifyGap(gap, before, after, {
			deleted: (index) => moved.has(beforeKeys[index]),
			added: (index) => moved.has(afterKeys[index]),
		}));
		beforeIndex = match.before + 1;
		afterIndex = match.after + 1;
	}
	return edits;
}

/**
 * Canonical key of a message for alignment: role, `customType`, and the
 * model-facing payload with sorted object keys. Volatile metadata such as
 * timestamps, usage, `display`, and `details` is not part of it.
 */
export function messageKey(message: RequestMessage): string {
	return `${message.role}\u0000${customTypeKey(message)}\u0000${canonicalJson(modelFacingPart(message))}`;
}

/**
 * Whether two messages have the same `messageKey()`, decided without building
 * the keys for plain JSON data. Anything JSON would encode differently, such
 * as functions, non-finite numbers, or class instances, falls back to the keys.
 */
export function sameMessage(a: RequestMessage, b: RequestMessage): boolean {
	if (a.role !== b.role || customTypeKey(a) !== customTypeKey(b)) return false;
	const result = compareJson(modelFacingPart(a), modelFacingPart(b), 0);
	return result === "unknown" ? messageKey(a) === messageKey(b) : result === "equal";
}

/**
 * Remove the non-system messages that both sides share at the start and at
 * the end. Alignment matches these ends first, so `diffConversation()` over
 * the rest returns the same edits as over both whole sides. An unchanged
 * request leaves nothing.
 */
export function trimMatchedEnds(
	baseline: readonly BaselineMessage[],
	captured: readonly RequestMessage[],
): UnmatchedMessages {
	const before = baseline.filter(({ message }) => message.role !== "system");
	const after = captured.filter((message) => message.role !== "system");
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && sameMessage(before[prefix].message, after[prefix])) {
		prefix++;
	}
	let suffix = 0;
	while (suffix < before.length - prefix && suffix < after.length - prefix
		&& sameMessage(before[before.length - 1 - suffix].message, after[after.length - 1 - suffix])) suffix++;
	return {
		prefix,
		baseline: before.slice(prefix, before.length - suffix),
		request: after.slice(prefix, after.length - suffix),
	};
}

// ============================================================================
// System state
// ============================================================================

/** Sections added or changed in `after`, then sections removed from `before`. */
function diffSections(
	before: Readonly<Record<string, string | null>>,
	after: Readonly<Record<string, string | null>>,
): SystemChange[] {
	const changes: SystemChange[] = [];
	for (const [name, text] of Object.entries(after)) {
		if (text !== null && before[name] !== text) changes.push({ type: "section", name, text });
	}
	for (const [name, text] of Object.entries(before)) {
		if (text !== null && (after[name] === undefined || after[name] === null)) {
			changes.push({ type: "section", name, text: null });
		}
	}
	return changes;
}

/** Declarations added or redefined in `after`, then declarations removed from `before`. */
function diffTools(before: readonly Tool[], after: readonly Tool[]): SystemChange[] {
	const beforeByName = new Map(before.map((tool) => [tool.name, tool]));
	const afterNames = new Set(after.map((tool) => tool.name));
	const changes: SystemChange[] = [];
	for (const tool of after) {
		const previous = beforeByName.get(tool.name);
		if (previous === undefined || !declarationsEqual(previous, tool)) {
			changes.push({ type: "tool", name: tool.name, declaration: tool });
		}
	}
	for (const tool of before) {
		if (!afterNames.has(tool.name)) changes.push({ type: "tool", name: tool.name, declaration: null });
	}
	return changes;
}

/** Plain text of system content; text blocks join with a newline, as Pi renders them. */
function contentText(content: SystemMessage["content"]): string {
	return typeof content === "string" ? content : content.map((block) => block.text).join("\n");
}

// ============================================================================
// Conversation
// ============================================================================

/** Unmatched indexes between two consecutive aligned matches. */
interface Gap {
	readonly deleted: readonly number[];
	readonly added: readonly number[];
}

/** Predicates for gap members whose exact copy is unmatched on the other side. */
interface MovedMembers {
	readonly deleted: (index: number) => boolean;
	readonly added: (index: number) => boolean;
}

/**
 * Pair each deletion with the next unpaired addition of the same role, keeping
 * order. Moved messages are never paired: a reorder stays a deletion plus an
 * addition. Deletions come first, then the gap's request messages in order.
 */
function classifyGap(
	gap: Gap,
	before: readonly BaselineMessage[],
	after: readonly RequestMessage[],
	moved: MovedMembers,
): ConversationEdit[] {
	const pairs = new Map<number, number>();
	let searchFrom = 0;
	const unpairedDeletions: number[] = [];
	for (const deleted of gap.deleted) {
		const role = before[deleted].message.role;
		const position = moved.deleted(deleted) ? -1 : gap.added.findIndex((added, candidate) =>
			candidate >= searchFrom && !moved.added(added) && after[added].role === role);
		if (position === -1) {
			unpairedDeletions.push(deleted);
			continue;
		}
		pairs.set(gap.added[position], deleted);
		searchFrom = position + 1;
	}
	const edits: ConversationEdit[] = unpairedDeletions.map((index) => ({ type: "deleted", baseline: before[index] }));
	for (const added of gap.added) {
		const paired = pairs.get(added);
		edits.push(paired === undefined
			? { type: "added", message: after[added] }
			: { type: "modified", baseline: before[paired], message: after[added] });
	}
	return edits;
}

/**
 * Keys that occur both among unmatched baseline and unmatched request messages:
 * the request carries an exact copy of a message from another position.
 */
function findMovedKeys(
	beforeKeys: readonly number[],
	afterKeys: readonly number[],
	matches: readonly AlignedPair[],
): Set<number> {
	const matchedBefore = new Set(matches.map((match) => match.before));
	const matchedAfter = new Set(matches.map((match) => match.after));
	const unmatchedBefore = new Set(beforeKeys.filter((_key, index) => !matchedBefore.has(index)));
	return new Set(afterKeys.filter((key, index) => !matchedAfter.has(index) && unmatchedBefore.has(key)));
}

/** Indexes from `start` up to, but not including, `end`. */
function range(start: number, end: number): number[] {
	return Array.from({ length: Math.max(0, end - start) }, (_unused, offset) => start + offset);
}

/** Interns message keys as small integers, so alignment compares numbers, not long strings. */
class MessageKeys {
	private readonly ids = new Map<string, number>();

	/** The integer ID of a message's canonical key. */
	public of(message: RequestMessage): number {
		const key = messageKey(message);
		let id = this.ids.get(key);
		if (id === undefined) {
			id = this.ids.size;
			this.ids.set(key, id);
		}
		return id;
	}
}

/** The `customType` part of a message key; empty for other roles. */
function customTypeKey(message: RequestMessage): string {
	return message.role === "custom" ? `${message.customType}` : "";
}

/**
 * The part of a message the model receives, before Pi's conversion. Unknown
 * roles keep every field except the timestamp.
 */
function modelFacingPart(message: RequestMessage): unknown {
	switch (message.role) {
		case "user":
		case "assistant":
		case "custom":
			return message.content;
		case "toolResult":
			return {
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: message.content,
				isError: message.isError,
			};
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		default: {
			const { timestamp: _timestamp, ...rest } = message;
			return rest;
		}
	}
}

/** JSON with object keys sorted at every level, so key order never affects equality. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, nested: unknown) => {
		if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return nested;
		return Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	}) ?? "";
}

/**
 * Result of comparing two values as JSON:
 *   equal       both encode to the same canonical JSON
 *   different   their canonical JSON differs
 *   unknown     a value is outside plain JSON data; compare the encoded keys
 */
type JsonComparison = "equal" | "different" | "unknown";

/**
 * Compare plain JSON data (strings, booleans, null, finite numbers, arrays,
 * and plain objects) as `canonicalJson()` would, without encoding it. Object
 * key order and `undefined` properties do not matter, as in the keys.
 */
function compareJson(a: unknown, b: unknown, depth: number): JsonComparison {
	if (typeof a === "string" || typeof a === "boolean") {
		if (typeof b !== typeof a) return "unknown";
		return a === b ? "equal" : "different";
	}
	if (typeof a === "number") {
		if (typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return "unknown";
		return a === b ? "equal" : "different";
	}
	if (a === null) return b === null ? "equal" : "unknown";
	if (typeof a !== "object" || typeof b !== "object" || b === null || depth >= MAX_COMPARE_DEPTH) return "unknown";
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) ? compareJsonArrays(a, b, depth) : "unknown";
	}
	if (!isPlainObject(a) || !isPlainObject(b)) return "unknown";
	return compareJsonObjects(a as Record<string, unknown>, b as Record<string, unknown>, depth);
}

/** Compare two arrays element by element; JSON keeps their order. */
function compareJsonArrays(a: readonly unknown[], b: readonly unknown[], depth: number): JsonComparison {
	if (a.length !== b.length) return "different";
	for (let index = 0; index < a.length; index++) {
		const result = compareJson(a[index], b[index], depth + 1);
		if (result !== "equal") return result;
	}
	return "equal";
}

/** Compare two plain objects by their defined properties, in any key order. */
function compareJsonObjects(
	a: Readonly<Record<string, unknown>>,
	b: Readonly<Record<string, unknown>>,
	depth: number,
): JsonComparison {
	let unpaired = 0;
	for (const key in a) {
		if (a[key] === undefined) continue;
		unpaired++;
		const result = compareJson(a[key], b[key], depth + 1);
		if (result !== "equal") return result;
	}
	for (const key in b) {
		const value = b[key];
		if (value === undefined) continue;
		// JSON omits these, so an extra one would not make the keys differ
		if (typeof value === "function" || typeof value === "symbol") return "unknown";
		unpaired--;
	}
	return unpaired === 0 ? "equal" : "different";
}

/** Whether a value is an object literal, not a class instance whose JSON may differ. */
function isPlainObject(value: object): boolean {
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

// ============================================================================
// Alignment
// ============================================================================

/** Indexes of one matched element in the baseline and the request. */
export interface AlignedPair {
	readonly before: number;
	readonly after: number;
}

/**
 * Longest common subsequence of two key sequences, as ascending index pairs.
 * The common prefix and suffix are matched directly; Myers' O((N+M)D) search
 * aligns only the middle, which is small when few messages changed.
 */
export function alignSequences(before: readonly number[], after: readonly number[]): AlignedPair[] {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
	let suffix = 0;
	while (suffix < before.length - prefix && suffix < after.length - prefix
		&& before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;

	const pairs: AlignedPair[] = range(0, prefix).map((index) => ({ before: index, after: index }));
	const middle = myersMatches(before.slice(prefix, before.length - suffix), after.slice(prefix, after.length - suffix));
	pairs.push(...middle.map((pair) => ({ before: pair.before + prefix, after: pair.after + prefix })));
	for (let offset = suffix; offset > 0; offset--) {
		pairs.push({ before: before.length - offset, after: after.length - offset });
	}
	return pairs;
}

/** Myers' shortest edit script, backtracked into the matched pairs in ascending order. */
function myersMatches(before: readonly number[], after: readonly number[]): AlignedPair[] {
	const n = before.length;
	const m = after.length;
	if (n === 0 || m === 0) return [];
	const offset = n + m;
	// furthest[offset + k]: the furthest x reached on diagonal k = x - y
	let furthest = new Int32Array(2 * offset + 2);
	const trace: Int32Array[] = [];
	for (let depth = 0; depth <= offset; depth++) {
		trace.push(furthest);
		furthest = furthest.slice();
		for (let k = -depth; k <= depth; k += 2) {
			let x = followsInsertion(furthest, offset, k, depth) ? furthest[offset + k + 1] : furthest[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && before[x] === after[y]) {
				x++;
				y++;
			}
			furthest[offset + k] = x;
			if (x >= n && y >= m) return backtrack(trace, offset, n, m);
		}
	}
	return [];
}

/** Whether diagonal `k` at `depth` continues from diagonal `k + 1` (an insertion) rather than `k - 1`. */
function followsInsertion(furthest: Int32Array, offset: number, k: number, depth: number): boolean {
	return k === -depth || (k !== depth && furthest[offset + k - 1] < furthest[offset + k + 1]);
}

/** Walk the recorded search back from the end and collect the diagonal (matching) moves. */
function backtrack(trace: readonly Int32Array[], offset: number, n: number, m: number): AlignedPair[] {
	const pairs: AlignedPair[] = [];
	let x = n;
	let y = m;
	for (let depth = trace.length - 1; depth >= 0; depth--) {
		const furthest = trace[depth];
		const k = x - y;
		const previousK = followsInsertion(furthest, offset, k, depth) ? k + 1 : k - 1;
		const previousX = depth === 0 ? 0 : furthest[offset + previousK];
		const previousY = depth === 0 ? 0 : previousX - previousK;
		while (x > previousX && y > previousY) {
			x--;
			y--;
			pairs.push({ before: x, after: y });
		}
		x = previousX;
		y = previousY;
	}
	return pairs.reverse();
}
