# pi-context-view — Development Plan

## Goal

Add a `/context` slash command to pi with focused subcommands rather than one
tabbed dialog:

- `/context` or `/context usage` — open an estimated map of current context
  usage by data type: system instructions, tool schemas, user/assistant
  messages, thinking, tool calls/results, summaries, and extension messages.
- `/context injections` — open the injection explorer:
  - **Initial** — the first observable provider-bound context in the current
    extension runtime: pi prompt components, active tool definitions,
    extension prompt additions, and injected messages.
  - **Runtime** — an optional, bounded log of hidden provider-bound context
    mutations observed after the initial snapshot. Logging is disabled by
    default.
- `/context runtime on|off` — control future Runtime logging without opening a
  view or triggering a probe.

The old `--context-inspect` print-and-exit workflow is superseded. See
[HISTORY.md](HISTORY.md).

## Product decisions

- `/context` is TUI-only in v2. Non-TUI invocation reports that TUI mode is
  required; it does not preserve the old plain-table workflow.
- `/context` defaults to `/context usage`. Usage and Injections are separate,
  focused fullscreen overlays with no tabs or tab-switching keybindings.
- Unknown arguments show concise command usage; argument completions offer
  `usage`, `injections`, and `runtime on|off`.
- Initial means the first context observable by this extension instance. It
  comes from the first real turn, or from one on-demand silent probe if a
  Usage/Injections view is requested before any real turn.
- Initial is frozen once captured. Later changes appear only in Runtime when
  runtime logging is enabled.
- Runtime logging is opt-in, in-memory, bounded, and session-runtime scoped.
  It is never injected into model context or persisted in session entries.
- Usage is computed on demand. Category totals are estimates and may differ
  from pi/provider token accounting.
- Per-extension attribution of chained prompt edits is unavailable through the
  public API. Prompt additions remain one aggregate extension contribution.
- Tool ownership uses `ToolInfo.sourceInfo`. Injected messages are identified
  by `customType` when present; `customType` is not guaranteed to be a package
  or extension name.

## UI sketches

Both views are fullscreen with horizontal top/bottom borders, one blank padding
row inside each border and after the dialog header, an accent title with the
capture/summary aligned right, a `→` cursor in a fixed column, a muted
description between blank rows above the hints, and dim key + muted description
hints. Headers, sub-headers, and the cursor sit flush at column 0; sub-headers
are bold and use `mdHeading`; the description, scroll counter, hint row, and
preview body are indented two spaces. Hints are joined by ` · `. Titles, section
names, and hint labels use Title Case
(`Context Injections`, `Esc Close`); recognizable identifiers such as `pi` and
tool names (`edit`, `web_search`) keep their literal casing, and longer
descriptions stay sentence case. `(current/total)` appears only while scrolling.

Default — `/context` or `/context usage`:

```text
────────────────────────────────────────────────────────────────────────────────

  Context Usage:

  ■ ■ ■ ◧ ◧ ■ ■ ■ ■ ■ ⛶ ⛶ ⛶ ⛶     Model:
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶    claude-opus-4-8
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶    43.8k/1m tokens (4%)
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶    Category:
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶    ■ System Prompt: 3.7k tokens (0.4%)
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶    ■ System Tools: 11.8k tokens (1.2%)
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶    ■ Custom Tools: ...
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶    ■ MCP tools: ...
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶    ■ Memory (AGENTS.md): 1.8k tokens (0.2%)
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶    ■ Skills: 3.2k tokens (0.3%)
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶    ■ User Messages: ...
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶    ■ Tool Output: ...
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶    ■ Extensions: ...
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶    ▦ Compacted Data: ...
  ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶    ⛶ Free space: 955.8k (95.6%)

  ↑↓ Navigate · Enter Preview · Esc Close

────────────────────────────────────────────────────────────────────────────────
```

`/context injections`:

