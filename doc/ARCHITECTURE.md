# Capture and Usage Architecture

This document describes the current implementation, its limits, and the rules
that changes must preserve. It covers how pi builds a request, what this
extension can read, and how that data reaches the two views.

## Views and Data Sources

| View       | What it shows                                                                      | When its data changes                                          |
| ---------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Injections | The captured system prompt, tools, and injected messages.                          | Never after Initial is captured.                               |
| Usage      | Current prompt, tools, and session messages, plus Initial's request-only messages. | Rebuilt when the view opens; the Initial messages stay frozen. |

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

The following flow was checked against pi `0.85.1`. The notes on the right show
which parts `pi-context-view` uses or skips.

```text
Current agent history
  Restored/rebuilt with buildSessionContext()    USE: session branch baseline
  (branch, compaction, saved custom messages)
  |
  + New user message and pending messages
  |
  v
before_agent_start handlers                     OBSERVE: copy prompt options
  Inject messages, change the system prompt
  |
  v
context handlers, in extension load order       OBSERVE: freeze Initial once
  Add, replace, remove, or reorder messages
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

This is a simplified flow. Pi maintains agent history in memory. It does not
rebuild the session tree before every request. It can also compact history and
deliver queued messages between requests. `before_agent_start` runs for a new
prompt, while `context` runs before each model call, including tool follow-ups.

Pi's `context` handler chain starts with a deep copy of the messages. Its result
is used for that request, not written back into session history. Rebuilding the
session branch later cannot recover those request-only changes.

### Pi APIs Use

- Use `buildSessionContext(entries, leafId).messages` to obtain the current
  branch's conversation messages, with compaction applied. Do not estimate usage
  directly from `buildContextEntries()`: it also returns bookkeeping records
  such as model changes, bookmarks, and saved extension state. Pi does not send
  those records to the model, so they must not contribute to token estimates.
  **Goal:** count current session messages in Usage and identify request-only
  messages by comparing this list with the captured `context` event.

- `ctx.getSystemPrompt()` reads the effective agent prompt. It can include
  `before_agent_start` edits and can still hold them after a turn. It does not
  expose later provider-payload rewrites.
  **Goal:** capture the prompt text for Initial and estimate the current prompt
  when Usage opens.

- `ctx.getSystemPromptOptions()` reads the base prompt construction options in
  a command handler. The corresponding event field is
  `event.systemPromptOptions` in `before_agent_start`.
  **Goal:** identify prompt sections, such as instruction files and skills,
  for separate estimates and previews.

- `pi.getActiveTools()` and `pi.getAllTools()` supply the active tool names,
  definitions, and source information. `pi.getCommands()` supplies additional
  extension source information for prompt attribution.
  **Goal:** estimate active tools and group them by source, use tool and command
  source information to guess which extension added prompt text.

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
  Filter known probe messages, do not replace Initial
```

Usage therefore combines two sources: the request-only messages frozen in
Initial, and the current system prompt, active tools, and session-branch
messages read when the view opens. See
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
content, compare the `context` event messages with `buildSessionContext()` for
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

- **Skip matched ordinary session messages.** Usage reads them from the current
  session branch instead, which keeps them up to date and avoids counting them
  twice.

