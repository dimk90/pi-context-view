# pi-context-view

Pi extension with two TUI-only views:

- `/context` or `/context usage` — estimated context composition.
- `/context injections` — frozen Initial snapshot with explicit raw-text
  previews.

Runtime inspection is roadmap-only; see [PLAN.md](PLAN.md). The command accepts
only `usage` and `injections`, including completions, and rejects non-TUI modes.

## Capture architecture

### Initial snapshot

Capture Initial once per extension runtime:

```text
before_agent_start → own structured prompt options
context            → read the final system prompt and active tools, then freeze
                     prompt, tools, and injected messages as owned copies
```

Structured prompt options are available as `event.systemPromptOptions` in
`before_agent_start`, not `session_start`. Do not
freeze the prompt or active tools there: later handlers may edit the prompt or
call `pi.setActiveTools()`. Finalize in the first `context` event using
`ctx.getSystemPrompt()` and pi's then-active tool set.

The snapshot represents the first observable run, real or synthetic, and is
never overwritten. Conditional additions inactive during that run are absent.
Prompt and tool capture is load-order independent; message changes from later
`context` handlers and provider-payload rewrites are not observable.

### On-demand silent probe

If a view is requested before a real turn, allow one explicit probe per
extension runtime:

```text
/context           → wait idle, hide working row, sendUserMessage("")
before_agent_start → prepare Initial
turn_start         → abort before provider
context            → finalize Initial; filter synthetic user message
message_end        → sanitize only the synthetic aborted assistant
agent_settled      → restore UI, resolve command, open the requested view
```

Never probe automatically. Track the synthetic user and assistant by exact
role and timestamp; remove only those entries from later model contexts and
Usage so genuine aborts remain visible. Probe entries remain in pi's session
tree, and other extensions still observe the lifecycle. Identities (role and
timestamp only, never content) are persisted as a
`pi-context-view:probe-identities` custom entry on `agent_settled` and
`session_shutdown`, then restored on `session_start`, so filtering survives
resume, reload, and fork without identifying probes by empty content.

`pi.sendMessage(..., { triggerTurn: true })` cannot replace
`sendUserMessage()` because it bypasses `before_agent_start`. Abort at
`turn_start`; do not rely on `before_provider_request`, which some transports
skip. Always restore UI state in `finally`. On failure or timeout, return a
pi-native fallback with a precise degraded-capture reason.

## Usage and attribution

Compute Usage on demand from the exported
`buildSessionContext(session entries, leaf id).messages`, after synthetic
filtering. Do not use `buildContextEntries()`, which includes non-context
metadata. Use `ctx.getContextUsage()` separately for pi's reported usage and
window.

Estimates need not reconcile exactly with pi or provider totals because of
serialization, images, tokenizer differences, compaction timing, handler load
order, and payload rewrites.

Keep source, kind, and hierarchy in typed model fields; never recover semantics
from display labels. Further rules:

- tool ownership comes from `ToolInfo.sourceInfo`;
- chained prompt edits form one unattributable extension aggregate;
- `customType` identifies an injected message type, not necessarily its package;
- role-only injection detection misses non-custom messages and requires
  session-branch diffing;
- children break down parent contributions and are not counted again in totals.

## Privacy

Raw prompt and message content stays process-local and is terminal-sanitized.
Show it only after explicit Enter preview. Never log it, persist additional
copies, include it in notifications, or inject captured content into later
requests.

## UI

[doc/UI.md](doc/UI.md) is the canonical specification for rendering,
interaction, responsive behavior, previews, and release media.

## Verification

Run `pnpm check`. Follow the `pi-extension` skill for provider smoke tests
and real-PTY testing. Lifecycle coverage must load `test/fixtures/marker.ts` in
both orders and use an `after_provider_response` sentinel for probes.

Required invariants:

- normal turns are unchanged when inspection is not invoked;
- probes make no provider request and leave no visible transcript artifact;
- genuine aborts remain visible;
- synthetic entries never reach later model contexts or Usage;
- Initial freezes once per extension runtime;
- Runtime state, commands, completions, focus, and toggles remain absent until
  their roadmap step;
- raw content appears only after Enter and is never logged or newly persisted;
- every rendered line respects width, and views reflow with width and height.

## Dependencies

Keep `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as `"*"`
peer dependencies and exact development pins matching `pi --version`. Run
`pnpm install` after changing the pins.
