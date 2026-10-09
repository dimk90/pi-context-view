/**
 * PayloadGuard: deferred comparison of the tool-declaration and message
 * channels, and dispatch confirmation (D4, D7). Physical selections parse
 * immediately after the payload copy; virtual selections keep the copy until
 * dispatch supplies the model.
 */
import type { Dispatch, GuardFinding, GuardResult } from "../snapshot.ts";
import {
	type ConvertedRequest, type ConvertibleCapture, convertCapturedRequest, renderExpectedUnits,
} from "./adjustments.ts";
import { compareMessageUnits } from "./messages.ts";
import {
	copyPayload, type PayloadCopy, type PayloadDeclaration, parsePayloadMessages, parsePayloadTools,
} from "./payload.ts";
import { compareToolDeclarations } from "./tools.ts";

/** Model identity and the capabilities message normalization reads. */
export interface GuardModel {
	readonly provider: string;
	readonly api: string;
	readonly id: string;
	/** Input modalities; without `image`, Pi replaces images with placeholders. */
	readonly input: readonly string[];
	/** API-specific compatibility settings; only top-level boolean flags are read. */
	readonly compat?: object;
}

/** What the guard reads from a capture, before releasing the transcript. */
export interface GuardCapture extends ConvertibleCapture {
	readonly id: number;
	readonly requestModel?: GuardModel;
	/** Tools Pi left out of the request; their missing declarations are expected. */
	readonly hiddenTools?: readonly string[];
}

/** Where guard results go; SnapshotBuilder in production. */
export interface GuardPublisher {
	/** Replace the earlier guard, including on a dispatch mismatch. */
	settleGuard(id: number, guard: GuardResult): void;
	/** Stop accepting updates after the final result. */
	release(id: number): void;
}

/** Ports of the guard. */
export interface PayloadGuardOptions {
	readonly publisher: GuardPublisher;
	/** Pi's `images.blockImages` setting, read at the payload hook. */
	readonly blockImages: () => boolean;
}

/** Catalog lookup, as `ctx.modelRegistry.find()` does. */
export type FindModel = (provider: string, modelId: string) => GuardModel | undefined;

/** Minimal comparison data; no schemas, image data, or signatures. */
interface ExpectedRequest {
	readonly declarations: readonly PayloadDeclaration[];
	/** Undefined when the captured request could not be converted. */
	readonly transcript?: ConvertedRequest;
}

/**
 * Result of comparing one channel:
 *   compared      the channel was compared; `findings` may be empty
 *   unsupported   the channel could not be compared, for `reason`
 */
type ChannelResult =
	| { readonly status: "compared"; readonly findings: readonly GuardFinding[] }
	| { readonly status: "unsupported"; readonly reason: string };

/** State retained until comparison and dispatch confirmation have both ended. */
interface PairedState {
	readonly id: number;
	readonly requestModel?: GuardModel;
	readonly blockImages: boolean;
	capture?: GuardCapture;
	expected?: ExpectedRequest;
	payload?: PayloadCopy;
	scheduled?: NodeJS.Immediate;
	/** The virtual route's catalog model, once known. */
	dispatchedModel?: GuardModel;
	dispatch?: Dispatch;
	/** A failure that replaces even a comparison already published on the physical path. */
	failure?: GuardResult;
	finished: boolean;
}

/** Compare payloads and release raw copies before retaining the final snapshots. */
export class PayloadGuard {
	private readonly options: PayloadGuardOptions;
	private readonly open = new Map<number, PairedState>();

	public constructor(options: PayloadGuardOptions) {
		this.options = options;
	}

	/** Copy synchronously in the payload hook; defer all comparison work. */
	public accept(capture: GuardCapture, payload: unknown): void {
		const state: PairedState = {
			id: capture.id,
			requestModel: capture.requestModel,
			capture,
			payload: copyPayload(payload),
			blockImages: this.options.blockImages(),
			finished: false,
		};
		this.open.set(state.id, state);
		this.schedule(state);
	}

	/**
	 * Read identity once, without parsing in a stream handler. Physical identity
	 * mismatches invalidate the result, never reparse. Virtual
	 * requests use the dispatched model's API, not the payload shape.
	 */
	public confirm(id: number, dispatch: Dispatch, findModel: FindModel): void {
		const state = this.open.get(id);
		if (state === undefined || state.finished) return;
		state.finished = true;
		state.dispatch = dispatch;
		const model = state.requestModel;
		if (model?.api === "pi-virtual") {
			state.dispatchedModel = findModel(dispatch.provider, dispatch.model);
			if (state.dispatchedModel === undefined || !sameDispatch(toDispatch(state.dispatchedModel), dispatch)) {
				state.failure = { status: "incomplete", reason: "The dispatched model is not registered.", dispatch };
			}
		} else if (model !== undefined && !sameDispatch(toDispatch(model), dispatch)) {
			state.failure = {
				status: "incomplete", reason: "The dispatched provider, API, or model differs from the captured selection.", dispatch,
			};
		}
		this.schedule(state);
	}

	/** A paired request ended without dispatch metadata; discard any provisional result. */
	public finishUnconfirmed(id: number): void {
		const state = this.open.get(id);
		if (state === undefined || state.finished) return;
		state.finished = true;
		state.failure = { status: "incomplete", reason: "No dispatch identity was observed for this request." };
		this.schedule(state);
	}