```text
────────────────────────────────────────────────────────────────────────────────

Context Injections                                        Runtime Logging: Off

[INITIAL]
→ pi                                                                     3,000
    Base Prompt                                                            652
    Built-in Tools (4)                                                     640
      edit                                                                 278
      read                                                                 154
      bash                                                                 118
      write                                                                 90
    Skills (6)                                                             862
      code-style                                                           236
      pi-extension                                                         192
      typescript-code                                                      168
      skill-creator                                                        124
      python-code                                                           82
      commit                                                                60
    ~/.pi/agent/AGENTS.md                                                   89
    ./AGENTS.md                                                            757
  npm:pi-web-providers                                                   1,510
    web_search                                                           1,414
    web_contents                                                            96
  extensions (aggregate)                                                    85
  (1/22)

  TOTAL                                                                  4,912

  Initial injections and estimated token counts.

  ↑↓ Navigate · Enter Preview · R Toggle Runtime Logging · Esc Close

────────────────────────────────────────────────────────────────────────────────
```

When capture is degraded (no model/auth or a failed probe), the `INITIAL`
sub-header is tagged — `Degraded:` in the error color — and the specific reason
wraps directly below it:

```text
[INITIAL] [Degraded: pi-native fallback used]
  Silent probe unavailable: context-noauth has no configured authentication.
  Extension additions were not observed.
→ pi                                                                     3,000
...
```

Enter on an item opens a scrolling raw-text preview:

```text
────────────────────────────────────────────────────────────────────────────────

Base Prompt                                                pi · 652 tokens

  You are pi, a coding agent. ...
  ...raw captured text, wrapped to width...

  (1/58)

  ↑↓ Scroll · PgUp/PgDn Page · Esc Back

────────────────────────────────────────────────────────────────────────────────
```

## Architecture

### Initial capture: prepare, then finalize once

The initial snapshot is built across two events:

1. `before_agent_start`
   - Save `event.systemPromptOptions` for structured pi-native inputs — the
     only event where they are available.
   - Nothing else: `event.systemPrompt` is not final (later-loaded handlers
     may still edit it), and the active tool set is not final either (later
     handlers may call `pi.setActiveTools()`).
2. The first `context` event for that run
   - Read `ctx.getSystemPrompt()`. At this point every
     `before_agent_start` handler has completed, so this is the final chained
     prompt even when the inspector extension loaded before an injector.
   - Snapshot the final active tool set (`getAllTools` ∩ `getActiveTools`)
     with `sourceInfo` metadata — load-order independent for the same reason.
   - Capture observable injected messages, excluding synthetic probe entries
     and ordinary conversation history.
   - Measure and freeze the Initial snapshot as owned copies (no shared
     references other extensions could mutate). Later `context` events never
     overwrite it.

This removes the old “load last for accurate prompt aggregate” requirement.
Load order still limits visibility into message mutations made by later
`context` handlers. Provider-payload rewrites in `before_provider_request` are
also outside the guaranteed capture surface.

Conditional prompt additions that are inactive in the initial run correctly
do not appear in Initial. If they activate later, Runtime records the hidden
provider-bound change when logging is enabled.

### On-demand silent probe

Both `/context usage` (including bare `/context`) and
`/context injections` need a complete Initial snapshot even before the first
real prompt. The public API has no direct way to invoke the
`before_agent_start` chain, so one synthetic run is necessary. Runtime toggle
subcommands never trigger a probe.

Important API constraint: `pi.sendMessage(..., { triggerTurn: true })` starts
the low-level agent directly and does **not** run `before_agent_start`. It
cannot be used for this probe.

Probe state machine:

1. If Initial already exists, open the requested Usage or Injections view
   immediately.
2. Otherwise wait for idle and enter `probing` state.
3. Hide the normal working row and call `pi.sendUserMessage("")`.
4. Capture through the normal `before_agent_start` → `context` path.
5. Abort at `turn_start`, before any provider request.
6. Record synthetic user/assistant message timestamps from message events.
7. Only for the probe assistant message, `message_end` returns an empty
   assistant message with `stopReason: "stop"`; this suppresses pi’s
   “Operation aborted” transcript row without affecting genuine user aborts.
8. At `agent_settled`, restore UI state, resolve the pending command, and open
   the requested view.

