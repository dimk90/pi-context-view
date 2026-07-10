# pi-context-inspect — Development Plan

## Goal

Add a `/context` slash command to pi. It opens an interactive TUI dialog for
understanding what occupies the model context.

The dialog has two tabs:

1. **Injections**
   - **Initial** — the first observable provider-bound context in the current
     extension runtime: pi prompt components, active tool definitions,
     extension prompt additions, and injected messages.
   - **Runtime** — an optional, bounded log of context injections observed
     after the initial snapshot. Logging is disabled by default.
2. **Statistics** — an estimated map of current context usage by data type:
   system instructions, tool schemas, user/assistant messages, thinking,
   tool calls/results, summaries, and extension messages.

The old `--context-inspect` print-and-exit workflow is superseded. See
[HISTORY.md](HISTORY.md).

## Product decisions

- `/context` is TUI-only in v2. Non-TUI invocation reports that TUI mode is
  required; it does not preserve the old plain-table workflow.
- Initial means the first context observable by this extension instance. It
  comes from the first real turn, or from one on-demand silent probe if
  `/context` is invoked before any real turn.
- Initial is frozen once captured. Later changes appear only in Runtime when
  runtime logging is enabled.
- Runtime logging is opt-in, in-memory, bounded, and session-runtime scoped.
  It is never injected into model context or persisted in session entries.
- Statistics are computed on demand. Category totals are estimates and may
  differ from pi/provider token accounting.
- Per-extension attribution of chained prompt edits is unavailable through the
  public API. Prompt additions remain one aggregate extension contribution.
- Tool ownership uses `ToolInfo.sourceInfo`. Injected messages are identified
  by `customType` when present; `customType` is not guaranteed to be a package
  or extension name.

## UI sketch

```text
┌ Context ────────────────────────────────────────────────┐
│ [Injections]  Statistics                                │
│                                                        │
│ INITIAL                      captured: synthetic probe  │
│  pi                                             3,126  │
│    base system prompt                             652  │
│    built-in tool definitions                      640  │
│    context files                                  846  │
│      ~/.pi/agent/AGENTS.md                         89  │
│      ./AGENTS.md                                  757  │
│    skills                                         988  │
│  npm:pi-web-providers                           1,510  │
│    web_search                                   1,414  │
│    web_contents                                    96  │
│  extensions (aggregate)                            85  │
│                                                        │
│ RUNTIME                         logging: off            │
│  Press r to start logging future injections.            │
│                                                        │
│ ↑/↓ select · Enter preview · Tab switch · r logging    │
│ Esc close                                              │
└────────────────────────────────────────────────────────┘
```

## Architecture

### Initial capture: prepare, then finalize once

The initial snapshot is built across two events:

1. `before_agent_start`
   - Save `event.systemPromptOptions` for structured pi-native inputs.
   - Record the active tools and their `sourceInfo` metadata.
   - Do not freeze `event.systemPrompt`: later-loaded handlers may still edit
     it.
2. The first `context` event for that run
   - Read `ctx.getSystemPrompt()`. At this point every
     `before_agent_start` handler has completed, so this is the final chained
     prompt even when the inspector extension loaded before an injector.
   - Capture observable injected messages, excluding synthetic probe entries
     and ordinary conversation history.
   - Measure and freeze the Initial snapshot. Later `context` events never
     overwrite it.

This removes the old “load last for accurate prompt aggregate” requirement.
Load order still limits visibility into message mutations made by later
`context` handlers. Provider-payload rewrites in `before_provider_request` are
also outside the guaranteed capture surface.

Conditional prompt additions that are inactive in the initial run correctly
do not appear in Initial. If they activate later, Runtime records them when
logging is enabled.

### On-demand silent probe

`/context` needs a complete Initial snapshot even before the first real prompt.
The public API has no direct way to invoke the `before_agent_start` chain, so
one synthetic run is necessary.

Important API constraint: `pi.sendMessage(..., { triggerTurn: true })` starts
the low-level agent directly and does **not** run `before_agent_start`. It
cannot be used for this probe.

Probe state machine:

