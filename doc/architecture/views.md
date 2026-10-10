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
   Prompt item carries the `forced` request-only change. Current
   `getSystemPromptOptions().customPrompt` preserves Dropped markers for
   `--system-prompt`. Other live prompt options do not replace recorded
   sections.
4. Keep session-backed custom messages. Replace their rows when modified or
   deleted. Add every request-only conversation change under its `customType`
   source or `unattributed`; unchanged ordinary conversation stays out of the
   tree.

Added and modified rows count their request version. Deleted rows count zero.
A modified message previews `Request` and `Session` parts: only Request counts;
a deletion previews its session original. Message previews use the
content-only extraction in `src/message-preview.ts`. Snapshot images already
hold size markers; session originals are redacted on extraction. Neither
source's opaque signature bytes reach a preview.

System changes mark the affected prompt part or tool in place. These groups
identify the affected content, **not the editing extension**. Marking a pi part
never attributes its editor to pi. The replay supplies exact section
boundaries, including inline XML, empty, and unwrapped sections, so repeated
text cannot move a marker onto another section. Deleted sections keep their
original text at zero tokens, after sent parts and before Extension Additions.
A deleted tool keeps its definition at zero tokens. The total counts only this
view's contributions, not unchanged ordinary history or provider serialization.

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
  compared channel form a separate `payload changes` group after
  `unattributed`. They have no entry reference or attribution. An item keeps the finding's changed lines for
  its preview; its text and estimate hold only the added lines, so a deletion
  counts zero. Tool removals Pi did not hide belong here. Item kinds are
  `message` and `tool`.

Probe snapshots carry the warning specified in
[ui/injections.md](../ui/injections.md#latest-request). Pending and incomplete
guards appear as an unavailable or partial payload-change comparison in the
description, never as "no edits". A complete guard adds no note. The view is
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
  appended text counts as an extension addition. Like Injections, Usage marks
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

This is a provider-independent semantic estimate, not a wire-size estimate.
Some providers keep earlier section versions or tool declarations in the cached
transcript; others collapse them. Usage deliberately does not count that
history, patch framing, or provider-specific serialization.

The UI receives `ctx.getContextUsage()` separately. Its reported total is not
used to force category estimates to match. Map rendering rules belong to
[ui/usage.md](../ui/usage.md#context-map).

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
