# Capture and Usage Architecture

This document describes the current implementation, its limits, and the rules
that changes must preserve. It covers how pi builds a request, what this
extension can read, and how that data reaches the two views.

## Views and Data Sources

| View       | What it shows                                                                           | When its data changes                                     |
| ---------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Injections | The captured system prompt, tools, and injected messages.                               | Never after Initial is captured.                          |
| Usage      | Replayed branch prompt/tools and session messages, plus Initial's request-only changes. | Rebuilt when the view opens; Initial changes stay frozen. |

**Initial** is a frozen snapshot of the system prompt, active tools, and injected messages at the first
capture after this extension loads. There are two ways to capture it:

- **You send a prompt.** While pi prepares the model request, `pi-context-view` copies the prompt,
  tools, and injected messages it can see. The request then continues normally. This is capture
  during a real turn.

- **You open Usage or Injections before anything has been captured.** `pi-context-view` can start
  a run with an empty user message so pi and other extensions execute their request-preparation
  handlers. It captures the context from that run, but aborts before a request reaches the model
  provider. This is the [silent probe](#on-demand-silent-probe). It does not generate a model reply.

**Request-only messages** are message versions seen during request preparation but not found in the
saved session context. They may be extra messages added by an extension, or modified versions of
existing messages. Capture marks both cases as `requestOnly`. It does not determine which original
message, if any, was replaced. These request-only changes do not update the saved conversation.

Usage is therefore not independent of Initial today. See the
[known limitation](#known-limitation-replacements-and-removals) below.

> [!NOTE]
> When resuming a session or reloading extensions, Initial reflects the next successful capture - not
> the session’s beginning. Once captured, it stays unchanged. Ordinary conversation history is not
> copied into this snapshot.

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
before_agent_start handlers                     OBSERVE: copy prompt options
  Inject messages, change structured prompt options
  |
  + Persist system-section patches and tool changes
  |
  v
context handlers, in extension load order       OBSERVE: freeze Initial once
  Conversation only; Pi restores system state
  |
  v
context_with_system handlers                    FILTER: known probe identities
  Full transcript, with system positions intact
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
Messages + effective prompt + active tools      READ: prompt and tool APIs
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
  messages by comparing this list with the captured `context` event.

- `ctx.getSystemPrompt()` reads Pi's effective prompt during a run, including
  `before_agent_start` edits and a forced prompt, which Pi renders instead of
  the structured sections. Pi clears per-run options on settlement, so an idle
  read is not the prompt used by the last request. It does not expose later
  provider-payload rewrites.
  **Goal:** preserve Initial's effective-prompt capture, provide a Usage fallback
  only when the branch has no system messages.

- `ctx.getSystemPromptOptions()` reads the base prompt construction options in
  a command handler. The corresponding event field is
  `event.systemPromptOptions` in `before_agent_start`.
  **Goal:** identify prompt sections, such as instruction files and skills,
  for separate estimates and previews.

- `pi.getActiveTools()` and `pi.getAllTools()` supply the active tool names,
  definitions, and source information. `pi.getCommands()` supplies additional
  extension source information for prompt attribution.
  **Goal:** estimate Initial's active tools and provide Usage's live fallback.
  For transcript-backed Usage, recorded declarations supply definitions and the
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

`pi-context-view` normally captures Initial while pi is already preparing a
request for your prompt. This avoids starting another run - and repeating other
extensions’ actions - just to inspect the context.

If the user opens a view before Initial exists, it can make one explicit
[silent probe](#on-demand-silent-probe). That probe still
runs other extensions' handlers, so it is limited to one attempt per extension
runtime. Later view opens read the existing capture and current pi data instead
of starting another run.

## Initial Snapshot

Initial is captured once per extension runtime. The capture has two parts: the
prompt with its active tools, and the injected messages. They use different
events and different rules, so the first two sections below follow this flow.
The last section states what the captured result covers.

```text
Real turn or explicit silent probe
  |
  v
before_agent_start                              → Capturing the Final
  Copy structured prompt options and the prompt     Prompt and Tools
  at this handler
  |
  v
First context event after preparation
  Read effective prompt + active tools          → Capturing the Final
                                                    Prompt and Tools

  Remove known probe messages from both lists   → Message Comparison
  Compare event messages with the session branch    and Stored Data
  Measure content and copy the retained data
  |
  v
Frozen Initial ------------------------------> Injections view
  |                                             Shows the whole snapshot
  |
  +-- request-only messages ---------+
                                     |
                                     +-------> Usage at view-open time
                                     |
Current prompt, tools, and session --+
messages, read when the view opens

  |
  v
Later context events
  Do not replace Initial
  |
  v
Every context_with_system event
  Filter known probe messages without moving system messages
```

Usage therefore combines two sources: the request-only changes frozen in
Initial, and the session-branch messages read when the view opens. Those
messages also carry the recorded prompt and tool state. See
[Usage and Attribution](#usage-and-attribution) for that flow.

### Capturing the Final Prompt and Tools

This covers the first two steps of the flow above: the `before_agent_start` copy
and the prompt and tool read in the first `context` event.

**Goal:** record the prompt and tools that pi actually sends, after every
extension injection.

The capture is therefore split across two events:

- **`before_agent_start`: copy the prompt options.** Pi exposes
  `event.systemPromptOptions` here, not in `session_start`. These options name
  the prompt's sources, such as instruction files and skills, so the prompt can
  later be split into separate items.

- **First `context` event: freeze the prompt and tools.** Waiting until here is
  what makes the result final: extensions loaded after this one can still edit
  the prompt or call `pi.setActiveTools()` during `before_agent_start`. At this
  point `ctx.getSystemPrompt()` and pi's active tools already include those
  changes, whatever the extension load order.

Initial describes one specific run: an injection that did not run for it is
absent, so the snapshot must never be overwritten with a later turn's content,
which would mix data from different runs. The other limits of this timing are
listed in [Capture Coverage and Load Order](#capture-coverage-and-load-order).

### Message Comparison and Stored Data

This covers the remaining steps of the same `context` event: comparing messages,
then measuring and copying what the snapshot keeps.

**Goal:** keep only the messages a user cannot already see in the conversation,
and keep them stable for later inspection.

The request message list contains the whole conversation, so storing it would
duplicate visible history and make the snapshot large. To separate injected
content, compare the `context` event messages with `buildSessionProjection()` for
the current branch, after removing known probe messages from both lists:

- **Match complete messages by their serialized JSON.** An exact comparison
  avoids guessing which fields matter. Count duplicate matches separately so
  two identical messages are not collapsed, and ignore order, because handlers
  may reorder messages.

- **Keep custom messages, even when already saved in the session.** They are
  extension content, which the Injections view exists to show. `customType`
  names a message type, not necessarily the extension package, so it identifies
  the type only.

- **Keep unmatched messages of other roles, marked `requestOnly`.** These exist
  only in the request, so no other source can show them. Custom messages are
  marked the same way when they do not match.

- **Skip matched ordinary session messages, including system messages.** Usage
  reads them from the current session branch instead, which keeps them up to
  date and avoids counting them twice. Captured request-only system messages
  retain sanitized replay inputs and their original request order, so Usage
  can apply section and tool patches instead of counting their preview again.

Store copies of everything retained: prompt parts, tools, message previews,
sources, and children. Copies keep the frozen snapshot correct even when pi or
another extension later changes the original objects. Apply the
[privacy rules](#privacy) before retaining preview content.

Build these comparison inputs only for the event that freezes Initial.
Rebuilding the session baseline costs time proportional to the conversation
length, so later `context` events skip that work. Capture filters its own
comparison inputs but never returns a changed request. Request filtering runs
separately in `context_with_system`.

### Capture Coverage and Load Order

**Goal:** state what a capture can and cannot contain, so a missing injection
reads as a known limit instead of a bug.

Coverage follows from the two capture events above. It is the same for a real
turn and for a silent probe: the probe decides when a capture happens, not what
it sees.

- **Prompt and active tools: every extension, whatever the load order.** They
  are read in the first `context` event, after every `before_agent_start`
  handler has run, through `ctx.getSystemPrompt()` and pi's active-tool API.
  Both report pi's current state rather than one handler's result, so an
  extension loaded after this one is still included.

- **Messages injected in `before_agent_start`: every extension.** They are
  already part of the message list that the `context` chain receives.

- **Message changes by `context` handlers: only extensions loaded before this
  one.** Pi runs that chain in extension load order and passes each handler's
  result to the next, so this extension freezes the list as it stands at its
  own position. Later additions, replacements, removals, and reordering are
  absent.

- **Forced prompts: every extension, whatever the load order.** A
  `before_agent_start` handler returning `systemPrompt` sets
  `systemPromptOptions.forceSystemPrompt`, and `ctx.getSystemPrompt()` then
  renders that exact text instead of the structured sections. Initial measures
  the forced text as the prompt, so recorded sections the run did not send are
  neither counted nor attributed; without XML sections it is
  [one undivided part](#prompt-parts-and-moved-blocks). Pi projects the forced text onto the request
  after the `context` handlers and keeps recording the structured sections, so
  only Initial sees it: Usage reads the transcript instead.

- **`context_with_system` changes: not captured.** Initial still freezes in
  `context`; moving capture itself belongs to the request-only redesign.

- **Provider-payload rewrites: no extension, whatever the load order.**
  `before_provider_request` handlers and provider transports run after the
  capture point, so an effective prompt they rewrite there never reaches
  Initial or Usage.

## Usage and Attribution

Usage is built when `/context` or `/context usage` opens. It does not capture a
new transformed request on each open.

```text
                             Open Usage
                                 |
                                 v
      Resolve Initial: existing capture, one probe, or fallback
                                 |
                                 v
                        Collect view inputs
                                 |
         +-----------------------+---------------------------+
         |                       |                           |
         v                       v                           v
Live prompt/tool fallback   Initial snapshot          Current session branch
         |                       |                           |
         |                       v                           v
         |                requestOnly items         buildSessionProjection()
         |                 (still frozen)                    |
         |                       |                           v
         |                       |                  Filter probe messages
         |                       |                           |
         +-----------------------+---------------------------+
                                 |
                                 v
                       buildUsageSnapshot()
                  Replay system sections and tool deltas
                  (live fallback only without system state)
                  Merge non-system request-only messages
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
`buildUsageSnapshot()` replays the branch's system messages in order: plain
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

Frozen request-only system patches apply after the branch state in their captured
request order. They are not also merged as counted message previews. Other
request-only messages retain the existing merge. Session-backed custom messages
count from the current branch, not again from Initial. `computeUsage()` skips
system messages because the prompt/tool snapshot already accounts for them.

This is a provider-independent semantic estimate, not a wire-size estimate.
Some providers keep earlier section versions or tool declarations in the cached
transcript; others collapse them. Usage deliberately does not count that history,
patch framing, or provider-specific serialization. A forced prompt is likewise
out of scope for Usage: Pi never records that text, and the per-run options are
cleared on settlement, so both the replayed transcript and the idle live
fallback describe the structured prompt, not the forced projection of the last
request. Initial's frozen forced prompt is not merged back in, because it
describes one past run. Initial continues to read the effective prompt rather
than replacing it with replay.

The UI receives `ctx.getContextUsage()` separately. Its reported total is not
used to force category estimates to match. Map rendering rules belong to
[ui/usage.md](ui/usage.md#context-map).

### Known Limitation: Replacements and Removals

The current merge handles additions, but cannot correctly account for all
message transformations. This is tracked in
[issue #6](https://github.com/dimk90/pi-context-view/issues/6).

If an earlier `context` handler replaces a session message, the replacement
fails the exact baseline match and becomes `requestOnly`. Usage then counts
both the original session message and the captured replacement. For example,
a 40,000-character user message replaced with `bbbb` contributes 10,001 estimated
tokens, although the observed replacement alone contributes 1.
If a handler removes a message, capture records no removal. Usage still counts
the session original.

Beyond replacement and removal, frozen request-only messages can go out of
date. Initial is never recaptured, so later turns, branch changes, or compaction
can leave it describing content the session no longer contains.

These are limits of the current data combination, not normal tokenizer error.
Usage combines data from different times. It is not an exact view of the last
or next provider request.

## On-demand Silent Probe

### Why it is Needed

Before a real turn, pi's APIs can supply the current prompt, tools, and saved
session messages. That is enough for a partial view, but not for Initial's
observation of extension handlers.

Without running a turn, this extension cannot observe:

- `before_agent_start` changes for that run: prompt edits, injected messages,
  and tool activation;
- request-only messages and transformations from earlier `context` handlers.

Reading session history or calling `convertToLlm()` does not run those handlers.
The silent probe starts the lifecycle so capture can see them, then aborts
before a provider request. It widens nothing beyond
[Capture Coverage and Load Order](#capture-coverage-and-load-order), and an
empty-input probe also cannot reveal contributions that run only for a
particular real prompt.

If Initial already exists, no probe is needed. Both views currently resolve
Initial, so either view can request the one probe. Never probe automatically
or repeat it on every Usage open.

### Probe Lifecycle

Allow at most one attempt per extension runtime. Concurrent callers share it.

```text
/context
  Refuse the view if compaction is active
  Wait for idle
  Check compaction, pending messages, model, auth, and Pi settings
  If unsafe, return a partial fallback without consuming the attempt
  Otherwise hide the working row and call sendUserMessage("") inside
  this attempt's probe-token scope
  |
  v
input
  Empty the probe prompt again if an earlier transform added text to it
  |
  v
before_agent_start
  Claim this run if it carries the token, otherwise fail the attempt
  and leave the run alone
  Prepare Initial
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
context
  Filter only capture's comparison inputs, finalize Initial
  |
  v
context_with_system
  Filter the request without changing system-message positions
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
  Restore UI, persist probe identities, resolve the attempt, open the view
```

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
projection they read. The command checks before resolving Initial, so it never
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
startup failure, or a timeout returns a current prompt/tool snapshot with a precise reason that
extension additions were not observed. This fallback does not freeze Initial.
Usage can still classify current session messages alongside it.

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
- Also split at the boundary of the prompt seen by this extension's own
  `before_agent_start` handler. A block must not combine additions from
  extensions loaded before and after this one.
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
  even when `content` is empty. Omit text-block signatures. Request-only system
  replay data contains only content, section patches, tool declarations/removals,
  and ordering metadata; it stays process-local and is never persisted by this
  extension. Deleted sections have no preview text or text-token contribution.
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

Persisted probe records contain only role and timestamp identities, plus
`context_edit` target entry IDs with null replacements.

## Module Boundaries

| Path                        | Responsibility                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `src/index.ts`              | Create the layers, register them in order, and register the command; assemble view inputs.    |
| `src/command.ts`            | Parse commands; resolve Initial through capture, probe, or fallback.                          |
| `src/config.ts`             | Load, validate, cache, and explicitly create configuration.                                   |
| `src/settings.ts`           | Read pi's own settings: live settings, the compaction reserve, and global warming mode.       |
| `src/capture.ts`            | Manage Initial and measure injected messages.                                                 |
| `src/compaction.ts`         | Track the compaction lifecycle for the probe preconditions and the command refusal.           |
| `src/snapshot.ts`           | Define request snapshots; SnapshotStore retains the first and latest per origin.              |
| `src/probe/filter.ts`       | ProbeFilter: hold and restore probe identities; filter requests in `context_with_system`.     |
| `src/probe/silent-probe.ts` | SilentProbe: claim, abort, blank, and omit the probe run; persist its identities.             |
| `src/probe/view.ts`         | ProbeView: the run origin and probe-message filter that capture reads.                        |
| `src/probe/token.ts`        | Carry the probe token through the async context of this extension's own send.                 |
| `src/pi-version.ts`         | Check the running Pi version against the oldest supported release.                            |
| `src/measure.ts`            | Split and estimate prompt/tool contributions without pi API access.                           |
| `src/prompt-blocks.ts`      | Locate XML sections and moved tool surfaces, excluding nested/fenced examples.                |
| `src/transcript.ts`         | Replay system content, section patches, and tool declarations without provider serialization. |
| `src/prompt-additions.ts`   | Identify prompt additions and make source-attribution guesses.                                |
| `src/usage.ts`              | Classify messages; build usage totals and previews.                                           |
| `src/model.ts`              | Define types, ownership, hierarchy, and grouping.                                             |
| `src/text.ts`               | Sanitize dynamic text before terminal display.                                                |
| `src/ui/`                   | Handle navigation, layout, previews, and fullscreen rendering.                                |
| `test/fixtures/`            | Test capture visibility, forced prompts, and extension load order.                            |

Each layer's module exports its state and a `register*()` function with its pi
handlers; `src/index.ts` creates the layers and calls those functions. Only
Initial capture still registers its `before_agent_start` and `context` handlers
in `src/index.ts`. SnapshotStore has no Pi handlers and imports Pi types only;
`src/index.ts` clears it on `session_shutdown`. Nothing publishes to it yet. Register the probe layer first: ProbeFilter's
`context_with_system` handler must run before any capture handler on that event.
The probe layer imports no capture module; capture reads it only through
ProbeView. Keep state machines, measurement, and rendering in focused modules
that can be tested independently.

## Required Invariants

Lifecycle or accounting changes must preserve these rules. The current
[nested-send limitation](#known-limitation-nested-sends) is a known violation of
probe request isolation and message ownership, not a relaxation of those goals.

- Normal turns are unchanged when inspection is not invoked.
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
- Initial freezes exactly once per extension runtime; if capture never succeeds,
  the fallback does not freeze it.
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
