
## `Request-only capture`

Migrate from the frozen Initial capture in [ARCHITECTURE.md](ARCHITECTURE.md) to the design in
[REQUEST-ONLY-INJECTIONS.md](REQUEST-ONLY-INJECTIONS.md). Do the steps in order. Each step keeps
`pnpm check` green and both views working, and updates `doc/ARCHITECTURE.md` and the owning UI page
for the behavior it changes.

Decisions: Injections keeps the full composition and adds request-only changes; probing stays
automatic (manual probing is in the backlog); the D4 parsing strategy is chosen in its own step;
code kept only for Pi versions before 1.0 is removed, not migrated.

Probe hardening was implemented separately from the full migration: filtering now
runs in `context_with_system`, owned `turn_end` boundaries append omission edits,
and conservative preconditions skip risky probes. Initial capture remains in
`context`. Keep these behaviors when splitting the probe layer below. Pi 1.0
normally aborts before payload hooks, so probe payload guards settle incomplete.

- [x] **Prerequisites and validation harness**:
  - Add `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` as `"*"` peer dependencies with exact development pins; run `pnpm install`.
  - Update the dependency contract in `AGENTS.md` and the pin step in `doc/RELEASE.md` for four Pi packages.
  - Build the harness from the Validation section: local mock provider (OpenAI Completions and Anthropic streaming, tool calls, delayed stream events, controlled failures, a text-only model), isolated `PI_CODING_AGENT_DIR`, RPC driver.
  - Add fixtures: `context` add/modify/delete, `context_with_system` section patch, in-place mutation, `before_provider_request` rewrite, `cache_warming_decision` returning `warm`.

- [x] **Demo extensions for request-only injections**:
  - Write small dummy extensions under `test/fixtures/`, one kind of change each. Each uses its own marker text, so the change is easy to find in the views and in the request. Reuse the harness fixtures where they fit.
  - System prompt: append text, modify a section, and delete a section in `context_with_system`; a forced prompt from `before_agent_start`.
  - Conversation in `context`: add a custom message with a `customType`, add a user message, modify a message's text, delete a message, reorder messages, and mutate `event.messages` in place.
  - Payload in `before_provider_request`: add, modify, and delete a message; remove a tool declaration.
  - Load each extension before and after pi-context-view. Write the expected result for both orders in the fixture's header comment: structured change with its source, unattributed change, **edited after monitor**, or not visible.
  - Check both views in a real session against a `before_provider_request` logger loaded last. Check that a change from an extension loaded after ours is shown as expected and never as "no edits".
  - Record the results per version in `scripts/demo-injections.md`; start pi with all demo extensions through `scripts/demo-injections.sh`.

- [x] **Remove pre-1.0 compatibility**:
  - Remove the Pi 0.80–0.85 prompt parser from `src/measure.ts`, `src/prompt-blocks.ts`, and `src/prompt-additions.ts`: unwrapped `Available tools:`, `Guidelines:`, and `Pi documentation` headers, the `Current working directory` and `Current date` footer, moved-block recovery from headers, the custom-tools filler rule, and helpers that only this parser uses. Remove or rewrite their tests.
  - Keep the XML-section path with its `Moved` and `Dropped` markers. Pi 1.0 always renders a `cwd` section, so only a forced prompt can have no sections: measure it as one System Prompt part and specify that in `doc/ui/injections.md`.
  - Check on the harness which stop reason and error message Pi 1.0 gives the probe's aborted assistant message. Keep only those forms in `blankProbeAbort()`; keep both the Node.js and Bun messages.
  - Read the projection with `ctx.sessionManager.buildSessionProjection()` instead of the `buildSessionContext()` workaround in `src/index.ts`.
  - Keep Usage's live prompt/tool fallback for branches with no recorded system message yet, such as a new session before its first prompt; drop the "legacy" wording.
  - Remove pre-1.0 notes from `doc/ARCHITECTURE.md` and code comments: the legacy parser section, Pi 0.84 abort notes, compaction on Pi without `session_compact_failed`, and "checked against pi 0.86.1".
  - Decide whether to report an unsupported Pi version once, using `VERSION`, instead of capturing nothing: Pi before 0.87 never fires `context_with_system`.
    Decided: before Pi 1.0.0, register no lifecycle handlers; every `/context` form, including `config`, only reports the required version.
  - Add a `Changed` entry to `CHANGELOG.md` for the removed compatibility.