	/** Cancel scheduled work and release payloads and comparison inputs at shutdown. */
	public clear(): void {
		for (const state of this.open.values()) {
			if (state.scheduled !== undefined) clearImmediate(state.scheduled);
		}
		this.open.clear();
	}

	/** Schedule at most one job per request; failures never escape into the host. */
	private schedule(state: PairedState): void {
		if (state.scheduled !== undefined) return;
		state.scheduled = setImmediate(() => {
			state.scheduled = undefined;
			try {
				this.process(state);
			} catch {
				this.options.publisher.settleGuard(state.id, {
					status: "incomplete", reason: "The payload could not be compared.",
				});
				state.capture = undefined;
				state.expected = undefined;
				state.payload = undefined;
			}
			if (state.finished) {
				this.open.delete(state.id);
				this.options.publisher.release(state.id);
			}
		});
	}

	/** Reduce the capture to comparison data first, even while a virtual request waits for dispatch. */
	private process(state: PairedState): void {
		if (state.failure !== undefined) {
			this.options.publisher.settleGuard(state.id, state.failure);
			return;
		}
		if (state.capture !== undefined) {
			state.expected = reduceCapture(state.capture, state.blockImages);
			state.capture = undefined;
		}
		const model = state.requestModel?.api === "pi-virtual" ? state.dispatchedModel : state.requestModel;
		if (model === undefined && state.requestModel?.api === "pi-virtual") return;
		const copy = state.payload;
		const expected = state.expected;
		state.payload = undefined;
		state.expected = undefined;
		if (copy === undefined || expected === undefined) return; // Already compared on the physical path
		if (model === undefined) {
			this.options.publisher.settleGuard(state.id, {
				status: "incomplete", reason: "No model was selected for this request.",
			});
			return;
		}
		this.evaluate(state, copy, expected, model);
	}

	/**
	 * Compare both channels and publish their findings. Only two compared
	 * channels complete the guard; otherwise the compared one keeps its findings.
	 */
	private evaluate(state: PairedState, copy: PayloadCopy, expected: ExpectedRequest, model: GuardModel): void {
		const dispatch = state.dispatch ?? toDispatch(model);
		if (!copy.supported) {
			this.options.publisher.settleGuard(state.id, { status: "incomplete", reason: copy.reason, dispatch });
			return;
		}
		const tools = compareToolChannel(copy.payload, expected, model);
		const messages = compareMessageChannel(copy.payload, expected.transcript, model);
		const compared = [tools, messages].flatMap((channel) => channel.status === "compared" ? [channel.findings] : []);
		const failure = tools.status === "unsupported" ? tools : messages.status === "unsupported" ? messages : undefined;
		const guard: GuardResult = failure === undefined
			? { status: "complete", dispatch, findings: compared.flat() }
			: {
				status: "incomplete", reason: failure.reason, dispatch,
				...(compared.length === 0 ? {} : { findings: compared.flat() }),
			};
		this.options.publisher.settleGuard(state.id, guard);
	}
}

/**
 * The comparison data of a capture: the declarations Pi sends, without the
 * tools it hid, and the converted transcript. A request that cannot be
 * converted leaves only the message channel uncompared.
 */
function reduceCapture(capture: GuardCapture, blockImages: boolean): ExpectedRequest {
	const hidden = new Set(capture.hiddenTools);
	const tools = {
		declarations: (capture.system?.toolsAdded ?? [])
			.filter(({ name }) => !hidden.has(name))
			.map(({ name, description }) => ({ name, description })),
	};
	try {
		return { ...tools, transcript: convertCapturedRequest(capture, { blockImages }) };
	} catch {
		return tools;
	}
}

/** Compare the payload's tool declarations with the expected ones. */
function compareToolChannel(payload: unknown, expected: ExpectedRequest, model: GuardModel): ChannelResult {
	const parsed = parsePayloadTools(model.api, payload);
	if (parsed.status !== "parsed") return parsed;
	const findings = compareToolDeclarations({
		expected: expected.declarations,
		declarations: parsed.declarations,
		ignoreNameCase: model.api === "anthropic-messages",
	});
	return { status: "compared", findings };
}

/** Compare the payload's text units with those Pi would send for the captured request. */
function compareMessageChannel(
	payload: unknown,
	transcript: ConvertedRequest | undefined,
	model: GuardModel,
): ChannelResult {
	if (transcript === undefined) {
		return { status: "unsupported", reason: "The captured request could not be converted for comparison." };
	}
	const parsed = parsePayloadMessages(model.api, payload);
	if (parsed.status !== "parsed") return parsed;
	let expected;
	try {
		expected = renderExpectedUnits(transcript, model);
	} catch {
		// An unexpected message shape must not hide the tool channel's result
		return { status: "unsupported", reason: "The captured request could not be normalized for this model." };
	}
	const findings = compareMessageUnits(expected, parsed.units, { ignoreNameCase: model.api === "anthropic-messages" });
	return { status: "compared", findings };
}

/** Dispatch identity without mutable model metadata. */
function toDispatch(model: GuardModel): Dispatch {
	return { provider: model.provider, api: model.api, model: model.id };
}

/** Whether two identities name the same provider, API, and model. */
function sameDispatch(a: Dispatch, b: Dispatch): boolean {
	return a.provider === b.provider && a.api === b.api && a.model === b.model;
}