1. If Initial already exists, open the dialog immediately.
2. Otherwise wait for idle and enter `probing` state.
3. Hide the normal working row and call `pi.sendUserMessage("")`.
4. Capture through the normal `before_agent_start` → `context` path.
5. Abort at `turn_start`, before any provider request.
6. Record synthetic user/assistant message timestamps from message events.
7. Only for the probe assistant message, `message_end` returns an empty
   assistant message with `stopReason: "stop"`; this suppresses pi’s
   “Operation aborted” transcript row without affecting genuine user aborts.
8. At `agent_settled`, restore UI state, resolve the pending command, and open
   the dialog.

The empty synthetic user and assistant entries remain in the session tree.
They must be filtered by exact role+timestamp from every later `context`
event, the Statistics tab, and Runtime logging. They are hidden from the
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

When enabled, inspect each provider-bound `context` event and record only
changes relative to the previous observable state:

- final chained system-prompt changes;
- active tool additions/removals;
- observable context-only or custom message additions/removals.

Normal conversation growth—assistant replies and tool results—is not a runtime
injection; it belongs in Statistics.

Each entry stores request index, kind, label/source, estimated token delta, and
bounded preview text. Use a ring buffer with both entry and byte limits
(initial target: 200 entries and 1 MiB). Show an eviction counter when older
entries are dropped.

Toggle from either surface:

- `r` in the Injections tab;
- `/context runtime on|off`.

The UI records “enabled at request N,” so it does not imply that earlier
runtime injections were captured. Tree navigation clears the log and resets
its comparison baseline while retaining the enabled/disabled setting.
Reload/new/resume/fork creates a fresh extension runtime and clears all
in-memory logging state.

### Context statistics

Statistics are computed when the tab opens or refreshes; there is no continuous
statistics collector.

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
  preview text, optional request index.
- `InjectionGroup` — source/category plus child items and totals.
- `RuntimeInjection` — change kind and signed token delta.
- `ContextStatistics` / `StatisticCategory` — category totals and overall
  usage metadata.

Raw preview text can contain sensitive project instructions or message
content. Keep it process-local, never log it, never persist it, and reveal it
only after explicit Enter selection in the dialog.

### Source layout target

- `src/index.ts` — extension factory and event/command wiring only.
- `src/model.ts` — semantic capture/report types.
- `src/capture.ts` — initial snapshot and silent-probe state machine.
- `src/runtime.ts` — bounded runtime diff log.
- `src/measure.ts` — pure prompt/tool measurement.
- `src/statistics.ts` — pure message classification and totals.
- `src/ui/context-dialog.ts` — overlay state machine and rendering.
- `src/report.ts` — temporary v1 debug renderer; remove once the dialog and
  tests no longer use it.

### Dialog behavior

Use one component state machine rather than nesting disposable components:

- `tab`: `injections | statistics`;
- `view`: `list | preview`;
- selected row and scroll offset per tab.

Tab/Shift+Tab or Left/Right switches tabs. Up/Down and j/k navigate. Enter
opens a scrollable preview. Escape returns from preview to list, then closes
the dialog. Use pi’s injected theme/keybindings, `matchesKey`, ANSI-aware width
helpers, render caching, and proper theme invalidation.

Use an overlay on sufficiently large terminals. On narrow terminals, open the
same component as a regular full custom view rather than hiding or clipping the
overlay.

## Development steps

- [ ] 1. **Remove v1 CLI lifecycle and establish passive capture.**
  - Delete `registerFlag`, automatic probe, abort/report/shutdown path,
    watchdog, retry timer, shutdown grace period, JSON refusal, print fallback,
    and `-p` hint from `src/index.ts`.
  - Add capture-once preparation in `before_agent_start` and finalization in
    `context` using final `ctx.getSystemPrompt()`.
  - Keep normal prompts behaviorally unchanged; no automatic probe.
  - Keep `measure.ts` and the temporary `report.ts` while capture is verified.
  - Update package description/keywords after the CLI code is gone.
  - Verify `npx tsc --noEmit`, a normal prompt, and marker capture with both
    extension load orders.
