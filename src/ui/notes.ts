/** Presentation notes, kept separate from layout and from the states they explain. */
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { InjectionItem } from "../model.ts";
import type { GuardResult } from "../snapshot.ts";
import { normalizeInlineText } from "../text.ts";
import { wrapDescriptionLines } from "./layout.ts";
import { noteBulletLines } from "./markers.ts";

/** Payload comparison state that needs a description note. */
export type PayloadCheck = "pending" | "unchecked" | "partial";

/** A note's identity survives copy changes; text may contain theme styling, never raw content. */
export interface DescriptionNote {
	readonly kind: "overview" | "degraded" | "probe" | "probing-disabled" | "payload-check" | "hidden-tools" | "payload-changes" | "thinking" | "empty";
	readonly text: string;
}

/** Capture metadata that can be explained without opening raw content. */
export interface InjectionsNotesInput {
	readonly degradedReason?: string;
	readonly probe?: boolean;
	/** True when no request was captured yet and configuration disables the silent probe. */
	readonly probingDisabled?: boolean;
	readonly guard?: GuardResult;
	readonly hiddenTools?: readonly string[];
	readonly items: readonly InjectionItem[];
}

/** A complete comparison and a fallback without a request need no attention state. */
export function payloadCheck(guard: GuardResult | undefined): PayloadCheck | undefined {
	if (guard?.status === "pending") return "pending";
	if (guard?.status === "incomplete") return guard.findings === undefined ? "unchecked" : "partial";
	return undefined;
}

/** Origin stays visible even when the optional notes collapse. */
export function requestOriginLabel(probe = false): string {
	return probe ? "[Request Probe]" : "[Latest Request]";
}

/** Build optional notes in presentation order, with dynamic metadata sanitized before styling. */
export function injectionsNotes(theme: Theme, input: InjectionsNotesInput): DescriptionNote[] {
	const notes: DescriptionNote[] = [{ kind: "overview", text: "Injections into the model context, with token estimates." }];
	if (input.degradedReason !== undefined) {
		notes.push({ kind: "degraded", text: theme.fg("warning", "Degraded") + theme.fg("dim", ": pi-native fallback used") });
	}
	if (input.probingDisabled === true) notes.push(probingDisabledNote(theme));
	if (input.probe === true) {
		notes.push({ kind: "probe", text: `Captured by a ${theme.fg("warning", "request probe")}` + theme.fg(
			"dim", " with an empty prompt. Prompt-dependent injections may be missing.",
		) });
	}
	const check = payloadCheck(input.guard);
	if (check === "pending") {
		notes.push({ kind: "payload-check", text: "Payload changes are not checked yet: the comparison is pending." });
	} else if (input.guard?.status === "incomplete") {
		const reason = normalizeInlineText(input.guard.reason);
		notes.push({ kind: "payload-check", text: check === "unchecked"
			? `Payload changes were not checked: ${reason}`
			: `Payload changes were checked only in part: ${reason}` });
	}
	const tools = input.hiddenTools ?? [];
	if (tools.length > 0) {
		const names = [...tools].sort().map(normalizeInlineText).join(", ");
		notes.push({ kind: "hidden-tools", text: `${tools.length} ${tools.length === 1 ? "tool" : "tools"} hidden by pi: ${names}.` });
	}
	return [...notes, ...findingNotes(input.items)];
}

/** Payload findings explain a separate observation layer in the list and preview. */
export function findingNotes(items: readonly InjectionItem[]): DescriptionNote[] {
	return items.some((item) => item.kind === "payload-change")
		? [{ kind: "payload-changes", text: "Payload changes appear only in the provider payload. Their sources are unknown." }]
		: [];
}

/** Explain what a view opened before the first request misses while the silent probe is disabled. */
export function probingDisabledNote(theme: Theme): DescriptionNote {
	return { kind: "probing-disabled", text: `${theme.fg("warning", "Request probing")}` + theme.fg(
		"dim", " is disabled. Request-only injections may be missing before the first prompt.",
	) };
}

/** Explain why category estimates need not reconcile with reported usage. */
export function usageNote(): DescriptionNote {
	return { kind: "overview", text: "Estimated context for the next model request. " +
		"Token counts are approximate and may differ from the provider's estimate." };
}

/** Explain the different bases of thinking estimates, without retaining signatures. */
export function thinkingNote(): DescriptionNote {
	return { kind: "thinking", text: "Entry headers read: [DD-MM-YYYY] [assistant] visible + Reasoning ≈invisible (≈total). " +
		"≈ is a provider-reported count; ~ is a rough approximation when no breakdown " +
		"is reported and excluded from category totals. " +
		"Encoded replaces Reasoning when the provider replays encrypted reasoning with its message." };
}

/** Empty content is explicit, rather than an unexplained blank preview. */
export function emptyPreviewNote(): DescriptionNote {
	return { kind: "empty", text: "No content captured for this category." };
}

/** Wrap a complete note; the caller decides whether the whole block fits. */
export function descriptionNoteLines(theme: Theme, note: DescriptionNote, width: number): string[] {
	return note.kind === "overview" || note.kind === "degraded" || note.kind === "thinking" || note.kind === "empty"
		? wrapDescriptionLines(theme, note.text, "dim", width)
		: noteBulletLines(theme, note.text, width);
}