The empty synthetic user and assistant entries remain in the session tree.
They must be filtered by exact role+timestamp from every later `context`
event, the Usage view, and Runtime logging. They are hidden from the
transcript and model, but the probe is not side-effect-free: other extensions
still observe its lifecycle events. Run it only on demand and at most once per
extension runtime.

Use a short timeout and `try/finally` UI restoration so a failed probe cannot
hang `/context` or leave the working row hidden. If no model/auth is available
or the probe otherwise fails, show the pi-native snapshot obtainable from
`ctx.getSystemPromptOptions()` plus a clear “extension additions not observed”
note.

### Runtime injection logging

Runtime logging is disabled by default. Disabled handlers return after one
state check.

When enabled, compare each provider-bound `context` event with the previous
observable state and record only hidden mutations that the interactive
transcript does not already explain:

- final chained system-prompt components added, removed, or changed, including
  conditional extension additions, skills, and context files;
- active tools added or removed, and tool schemas changed;
- transient messages added only for provider context;
- ordinary branch messages modified or removed by `context` handlers before
  the provider call.

Do not copy ordinary user/assistant messages, visible custom messages, tool
calls/results, or unchanged prompt components into Runtime. Normal conversation
growth belongs in Usage. When no hidden context mutation occurs, Runtime stays
empty.

Each entry stores request index, kind, label/source, estimated token delta, and
bounded preview text. Use a ring buffer with both entry and byte limits
(initial target: 200 entries and 1 MiB). Show an eviction counter when older
entries are dropped.

Toggle from either surface:

- `r` in the Injections view;
- `/context runtime on|off` (no view and no probe).

The UI records “enabled at request N,” so it does not imply that earlier
runtime injections were captured. Tree navigation clears the log and resets
its comparison baseline while retaining the enabled/disabled setting.
Reload/new/resume/fork creates a fresh extension runtime and clears all
in-memory logging state.

### Context usage

Usage is computed when `/context` or `/context usage` opens, and again when the
user presses `r`; there is no continuous usage collector.

Use `ctx.sessionManager.buildSessionContext().messages`, not
`buildContextEntries()`: the latter preserves non-context metadata entries.
Filter synthetic probe messages, then classify estimated tokens into:

- system prompt: base/custom prompt, built-in prompt text, context files,
  skills, appended prompt, aggregate extension additions;
- active tool payload definitions;
- user messages;
- assistant text, thinking, and tool-call blocks;
- tool results grouped by tool name;
- custom messages grouped by `customType`;
- compaction and branch summaries;
- bash execution messages included in context.

Use `ctx.getContextUsage()` for pi’s overall `tokens`, `contextWindow`, and
`percent` when available. Display that separately from the estimated category
sum; after compaction pi may report unknown usage until the next response.
Provider serialization, images, tokenizer differences, later `context`
handlers, and provider-payload rewrites can prevent exact reconciliation.
Label the view **estimated current/next-request composition**, not an exact
provider payload.

### Semantic model

Do not encode hierarchy in display labels. Introduce explicit pure data types,
for example:

- `InitialSnapshot` — origin (`real-turn` or `synthetic-probe`), timestamp,
  measured items, synthetic-message identities.
- `InjectionItem` — stable id, phase, kind, source, label, tokens, chars, raw
  preview text, optional request index, and optional constituent children.
  Children are a breakdown of the parent (currently individual built-in tools),
  not additional contributions to group or snapshot totals.
- `InjectionGroup` — source/category plus top-level items and totals.
- `RuntimeInjection` — change kind and signed token delta.
- `ContextUsageSnapshot` / `UsageCategory` — category totals and overall usage
  metadata.

Raw preview text can contain sensitive project instructions or message
content. Keep it process-local, never log it, never persist it, and reveal it
only after explicit Enter selection in the Injections view.

### Source layout target

- `src/index.ts` — extension factory and event/command wiring only.
- `src/model.ts` — semantic capture/report types.
- `src/capture.ts` — initial snapshot and silent-probe state machine.
- `src/runtime.ts` — bounded runtime diff log.
- `src/measure.ts` — pure prompt/tool measurement.
- `src/usage.ts` — pure message classification and usage totals.
- `src/ui/usage-view.ts` — focused Usage overlay.
- `src/ui/usage-map.ts` — pure proportional-cell model for the Usage graph.
- `src/ui/injections-view.ts` — Initial/Runtime explorer and preview state.