Store copies of everything retained: prompt parts, tools, message previews,
sources, and children. Copies keep the frozen snapshot correct even when pi or
another extension later changes the original objects. Apply the
[privacy rules](#privacy) before retaining preview content.

Build these comparison inputs only for the event that freezes Initial.
Rebuilding the session baseline costs time proportional to the conversation
length, so later `context` events must skip that work and only filter known
probe messages.

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
Current prompt + tools     Initial snapshot          Current session branch
         |                       |                           |
         v                       v                           v
buildNativeSnapshot()     requestOnly items          buildSessionContext()
         |                 (still frozen)                    |
         |                       |                           v
         +-----------+-----------+                  Filter probe messages
                     |                                       |
                     v                                       |
        mergeRequestOnlyMessages()                           |
                     |                                       |
                     +----------------+----------------------+
                                      |
                                      v
                                computeUsage()
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

Despite its name, `buildNativeSnapshot()` reads the effective prompt supplied
by the caller: that prompt can already contain extension edits. It does not
rerun those extensions.

Session-backed custom messages count from the current branch, not again from
Initial. Only Initial items marked `requestOnly` are merged into the fresh
prompt/tool snapshot. `computeUsage()` classifies those items along with the
current session messages.

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
  Wait for idle
  If compaction is active, return a partial fallback without probing
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
context
  Filter the synthetic user message, finalize Initial
  |
  v
message_end
  Blank the synthetic prompt and the recorded abort result
  |
  v
agent_settled
  Restore UI, persist probe identities, resolve the attempt, open the view
```

Use `sendUserMessage("")`. `pi.sendMessage(..., { triggerTurn: true })` skips
`before_agent_start`. Abort at `turn_start`, not `before_provider_request`,
because some transports skip the latter.

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

Filter the recorded identities from every later model context and Usage
calculation. Blank both recorded probe messages in `message_end`: the synthetic
prompt, which may carry text an input transform added, and the assistant abort
result. Filtering keeps probe messages out of model contexts; blanking keeps
them out of stored messages.

Blanking cleans agent state, later model contexts, and the saved session, but
not the current screen: pi renders a user row when the message starts and does
not repaint it for a `message_end` replacement. Text another extension's input
transform added to the probe prompt therefore stays visible for that run and
disappears on reload or resume. Nothing of that text is sent or stored.

Persist only role-and-timestamp identities in `pi-context-view:probe-identities`
custom entries on `agent_settled` and `session_shutdown`. Restore all prior
identities on `session_start`, including after resume, reload, and fork. Never
persist probe content in these records.

### Compaction, Failures and Fallback

`waitForIdle()` does not cover manual compaction. Track
`session_before_compact` until its signal aborts or pi reports the outcome:

- Pi 0.84.3 and newer finish each observed compaction with exactly one of
  `session_compact` or `session_compact_failed`. Do not infer completion from
  later agent runs.
- Older pi does not emit the failure event. A failed compaction keeps this
  extension in fallback mode until the session ends.

While compaction is active, return the fallback without starting or consuming
the probe attempt.

A missing model, missing authentication, startup failure, timeout, or active
compaction returns a current prompt/tool snapshot with a precise reason that
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

Split pi's own system prompt into the parts it builds: the preamble,
`Available tools:`, `Guidelines:`, `Pi documentation`, appended prompt text,
and the working-directory footer. The counted parts must concatenate back to
the item's text and share its token estimate.

Find block headers independently and preserve their actual order. An extension
can move or rewrite a block, not just append text. The footer is therefore not
an absolute boundary for Available Tools or Guidelines.

Outside their normal region before Documentation, accept a block only when:

1. Its header starts a line and is followed immediately by consecutive bullets.
2. Available Tools has at least one exact active-tool `name: snippet` match,
   or Guidelines has an active-tool or universal pi guideline match.
3. The block ends at the first non-bullet line. Include pi's exact optional
   custom-tools filler with Available Tools.

Never invent missing or withheld tool lines. Ignore header examples inside
separately identified instruction files, skills, appended instructions, and
Markdown fences.

A match before the footer takes priority over later copies. Several candidates
after the footer are ambiguous and stay prompt additions. A block after a
normally later block or after the footer gets typed `moved` metadata. This
records position only: it does not prove who moved it or that its text is
unchanged.

Moved native text still counts under System Prompt. Extension tool lines keep
their usual tool ownership. Keep all recovered blocks in actual prompt order,
including relative to Appended Prompt and Current Dir. A newly added tool list
is not a moved block if a custom prompt prevented pi from rendering that block
in the first place.

### Tool Ownership and Preview References

Use `ToolInfo.sourceInfo` for tool ownership.

Separate a tool's complete prompt bullets only from the selected blocks,
including recovered moved blocks. Never match unrelated text or only a prefix
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

For text after pi's footer and outside recovered blocks:

- Split at blank lines and ignore whitespace-only gaps. Keep gaps on opposite
  sides of a recovered block separate, so unrelated source evidence cannot mix.
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
works in every run mode. Only the views require `ctx.mode === "tui"`.

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

Persisted probe records contain only role and timestamp identities.

## Module Boundaries

| Path                      | Responsibility                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `src/index.ts`            | Register events and commands; assemble view inputs.                                |
| `src/command.ts`          | Parse commands; resolve Initial through capture, probe, or fallback.               |
| `src/config.ts`           | Load, validate, cache, and explicitly create configuration.                        |
| `src/capture.ts`          | Manage Initial, probes, compaction state, probe identities, and injected messages. |
| `src/probe-token.ts`      | Carry the probe token through the async context of this extension's own send.      |
| `src/measure.ts`          | Split and estimate prompt/tool contributions without pi API access.                |
| `src/prompt-blocks.ts`    | Find native and moved prompt blocks using markers and tool metadata.               |
| `src/prompt-additions.ts` | Identify prompt additions and make source-attribution guesses.                     |
| `src/usage.ts`            | Classify messages; build usage totals and previews.                                |
| `src/model.ts`            | Define types, ownership, hierarchy, and grouping.                                  |
| `src/text.ts`             | Sanitize dynamic text before terminal display.                                     |
| `src/ui/`                 | Handle navigation, layout, previews, and fullscreen rendering.                     |
| `test/fixtures/marker.ts` | Test capture visibility and extension load order.                                  |

Keep pi event and command wiring in `src/index.ts`. Keep state machines,
measurement, and rendering in focused modules that can be tested independently.

## Required Invariants

Lifecycle or accounting changes must preserve these rules. The current
[nested-send limitation](#known-limitation-nested-sends) is a known violation of
probe request isolation and message ownership, not a relaxation of those goals.

- Normal turns are unchanged when inspection is not invoked.
- Probes make no provider request, and their messages are blanked in agent
  state, in every later model context, and in the saved session.
- Only a run carrying the probe token is aborted or rewritten. Every other run
  proceeds untouched, because it may belong to the user or another extension.
- Active compaction uses the fallback without consuming the probe attempt.
- Genuine messages and genuine aborts remain visible.
- Synthetic probe entries never reach later model contexts or Usage, including
  after resume, reload, or fork.
- Initial freezes exactly once per extension runtime; if capture never succeeds,
  the fallback does not freeze it.
- Raw content appears only after Enter and is never logged or newly persisted.
- Parent and child contributions are never double-counted.
- Every rendered line respects width, and views reflow with width and height.

For lifecycle smoke tests, load `test/fixtures/marker.ts` and
`test/fixtures/input-transform.ts` before and after this extension. Use an
`after_provider_response` sentinel to detect provider calls.
Follow [UI.md](UI.md#responsive-rendering) for the rendering test matrix.
