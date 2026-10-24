# Views on Snapshots

Part of the [architecture](../ARCHITECTURE.md). Both views read the latest
request snapshot that [capture](capture.md) publishes, but answer different
questions: Injections describes that request's contributions as sent; Usage
estimates the current branch with the request's changes applied. Rendering
rules belong to [ui/injections.md](../ui/injections.md) and
[ui/usage.md](../ui/usage.md).

## Resolving the Snapshot

The command resolves `SnapshotStore.latest()` once, before choosing the view.
If the store is empty, it waits for idle and rechecks it before asking
ProbeTrigger. A turn that published while the command waited supplies the
snapshot without another run. ProbeTrigger resolves with a status only; the
command then reads the store again ([probe lifecycle](probe.md#probe-lifecycle)).

A failed or skipped probe leaves the store empty: the view opens on Pi's
current data with a degraded reason, and the fallback never enters the store.
While compaction is active, both views refuse to open; the command checks
before and after resolving ([preconditions](probe.md#preconditions-failures-and-fallback)).
The command also keeps the TUI-only guard. `openInjections()` and
`openUsage()` receive the same resolution result.

## Injections

`src/injections.ts` builds the composition when the view opens:

1. Rebuild `buildSessionProjection(entries, snapshot.leafId)` and filter known
   probe messages, keeping source entry IDs. Later messages, context edits,
   branch navigation, and compaction do not change this historical baseline.
2. Replay system state with `getCurrentSystemMessage()` and apply the
   snapshot's content, section, and declaration changes. Measure the result
   like Usage: recorded declarations supply definitions, current tool metadata
   supplies provenance and guidelines. Leave out the snapshot's hidden tools,
   as Usage leaves out live ones, and count them. Shared helpers live in
   `src/replay.ts`.
3. A forced prompt replaces the replayed prompt, so captured content and
   section patches do not apply to it; tool changes still apply. The System
   Prompt item carries the `forced` request-only change. Content and section
   edits the forced text replaced stay visible as `forcedEdit` on their parts,
   never counted: a part the forced text still sent keeps its estimate, and an
   added or modified part it lacks is appended at zero tokens. An undivided
   forced prompt has no parts to mark. Current
   `getSystemPromptOptions().customPrompt` preserves Dropped markers for
   `--system-prompt`. Other live prompt options do not replace recorded
   sections.
4. Combine session-backed custom messages and every request-only conversation
   change in one `messages (N)` row under `unattributed`. Session-backed parts
   follow baseline order, with modifications and deletions in place; additions
   and changes with no matched entry follow in capture order. Unchanged
   ordinary conversation stays out of the tree. `N` counts only sent messages,
   excluding deletions.

Added and modified message parts count their request version; deleted parts
count zero. The row sums their estimates and token diffs against the session,
with no child rows. A modified message keeps its session original only as
preview metadata of its counted part, for a word-level diff; a deletion
previews its session original at zero. A customType or role labels each part,
never a source group. Message previews use the content-only extraction in
`src/message-preview.ts`. Snapshot images already hold size markers; session
originals are redacted on extraction. Neither source's opaque signature bytes
reach a preview.

Each message part also carries its `user prompt #N`: the genuine user
messages from the session root through its source entry, on the branch
ending at `snapshot.leafId`. Walking parent links over all entries counts
prompts that compaction or a context omission left out of the projection and
ignores abandoned branches and later entries, so numbers stay stable. Known
probe prompts are excluded through the same filter. Additions take the number
of the request's leaf; parts before the first prompt have none.

System changes mark the affected prompt part or tool in place. These groups
identify the affected content, **not the editing extension**. Marking a pi part
never attributes its editor to pi. The replay supplies exact section
boundaries, including inline XML, empty, and unwrapped sections, so repeated
text cannot move a marker onto another section. Deleted sections keep their
original text at zero tokens, after sent parts and before Extension Additions.
A deleted tool keeps its definition at zero tokens. The total counts only this
view's contributions, not unchanged ordinary history or provider serialization.

Every row also carries a token diff, the tokens it gained and lost against its
base, from a word-level comparison in `src/token-diff.ts`:

- **Prompt and tools.** The session's prompt and tools at the snapshot's leaf
  are measured like the request, without its changes. Pi's parts compare with
  that version minus the extension lines its references cover: pi's default
  prompt. Custom sections and Extension Additions have no default, except that
  a deleted custom section compares with the session. Tools, instruction
  files, and skills compare with the session; parents sum their children.
  A request that replaces or deletes a generated instruction-file or skill
  section keeps it as a System Prompt part, comparing with the session's
  measured record aggregate rather than losing that base.
- **Messages.** A changed message compares its content-only preview with the
  session original's; an unchanged custom message has no diff.
- **Payload changes.** A finding compares the lines the payload added with
  the lines it removed.

A branch without recorded system state and the degraded fallback compare the
live prompt with itself, so only extension text shows.
[Measurement](measurement.md#token-diffs) owns diff reconciliation and limits.

Injections also builds diff-only `system prompt` rows per extension and under
`unattributed`, splitting these prompt diffs by their available ownership
signals. They repeat changes already counted under `pi`, including unknown
instruction-file and skill changes, and increase neither group nor total
estimates or group diffs. Only Injections builds them; Usage does not restore
an Extensions category for prompt text.
[measurement.md](measurement.md#system-prompt-rows) owns their attribution and
rounding rules.

A leaf row whose sent content differs from the session is request-only
(`InjectionItem.requestOnly`): an added, modified, or deleted message, prompt
part, or tool. Pi never saves a forced prompt, so under one, every prompt part,
instruction file, or skill whose text differs from the session's version is
request-only too. Generated instruction-file and skill children compare their
text with the session even without a forced prompt: a section patch marks
only their parent aggregate. The `messages (N)` row is request-only when any
of its message parts changed. Parents, the System Prompt item, and payload
changes never are. Sections that mirror child rows copy the flag, and changed
message parts carry it too, so previews mark the same content as the list.
An extension's `system prompt` row compares its attributed lines with the
session's, rather than inheriting the containing part's flag;
the unattributed row is request-only when any of its changes is.

System Prompt parts and diff-only rows also carry `InjectionItem.savedChange`
when the session's version already differs from their diff base. A saved custom
section with a request-only edit can therefore explain both states even when
the edit folds into its `+N`. A deleted custom section compares with the session,
so its deletion is request-only, not saved. Request-only prompt/tool leaves
record whether a session original exists (`sessionOriginal`); a new forced part
must not claim that the session keeps an original it never had. The row model
combines these states for parents and groups, adding request-only removals of
session-only children and excluding diff-only rows. None changes an estimate,
capture, or persisted data.

Prompt additions have no `before_agent_start` handler boundary: recorded
structured edits already belong to the baseline, and the forced prompt is
captured as final text ([prompt additions](measurement.md#extension-prompt-additions)).

The snapshot also supplies hidden tools and payload changes:

- **Hidden tools.** The tools in the snapshot's `hiddenTools` that the request
  declared are left out of the tree, independently of guard status and of any
  structured change of the same tool. The view-local snapshot keeps their
  names; one description bullet reports their count and lists all names
  alphabetically, sanitized and wrapped. There are no rows, markers, or
  candidate labels. A fallback without a snapshot uses Pi's live hidden set.
- **Payload changes.** [Payload guard](payload-guard.md) findings of each
  compared channel form one `payload changes (N)` row under `unattributed`,
  after messages. `N` counts every finding, deletions included. It has kind
  `payload-change` and no child rows. One section per finding retains its
  changed lines in guard order; its text and estimate hold only the added
  lines, so a deletion counts zero. The item sums these estimates and diffs
  against the captured request. Tool removals Pi did not hide belong here;
  typed section metadata distinguishes a tool declaration from a message part.
  Sections render their colored changed lines, with changed words inverse.

Top-level sources are `pi`, identified extensions by size, then one
`unattributed` group for content from an unknown extension. Unregistered tools,
unknown prompt changes, custom messages, conversation changes, and payload
changes all share this group. `customType` and cooperative provenance do not
identify an extension for grouping. Pi's `pi.share` is a session/export entry,
not a context custom message. Presentation decisions live in
[ui/injections.md](../ui/injections.md#contribution-tree).

Probe snapshots must remain distinguishable from ordinary requests, with their
capture limits explained under [the UI rules](../ui/injections.md#latest-request).
Pending and incomplete guards mean an unavailable or partial payload-change
comparison, never "no edits". A complete guard adds no warning. The view is
fixed while open; reopening reads the latest snapshot or a guard update with
the same snapshot ID. A real request replaces a probe snapshot and removes its
probe warning.

## Usage

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
                  a fresh forced prompt replaces the prompt text;
                  Pi's live hidden tools are left out
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

### Replayed State

**Usage counts the replayed current state once, not the history of changes.**
`buildUsageSnapshot()` replays the branch's system messages in order with Pi's
`getCurrentSystemMessage()`: plain `content` appends, `sections` replaces
values by name (`null` removes one), and `toolsRemoved` applies before
`toolsAdded`. Replacing a tool uses its recorded name, description, and schema,
not today's registered definition. Removed tools and superseded sections no
longer contribute. An explicitly empty system state is still authoritative; it
must not revive the live prompt or active tools.

`buildSessionProjection()` already selects the current branch and applies
compaction. Its compaction checkpoint replaces earlier system messages,
including system messages in the retained range. The same replay therefore
works after resume, branch navigation, and compaction without a separate
mutable state cache.

Only a branch with no recorded system message yet, such as a new session before
its first prompt, uses `buildNativeSnapshot()` and the caller's live
prompt/tools. Neither path reruns extension handlers. Generated
instruction-file and skill records are read from the recorded prompt, not
today's loader metadata. Custom XML sections remain named System Prompt parts
even after `cwd`; their tag does not establish extension ownership.

### Applying the Latest Request

Usage reads `SnapshotStore.latest()`, just as Injections does. A probe supplies
the changes only until the first real request's snapshot replaces it.
`src/projection.ts` applies them when the view opens:

- **Conversation changes, by baseline entry.** A modification replaces the
  first unchanged conversation message of its source entry with the request
  version; a deletion removes it; an addition is appended and classified like
  any other message by role or `customType`. The replaced or deleted session
  original contributes neither tokens nor a Usage preview. A reorder, captured
  as a deletion plus an addition, is counted once. A modification or deletion
  whose entry is no longer in the current projection, after compaction or
  branch navigation, is stale and dropped: the current message is counted
  instead. Additions have no entry and always apply.
- **System changes, while fresh.** Content, section, and tool changes are
  deltas against the snapshot's replayed system state. They apply after the
  branch replay only while the current replayed state equals the state rebuilt
  at the snapshot's `leafId`; any recorded system change since capture drops
  them until the next request. Usage marks none of these changes.
- **Forced prompt, while fresh.** An idle read of the prompt returns the
  structured one, so only the snapshot holds the
  [forced prompt](capture.md#forced-prompt). The forced text renders the
  snapshot's system state, so it follows the same freshness rule as system
  changes. While it applies, Usage measures it in place of the replayed prompt,
  also in the live fallback. As in Pi, section and content changes do not apply
  to it, and tool changes still do. Pi's sections inside it are
  [measured as usual](measurement.md#prompt-parts-and-moved-blocks), so
  appended text counts in its Extension Additions part. Like Injections, Usage marks
  the System Prompt item `forced`, and its previews
  [show the marker](../ui/usage.md#forced-prompt).
- **Hidden tools, from Pi's live loadout.** Every time Usage opens, it reads
  `ctx.getSystemPromptOptions().hiddenTools`. After applying fresh request-only
  tool changes, it leaves out those names, without markers. The same filtering
  applies to the live fallback, before any prompt, and when a probe fails or
  the payload guard is incomplete. Counted tools keep their replayed
  definitions, not payload text. Pi records active-tool changes at the next
  request: the replay can still include a recently deactivated tool until then,
  but the hidden set updates immediately. A payload removal does not change
  Usage, just as other payload changes do not.

Without a snapshot, after a failed or skipped probe, Usage counts the current
branch alone and shows the degraded reason. Session-backed custom messages
count from the current branch once. `computeUsage()` skips system messages
because the prompt/tool snapshot already accounts for them.

**Thinking of other models is left out, as Pi drops it.** `src/index.ts`
passes the next request's model to `computeUsage()`: `ctx.model` for a
physical selection, or the model of the latest reply that is not an error or
aborted for a virtual one. Like Pi's routed-model lookup, the reply comes from
the branch messages without the latest request's changes, which
`applyRequestSnapshot()` also returns. Assistant Thinking skips messages from another
provider, API, or model, including their tool calls' signature proxy; like
deleted messages, that thinking gets no preview and no marker. Without a model,
all thinking counts. [THINKING.md](../THINKING.md#counting-architecture) holds
the counting rules.

This is a provider-independent semantic estimate, not a wire-size estimate.
Some providers keep earlier section versions or tool declarations in the cached
transcript; others collapse them. Usage deliberately does not count that
history, patch framing, or provider-specific serialization.

The UI receives `ctx.getContextUsage()` separately. Its reported total is not
used to force category estimates to match. Map rendering rules belong to
[ui/usage.md](../ui/usage.md#context-map).

### Auto-compaction Reserve

Read the reserve from Pi's live merged settings each time Usage opens.
The current model's `compaction.modelOverrides["<provider>/<id>"].reserveTokens`
wins over `compaction.reserveTokens`, then Pi's default. The buffer is absent
when auto-compaction is disabled or settings are invalid; a model switch takes
effect on the next open.

The reserve occupies the tail of the context window after free space. It shrinks
when estimated content grows into it, and free space excludes it so capacity is
not counted twice. Fit scale changes only the map's range: the reserve may lie
outside it without disappearing from the capacity breakdown. Presentation
belongs to [the Usage map](../ui/usage.md#context-map).

## One Snapshot, Two Views

- **Baseline leaf.** Injections rebuilds at `snapshot.leafId`; Usage rebuilds
  at the current leaf and drops modifications and deletions whose entries are
  gone.
- **System changes and forced prompt.** Injections always applies them to
  their captured baseline. Usage applies them only while the replayed system
  state still matches that baseline.
- **Hidden tools.** Injections uses the captured set until another request
  replaces it. Usage uses Pi's live set on every open.
- **Custom messages saved after the request.** They are outside Injections'
  baseline until the next request, but Usage counts them from the current
  branch.
- **Payload changes.** Injections shows guard findings with changed lines. Usage
  does not apply them, including tool removals in the payload.

## Known Limitation: One Request's Changes

Both views use one request's snapshot, not a summary of the run or session.
A tool follow-up replaces the request that started the run, so a one-time
injection can disappear from Injections between prompts. There is no separate
selector for the latest request that started a run.

Usage assumes the next request repeats the latest request's changes, the forced
prompt included. A change that an extension makes only once, or only for a
particular prompt, therefore stays counted until the next request replaces the
snapshot. Additions carry no entry reference, so they remain after branch
navigation or compaction. A modification whose entry is still projected
replaces that entry's current message even if a later `context_edit` changed
it. Payload changes from later `context_with_system` handlers and payload
rewrites are not applied to Usage, including tool removals in the payload.
Usage is not an exact view of the last or next provider request.