### Command and view behavior

One command handler parses a small explicit grammar:

```text
/context                 → usage
/context usage           → usage
/context injections      → injections
/context runtime on|off  → toggle only
```

Provide argument completion for this grammar. Unknown or incomplete arguments
show concise usage rather than silently choosing a view.

The views are independent; there is no tab state or tab-switching keybinding.
Both views share a small state machine (`list | preview`), a selected row, and
scroll offsets. Up/Down/PgUp/PgDn/Home/End navigate; Enter opens a scrollable
preview; Escape returns from preview to list, then closes the view. The Usage
preview shows the selected category's actual content as a chronological entry
stream (bracketed datetime/breadcrumb/token headers, capped sanitized content);
the Injections preview shows sanitized raw injection text. In the Injections
view, `r` toggles Runtime logging.

Use pi’s injected theme/keybindings, `matchesKey`, ANSI-aware width helpers,
render caching, and proper theme invalidation. Both focused views use fullscreen
overlays at all terminal widths; content must resize rather than clip.

The Injections header shows the current runtime-logging status
(`Runtime Logging: On|Off`) right-aligned; there is no standalone status line.
The `RUNTIME` section is shown only once it has logged entries (step 8), so an
empty log adds no rows.

Match pi's native selector styling (`/settings`, `/model`): one blank padding
row inside both borders and after the dialog header; keep exactly one blank row
between the dialog header and `INITIAL`, and one before later sub-headers such as
`RUNTIME` when present. Use an accent title, bold `mdHeading` sub-headers, a `→`
cursor, and an accent selected label; keep the cursor in a fixed column with
hierarchy indentation after it; use bright `text` for main rows, `muted` for
sub-items and values, and `dim` for sub-sub-items. Selection
uses `accent` for both label and value, never a full-line background. Put a
concise muted dialog description between blank rows above the hotkey row.
Indent descriptions, scroll counters, hints, and preview bodies two spaces.
Format hints as dim key + muted description and show a dim `(current/total)`
line only when scrolling is required.

## Development steps

- [x] 1. **Remove v1 CLI lifecycle and establish passive capture.**
  - Delete `registerFlag`, automatic probe, abort/report/shutdown path,
    watchdog, retry timer, shutdown grace period, JSON refusal, print fallback,
    and `-p` hint from `src/index.ts`.
  - Add capture-once preparation in `before_agent_start` (prompt options
    only) and finalization in `context`: final `ctx.getSystemPrompt()`, final
    active tool set, injected messages — all frozen as owned copies.
  - Keep normal prompts behaviorally unchanged; no automatic probe.
  - Keep `measure.ts` and the temporary `report.ts` while capture is verified.
  - Update package description/keywords after the CLI code is gone.
  - Verify `npx tsc --noEmit`, a normal prompt, and marker capture with both
    extension load orders; verify tool-set mutations from a later-loaded
    extension's `before_agent_start` are reflected in both load orders.
- [x] 2. **Introduce semantic data model and module boundaries.**
  - Add `model.ts` and `capture.ts`; keep `index.ts` registration-only.
  - Replace label-parsing assumptions with typed item/group/source fields.
  - Add pure tests for grouping, totals, stable ids, and final snapshot freeze.
- [x] 3. **Implement the silent probe and `/context` command shell.**
  - Add the guarded state machine described above; verify the partial PoC
    findings in production wiring.
  - Register the explicit command grammar and argument completions:
    `/context` → usage, `/context usage`, `/context injections`, and
    `/context runtime on|off`.
  - Usage/Injections before the first real turn: probe once, await
    `agent_settled`, then show a minimal placeholder for the requested view;
    Runtime toggles never probe. On failure show degraded data.
  - Verify no provider call, no transcript artifacts, no model-context
    pollution, exact filtering of only synthetic entries, repeated command
    idempotency, and genuine user abort rendering.
