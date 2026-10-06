/**
 * PayloadGuard: deferred tool-channel comparison and dispatch confirmation
 * (D4, D7, D9). Physical selections parse immediately after the payload copy;
 * virtual selections keep the copy until dispatch supplies the model.
 */
import { type Api, getCurrentTools, type Model, type SystemMessage } from "@earendil-works/pi-ai";

import type { DeclaredTools, Dispatch, GuardResult } from "../snapshot.ts";
import { copyPayload, type ParsedTools, type PayloadCopy, type PayloadDeclaration, parsePayloadTools } from "./payload.ts";
import type { Baseline } from "./request.ts";
import { compareToolDeclarations } from "./tools.ts";

/** Guard reason while only the tool-declaration channel is compared. */
export const MESSAGES_NOT_COMPARED_REASON = "Message edits after the monitor are not compared yet.";

/** Model identity at capture; message normalization will also need its capabilities. */
export type GuardModel = Pick<Model<Api>, "provider" | "api" | "id">;

/** What the guard reads from a capture, before releasing the transcript. */
export interface GuardCapture {
	readonly id: number;
	readonly requestModel?: GuardModel;
	readonly system?: SystemMessage;
	readonly baseline: Baseline;
}

/** Where guard results go; SnapshotBuilder in production. */
export interface GuardPublisher {
	/** Replace the earlier guard and declared names, including on a dispatch mismatch. */
	settleGuard(id: number, guard: GuardResult, declaredTools?: DeclaredTools): void;
	/** Stop accepting updates after the final result. */
	release(id: number): void;
}

/** Ports of the guard. */
export interface PayloadGuardOptions {
	readonly publisher: GuardPublisher;
	/** Read at the payload hook, before active tools can change while awaiting dispatch. */
	readonly loadoutCandidates: () => readonly string[];
}

/** Catalog lookup, as `ctx.modelRegistry.find()` does. */
export type FindModel = (provider: string, modelId: string) => GuardModel | undefined;

/** Minimal comparison data; no transcript, schemas, images, or signatures. */
interface ExpectedTools {
	readonly declarations: readonly PayloadDeclaration[];
	readonly baselineNames: readonly string[];
}

/** State retained until comparison and dispatch confirmation have both ended. */
interface PairedState {
	readonly id: number;
	readonly requestModel?: GuardModel;
	readonly candidates: readonly string[];
	capture?: GuardCapture;
	expected?: ExpectedTools;
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
			candidates: [...this.options.loadoutCandidates()],
			finished: false,
		};
		this.open.set(state.id, state);
		this.schedule(state);
	}

	/**
	 * Read identity once, without parsing in a stream handler. Physical identity
	 * mismatches invalidate the result and declared names, never reparse. Virtual
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

	/** Release transcript references even while a virtual request waits for dispatch. */
	private process(state: PairedState): void {
		if (state.failure !== undefined) {
			this.options.publisher.settleGuard(state.id, state.failure);
			return;
		}
		if (state.capture !== undefined) {
			state.expected = {
				declarations: (state.capture.system?.toolsAdded ?? []).map(({ name, description }) => ({ name, description })),
				baselineNames: getCurrentTools(state.capture.baseline.messages.map(({ message }) => message)).map((tool) => tool.name),
			};
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
			this.options.publisher.settleGuard(state.id, { status: "incomplete", reason: "No model was selected for this request." });
			return;
		}
		this.evaluate(state, copy, expected, model);
	}

	/** Parse the tool channel and publish findings plus names; the message channel remains unavailable. */
	private evaluate(state: PairedState, copy: PayloadCopy, expected: ExpectedTools, model: GuardModel): void {
		const parsed: ParsedTools = copy.supported
			? parsePayloadTools(model.api, copy.payload)
			: { status: "unsupported", reason: copy.reason };
		const dispatch = state.dispatch ?? toDispatch(model);
		if (parsed.status !== "parsed") {
			this.options.publisher.settleGuard(state.id, { status: "incomplete", reason: parsed.reason, dispatch });
			return;
		}
		const comparison = compareToolDeclarations({
			expected: expected.declarations,
			declarations: parsed.declarations,
			baselineNames: expected.baselineNames,
			ignoreNameCase: model.api === "anthropic-messages",
			loadoutCandidates: () => state.candidates,
		});
		this.options.publisher.settleGuard(state.id, {
			status: "incomplete", reason: MESSAGES_NOT_COMPARED_REASON, dispatch, findings: comparison.findings,
		}, comparison.declaredTools);
	}
}

/** Dispatch identity without mutable model metadata. */
function toDispatch(model: GuardModel): Dispatch {
	return { provider: model.provider, api: model.api, model: model.id };
}

/** Whether two identities name the same provider, API, and model. */
function sameDispatch(a: Dispatch, b: Dispatch): boolean {
	return a.provider === b.provider && a.api === b.api && a.model === b.model;
}