- [x] **Probe layer** (D10):
  - Split `src/capture.ts` into ProbeFilter (identities, restore, `filterMessages`) and SilentProbe (token, claim, abort, blanking, persistence). Keep the SilentProbe lifecycle unchanged.
    Decided: modules in `src/probe/` (`filter.ts`, `silent-probe.ts`, `view.ts`, and `token.ts`, moved from `src/probe-token.ts`), each layer with a `register*()` function called from `src/index.ts`; `CompactionState` moved to `src/compaction.ts`. SilentProbe gets a `hasCapture` callback instead of importing capture.
  - Preserve the existing `context_with_system` filter when extracting ProbeFilter; it returns nothing when no message matches. Keep the self-filter in the old Initial capture until it is removed.
  - Expose the `ProbeView` interface (`isCurrentRun`, `filterMessages`) for capture.
  - Preserve `turn_end` omission drafts and identity filtering for branches before those edits. Only unomitted blank probe entries remain visible to `context` and earlier `context_with_system` handlers.
  - Test that system messages keep their positions after probes on a model with `supportsMidConvoSystemMessages`; run the lifecycle smoke test with the three fixtures in both orders and an `after_provider_response` sentinel.

- [x] **Refuse views during compaction**:
  - Current behavior: "If compaction is active, return a partial fallback without probing".
  - Decided: both views refuse with a warning and do not open, checked before and after resolving Initial.
    The probe precondition stays as a safety guard; its fallback is no longer shown.

- [x] **SnapshotStore** (D11):
  - Add snapshot types (`RequestSnapshot`, `StructuredChanges`, `GuardResult`, `DeclaredTools`, `SnapshotReader`) and move `CaptureOrigin` out of `src/model.ts`.
  - Retain the first and latest snapshot per origin; a guard update replaces the copy with the same ID; `subscribe()` reports every publication; clear on `session_shutdown`.
  - No Pi imports. Unit-test retention, replacement, and selection without an origin.
    Decided: types and store in `src/snapshot.ts`, type-only Pi imports allowed; `src/index.ts` clears it on `session_shutdown`. Change and finding types are minimal; the Structured capture and Payload guard steps extend them.

- [x] **Structured capture** (D2, D3, D5, D6):
  - RequestTracker: number captures, set the origin from `ProbeView`, settle an unpaired capture `incomplete` on the next capture or `agent_settled`. Until the payload guard exists, every guard settles `incomplete`.
  - ProjectionReader: read `buildSessionProjection()`, filter probe messages, keep source entry IDs and the leaf ID.
  - TranscriptCapture: clone `event.messages` synchronously; detect a forced prompt with `getCurrentSystemPrompt(baseline)`.
  - Differ: compare replayed system state (sections and declarations separately) and align conversation messages with an LCS diff; pair modifications; keep baseline entry references. Decide whether `src/transcript.ts` replay is replaced by `getCurrentSystemMessage()`.
    Decided: replaced everywhere, Usage included; `src/transcript.ts` keeps only its render and copy helpers. A request message that copies a deleted baseline message is never paired, so a reorder stays a deletion plus an addition.
  - Attributor: `customType` for added messages, `details` provenance when present, everything else unattributed.
  - SnapshotBuilder: deferred work, publish with guard `pending`, release clones. Keep raw content process-local.
  - Register in `src/index.ts` after ProbeFilter, in every run mode. Run beside the old Initial capture; views do not read snapshots yet.
    Decided: modules in `src/capture/` beside the old `src/capture.ts`. Snapshots redact the messages they retain (image data, signature bytes), so the privacy rule stays unchanged.
  - Test the empty diff (first and later prompts, tool follow-ups, resume with another model, compaction, after a probe), structured edits, forced prompts in real and probe runs in both load orders, and capture in RPC mode without consumers.

