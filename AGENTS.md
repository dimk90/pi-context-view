# pi-context-inspect

Pi extension in migration from the superseded `--context-inspect` CLI workflow
to an interactive `/context` command. The command opens a TUI context browser:

- **Injections** tab: frozen Initial snapshot + optional bounded Runtime log.
- **Statistics** tab: on-demand estimated context composition.
- Enter previews raw injection text; no raw content is logged or persisted.

`src/` still contains the v1 CLI implementation until PLAN.md step 1 is
completed. Do not preserve CLI compatibility during the migration.

## Target architecture

Initial capture is prepared once in `before_agent_start` and finalized once in
the first `context` event:

```text
before_agent_start → save structured prompt options + tool metadata
context            → read final ctx.getSystemPrompt(), messages; freeze Initial
```

`ctx.getSystemPrompt()` in `context` is the completed prompt chain, including
injectors loaded after this extension. Do not freeze `event.systemPrompt` in
our own `before_agent_start` handler.

If `/context` runs before a real turn, use one on-demand silent probe:

```text
/context           → wait idle, hide working row, sendUserMessage("")
before_agent_start → prepare Initial
turn_start         → abort before provider
context            → finalize Initial; filter synthetic user message
message_end        → sanitize only synthetic aborted assistant
agent_settled      → restore UI, resolve command, open dialog
```

The probe entries remain in the session tree. Track their exact role+timestamp
and filter them from later model context, Runtime logging, and Statistics.
Other extensions still observe probe lifecycle events; never probe
automatically or more than once per extension runtime.

Runtime injection logging is disabled by default, memory-only, and bounded
(initial target: 200 entries / 1 MiB). Statistics are computed on demand from
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
- `buildContextEntries()` includes non-context metadata. Use
  `buildSessionContext().messages` for Statistics.
- `ctx.ui.custom()` is TUI-only. Guard with `ctx.mode === "tui"`.

## Layout

Target modules (created incrementally per PLAN.md):

- `src/index.ts` — factory and event/command wiring only.
- `src/model.ts` — semantic snapshot/injection/statistics types.
- `src/capture.ts` — capture-once and silent-probe state machine.
- `src/runtime.ts` — bounded optional Runtime log.
- `src/measure.ts` — pure prompt/tool measurement.
- `src/statistics.ts` — pure context classification.
- `src/ui/context-dialog.ts` — tabbed dialog and preview state machine.
- `src/report.ts` — temporary v1 renderer; remove when no longer needed.
- `PLAN.md` — current decisions and step checkboxes; keep them current.
- `HISTORY.md` — superseded v1 findings; reference only.
- `poc/` — throwaway/reference spikes; `marker.ts` is also a test injector.

Keep hierarchy in typed model fields. Never parse labels in UI code to recover
source, kind, or parent/child relationships.

## Verification

```bash
npx tsc --noEmit

# normal-turn no-op: inspection must not alter the response
pi -e ./src/index.ts --no-session -p "say hi"

# interactive testing without tmux
script -qec "pi -e ./src/index.ts --no-session" /tmp/context-tui.log
```

Use `script` or a Python `pty` harness; tmux is unavailable. Test marker load
order in both directions and use an `after_provider_response` sentinel for the
silent probe. Required invariants:

- no provider request during a probe;
- no visible probe/abort transcript artifacts;
- genuine user aborts remain visible;
- synthetic entries never reach later model contexts or Statistics;
- Initial freezes once per extension runtime;
- Runtime is off and bounded by default;
- no raw injection content is printed, logged, or persisted;
- all TUI lines respect the supplied width.

## Dependencies

`@earendil-works/pi-coding-agent` is declared twice on purpose:

- `peerDependencies: "*"` — published compatibility contract.
- exact `devDependencies` pin — local type snapshot. It MUST match
  `pi --version`; update the pin and run `npm install` on mismatch.

## Code style

Follow the `code-style`, `typescript-code`, and `pi-extension` skills. Use tabs,
double quotes, ESM, named exports for helpers, no `any`, and `undefined` over
`null`. Follow newspaper layout: public entry points and primary types first,
implementation details later. Keep `index.ts` registration-only and move pure
logic/UI classes into focused modules.