- [ ] 2. **Introduce semantic data model and module boundaries.**
  - Add `model.ts` and `capture.ts`; keep `index.ts` registration-only.
  - Replace label-parsing assumptions with typed item/group/source fields.
  - Add pure tests for grouping, totals, stable ids, and final snapshot freeze.
- [ ] 3. **Implement the silent probe and `/context` command shell.**
  - Add the guarded state machine described above; verify the partial PoC
    findings in production wiring.
  - Register `/context` and `/context runtime on|off` argument handling.
  - Before first real turn: probe once, await `agent_settled`, then show a
    minimal custom dialog confirming capture; on failure show degraded data.
  - Verify no provider call, no transcript artifacts, no model-context
    pollution, exact filtering of only synthetic entries, repeated command
    idempotency, and genuine user abort rendering.
- [ ] 4. **Build the Injections/Initial dialog.**
  - Tab bar with Statistics placeholder.
  - Hierarchical groups/items, totals, capture-origin metadata, navigation,
    scrolling, narrow-terminal fallback, themed colors and bold text.
- [ ] 5. **Add injection preview mode.**
  - Enter opens `InjectionItem.text`; scrolling via arrows/j/k/PgUp/PgDn;
    Escape returns to the same selected list row.
  - Wrap ANSI-aware text and avoid exposing raw content outside the dialog.
- [ ] 6. **Add bounded opt-in Runtime logging.**
  - Implement prompt/tool/message diffing, request indexing, ring-buffer
    limits, eviction count, both toggle surfaces, and Runtime section UI.
  - Verify disabled overhead is only guarded event dispatch/state checks.
- [ ] 7. **Add the Statistics tab.**
  - Implement `buildSessionContext().messages` classification and synthetic
    filtering in `statistics.ts`.
  - Render category totals, proportions, pi usage/context-window metadata,
    unknown-after-compaction state, and refresh behavior.
- [ ] 8. **Polish lifecycle and edge cases.**
  - Streaming command invocation, probe timeout/no model/no auth, zero other
    extensions, compaction, tree navigation, reload/new/resume/fork, dynamic
    tools, images, and conditional prompt additions.
- [ ] 9. **Complete automated and real-TTY testing.**
  - Pure measurement/grouping/runtime/statistics tests.
  - Real pty tests at 60/80/120 columns; theme invalidation; overlay/full-view
    behavior; marker before/after inspector; no provider-call sentinel.
  - Use `script` or Python `pty`; tmux is unavailable in this environment.
- [ ] 10. **Documentation and release.**
  - README with `/context`, tabs, preview/privacy notes, runtime logging
    overhead/bounds, estimate disclaimer, and screenshots/asciicast.
  - Remove obsolete v1 renderer/PoC files if no longer useful.
  - Add repository/homepage/bugs metadata; decide release version, then tag and
    verify `pi install` + `pi list`.

## Initial hierarchy

- pi
  - base/custom system prompt
  - built-in tool prompt text and payload definitions
  - context files → one child per path
  - skills → one child per skill if reliably separable, otherwise aggregate
  - appended system prompt
- each extension/tool source (`sourceInfo.source`)
  - tool → one child per active tool
  - custom message → identified by `customType` when available
- extensions (unattributable)
  - chained prompt additions aggregate
- TOTAL

## Verification invariants

- Inspection never calls a provider.
- Normal turns are unchanged when `/context` is not invoked and runtime logging
  is off.
- Initial freezes once per extension runtime.
- Final prompt capture is independent of inspector/injector load order.
- Probe suppression never hides a genuine user abort.
- Synthetic probe messages never reach later provider contexts or statistics.
- Runtime storage is bounded and disabled by default.
- No raw injection content is printed, logged, or persisted.
- Every rendered TUI line stays within the supplied width.

## Remaining questions

- Can the structured skills block be split per skill without duplicating pi’s
  private formatter, or should it remain one aggregate item?
- For context-only message mutations, should the UI emphasize the inspector’s
  chain-position limitation inline or only in documentation?
- Which release version is appropriate if the old CLI version was never
  publicly released: `v0.1.0` or `v0.2.0`?
