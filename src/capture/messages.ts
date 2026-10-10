/**
 * PayloadGuard's message channel: compare the text units a payload sends
 * with the units Pi would send for the captured request. Keys ignore
 * whitespace; an LCS alignment matches them, and every unit left over is a
 * late edit with its changed lines. Pure functions over process-local data.
 */
import type { GuardFinding, LateEditLine, MessagePart } from "../snapshot.ts";
import { alignSequences } from "./diff.ts";

/** Unpaired UTF-16 surrogates; Pi removes them from text before sending it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const WHITESPACE = /\s+/gu;

/** Parts that Pi omits when their text is empty; a tool call or result always counts. */
const OMITTED_WHEN_EMPTY: ReadonlySet<MessagePart> = new Set(["system", "user", "assistant"]);

/** One model-facing text unit: a run of one message part's text, a tool call, or a tool result. */
export interface MessageUnit {
	readonly part: MessagePart;
	/** Text as sent; for a tool call, its arguments as canonical JSON or grammar input. */
	readonly text: string;
	/** Tool name of a tool call. */
	readonly name?: string;
}

/** Options of one message-channel comparison. */
export interface MessageComparisonOptions {
	/** Match tool-call names without case, as for Claude Code names with an Anthropic OAuth token. */
	readonly ignoreNameCase: boolean;
}

/**
 * Collects units in message order. Text of one part merges with the previous
 * unit until a message boundary or another part, so how a serializer splits a
 * message into blocks does not matter.
 */
export class UnitCollector {
	private readonly units: MessageUnit[] = [];
	private open = false;

	/** Start a new message: the next text never merges with earlier units. */
	public boundary(): void {
		this.open = false;
	}

	/** Add text of a system, user, or assistant part. */
	public text(part: "system" | "user" | "assistant", text: string): void {
		const previous = this.units.at(-1);
		if (this.open && previous?.part === part) {
			this.units[this.units.length - 1] = { part, text: `${previous.text}\n${text}` };
			return;
		}
		this.units.push({ part, text });
		this.open = true;
	}

	/** Add one tool call; it ends the current text run. */
	public toolCall(name: string, text: string): void {
		this.units.push({ part: "tool-call", name, text });
		this.open = false;
	}

	/** Add one tool result; it ends the current text run. */
	public toolResult(text: string): void {
		this.units.push({ part: "tool-result", text });
		this.open = false;
	}

	/** The collected units, in order. */
	public result(): MessageUnit[] {
		return this.units;
	}
}

/**
 * Compare the expected units with the payload's units:
 *   only in the payload                        added
 *   only in the expected units                 deleted
 *   both with one part between the same matches   modified, with the differing lines
 * Units whose text is only whitespace are skipped where Pi omits them too.
 */
export function compareMessageUnits(
	expected: readonly MessageUnit[],
	sent: readonly MessageUnit[],
	options: MessageComparisonOptions,
): GuardFinding[] {
	const gaps = findGaps(expected.filter(isSent), sent.filter(isSent), (unit) => unitKey(unit, options.ignoreNameCase));
	return gaps.flatMap(classifyGap);
}

/**
 * Lines that differ between two texts, ignoring whitespace and blank lines:
 * removed lines of `before`, then added lines of `after`, for each gap.
 */
export function diffLines(before: string, after: string): LateEditLine[] {
	const beforeLines = splitLines(before);
	const afterLines = splitLines(after);
	return findGaps(beforeLines, afterLines, normalizeText)
		.flatMap((gap) => [...gap.deleted.map(removedLine), ...gap.added.map(addedLine)]);
}

/** Text without whitespace and unpaired surrogates: what a unit key compares. */
export function normalizeText(text: string): string {
	return text.replace(LONE_SURROGATE, "").replace(WHITESPACE, "");
}

/** Items between two consecutive aligned matches. */
interface Gap<Item> {
	readonly deleted: readonly Item[];
	readonly added: readonly Item[];
}

/** Align two sequences by key and return the unmatched items between matches, in order. */
function findGaps<Item>(before: readonly Item[], after: readonly Item[], key: (item: Item) => string): Gap<Item>[] {
	const ids = new Map<string, number>();
	const intern = (item: Item) => {
		const text = key(item);
		let id = ids.get(text);
		if (id === undefined) {
			id = ids.size;
			ids.set(text, id);
		}
		return id;
	};
	const matches = alignSequences(before.map(intern), after.map(intern));
	const gaps: Gap<Item>[] = [];
	let beforeIndex = 0;
	let afterIndex = 0;
	// A sentinel match after both ends closes the last gap
	for (const match of [...matches, { before: before.length, after: after.length }]) {
		const gap = { deleted: before.slice(beforeIndex, match.before), added: after.slice(afterIndex, match.after) };
		if (gap.deleted.length > 0 || gap.added.length > 0) gaps.push(gap);
		beforeIndex = match.before + 1;
		afterIndex = match.after + 1;
	}
	return gaps;
}

/**
 * Pair each deleted unit with the next unpaired added unit of the same part,
 * keeping order. Deletions come first, then the gap's payload units in order.
 */
function classifyGap(gap: Gap<MessageUnit>): GuardFinding[] {
	const pairs = new Map<number, MessageUnit>();
	const unpaired: MessageUnit[] = [];
	let searchFrom = 0;
	for (const unit of gap.deleted) {
		const position = gap.added.findIndex((candidate, index) => index >= searchFrom && candidate.part === unit.part);
		if (position === -1) {
			unpaired.push(unit);
			continue;
		}
		pairs.set(position, unit);
		searchFrom = position + 1;
	}
	const findings: GuardFinding[] = unpaired.map((unit) => lateEdit("deleted", unit, unitLines(unit).map(removedLine)));
	for (const [index, unit] of gap.added.entries()) {
		const original = pairs.get(index);
		findings.push(original === undefined
			? lateEdit("added", unit, unitLines(unit).map(addedLine))
			: lateEdit("modified", unit, diffLines(displayText(original), displayText(unit))));
	}
	return findings;
}

/** A late-edit finding for one unit. */
function lateEdit(
	change: "added" | "modified" | "deleted",
	unit: MessageUnit,
	lines: readonly LateEditLine[],
): GuardFinding {
	return { type: "late-edit", change, part: unit.part, lines };
}

/** Non-blank lines of a unit as findings show it. */
function unitLines(unit: MessageUnit): string[] {
	return splitLines(displayText(unit));
}

/** Whether a unit reaches the model: Pi drops system, user, and assistant text that is only whitespace. */
function isSent(unit: MessageUnit): boolean {
	return !OMITTED_WHEN_EMPTY.has(unit.part) || normalizeText(unit.text).length > 0;
}

/** Comparison key: part, tool name, and text without whitespace. */
function unitKey(unit: MessageUnit, ignoreNameCase: boolean): string {
	const name = unit.name === undefined ? "" : ignoreNameCase ? unit.name.toLowerCase() : unit.name;
	return `${unit.part}\u0000${name}\u0000${normalizeText(unit.text)}`;
}

/** Text of a unit as findings show it; a tool call leads with its name. */
function displayText(unit: MessageUnit): string {
	return unit.name === undefined ? unit.text : `${unit.name} ${unit.text}`;
}

/** Lines of a text that hold more than whitespace. */
function splitLines(text: string): string[] {
	return text.split(/\r?\n/).filter((line) => normalizeText(line).length > 0);
}

/** A line only in the payload. */
function addedLine(text: string): LateEditLine {
	return { type: "added", text };
}

/** A line only in the captured request. */
function removedLine(text: string): LateEditLine {
	return { type: "removed", text };
}