- [ ] **ProbeTrigger** (D10, automatic policy):
  - Replace `resolveInitialCapture()` in `src/command.ts`: wait for idle, one attempt per runtime, concurrent callers share it.
  - Preserve the implemented guards for compaction, reported pending messages, virtual selections, idle warming, excessive known context usage and unreadable settings.
  - Resolve with the first `synthetic-probe` snapshot published after the start whose guard has settled, or with the failure reason.
  - Keep the TUI mode guard in the command; ProbeTrigger itself has none.
  - Remove the `hasCapture` callback of `registerSilentProbe()` and the `captured` probe outcome: ProbeTrigger reads the result from the store.

- [ ] **Injections on snapshots** (full composition and changes):
  - Select `first()`; ask ProbeTrigger when the store is empty; keep today's degraded fallback.
  - Build the composition from the snapshot baseline: rebuild with `buildSessionProjection(entries, leafId)`, replay the system state, and measure it the way Usage does today. A forced prompt is measured as the prompt.
  - Decide whether the `before_agent_start` prompt boundary (`promptAtHandler`) is still needed for splitting prompt additions, now that structured prompt edits are in the baseline.
  - Add request-only changes: added messages under their `customType` source or unattributed; modifications and deletions with their baseline message; system patches.
  - Label probe snapshots; show a pending or incomplete guard as an unavailable comparison, never as "no edits".
  - Specify rows and previews for modifications and deletions in `doc/ui/injections.md` before implementing them.

