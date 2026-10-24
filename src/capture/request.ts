/**
 * ProjectionReader and TranscriptCapture: the synchronous part of a structured
 * capture in `context_with_system`. Everything here runs inside the
 * handler, before later handlers can mutate the shared request messages.
 */
import {
	contentText, getCurrentSystemMessage, getCurrentSystemPrompt, getDeclaredTools, type SystemMessage, type Tool,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ProbeView } from "../probe/view.ts";
import type { CaptureOrigin, RequestMessage } from "../snapshot.ts";
import { sameDeclaration, trimMatchedEnds, type UnmatchedMessages } from "./diff.ts";
import type { GuardModel } from "./guard.ts";

/**
 * Forced prompt per capture, resolved by whichever deferred job asks first.
 * Weak keys release an entry with its capture.
 */
const FORCED_PROMPTS = new WeakMap<ForcedPromptInput, string | undefined>();

/** A baseline message with the session entry that owns it. */
export interface BaselineMessage {
	readonly entryId: string;
	readonly message: RequestMessage;
}

/** Filtered session projection at capture time. */
export interface Baseline {
	/** Session leaf; `buildSessionProjection(entries, leafId)` rebuilds these messages. */
	readonly leafId: string | null;
	readonly messages: readonly BaselineMessage[];
}

/**
 * Text of one request system message, without its tool changes. The payload
 * guard renders it as Pi does, at its position, for models that keep later
 * system messages in place.
 */
export interface SystemText {
	/** Number of non-system request messages before this one. */
	readonly position: number;
	/** Plain content; text blocks are joined as Pi renders them. */
	readonly content: string;
	readonly sections?: Readonly<Record<string, string | null>>;
}

/**
 * The parts of a request the deferred diff and the payload guard need, as this
 * extension's handler saw them. Request-side objects are owned copies, except
 * declarations equal to the baseline's: those are the baseline's own objects,
 * which are only read. Strings are kept by reference.
 */
export interface RequestCopy {
	/** The request's replayed system state; undefined when it has none. */
	readonly system?: SystemMessage;
	/** Every request system message's text, in order. */
	readonly systemTexts: readonly SystemText[];
	/** Every definition declared in the request, latest per name, including tools removed later. */
	readonly declarations: readonly Tool[];
	/**
	 * Non-system messages left after removing the ends both sides share: session
	 * originals on the baseline side, copies on the request side.
	 */
	readonly conversation: UnmatchedMessages;
}

/**
 * Everything the deferred diff needs from one request. Process-local: it holds
 * raw content and is released once its snapshot is built.
 */
export interface CapturedRequest extends RequestCopy {
	readonly id: number;
	readonly origin: CaptureOrigin;
	readonly baseline: Baseline;
	/**
	 * `ctx.getSystemPrompt()` at capture. Deferred jobs compare it with the
	 * baseline replay to detect a forced prompt ({@link resolveForcedPrompt}).
	 */
	readonly effectivePrompt: string;
	/** `ctx.model` at capture: the dispatched model on a physical selection, the virtual one otherwise. */
	readonly requestModel?: GuardModel;
	/** Tools Pi left out of the request; absent when it hid none. */
	readonly hiddenTools?: readonly string[];
}

/** What forced-prompt detection reads from a capture. */
export interface ForcedPromptInput {
	readonly effectivePrompt: string;
	readonly baseline: { readonly messages: readonly BaselineMessage[] };
}

/** Inputs of one capture, read from the `context_with_system` event and its context. */
export interface CaptureInput {
	readonly id: number;
	readonly origin: CaptureOrigin;
	readonly messages: readonly RequestMessage[];
	readonly sessionManager: Pick<ExtensionContext["sessionManager"], "buildSessionProjection" | "getLeafId">;
	/** `ctx.getSystemPrompt()`: Pi's effective prompt for the current run. */
	readonly effectivePrompt: string;
	readonly probe: Pick<ProbeView, "filterMessages">;
	/** `ctx.model`; its identity is copied before later handlers can change it. */
	readonly requestModel?: GuardModel;
	/** Pi's hidden declarations for the current run, from its `before_agent_start` options. */
	readonly hiddenTools?: readonly string[];
}

/**
 * Read the baseline, copy what differs from it, and keep the effective prompt
 * for deferred forced-prompt detection. Throws when a differing message or tool
 * cannot be cloned, for example when a handler added a function value to it.
 */
export function captureRequest(input: CaptureInput): CapturedRequest {
	const baseline = readBaseline(input.sessionManager, input.probe);
	return {
		id: input.id,
		origin: input.origin,
		baseline,
		...copyRequest(baseline.messages, input.messages),
		effectivePrompt: input.effectivePrompt,
		...(input.requestModel === undefined ? {} : { requestModel: copyGuardModel(input.requestModel) }),
		...(input.hiddenTools === undefined || input.hiddenTools.length === 0
			? {}
			: { hiddenTools: [...input.hiddenTools] }),
	};
}

