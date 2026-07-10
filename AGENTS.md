# pi-context-inspect

Pi extension in migration from the superseded `--context-inspect` CLI workflow
to focused `/context` TUI views:

- `/context` or `/context usage` — on-demand estimated context composition.
- `/context injections` — frozen Initial snapshot + optional bounded Runtime
  log; Enter previews raw injection text.
- `/context runtime on|off` — toggle future logging without a view or probe.

There are no tabs. No raw injection content is logged or persisted.

The v1 CLI lifecycle has been removed. Passive capture, the one-shot silent
probe, command grammar, and the Injections/Initial view with item preview are
implemented (PLAN.md steps 1–5); review hardening step 5a is next, and
`/context` temporarily defaults to Injections until the Usage view lands. Do
not preserve CLI compatibility during the migration.

## Target architecture

Initial capture is prepared once in `before_agent_start` and finalized once in
the first `context` event:

```text
before_agent_start → save structured prompt options (only available here)
context            → read final ctx.getSystemPrompt(), final active tool set,
                     injected messages; freeze Initial as owned copies
```

`ctx.getSystemPrompt()` in `context` is the completed prompt chain, including
injectors loaded after this extension. Do not freeze `event.systemPrompt` or
the active tool set in our own `before_agent_start` handler — later-loaded
handlers may still edit the prompt or call `pi.setActiveTools()`. Freeze
owned copies only; shared references can be mutated by other extensions.

If Usage or Injections is requested before a real turn, use one on-demand
silent probe. Runtime toggle subcommands never probe:

```text
/context           → wait idle, hide working row, sendUserMessage("")
before_agent_start → prepare Initial
turn_start         → abort before provider
context            → finalize Initial; filter synthetic user message
message_end        → sanitize only synthetic aborted assistant
agent_settled      → restore UI, resolve command, open requested view
```

The probe entries remain in the session tree. Track their exact role+timestamp
and filter them from later model context, Runtime logging, and Usage.
Other extensions still observe probe lifecycle events; never probe
automatically or more than once per extension runtime.

Runtime injection logging is disabled by default, memory-only, and bounded
(initial target: 200 entries / 1 MiB). Usage is computed on demand from
`ctx.sessionManager.buildSessionContext().messages`; use
`ctx.getContextUsage()` separately for pi’s overall usage/window values.

## API constraints

- `ctx.getSystemPromptOptions()` is command-context-only; it is unavailable on
  `session_start` event ctx.
- Extension prompt additions are observable only inside an agent run.
- `pi.sendMessage(..., { triggerTurn: true })` bypasses
  `before_agent_start`; it cannot drive the capture probe.
- Abort probes at `turn_start`; later hooks may allow a provider call.
- `before_provider_request` is unreliable with custom transports that skip
  `onPayload` (e.g. pi-anthropic-oauth); never depend on it.
- Per-extension attribution of chained prompt edits is impossible through the
  public API; use one aggregate contribution.
- `context` message mutations remain chain-position dependent: later handlers
  are not observable. Tool ownership must come from `ToolInfo.sourceInfo`.
- Extensions can inject non-custom-role messages from `context` handlers;
  role-based detection alone misses them (needs session-branch diffing).
- `buildContextEntries()` includes non-context metadata. Use
  `buildSessionContext().messages` for Usage.
- `ctx.ui.custom()` is TUI-only. Guard with `ctx.mode === "tui"`.

## Layout

Target modules (created incrementally per PLAN.md):

- `src/index.ts` — factory and event/command wiring only.
- `src/model.ts` — semantic snapshot/injection/usage types and grouping.
- `src/capture.ts` — capture-once and silent-probe state machines.
- `src/command.ts` — command parsing/completions and capture resolution.
- `src/ui/injections-model.ts` — pure row flattening, list navigation, and
  preview scrolling/normalization.
- `src/ui/injections-view.ts` — fullscreen Injections view with preview state.
- `src/runtime.ts` — bounded optional Runtime log.
- `src/measure.ts` — pure prompt/tool measurement.
- `src/usage.ts` — pure context classification and totals.
- `src/ui/usage-view.ts` — fullscreen Usage view.
- `src/report.ts` — temporary v1 renderer; remove when no longer needed.
- `PLAN.md` — current decisions and step checkboxes; keep them current.
- `HISTORY.md` — superseded v1 findings; reference only.
- `poc/` — throwaway/reference spikes; `marker.ts` is also a test injector.
- `test/` — Node `node:test` pure tests (native TypeScript type stripping).

Keep hierarchy in typed model fields. Never parse labels in UI code to recover
source, kind, or parent/child relationships.

TUI views follow pi's native selector style: fullscreen horizontal-border
layout with one blank row inside top/bottom and after the dialog header, plus
one row before later sub-headers such as `RUNTIME`; accent title and
fixed-column `→` cursor; bright main rows, muted sub-items/values, and dim
sub-sub-items. Selected
labels and values use accent with no background. Put the muted description
between blank rows before hints, format hints as dim key + muted description,
and show dim `(current/total)` only on overflow.

## Verification

```bash
npm run check

# normal-turn no-op: inspection must not alter the response
pi --model anthropic/claude-haiku-4-5 -e ./src/index.ts --no-session \
  -p "Say one word: ok"

# interactive testing without tmux
script -qec "pi --no-extensions -e ./src/index.ts --no-session" /tmp/context-tui.log
```

Use `script` or a Python `pty` harness; tmux is unavailable. Avoid provider
calls when lifecycle-only tests suffice. When a test genuinely needs a model,
use the cheapest/simple default: `anthropic/claude-haiku-4-5`.

Test marker load order in both directions and use an
`after_provider_response` sentinel for the silent probe. Required invariants:

- no provider request during a probe;
- no visible probe/abort transcript artifacts;
- genuine user aborts remain visible;
- synthetic entries never reach later model contexts or Usage;
- Initial freezes once per extension runtime;
- Runtime is off and bounded by default;
- raw injection content appears only after explicit Enter preview and is never
  included in notifications/reports, logged by the extension, or persisted;
- all TUI lines respect the supplied width and fullscreen views resize with
  both terminal width and height.

## Dependencies

`@earendil-works/pi-coding-agent` is declared twice on purpose:

- `peerDependencies: "*"` — published compatibility contract.
- exact `devDependencies` pin — local type snapshot. It MUST match
  `pi --version`; update the pin and run `npm install` on mismatch.

`@earendil-works/pi-tui` is also pinned exactly in `devDependencies` for local
TUI types; pi supplies it to extensions at runtime.

## Code style

Follow the `code-style`, `typescript-code`, and `pi-extension` skills. Use tabs,
double quotes, ESM, named exports for helpers, no `any`, and `undefined` over
`null`. Follow newspaper layout: public entry points and primary types first,
implementation details later. Keep `index.ts` registration-only and move pure
logic/UI classes into focused modules.