- [x] 4. **Build the Injections/Initial view.**
  - Hierarchical groups/items, totals, capture-origin metadata, navigation,
    scrolling, fullscreen overlay, and pi-native selector styling.
  - Use fixed-column `→` selection, foreground-only highlighting, main/sub-item
    hierarchy colors, muted values (accent when selected), dim scroll position,
    padded description + styled hotkey rows, top/bottom padding, one row after
    the dialog header, and one row before `RUNTIME` when that section is shown.
  - Set it as temporary default for `/context`.
- [x] 5. **Add injection preview mode.**
  - Enter opens `InjectionItem.text`; scrolling via arrows/PgUp/PgDn; Escape
    returns to the same selected list row.
  - Wrap ANSI-aware text and avoid exposing raw content outside the view.
  - Show individual built-in pi tools as previewable breakdown children under
    the built-in tool-definitions aggregate without double-counting totals.
- [x] 5a. **Harden completed capture and Injections paths after review.**
  - Ensure a probe that times out before `before_agent_start` still owns and
    aborts any delayed synthetic turn, so it can never reach a provider.
  - Sanitize preview terminal control sequences before rendering sensitive raw
    injection text; wrapping alone must not permit terminal escape injection.
  - Include terminal height and wrapped degraded-warning lines in fullscreen
    layout/cache calculations; verify same-width height-only resizing and very
    short terminals.
- [x] 6. **Build the Usage view (the default).**
  - Implement `buildSessionContext().messages` classification and synthetic
    filtering in `usage.ts`.
  - Render category totals, proportions, pi usage/context-window metadata,
    and the unknown-after-compaction state. Split user, agent
    text, agent thinking, and agent tool-call messages into independent colored
    top-level categories. Keep provider tool results and persisted bash output
    in a top-level `Tool Output` category.
  - Add a fullscreen overlay that resizes cleanly, themed colors, and bold text.
  - Set as default for `/context`.
- [x] 7. **Add map/graph for context usage visualization.**
  - Render the selected 14×14 Claude Code-like map with themed `■` full,
    `◧` partial, `▦` compacted-data, and dim `⛶` free cells.
  - Allocate occupied cells from estimated category totals against pi's context
    window; keep pi-reported overall usage separate because its accounting and
    last-response timing may differ.
  - Keep the color-matched category legend beside the map at 52+ columns, remove
    inter-cell spacing from 52–71 columns, and retain a category-only fallback
    below 52 columns.
  - Give every top-level category a distinct semantic theme color except the
    intentionally shared small System Prompt/System Tools color; align token
    values and percentages in separate columns at the earliest common position.
  - Keep all aggregate breakdowns collapsed except `Tool Output`: show its
    per-tool results and bash executions directly, without a `Tool Results`
    layer. Make that list independently scrollable when needed; map allocation
    continues to use top-level totals only.
- [x] 7a. **Make Usage categories selectable and add category content preview.**
  - Add a fixed-column cursor plus arrow, Page Up/Down, Home, and End navigation
    across category rows; keep scrolling bounded and preserve selection through
    width/height reflows.
  - Open the selected category with Enter. Preview its actual content as a
    chronological entry stream, one entry per constituent block: header
    `[DD-MM-YYYY HH:MM:SS] [breadcrumb…] tokens` (dim datetime and tokens,
    mdHeading first bracket cell, muted rest), content indented below, blank
    row between entries.
  - Assistant messages produce per-block entries: tool calls get
    `[assistant] [toolname]`, text/thinking add a `text i/n` cell only for
    multi-block messages. Snapshot-backed categories (System Prompt/Tools,
    Skills, Memory) omit the datetime cell and keep category order.
  - Cap each entry at 20 wrapped lines with a dim `… +N lines` marker; full
    content still counts in tokens. Content is explicit-Enter-only,
    terminal-sanitized, memory-only, and unpersisted.
  - Escape returns to the same selected row; a second Escape closes the Usage
    view. Keep map colors and top-level allocation unchanged in preview mode.
  - Cover per-block splitting, chronological flattening, entry caps,
    sanitization, empty categories, Tool Output children, overflow scrolling,
    narrow widths, and short terminal heights in tests.
