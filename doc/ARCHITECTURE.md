# Capture and Usage Architecture

This document describes the current implementation, its limits, and the rules
that changes must preserve. It covers how pi builds a request, what this
extension can read, and how that data reaches the two views.

## Views and Data Sources

| View       | What it shows                                                                    | When its data changes                                       |
| ---------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Injections | First request's prompt, tools, custom messages, and marked request-only changes. | First snapshot's content stays fixed; its guard may settle. |
| Usage      | Replayed branch prompt/tools and messages, with the latest request's changes.    | Rebuilt from the current branch and store when it opens.    |

Both views read request snapshots that
[structured request capture](#structured-request-capture) publishes to
SnapshotStore for every request. A snapshot exists in two ways:

- **You send a prompt.** While pi prepares each model request, `pi-context-view`
  records how the request differs from the saved session. The request then
  continues normally. This is capture during a real turn.

- **You open Usage or Injections before anything has been captured.**
  `pi-context-view` can start a run with an empty user message so pi and other
  extensions execute their request-preparation handlers. It captures that run's
  request, but aborts before a request reaches the model provider. This is the
  [silent probe](#on-demand-silent-probe). It does not generate a model reply.

**Initial in Injections** is `SnapshotStore.first()`, across real turns and
probes. Injections rebuilds the session baseline at that snapshot's leaf.
[Injections on snapshots](#injections-on-snapshots) describes composition,
changes, and previews.

**Usage** applies `SnapshotStore.latest()` to the current session branch:
request-only additions are counted, modifications replace their session
message, and deletions remove it. See [Usage and Attribution](#usage-and-attribution).

Request-only changes are message, section, and tool versions that a request
carried but the saved session does not. They do not update the saved
conversation.

> [!NOTE]
> When resuming a session or reloading extensions, Initial reflects the next
> successful capture - not the session’s beginning. Once captured, it stays
> unchanged. Snapshots keep only changes, not ordinary conversation history.

## How Pi Prepares a Request

The following flow was checked against pi `1.0.0`. The notes on the right show
which parts `pi-context-view` uses or skips.

```text
Canonical session projection
  Read through buildSessionProjection()         USE: session branch baseline
  (branch, compaction, context edits, custom messages)
  |
  + New user message and pending messages
  |
  v
before_agent_start handlers                     PROBE: claim the probe run only
  Inject messages, change structured prompt options
  |
  + Persist system-section patches and tool changes
  |
  v
context handlers, in extension load order       NOT observed directly; every
  Conversation only; Pi restores system state     result reaches the next step
  |
  v
context_with_system handlers                    FILTER: known probe identities
  Full transcript, with system positions intact OBSERVE: structured snapshot
  |
  v
convertToLlm()                                  USE: selected estimates/previews
  Convert custom, bash, and summary messages
  to LLM-complaint format
  Drop bash executions excluded from context
  |
  v
Settings-specific conversion                    NOT used
  For example, replace blocked images
  with a text placeholder
  |
  v
Messages + effective prompt + active tools      READ: forced prompt, tool APIs
  |
  v
Provider-specific serialization                 NOT used
  Convert messages, system prompt, and tools
  into the provider's request format
  |
  v
before_provider_request handlers                NOT used for capture
  May replace the outgoing payload
  |
  v
Send to provider
```

This is a simplified flow. Pi rebuilds each request from the canonical session
projection. It can also compact history, route virtual models, and deliver
queued messages between requests. `before_agent_start` runs for a new
prompt, while `context` runs before each model call, including tool follow-ups.

Pi's `context` handler chain starts with a deep copy of the messages. Its result
is used for that request, not written back into session history. Rebuilding the
session branch later cannot recover those request-only changes.

### Supported Pi Versions

This extension requires Pi `1.0.0` or newer. It relies on `context_with_system`
filtering, `turn_end` omission edits, and the probe's abort form described
below. The Pi packages stay `"*"` peer dependencies, so an older Pi can still
load the extension. The factory therefore compares pi's `VERSION` with
`MIN_PI_VERSION` and, on an older Pi, registers no lifecycle handlers: nothing
is captured, probed, or filtered. Every `/context` form, including `config`,
then reports the required and running versions as an error and does nothing
else. A version without a numeric `major.minor.patch` core is treated
as supported.

### Pi APIs Use

- Use `ctx.sessionManager.buildSessionProjection().messages` to obtain the
  current branch's conversation messages, with compaction and context edits
  applied. Do not estimate usage
  directly from `buildContextEntries()`: it also returns bookkeeping records
  such as model changes, bookmarks, and saved extension state. Pi does not send
  those records to the model, so they must not contribute to token estimates.
  **Goal:** count current session messages in Usage and identify request-only
  changes by comparing this list, with source entry IDs, with each captured
  request.

- `ctx.getSystemPrompt()` reads Pi's effective prompt during a run, including
  `before_agent_start` edits and a forced prompt, which Pi renders instead of
  the structured sections. Pi clears per-run options on settlement, so an idle
  read is not the prompt used by the last request. It does not expose later
  provider-payload rewrites.
  **Goal:** detect a forced prompt during capture, and provide a view fallback
  only when the branch has no system messages.

- `ctx.getSystemPromptOptions()` reads the base prompt construction options in
  a command handler.
  **Goal:** keep `customPrompt` Dropped markers in Injections and measure the
  live fallback.

- `pi.getActiveTools()` and `pi.getAllTools()` supply the active tool names,
  definitions, and source information. `pi.getCommands()` supplies additional
  extension source information for prompt attribution.
  **Goal:** provide the views' live fallback.
  For transcript-backed views, recorded declarations supply definitions and the
  active set; current registration metadata supplies provenance and guideline
  attribution only. Unregistered recorded tools stay visible as unattributed.
  Tool and command source information also supports prompt-addition guesses.

- `convertToLlm()` supplies the text pi sends for bash and summary messages.
  It does not run extension handlers or build the final provider payload.
  **Goal:** estimate bash and summary messages using pi's formatted text, and
  build captured bash previews without unrelated message metadata.

- `ctx.getContextUsage()` supplies pi's reported usage and context window
  separately from this extension's category estimates.
  **Goal:** show pi's usage in the header and scale the map against the model's
  context window, without replacing the category estimates.

### Why Preparing a Model Request Can Have Side Effects

Before pi sends a request to the model, other extensions can change its system
prompt, active tools, or messages. They do this in functions registered for
pi events such as `before_agent_start` and `context`. These functions are the
**event handlers** mentioned in this document.

`pi-context-view` needs to observe the results of these handlers to capture
injected content and estimate its size. Reading the saved conversation alone
is not enough: an extension can add or replace content only in the outgoing
request, without saving those changes in the conversation.

However, running the handlers again to refresh a view would execute extension
code, not just read data. For example, a handler could:

- Add a message to the saved conversation.
- Update its own state, changing what it does on the next real turn.
- Write a file, create a checkpoint, show a notification, or make a network call.

Opening `/context` should not repeat those actions every time. Pi copies the
messages before running `context` handlers, but that copy only protects the
original message list. It does not prevent the other actions above.

Starting a new run also delivers pending messages and calls `input`,
`before_agent_start`, and turn handlers. Aborting before the model request is
sent does not undo actions that those handlers have already performed.
**Pi has no API for extensions to prepare the complete next request without
risking such side effects.**

`pi-context-view` normally captures requests while pi is already preparing
them for your prompts. This avoids starting another run - and repeating other
extensions’ actions - just to inspect the context.

If the user opens a view before any request snapshot exists, it can make one explicit
[silent probe](#on-demand-silent-probe). That probe still
runs other extensions' handlers, so it is limited to one attempt per extension
runtime. Later view opens read the existing capture and current pi data instead
of starting another run.

## Structured Request Capture

This is the first part of the design in
[REQUEST-ONLY-INJECTIONS.md](REQUEST-ONLY-INJECTIONS.md) (D2, D3, D5, D6,
D11). It publishes request snapshots to SnapshotStore. Injections reads the
first snapshot; Usage reads the latest. Capture runs in every mode,
independently of either consumer.

**Goal:** describe every request as structured changes against the session
projection, for any consumer, in every run mode.

```text
context_with_system, after ProbeFilter's handler     every request: prompts,
  Settle the previous unpaired capture's guard         tool follow-ups, probes
  Number the capture; origin from ProbeView
  Read buildSessionProjection(), filter probe messages per entry,
  keep each message's source entry ID and the leaf ID
  Compare in place: drop non-system messages equal at both ends
  structuredClone the rest and the request's replayed system state
  Forced prompt: ctx.getSystemPrompt() differs from
  getCurrentSystemPrompt(baseline)
  Return nothing
  |
  v  setImmediate, off the request's critical path
Align the rest, diff system state, attribute, redact,
publish with guard "pending"
  |
  v  next capture or agent_settled
Guard "incomplete": no payload was observed
```

- **Observe only.** The handler returns nothing and changes no event data.
  It compares and copies synchronously because later handlers share and may
  edit the same message objects, tool schemas included. Messages equal to the
  baseline at both ends of the conversation are compared in place and never
  copied, so an unchanged request copies only its replayed system state. A
  request whose differing messages cannot be cloned is not captured.
  `session_shutdown` cancels scheduled diffs.

- **Coverage.** The compared request holds every `context` change and the
  `context_with_system` changes of extensions loaded before this one. Later
  `context_with_system` handlers and payload rewrites are not visible here; the
  payload guard is a later step. Until it exists, every guard settles
  `incomplete`, never as "no edits".

- **System state.** Both sides are replayed with Pi's
  `getCurrentSystemMessage()`, so Pi's collapse of system messages after a
  changing `context` handler is not a change. Changed plain content, sections,
  and tool declarations are reported separately. A forced prompt is recorded
  as its effective text; the run's options outlive the request until settlement,
  so this also works in probe runs.

- **Conversation.** System messages are excluded. Each message is keyed by role,
  `customType`, and canonical JSON of its model-facing part; timestamps,
  `details`, `display`, and usage are ignored. The handler removes the equal
  ends with a direct comparison that agrees with these keys; anything outside
  plain JSON data falls back to comparing the keys. A Myers diff aligns the
  keys of the rest, so the edits match a diff of both whole sides.
  An unmatched request message is an addition and an unmatched baseline message
  a deletion. A deletion and an addition with the same role between the same
  aligned messages are a modification. A message whose exact copy is deleted
  elsewhere is never paired, so a reorder stays a deletion plus an addition.
  Modifications and deletions reference their baseline message's source entry.

- **Attribution.** Only a custom message names a source: its `customType`,
  plus `details.source` and `details.reason` when an extension provides them.
  Everything else is unattributed. For a modification or deletion, these
  fields describe the affected message, not the extension that edited it.

- **Retention.** A snapshot keeps changed request messages, entry IDs, system
  changes, and the forced prompt, with the [redaction](#images-and-provider-signatures)
  below. The request copy and the baseline are released once the snapshot
  is built; consumers rebuild the baseline with
  `buildSessionProjection(entries, leafId)`.

With no request-only changes, a snapshot is empty after first and later
prompts, tool follow-ups, resume with another model, compaction, and probes.

## Injections on Snapshots

`/context injections` selects `SnapshotStore.first()` without an origin. If the
store is empty, the command waits for idle and rechecks it before asking
ProbeTrigger. A turn that published while the command waited supplies Initial
without another run. A failed or skipped probe keeps the existing pi-native
degraded fallback; it never inserts a fallback into the store. Both compaction
checks and the TUI guard remain in the command.

`src/injections.ts` builds the composition when the view opens:

1. Rebuild `buildSessionProjection(entries, snapshot.leafId)` and filter known
   probe messages, retaining source entry IDs. Later messages, context edits,
   branch navigation, and compaction do not change this historical baseline.
2. Replay system state with `getCurrentSystemMessage()` and apply the snapshot's
   content, section, and declaration changes. Measure the result like Usage:
   recorded declarations supply definitions, current tool metadata supplies
   provenance and guidelines. Shared helpers live in `src/replay.ts`.
3. A forced prompt replaces the replayed prompt, so captured content/section
   patches do not apply to it; tool changes still apply. The System Prompt
   item carries the `forced` request-only change. Current
   `getSystemPromptOptions().customPrompt` preserves Dropped markers for
   `--system-prompt`. Other live prompt options do not replace recorded sections.
4. Keep session-backed custom messages. Replace their rows when modified or
   deleted. Add every request-only conversation change under its `customType`
   source or `unattributed`; unchanged ordinary conversation stays out of the
   Injections tree.

Added and modified rows count their request version. Deleted rows count zero.
A modified message previews `Request` and `Session` parts: only Request counts;
a deletion previews its session original. Message previews use the
content-only extraction in `src/message-preview.ts`. Snapshot
images already hold size markers; session originals are redacted on extraction.
Neither source's opaque signature bytes reach a preview.

System changes mark the affected prompt part or tool in place. These groups
identify the affected content, **not the editing extension**. Marking a pi part
never attributes its editor to pi. The replay supplies exact section boundaries,
including inline XML, empty or unwrapped sections, so repeated text cannot move
a marker onto another section. Deleted sections retain their original text at
zero tokens, after sent parts and before Extension Additions. A deleted tool
keeps its definition at zero tokens. The total counts only this view's
contributions, not unchanged ordinary history or provider serialization.

Prompt additions have no `before_agent_start` handler boundary: recorded
structured edits already belong to the baseline, and the forced prompt is
captured as final text. Unwrapped additions split at blank lines and section
boundaries; adjacent additions with no separator may share an attribution guess.

Probe snapshots carry the warning specified in [ui/injections.md](ui/injections.md).
Pending and incomplete guards appear as an unavailable late-edit comparison in
the description, never as "no edits". The view is fixed while open; reopening
reads a guard update with the same snapshot ID. Payload findings and hidden
declarations are later roadmap steps; this step reports only structured edits.

## Usage and Attribution

Usage is built when `/context` or `/context usage` opens. It does not capture a
new transformed request on each open.

```text
                             Open Usage
                                 |
                                 v
     Resolve the latest snapshot: existing one, one probe, or none
                                 |
                                 v
                        Collect view inputs
                                 |
         +-----------------------+---------------------------+
         |                       |                           |
         v                       v                           v
Live prompt/tool fallback   Latest snapshot           Current session branch
         |                       |                           |
         |                       |                           v
         |                       |                  buildSessionProjection()
         |                       |                  Filter probe messages,
         |                       |                  keep source entry IDs
         |                       |                           |
         |                       +-------------+-------------+
         |                                     |
         |                                     v
         |                           applyRequestSnapshot()
         |                  Conversation changes by entry; drop stale ones
         |                  System changes and forced prompt
         |                  only while still fresh
         |                                     |
         +-------------------------------------+
                                 |
                                 v
                       buildUsageSnapshot()
                  Replay system sections and tool deltas,
                  then the fresh request-only system changes;
                  a fresh forced prompt replaces the prompt text
                  (live fallback only without system state)
                                 |
                                 v
                           computeUsage()
                  Skip already-replayed system messages
                                 |
                                 v
                    Category estimates + previews
                                 |
                                 v
                     Usage map and breakdown
                                 ^
                                 |
                  Separate inputs: pi's reported usage/window,
                  model, auto-compaction reserve, display config
```

**Usage counts the replayed current state once, not the history of changes.**
`buildUsageSnapshot()` replays the branch's system messages in order with Pi's
`getCurrentSystemMessage()`: plain
`content` appends, `sections` replaces values by name (`null` removes one), and
`toolsRemoved` applies before `toolsAdded`. Replacing a tool uses its recorded
name, description, and schema, not today's registered definition. Removed tools
and superseded sections no longer contribute. An explicitly empty system state
is still authoritative; it must not revive the live prompt or active tools.

`buildSessionProjection()` already selects the current branch and applies compaction.
Its compaction checkpoint replaces earlier system messages, including system
messages in the retained range. The same replay therefore works after resume,
branch navigation, and compaction without a separate mutable state cache.

Only a branch with no recorded system message yet, such as a new session
before its first prompt, uses `buildNativeSnapshot()` and the caller's live
prompt/tools. Neither path reruns extension handlers.
Generated instruction-file and skill records are read from the recorded prompt,
not today's loader metadata. Custom XML sections remain named System Prompt
parts even after `cwd`; their tag does not establish extension ownership.

**Usage applies the latest request's changes to the current branch.** It reads
`SnapshotStore.latest()` across both origins, so a probe after the last real
turn supplies the changes. `src/projection.ts` applies them when the view opens:

- **Conversation changes, by baseline entry.** A modification replaces the
  first unchanged conversation message of its source entry with the request
  version; a deletion removes it; an addition is appended and classified like
  any other message by role or `customType`. A reorder, captured as a deletion
  plus an addition, is counted once. A modification or deletion whose entry is
  no longer in the current projection, after compaction or branch navigation,
  is stale and dropped: the current message is counted instead. Additions have
  no entry and always apply.
- **System changes, while fresh.** Content, section, and tool changes are
  deltas against the snapshot's replayed system state. They apply after the
  branch replay only while the current replayed state equals the state rebuilt
  at the snapshot's `leafId`; any recorded system change since capture drops
  them until the next request. Usage marks none of these changes.
- **Forced prompt, while fresh.** Pi 1.0 turns every `systemPrompt` returned
  from `before_agent_start` into a forced prompt, including the common
  `event.systemPrompt` plus appended text. Pi never records that text, and an
  idle read of the prompt returns the structured one, so only the snapshot
  holds it. The forced text renders the snapshot's system state, so it follows
  the same freshness rule as system changes. While it applies, Usage measures
  it in place of the replayed prompt, also in the live fallback. As Pi does,
  section and content changes do not apply to it, and tool changes still do.
  Pi's sections inside it are
  [measured as usual](#prompt-parts-and-moved-blocks), so appended text counts
  as an extension addition. Like Injections, Usage marks the System Prompt item
  `forced`, and its previews [show the marker](ui/usage.md#forced-prompt).

Without a snapshot, after a failed or skipped probe, Usage counts the current
branch alone and shows the degraded reason. Session-backed custom messages
count from the current branch once. `computeUsage()` skips system messages
because the prompt/tool snapshot already accounts for them.

This is a provider-independent semantic estimate, not a wire-size estimate.
Some providers keep earlier section versions or tool declarations in the cached
transcript; others collapse them. Usage deliberately does not count that history,
patch framing, or provider-specific serialization.

The UI receives `ctx.getContextUsage()` separately. Its reported total is not
used to force category estimates to match. Map rendering rules belong to
[ui/usage.md](ui/usage.md#context-map).

### Known Limitation: One Request's Changes

Usage assumes the next request repeats the latest request's changes, the forced
prompt included. A change that an extension makes only once, or only for a
particular prompt, therefore stays counted until the next request replaces the
snapshot. Additions carry no
entry reference, so they remain after branch navigation or compaction. A
modification whose entry is still projected replaces that entry's current
message even if a later `context_edit` changed it. Changes from later
`context_with_system` handlers and payload rewrites are not visible yet. Usage
is not an exact view of the last or next provider request.

## On-demand Silent Probe

### Why it is Needed

Before a real turn, pi's APIs can supply the current prompt, tools, and saved
session messages. That is enough for a partial view, but not for a request
snapshot's observation of extension handlers.

Without running a turn, this extension cannot observe:

- `before_agent_start` changes for that run: prompt edits, injected messages,
  and tool activation;
- request-only messages and transformations from `context` handlers and earlier
  `context_with_system` handlers.

Reading session history or calling `convertToLlm()` does not run those handlers.
The silent probe starts the lifecycle so capture can see them, then aborts
before a provider request. A probe uses the same capture handlers as a real
turn, so it does not widen capture coverage. An empty-input probe
also cannot reveal contributions that run only for a particular real prompt.

If the view's snapshot exists, no probe is needed: Injections checks the store's
first snapshot; Usage checks its latest. Either view can request the shared
one automatic attempt when its data is missing. Never probe in the background
or repeat it on every view open.

### Probe Lifecycle

ProbeTrigger (`src/probe/trigger.ts`) applies the automatic policy: at most one
attempt per extension runtime, and concurrent and later callers share its
result. The command asks it only while the store holds no snapshot.
ProbeTrigger has no run-mode guard; the command keeps the TUI-only check.

```text
/context
  Refuse the view if compaction is active
  Ask ProbeTrigger when the store holds no snapshot yet
  |
  v
ProbeTrigger
  Wait for idle
  Check compaction, pending messages, model, auth, and Pi settings
  If unsafe, report why without consuming the attempt; the command
  shows a partial fallback
  Otherwise subscribe to SnapshotStore, hide the working row, and call
  sendUserMessage("") inside this attempt's probe-token scope
  |
  v
input
  Empty the probe prompt again if an earlier transform added text to it
  |
  v
before_agent_start
  Claim this run if it carries the token, otherwise fail the attempt
  and leave the run alone
  |
  v
turn_start
  Abort before the provider; context processing still reaches our handler
  |
  v
message_end (user)
  Blank the synthetic prompt before Pi persists it
  |
  v
context_with_system
  Filter the request without changing system-message positions;
  capture then records the probe request
  |
  v
message_end (assistant)
  Blank the recorded abort result before Pi persists it
  |
  v
turn_end
  Append context_edit omissions for known probe entries on this branch
  |
  v
agent_settled
  SilentProbe: restore UI, persist probe identities, settle the attempt
  Capture: settle the probe request's guard as incomplete (no payload)
  ProbeTrigger: resolve with that synthetic-probe snapshot; open the view
```

ProbeTrigger subscribes to SnapshotStore before it sends the probe prompt and
resolves with the first `synthetic-probe` snapshot whose guard has settled.
Probes run one at a time, so that snapshot belongs to this probe. SilentProbe's
outcome only reports whether its run settled or failed; it knows nothing about
capture. Capture settles the guard in its own `agent_settled` handler, after
SilentProbe's, so ProbeTrigger waits up to one second after settlement before
it reports a missing snapshot. Injections and Usage read that snapshot through
the store's `first()` and `latest()` selections.

Use `sendUserMessage("")`. `pi.sendMessage(..., { triggerTurn: true })` skips
`before_agent_start`. Abort at `turn_start`, not `before_provider_request`,
because some transports skip the latter. On Pi 1.0's standard runtime path,
authentication rejects the already-aborted signal before provider headers and
payload serialization. Structured context handlers still run for physical
models, but a probe normally has no provider payload. A router honoring the
aborted signal can stop before context handlers; virtual selections are skipped.

“Silent” means no provider request and no transcript text of the probe's own.
This depends on correct run recognition: the
[nested-send limitation](#known-limitation-nested-sends) can break that guarantee.
It does **not** mean no side effects: other extensions see the lifecycle, and probe
entries remain in pi's session tree. This is why the probe is explicit and
limited to one attempt, rather than a way to refresh Usage repeatedly.

### Identifying the Probe Run

The probe has to know which agent run is its own. Prompt text cannot answer
that question: any other extension can rewrite the text in an `input` transform
before pi reports it. Emptying the prompt in this extension's own `input`
handler does not settle it either, because that only undoes transforms from
extensions loaded before this one.

Use the call's async context to correlate the run. Each attempt gets its own
token, and the command sends the synthetic prompt inside an `AsyncLocalStorage`
scope holding that token. Pi emits `input` and `before_agent_start` from inside
that same call, so both handlers can read the token even after an input
transform changes the prompt. One run may claim a token and after that, no later
run can. This assumes no nested send claims the token first: async context is
not a unique per-prompt identity.

Treat every run without the token as someone else's. Fail the attempt and show
the fallback, but let that run continue: it may be the user's prompt or another
extension's message, so never abort or rewrite it.

Keep watching for the probe run after the attempt ends. The attempt can end
early, on timeout or because a foreign run failed it, while the probe's own run
is still on its way. That run still carries the token, so it is still claimed,
aborted, and sanitized.

The token stays in this process. Never persist, render, or log it.

### Known Limitation: Nested Sends

`AsyncLocalStorage` propagates the token to async work started inside its scope,
including another extension's nested `pi.sendUserMessage()` call. It does not
identify only the original synthetic prompt, and descendant work can retain
the token after the outer `sendUserMessage()` call returns.

For example, another extension's async `input` handler can send a separate
message and wait briefly before returning:

1. The nested send inherits the probe token. While the probe is waiting, its
   input handler can erase the nested message's text.
2. The nested run reaches `before_agent_start` first and claims the token. It
   is aborted, and its messages are blanked and recorded as probe identities.
3. If that run settles before the original input handler returns, the probe
   state becomes `settled`.
4. The original synthetic prompt then reaches `before_agent_start`, but cannot
   claim the already-used token. Its abort guard stays inactive, so it can
   make a provider request and remain in later context as an ordinary message.

The token approach is more robust against text transforms than the previous
empty-input checks, which lost recognition when another extension added text
([issue #5](https://github.com/dimk90/pi-context-view/issues/5)). It also avoids
claiming unrelated empty inputs outside the token scope. It is **not fail-safe**,
however: nested sends can be mistaken for the probe, including non-empty sends
that the old checks would have left alone. A timeout or fallback does not fix
that ownership mistake or guarantee that the original probe is aborted.


### Keeping Probe Messages Out of Real Context

Track synthetic user and assistant messages by exact role and timestamp.
Never identify them by empty content: genuine empty messages and genuine aborts
must remain visible.

Blank both recorded probe messages in `message_end`: the synthetic prompt,
which may carry text an input transform added, and the assistant abort result.
Blanking removes their content before Pi stores the messages.

At the owned run's `turn_end`, append `context_edit` drafts with
`replacement: null` and the exact session entry IDs of known probe messages that
are still visible in `event.context.contextEntries`. That boundary projection
already applies compaction, earlier edits, and earlier handlers' drafts, so each
visible target is omitted once. Preserve other handlers' proposed entries and do
not request continuation. Pi applies
these omissions to future context even when this extension is absent. The raw
blank messages remain in the session tree. Use `turn_end`, not
`agent_before_settle`: an explicit abort skips the latter boundary.

Targets include identities restored from earlier runtimes. An omission persists
in the session file and outlives this extension, so a genuine message whose role
and timestamp match a probe identity would stay omitted, not only filtered in
memory. Such a collision needs the same millisecond timestamp; exact identities
keep it unlikely.

Keep identity filtering for Usage, capture comparison inputs, and requests.
Omission edits are branch-relative: navigating before an edit can reveal a probe
entry again. Old sessions and an interrupted run may also lack omissions.
Request filtering runs in `context_with_system`, returning nothing when no
identity matches. A changed `context` result would collapse Pi's system messages
into a leading checkpoint; filtering the full transcript preserves their
positions and cached prefixes. `context` handlers and earlier
`context_with_system` handlers can still see blank probe entries that have not
been omitted from the projection.

Pi reports the probe's `turn_start` abort with an `error` stop reason:
authentication rejects the already-aborted signal before streaming. Its error
message is the `AbortError` text of the JavaScript runtime that runs pi:

| Runtime                    | Error message                |
| -------------------------- | ---------------------------- |
| Node.js                    | `This operation was aborted` |
| Bun (standalone pi binary) | `The operation was aborted.` |

Blank such an error only for a recorded probe assistant with one of these exact
messages. Any other stop reason, including `aborted`, provider errors, and
cancellations of runs the probe does not own remain visible. A runtime with other wording leaves the error row visible: add
its exact message instead of matching abort text loosely.

Blanking cleans agent state, later model contexts, and the saved session, but
not the current screen: pi renders a user row when the message starts and does
not repaint it for a `message_end` replacement. Text another extension's input
transform added to the probe prompt therefore stays visible for that run and
disappears on reload or resume. Nothing of that text is sent or stored.

Persist only role-and-timestamp identities in `pi-context-view:probe-identities`
custom entries on `agent_settled` and `session_shutdown`. Restore all prior
identities on `session_start`, including after resume, reload, and fork. Omission
edits persist only target entry IDs and `null`. Neither record stores content.

### Compaction, Failures and Fallback

Pi 1.0's `waitForIdle()` includes compaction. Still recheck the tracked lifecycle
after waiting, because compaction can start before the probe is sent. Track
`session_before_compact` until its signal aborts or Pi reports `session_compact`
or `session_compact_failed`; do not infer completion from a later agent run.

Pi runs extension commands at once during compaction, so `/context` checks the
tracked lifecycle itself. While compaction is active, both views are refused
with a warning and do not open: compaction is about to replace the session
projection they read. The command checks before resolving its snapshot, so it never
waits for compaction, and again after, because compaction can start while it
waits for idle. The second check replaces that probe fallback with the refusal.

Before starting or consuming an attempt, use the fallback when:

- compaction is active or `ctx.hasPendingMessages()` reports queued input;
- the selected model is virtual (`api: "pi-virtual"`), since routing can make
  classifier calls or fail before capture;
- idle cache warming is enabled, since its refresh uses a separate abort signal;
- known context usage exceeds `contextWindow - reserveTokens` while automatic
  compaction is enabled, using Pi's `shouldCompact()` and per-model settings;
- Pi settings cannot be checked safely.

Compaction settings come from `pi.getSettings()`, so runtime changes apply; the
Usage map's auto-compaction reserve reads the same source. The warming check
also reads global settings with project settings disabled: Pi's warming mode is
global-only, but the merged API can hide it under an ignored project override.
An idle value in either source triggers fallback. Extensions cannot see an SDK
host's custom agent directory, so this file read uses Pi's default directory,
which honors `PI_CODING_AGENT_DIR`; an unsaved runtime warming change hidden by
a project override is also missed. Never write or change Pi settings to make a
probe possible.

These are conservative checks, not a lock on Pi or other extensions. Unknown
usage does not block probing; pre-prompt overflow recovery, hidden `nextTurn`
messages (not reported by `hasPendingMessages()`), later model/settings changes,
and arbitrary extension side effects remain possible. Default `streaming`
warming remains enabled in Pi and stops on settlement; slow handlers or other
extensions can still affect it. The nested-send ownership limitation also
remains. Strict zero-provider-request guarantees require passive capture.

Any skipped precondition above, a missing model, missing authentication, a
startup failure, a timeout, or a probe that settles without a request snapshot
reports a precise reason that extension additions were not observed.
Injections then shows a current prompt/tool snapshot; Usage counts the current
branch without request changes. Neither fallback enters the store.

Always restore the working-row state in `finally`. If the probe times out,
keep tracking its run until it settles: delayed synthetic messages must still
be sanitized and filtered.

## Measurement and Source Attribution

Attribution means deciding which source owns a contribution. Store source,
kind, and hierarchy in typed model fields. Never recover these facts by parsing
display labels.

### Token Estimates

Estimates need not match pi or provider totals. Tokenizers, images, provider
serialization, compaction timing, handler order, and payload rewrites can all
change the result.

- Do not add guessed token constants for message roles or content-block framing.
- Do not count protocol metadata just because it appears in the request.
  Examples include `ToolCall.id`, `ToolResultMessage.toolCallId`, and
  `ToolResultMessage.toolName`.
- Estimate compaction summaries, branch summaries, and context-visible bash
  messages with `estimateTokens(convertToLlm([message])[0])`. Conversion adds
  wrapper text that the provider receives. Exclude messages conversion drops.
  This estimate can intentionally exceed pi's own heuristic.
- Follow [THINKING.md](THINKING.md) for reasoning counts, opaque signatures,
  model retention, and thinking-preview notation. That page is the source of
  truth for the thinking formula and its measurement evidence.

### Prompt Parts and Moved Blocks

Pi wraps independently replaceable sections in XML. Map `tools`, `rules`,
`docs`, `addendum`, and `cwd` to Available Tools, Guidelines, Documentation,
Appended Prompt, and Current Dir. Keep the unwrapped preamble separately.
Read `project_context` instruction records and `skills` records as their existing
aggregates. Overridden content that is not those generated records stays visible
as a System Prompt part; never substitute stale loader content.

Custom `systemPromptOptions.sections` use their literal tag names as part labels;
overrides of known names retain existing labels. Sections can follow `cwd`, so
that section is not the end of structured content. Ignore nested tags and fenced
examples when locating top-level sections. The first occurrence of a tag owns
the part; later duplicates are unwrapped additions, not a second counted part.
Unwrapped text between or after sections uses the existing addition attribution.

Count and preview section bodies without the outer XML transport wrappers.
The tool sections retain leading bullet newlines for exact line attribution.
The counted parts concatenate back to the item's text and share its estimate.
Native tool surfaces use consecutive bullets and keep actual section order;
relocated `tools` and `rules` retain the Moved marker and tool references.
A custom prefix may restore individual native sections, so only absent ones
are marked Dropped.

A section after one pi normally renders later gets typed `moved` metadata.
This records position only: it does not prove who moved it or that its text is
unchanged. Moved native text still counts under System Prompt, and extension
tool lines keep their usual tool ownership. Never invent missing or withheld
tool lines.

Pi always renders a `cwd` section, so only a forced prompt can have no sections.
Measure such a prompt as one undivided System Prompt part. Text shaped like
pi's own blocks is not evidence of them there: it has no Moved, Dropped, or
Extension Additions parts, and its tools keep only their definitions. A forced
prompt that contains sections is measured like any other sectioned prompt.

### Tool Ownership and Preview References

Use `ToolInfo.sourceInfo` for tool ownership.

Separate a tool's complete prompt bullets only from the first `tools` and
`rules` sections, including moved ones. Never match unrelated text or only a prefix
of a longer bullet. Give each shared guideline bullet to the first tool that
declares it in pi's active-tool order, so it counts once. Pi's own bullets stay
in the base prompt.

For each separated extension line, retain its original position, source, and
owning tool as a typed preview reference. Keep that reference on the System
Prompt section and standalone child from which the line was removed. This
applies to both Available Tools snippets and Guidelines bullets.

References restore prompt order for inspection. They add no counted text,
characters, or tokens to the base item; the owning tool counts the content.
Only exactly matched, rendered lines receive references, except for the
explicit dropped-block case below.

### Blocks Dropped by a Custom System Prompt

When `--system-prompt` drops Available Tools, Guidelines, or Documentation,
keep those parts in the model and mark them as dropped. They must contain no
pi-authored counted text. They may contain preview references to extension
lines that pi would otherwise have rendered.

Each tool also keeps its dropped snippet and guideline sections. Every dropped
part or section has zero tokens and contributes no counted text, characters,
or token shares. Do not count text pi never sent.

### Extension Prompt Additions

For unwrapped gaps between or after XML sections:

- Split at blank lines and ignore whitespace-only gaps. Keep gaps on opposite
  sides of a section separate, so unrelated source evidence cannot mix.
- There is no `before_agent_start` handler boundary: adjacent unwrapped
  additions without a blank line may share a block.
- Name a source only when the text contains exactly one loaded package
  specifier or extension path from `getAllTools()`/`getCommands()` source data.
  Always mark that name as a guess: pi does not record who made each prompt edit.
- Add a tool or slash-command qualifier only when exactly one registered name
  from that same extension appears as a complete token. A path segment, a
  command without its slash, or a name shorter than three characters does not
  qualify. The qualifier changes only the display label.
- Keep everything else unattributed.

Count an addition under its assigned source, never again under pi's own prompt.
System Prompt holds these additions only as references in its Extension
Additions part.

### Totals and Structured Previews

- Children break down their parent; they are never extra tokens in a total.
- Labeled preview sections hold shares of the parent estimate. Their tokens
  must sum to the parent, not add to it.
- An item with children exposes each child as a labeled preview part with its
  estimate and any marked JSON range.
- Mark JSON ranges when capture or classification serializes them: tool
  schemas, tool-call arguments, and non-string message content. Do not guess
  whether preview text is JSON by inspecting its appearance.
- Compact provider-bound JSON backs the estimate. Expanding it for display is
  covered by [ui/previews.md](ui/previews.md#marked-json).

## Configuration

### Defaults and Loading

Defaults live in code. The global file at
`getAgentDir()/extensions/pi-context-view.json` holds overrides, so omitted
keys follow later default changes.

Never auto-create the file or write missing defaults into an existing file.
Load it only when a view needs it, not in the extension factory: the factory
also runs in commands that never start a session. Cache per runtime and reload
when the file's modification time changes.

- An absent file or omitted key silently uses the default.
- An unreadable or unparseable file, unknown key, invalid color, or out-of-range
  value falls back to the applicable default. Warn once per file revision,
  never fail the view.
- A renamed key keeps its old name as a silently accepted alias. If both names
  are present, the current name wins.

### Explicit Writes

`/context config` is the create-only action. It writes every default with one
atomic `O_EXCL` create and never overwrites or modifies an existing path. It
works in every run mode on a [supported Pi](#supported-pi-versions). Only the views require
`ctx.mode === "tui"`.

Any later action that updates an existing file must debounce writes and merge
over a fresh read, preserving concurrent edits and unknown keys.

Configuration stores preferences only, never captured prompts or messages.
See [CONFIG.md](CONFIG.md) for the settings, [UI.md](UI.md#color-and-casing)
for colors, and [ui/usage.md](ui/usage.md#context-map) for map geometry.

## Privacy

### Raw text and Message Previews

Keep raw prompt and message content in this process only. Sanitize it before
terminal rendering, and reveal it only after explicit Enter preview. Never log
it, include it in notifications, persist extra copies, or inject it into a
later model request.

Capture message content, not the whole message object:

- System previews contain plain `content` followed by non-deleted section text,
  even when `content` is empty. Omit text-block signatures. Deleted sections
  have no preview text or text-token contribution.
- Branch and compaction previews contain only `summary`.
- Bash previews use pi's `convertToLlm` text, including failure/cancellation
  notices and truncated-output file references.
- A bash message excluded from context has no preview text.
- Fields such as `timestamp`, `fromId`, and `tokensBefore` are not preview
  content.

This extraction does not change source messages, baseline matching, or token
estimates.

### Images and Provider Signatures

Never retain or render captured image payloads. Before serializing a preview,
replace an image block's base64 `data` with its captured size. Keep the rest of
the block, including `mimeType`, as captured. The size measures the base64 text,
not the decoded image; token estimates still use pi's image proxy.

Treat `textSignature`, `thinkingSignature`, and `thoughtSignature` as opaque
provider metadata. Gemini can also store reasoning data in `textSignature` on
text blocks. Inspect signature bytes only for length; never retain, tokenize,
render, preview, or log the bytes themselves.

Strip those fields from assistant text, thinking, and tool-call blocks,
respectively, before serializing injected-message previews. This includes
request-only replacements. Do not change the provider-bound message or tool
arguments, even if an argument has the same name as a signature field.

Request snapshots redact the messages they retain before publication, so no
consumer receives these bytes: image `data` becomes the same
`<size omitted>` marker, `textSignature` is removed, and `thinkingSignature`
and `thoughtSignature` become filler of the same length. Only that length
remains, for the [signature-size proxy](THINKING.md#counting-architecture).
Token estimates do not change: Pi counts images by a fixed proxy and never
counts signatures. The short-lived request copy used for the diff is raw and
released after the snapshot is built. It holds only the replayed system state
and the messages that differ from the baseline, so unchanged history, its
images and signatures included, is never copied.

Persisted probe records contain only role and timestamp identities, plus
`context_edit` target entry IDs with null replacements.

## Module Boundaries

| Path                         | Responsibility                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `src/index.ts`               | Create the layers, register them in order, and register the command; assemble view inputs.    |
| `src/command.ts`             | Parse commands; resolve the first or latest snapshot through the store and ProbeTrigger.      |
| `src/config.ts`              | Load, validate, cache, and explicitly create configuration.                                   |
| `src/settings.ts`            | Read pi's own settings: live settings, the compaction reserve, and global warming mode.       |
| `src/capture/register.ts`    | Capture layer wiring: observe every request in `context_with_system`; settle unpaired guards. |
| `src/capture/tracker.ts`     | RequestTracker: number captures and remember the latest unpaired one.                         |
| `src/capture/request.ts`     | ProjectionReader and TranscriptCapture: baseline with entry IDs, request copy, forced prompt. |
| `src/capture/diff.ts`        | Differ: compare system state; trim equal ends in place, align the rest with a Myers diff.     |
| `src/capture/attribution.ts` | Attributor: `customType` and cooperative `details` provenance of custom messages.             |
| `src/capture/redact.ts`      | Redact image payloads and signatures from messages a snapshot retains.                        |
| `src/capture/builder.ts`     | SnapshotBuilder: defer the diff, publish snapshots and guard updates, release copies.         |
| `src/compaction.ts`          | Track the compaction lifecycle for the probe preconditions and the command refusal.           |
| `src/snapshot.ts`            | Define request snapshots; SnapshotStore retains the first and latest per origin.              |
| `src/probe/filter.ts`        | ProbeFilter: hold and restore probe identities; filter requests in `context_with_system`.     |
| `src/probe/silent-probe.ts`  | SilentProbe: claim, abort, blank, and omit the probe run; persist its identities.             |
| `src/probe/view.ts`          | ProbeView: the run origin and probe-message filter that capture reads.                        |
| `src/probe/trigger.ts`       | ProbeTrigger: preconditions, one automatic attempt, and the probe snapshot from the store.    |
| `src/probe/token.ts`         | Carry the probe token through the async context of this extension's own send.                 |
| `src/pi-version.ts`          | Check the running Pi version against the oldest supported release.                            |
| `src/injections.ts`          | Rebuild the first snapshot's baseline and measure its composition with marked changes.        |
| `src/projection.ts`          | Rebuild filtered projections; apply the latest snapshot's changes to the branch for Usage.    |
| `src/replay.ts`              | Replay recorded system state and changes; Usage prompt/tools and the live fallback.           |
| `src/message-preview.ts`     | Content-only message previews, redacting session images and omitting opaque signatures.       |
| `src/measure.ts`             | Split and estimate prompt/tool contributions without pi API access.                           |
| `src/prompt-blocks.ts`       | Locate XML sections and moved tool surfaces, excluding nested/fenced examples.                |
| `src/transcript.ts`          | Render system messages; replay itself uses Pi's `getCurrentSystemMessage()`.                  |
| `src/prompt-additions.ts`    | Collect extension sources; identify prompt additions and make source-attribution guesses.     |
| `src/usage.ts`               | Classify messages; build usage totals and previews.                                           |
| `src/model.ts`               | Define types, ownership, hierarchy, and grouping.                                             |
| `src/text.ts`                | Sanitize dynamic text before terminal display.                                                |
| `src/ui/`                    | Handle navigation, layout, previews, and fullscreen rendering.                                |
| `test/fixtures/`             | Test capture visibility, forced prompts, and extension load order.                            |

Each layer's module exports its state and a `register*()` function with its pi
handlers; `src/index.ts` creates the layers and calls those functions.
SnapshotStore has no Pi handlers and imports Pi types only;
`src/index.ts` clears it on `session_shutdown`. Structured capture publishes to
it through SnapshotBuilder; Injections reads its first snapshot, Usage its
latest. `src/ui/` and `src/usage.ts` import no capture or probe module, directly
or indirectly; a test enforces this. Register the probe layer first:
ProbeFilter's `context_with_system` handler must run before the capture handler
on that event. The probe layer imports no capture module; capture reads it only
through ProbeView. Capture imports no view, command, or trigger code.
ProbeTrigger imports SilentProbe and the store's reader, never capture.
Keep state machines, measurement, and rendering in focused modules
that can be tested independently.

## Required Invariants

Lifecycle or accounting changes must preserve these rules. The current
[nested-send limitation](#known-limitation-nested-sends) is a known violation of
probe request isolation and message ownership, not a relaxation of those goals.

- Normal turns are unchanged when inspection is not invoked. Capture handlers
  return nothing and never change provider-bound data.
- Per-request overhead stays as small as possible: capture runs on every
  request, even if `/context` is never opened. Compare in place, copy only what
  differs, and defer the rest.
- On a Pi version older than `MIN_PI_VERSION`, no lifecycle handler is registered.
- Probes make no provider request, and their messages are blanked in agent
  state, in every later model context, and in the saved session.
- Only a run carrying the probe token is aborted or rewritten. Every other run
  proceeds untouched, because it may belong to the user or another extension.
- Active compaction refuses both views. Reported pending messages, virtual
  models, idle warming, excessive known context usage, or unreadable settings
  use fallback. Neither consumes the probe attempt.
- Genuine messages and genuine aborts remain visible.
- Synthetic probe entries never reach later model contexts or Usage, including
  after resume, reload, or fork.
- Injections selects the first structured snapshot per runtime; guard updates
  keep its ID. A fallback never enters the store.
- Usage applies the latest snapshot's conversation changes by baseline entry,
  drops changes whose entry left the projection, and applies system changes
  and the forced prompt only while the replayed system state is unchanged
  since capture.
- Raw content appears only after Enter and is never logged or newly persisted.
- Parent and child contributions are never double-counted.
- Usage counts the replayed branch prompt/tool state once, never again as system
  messages or historical patches. Explicit removals cannot revive live defaults.
- Every rendered line respects width, and views reflow with width and height.

For lifecycle smoke tests, load `test/fixtures/marker.ts`,
`test/fixtures/forced-prompt.ts`, and `test/fixtures/input-transform.ts` before
and after this extension. Use an
`after_provider_response` sentinel to detect provider calls.
Follow [UI.md](UI.md#responsive-rendering) for the rendering test matrix.