- [ ] **Usage on snapshots and old capture removal** (D11, [#6](https://github.com/dimk90/pi-context-view/issues/6)):
  - Select `latest()` instead of Initial. Apply conversation changes by baseline entry: count additions, replace modified messages, remove deleted ones. Drop stale changes whose entry is no longer in the current projection.
  - Decide whether request-only system patches still apply to Usage: D11 lists only conversation changes.
  - Remove `InitialCaptureState`, the `context` handler, `measureInjectedMessages()` and its JSON-signature matching, the request-only merge in `buildUsageSnapshot()`, and the `requestOnly` and `systemMessage` item fields.
  - Add a test that `src/ui/` and `src/usage.ts` import no capture or probe module.

- [ ] **Verify the fix for [#6](https://github.com/dimk90/pi-context-view/issues/6)**:
  - Unit test the issue's reproduction on the new path: the baseline has a 40,000-character user message, and an earlier `context` handler replaced it with `bbbb`. Differ reports one modification that references the baseline entry; Usage estimates 1 token for it, not 10,001.
  - Unit test a removal (the original is no longer counted), a reorder (counted once), and a stale modification after branch navigation or compaction (dropped; the current message is counted).
  - Verify in a real session: a fixture `context` handler replaces one user message and removes another; load it in both orders and compare Usage with the observed request.
  - Remove the known limitation from `doc/ARCHITECTURE.md`. Add a `Fixed` entry to `CHANGELOG.md` that links #6 and credits the reporter, as for #5.

- [ ] **Choose the payload-parsing strategy** (D4):
  - Spike on the harness: dispatch-event order per adapter, `ctx.modelRegistry.find()` results for routed models, payload clone size, and shape ambiguity between OpenAI Completions, OpenAI Responses, and Anthropic.
  - Choose option A, option B, or the hybrid. Record the choice in D4 and update the code skeleton.

- [ ] **Payload guard** (D4, D7, D9):
  - RequestTracker pairing: latest unpaired capture; agent-level and provider-level retries; warm refreshes marked by `cache_warming_decision` plus a one-token output limit and skipped; release pending data on settlement and shutdown.
  - DispatchConfirmer: assistant `message_start`, `provider_stream_event`, assistant `message_end` as fallback; once per paired request; return quickly and treat `event.data` as read-only.
  - PayloadParser: message and tool-declaration channels for the supported APIs; unknown or ambiguous payloads settle `incomplete`.
  - PayloadGuard: normalize every Pi adjustment listed in D4; report the rest as **edited after monitor**.
  - LoadoutAttributor: explain missing declarations with active `model-only` candidates from `pi.getAllTools()`.
  - DeclaredTools: record declared and baseline tool names when the tool-declaration channel is complete.
  - Standard Pi 1.0 probes have no payload: settle their guards incomplete on settlement. Pair any payload from a nonstandard host normally; blanking keeps the assistant message's provider, API, and model.
  - Test late edits, built-ins (codemode normal and `only`, tool-search, MCP), routing and normalization, retries, cache warming, dispatch timing, incomplete comparison, and probe payloads.

- [ ] **Guard results in the views** (D7, D9, D11):
  - Injections: late edits without structure or attribution, hidden declarations with their candidates, guard status. Update `doc/ui/injections.md`.
  - Usage: filter replayed tools by `declaredTools` from the latest snapshot that records them, with the freshness and fallback rules; hidden tools drop out without a finding. Update `doc/ui/usage.md`.

- [ ] **Verify the fix for [#11](https://github.com/dimk90/pi-context-view/issues/11)**:
  - Unit test DeclaredTools with OpenAI Completions and Anthropic payloads that declare only `codemode` and `__pi_deferred_placeholder__`, against a baseline that replays `read`, `bash`, `edit`, `write`, and `codemode`. Declared names are `codemode` only; the placeholder never appears. Add Anthropic payloads where tools are added, removed, or redefined later through inline `tool_addition` and `tool_removal` blocks (Pi 1.0.1); declared names follow those blocks.
  - Unit test Usage: Built-in Tools neither lists nor counts hidden tools. It counts every replayed tool before the first snapshot, after an active-tool change, and with an incomplete tool-declaration channel.
  - Unit test Injections: hidden tools appear as hidden declarations with their `model-only` candidates, not as sent Built-in Tools.
  - Verify in a real session with `"codemode": { "mode": "only" }`: after a prompt, and after a later probe, `/context` counts only `codemode`; a probe before the first prompt records no declared names, so Usage counts every replayed tool; a `before_provider_request` logger confirms the declared names. Change active tools and reopen Usage before and after the next request.
  - Add a `Fixed` entry to `CHANGELOG.md` that links #11 and credits the reporter.

- [ ] **Adopt tests from [#9](https://github.com/dimk90/pi-context-view/pull/9)** (the PR's capture code is not merged):
  - Turn `examples/test.ts` into a fixture under `test/fixtures/` that changes the request at four points. Run it in both load orders and expect the design's results:
    - `before_agent_start` custom message: in the baseline, no change.
    - `context` user message: structured addition.
    - `context_with_system` custom message: structured addition with its `customType` when loaded before the monitor; **edited after monitor** when loaded after.
    - `before_provider_request` payload message: **edited after monitor** when loaded before the monitor; not visible when loaded after.
  - Adapt the `before_provider_request` test in `test/index-context.test.ts`: capture handlers return nothing and leave the payload and `event.messages` unchanged (D5).
  - Adapt the pi-ide editor-context simulation in `test/provider-runtime.test.ts` to the payload guard: an unexplained payload user message is reported with its text, including non-ASCII text.
  - Move the `providerToAgentMessage()` cases (text-block flattening, mixed content with images, assistant blocks, system text blocks, unknown roles) to PayloadParser channel tests for each supported format. Image data must not reach previews.
  - Drop the `InitialCaptureState` rebuild test: the SnapshotStore tests cover retention.
  - The PR's statement that `before_provider_request` does not fire for a standard Pi 1.0 probe is verified by `test/probe-runtime.test.ts`; keep this regression test.
  - Credit the PR in the `CHANGELOG.md` entry for request-only capture: `([#9](https://github.com/dimk90/pi-context-view/pull/9) by [@Drakejiejie](https://github.com/Drakejiejie))`.

- [ ] **Final documentation and validation**:
  - Rewrite `doc/ARCHITECTURE.md` to describe the implemented design: lifecycle, module boundaries, privacy, and required invariants (snapshot retention replaces "Initial freezes exactly once"). Reduce `doc/REQUEST-ONLY-INJECTIONS.md` to open alternatives and rationale, or remove it.
  - Update `AGENTS.md` sources of truth and lifecycle verification, `README.md`, and `CHANGELOG.md`.
  - Run the full Validation matrix, the real-PTY and provider smoke tests from the `pi-extension` skill, and the `doc/UI.md` rendering matrix.

## `Backlog`

- [ ] **Manual probe trigger** (D10):
  - An explicit user action starts a new probe; one probe at a time, concurrent requests share it.
  - Choose a command or a view key; keep parsing, completions, registration text, README usage, and command tests in sync.