- [ ] 8. **Add bounded opt-in Runtime mutation logging.**
  - The current command/view surfaces store only the toggle state; they do not
    log mutations yet and must not be treated as functional until this step.
  - Diff provider-bound states and retain only hidden prompt-component changes,
    active-tool/schema changes, transient context-only messages, and branch
    message mutations made by `context` handlers.
  - Exclude ordinary transcript-visible messages, tool calls/results, normal
    conversation growth, and unchanged components; an unchanged request adds no
    Runtime entries.
  - Add request indexing, ring-buffer limits, eviction count, both toggle
    surfaces, and Runtime section UI shown only when the log is non-empty
    (header always reflects the toggle state).
  - Verify disabled overhead is only guarded event dispatch/state checks,
    visible transcript activity creates no Runtime entries, and
    `/context runtime on|off` never probes or opens a view.
- [ ] 9. **Polish lifecycle and edge cases.**
  - Streaming command invocation, probe timeout/no model/no auth, zero other
    extensions, compaction, tree navigation, reload/new/resume/fork, dynamic
    tools, images, and conditional prompt additions.
- [ ] 10. **Complete automated and real-TTY testing.**
  - Pure measurement/grouping/runtime/usage tests.
  - Real pty tests at 60/80/120 columns; theme invalidation; fullscreen and
    height-only resize behavior; both focused views; marker before/after
    inspector; no-provider-call sentinel.
  - Use `script` or Python `pty`; tmux is unavailable in this environment.
- [ ] 11. **Documentation and release.**
  - README with all `/context` forms, Usage as the default, injection preview
    and privacy notes, runtime logging overhead/bounds, estimate disclaimer,
    and screenshots/asciicast.
      - Check if there best practice/recommendation for pi extension doc.
      - The doc should explicitly mention: what injected into context, slash commands, cli commands.
      - It should contain images for output examples and thumbnail for extension itself (need resolution best practice).
  - Remove obsolete v1 renderer/PoC files if no longer useful.
  - Add repository/homepage/bugs metadata; decide release version, then tag and
    verify `pi install` + `pi list`.

## Initial hierarchy

Within the `pi` group, items use a fixed semantic order regardless of size:
`Base Prompt`, `Built-in Tools (N)`, other tools, `Skills (K)`, then the rest
(context files, prompt additions) by size descending. Home-directory context
file paths are abbreviated with `~`. Measurements and previews use semantic
content only: pi's XML transport wrappers, section-introduction scaffolding,
and dynamic date/working-directory footer are excluded.

- pi
  - Base/Custom Prompt
  - Built-in Tools (N) → one breakdown child per active built-in tool
  - Skills (K) → one content-only breakdown child per skill
  - context file → one item per path (`~` for home paths)
  - appended system prompt
- each extension/tool source (`sourceInfo.source`)
  - tool → one child per active tool
  - custom message → identified by `customType` when available
- extensions (unattributable)
  - chained prompt additions aggregate

`TOTAL` is not part of the scrollable list. It renders as a fixed summary below
the scroll area, separated from the sections above (Initial now, Runtime later)
by one blank row, and sums the token estimates across all of them.

## Verification invariants

- Inspection never calls a provider.
- Normal turns are unchanged when `/context` is not invoked and runtime logging
  is off.
- Initial freezes once per extension runtime.
- Final prompt capture is independent of inspector/injector load order.
- Probe suppression never hides a genuine user abort.
- Synthetic probe messages never reach later provider contexts or Usage.
- Runtime storage is bounded and disabled by default.
- Usage-map occupancy and legend colors match the estimated category model;
  pi-reported usage remains separately labeled metadata.
- Raw injection content is rendered only after explicit Enter preview; it is
  never included in notifications/reports, logged by the extension, or persisted.
- Every rendered TUI line stays within the supplied width.

## Remaining questions

- Can the structured skills block be split per skill without duplicating pi’s
  private formatter, or should it remain one aggregate item?
- For context-only message mutations, should the UI emphasize the inspector’s
  chain-position limitation inline or only in documentation?
- Which release version is appropriate if the old CLI version was never
  publicly released: `v0.1.0` or `v0.2.0`?