/**
 * Copy the request's replayed system state and the messages that differ from
 * the baseline. Messages equal to the baseline at both ends, and declarations
 * equal to the baseline's of the same name, are compared in place and never
 * copied. System text positions and historical declarations also belong to
 * the copy: serializers may keep them instead of collapsing.
 */
export function copyRequest(baseline: readonly BaselineMessage[], messages: readonly RequestMessage[]): RequestCopy {
	const unmatched = trimMatchedEnds(baseline, messages);
	// Later handlers share these objects and may edit them in place
	const request = structuredClone(unmatched.request);
	const copyTool = createToolCopier(baseline);
	const system = getCurrentSystemMessage(messages);
	return {
		...(system === undefined ? {} : { system: copySystemState(system, copyTool) }),
		systemTexts: copySystemTexts(messages),
		declarations: getDeclaredTools(messages).map(copyTool),
		conversation: { prefix: unmatched.prefix, baseline: unmatched.baseline, request },
	};
}

/**
 * Read the canonical session projection Pi rebuilt this request from, without
 * recorded probe messages, keeping each message's source entry. The projection
 * returns stored session objects; they are only read, never changed.
 */
export function readBaseline(
	sessionManager: CaptureInput["sessionManager"],
	probe: CaptureInput["probe"],
): Baseline {
	const projection = sessionManager.buildSessionProjection();
	const messages = projection.entries.flatMap(({ sourceEntry, messages: entryMessages }) =>
		probe.filterMessages(entryMessages).map((message) => ({ entryId: sourceEntry.id, message })));
	return { leafId: sessionManager.getLeafId(), messages };
}

/**
 * The capture's forced prompt, replaying its baseline at most once: the
 * snapshot builder and the payload guard both read it, in either order.
 */
export function resolveForcedPrompt(capture: ForcedPromptInput): string | undefined {
	if (FORCED_PROMPTS.has(capture)) return FORCED_PROMPTS.get(capture);
	const forced = detectForcedPrompt(capture.effectivePrompt, capture.baseline.messages);
	FORCED_PROMPTS.set(capture, forced);
	return forced;
}

/**
 * The forced prompt of the current run, or undefined when the effective prompt
 * is the one the baseline replays. Pi records structured sections even for a
 * forced prompt and projects the forced text onto the request afterwards.
 * Runs off the request's critical path: baseline messages are append-only
 * session objects, so the replay matches the one at capture.
 */
export function detectForcedPrompt(effectivePrompt: string, baseline: readonly BaselineMessage[]): string | undefined {
	const replayed = getCurrentSystemPrompt(baseline.map(({ message }) => message));
	return effectivePrompt === replayed ? undefined : effectivePrompt;
}

/**
 * A function that returns, for each request tool, the baseline's declaration
 * of the same name when it is equal, else an owned copy. Each request object
 * is compared and copied once, so the current and historical declarations
 * keep sharing objects. Throws when a differing tool cannot be cloned.
 */
function createToolCopier(baseline: readonly BaselineMessage[]): (tool: Tool) => Tool {
	const baselineTools = new Map(getDeclaredTools(baseline.map(({ message }) => message))
		.map((tool) => [tool.name, tool]));
	const copies = new Map<Tool, Tool>();
	return (tool) => {
		let copy = copies.get(tool);
		if (copy === undefined) {
			const previous = baselineTools.get(tool.name);
			// Later handlers share request tools, schemas included, and may edit them in place
			copy = previous !== undefined && sameDeclaration(previous, tool) ? previous : structuredClone(tool);
			copies.set(tool, copy);
		}
		return copy;
	};
}

/**
 * The replayed system state with copied tools. Replay builds new containers
 * and strings are immutable, so content and sections need no copy.
 */
function copySystemState(system: SystemMessage, copyTool: (tool: Tool) => Tool): SystemMessage {
	return system.toolsAdded === undefined ? system : { ...system, toolsAdded: system.toolsAdded.map(copyTool) };
}

/**
 * Copy the text of every system message with its position. Strings are
 * immutable, so a shallow copy of the sections suffices; tool changes are
 * left out because the replayed system state already holds them.
 */
function copySystemTexts(messages: readonly RequestMessage[]): SystemText[] {
	const texts: SystemText[] = [];
	let position = 0;
	for (const message of messages) {
		if (message.role !== "system") {
			position++;
			continue;
		}
		const content = contentText(message.content);
		texts.push(message.sections === undefined
			? { position, content }
			: { position, content, sections: { ...message.sections } });
	}
	return texts;
}

/**
 * Copy the identity and the capabilities message normalization reads, before
 * later handlers can change the model object. Only top-level `compat` flags
 * are read, so a shallow copy suffices.
 */
function copyGuardModel(model: GuardModel): GuardModel {
	return {
		provider: model.provider,
		api: model.api,
		id: model.id,
		input: [...model.input],
		...(model.compat === undefined ? {} : { compat: { ...model.compat } }),
	};
}
