# pi-context-inspect — Development History

## v1: `--context-inspect` CLI workflow (superseded)

The first implementation added a `--context-inspect` flag that synthesized a
turn, measured startup context, printed a plain-text table, and exited. It was
fully implemented and manually tested through commit `e23c264`, then retired
in favor of the interactive `/context` design in PLAN.md.

The pure prompt/tool measurement work remains useful. The automatic
probe/abort/report/shutdown lifecycle does not.

## Proof of concept

### Failed direct startup capture

`ctx.getSystemPromptOptions()` is unavailable on `session_start` event
contexts, and `ctx.getSystemPrompt()` at session start does not contain
extensions’ per-turn `before_agent_start` additions. A real agent run is
required to invoke that chain.

### Revised probe flow

The working v1 flow was:

```text
session_start      → pi.sendUserMessage("probe")
before_agent_start → capture prompt + structured options
context            → capture injected messages
turn_start         → ctx.abort() before provider request
agent_settled      → print report + request shutdown
session_shutdown   → TUI-safe report fallback
```

Findings:

- `pi.sendMessage(..., { triggerTurn: true })` did not start the required turn
  in print mode without `-p`; `pi.sendUserMessage()` did.
- In pi 0.80.6 internals, `sendMessage(triggerTurn)` also bypasses
  `before_agent_start`, making it unsuitable for the v2 capture probe even in
  TUI mode.
- `before_provider_request` is not reliable as an abort point: custom
  transports can skip its `onPayload` path (observed with
  `pi-anthropic-oauth`).
- `ctx.abort()` at `turn_start` reliably prevented provider calls.
- Startup custom messages were visible in the first `context` event with
  `customType`; they were not visible in the session branch early enough at
  `before_agent_start`.

## v1 implementation milestones

1. Project/package initialization and exact pi development pin.
2. Probe capture and injected-message capture.
3. Pure prompt carving in `src/measure.ts`.
4. Plain aligned report rendering in `src/report.ts`.
5. JSON-mode refusal, startup-only guard, watchdog, idempotency, and custom
   prompt labels.
6. Manual matrix: print, TUI via real pty, no extensions, marker extension,
   plan mode, context files present/absent, appended prompt, disabled skills,
   no-op without flag, and zero provider calls.

## Hard-won v1 fixes

- `buildSystemPrompt()` is not importable through the package exports map.
  Measurement therefore carves structural markers emitted by pi’s private
  formatter: context-file tags, skills block, appended prompt substring, and
  the trailing current-date/cwd lines.
- Extension system-prompt edits cannot be attributed per extension through the
  public chain API; they are one aggregate contribution.
- Tool payload definitions must be counted separately from prompt snippets and
  guidelines. `ToolInfo.sourceInfo` provides canonical tool ownership.
- Some extensions register tools asynchronously during startup. Moving the
  automatic probe to `resources_discover` allowed the complete active tool set
  to be observed.
- The probe could settle before interactive mode subscribed to agent events.
  v1 needed a shutdown retry loop; pi 0.80.4’s `agent_settled` became the right
  “truly done” event, but the subscription-race safety net remained.
- Print mode could shut down before `agent_end`; v1 printed from
  `session_shutdown` as a fallback.
- TUI output had to wait until `session_shutdown` to avoid interleaving the
  table with TUI frames.
- A short shutdown grace period prevented other extensions’ in-flight startup
  work from hitting stale contexts.

These shutdown/report constraints belong only to the removed CLI lifecycle.
Do not reintroduce them into the interactive command unless a new requirement
specifically needs process shutdown.

## v2 investigation findings

The redesign review established two useful facts before implementation:

1. `ctx.getSystemPrompt()` in the `context` event contains the completed
   `before_agent_start` chain. A marker loaded after the inspector was absent
   in the inspector’s own `before_agent_start` event but present in its later
   `context` handler. Final prompt capture therefore does not require the
   inspector to load last.
2. A real-pty spike showed that a zero-length `sendUserMessage("")` can be made
   visually silent: hide the working row, abort at `turn_start`, and replace
   only the synthetic aborted assistant at `message_end` with empty content
   and `stopReason: "stop"`. The production design must still filter the
   persisted synthetic entries and verify zero provider calls.
