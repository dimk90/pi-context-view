# pi-context-inspect — Development Plan

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
  - **Runtime** — an optional, bounded log of context injections observed
    after the initial snapshot. Logging is disabled by default.
- `/context runtime on|off` — control future Runtime logging without opening a
  view or triggering a probe.

The old `--context-inspect` print-and-exit workflow is superseded. See
[HISTORY.md](HISTORY.md).

## Product decisions

- `/context` is TUI-only in v2. Non-TUI invocation reports that TUI mode is
  required; it does not preserve the old plain-table workflow.
- `/context` defaults to `/context usage`. Usage and Injections are separate,
  focused overlays with no tabs or tab-switching keybindings.
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

Default — `/context` or `/context usage`:

```text
┌ Context usage ──────────────────────────────────────────┐
│ estimated current/next-request composition              │
│                                                        │
│ system prompt                                  3,126   │
│ active tool schemas                            2,146   │
│ user messages                                  1,805   │
│ assistant text                                 8,491   │
│ thinking                                       3,102   │
│ tool calls/results                             4,384   │
│ summaries                                      1,227   │
│                                                        │
│ estimated total                              24,281   │
│ pi usage                         24,958 / 200,000  12% │
│                                                        │
│ r refresh · Esc close                                  │
└────────────────────────────────────────────────────────┘
```

`/context injections`:

```text
┌ Context injections ─────────────────────────────────────┐
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
│ ↑/↓ select · Enter preview · r logging · Esc close     │
└────────────────────────────────────────────────────────┘
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
do not appear in Initial. If they activate later, Runtime records them when
logging is enabled.

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

When enabled, inspect each provider-bound `context` event and record only
changes relative to the previous observable state:

- final chained system-prompt changes;
- active tool additions/removals;
- observable context-only or custom message additions/removals.

Normal conversation growth—assistant replies and tool results—is not a runtime
injection; it belongs in Usage.

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
  preview text, optional request index.
- `InjectionGroup` — source/category plus child items and totals.
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
- `src/ui/injections-view.ts` — Initial/Runtime explorer and preview state.
- `src/report.ts` — temporary v1 debug renderer; remove once the views and
  tests no longer use it.

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
The Usage view is read-only: `r` recomputes usage and Escape closes it. The
Injections view has a small state machine (`list | preview`), selected row, and
scroll offsets. Up/Down and j/k navigate; Enter opens a scrollable preview;
Escape returns from preview to list, then closes the view. In that view, `r`
toggles Runtime logging.

Use pi’s injected theme/keybindings, `matchesKey`, ANSI-aware width helpers,
render caching, and proper theme invalidation. Use overlays on sufficiently
large terminals. On narrow terminals, open the same components as regular full
custom views rather than hiding or clipping them.

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
    scrolling, narrow-terminal fallback, themed colors, and bold text.
  - Set it as temporary default for `/context`.
- [ ] 5. **Add injection preview mode.**
  - Enter opens `InjectionItem.text`; scrolling via arrows/j/k/PgUp/PgDn;
    Escape returns to the same selected list row.
  - Wrap ANSI-aware text and avoid exposing raw content outside the view.
- [ ] 6. **Build the Usage view (the default).**
  - Implement `buildSessionContext().messages` classification and synthetic
    filtering in `usage.ts`.
  - Render category totals, proportions, pi usage/context-window metadata,
    unknown-after-compaction state, and `r` refresh behavior.
  - Add narrow-terminal fallback, themed colors, and bold text.
  - Set as default for `/context`.
- [ ] 7. **Add map/graph for context usage visualization.**
  - Use Claude Code like context visualization -> ask me for template/example.
- [ ] 8. **Add bounded opt-in Runtime logging.**
  - Implement prompt/tool/message diffing, request indexing, ring-buffer
    limits, eviction count, both toggle surfaces, and Runtime section UI.
  - Verify disabled overhead is only guarded event dispatch/state checks and
    `/context runtime on|off` never probes or opens a view.
- [ ] 9. **Polish lifecycle and edge cases.**
  - Streaming command invocation, probe timeout/no model/no auth, zero other
    extensions, compaction, tree navigation, reload/new/resume/fork, dynamic
    tools, images, and conditional prompt additions.
- [ ] 10. **Complete automated and real-TTY testing.**
  - Pure measurement/grouping/runtime/usage tests.
  - Real pty tests at 60/80/120 columns; theme invalidation; overlay/full-view
    behavior; both focused views; marker before/after inspector;
    no-provider-call sentinel.
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
- Synthetic probe messages never reach later provider contexts or Usage.
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
