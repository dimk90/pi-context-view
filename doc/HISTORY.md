# pi-context-view — Development History

## v1: `--context-inspect` CLI workflow (superseded)

The first implementation added a `--context-inspect` flag that synthesized a
turn, measured startup context, printed a plain-text table, and exited. It was
fully implemented and manually tested through commit `e23c264`, then retired
in favor of the interactive `/context` design in [PLAN.md](../PLAN.md).

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

## Historical `npm:pi-anthropic-oauth` transport issues

These findings explain misleading counters observed during the encoded-thinking
investigation. They describe the transport installed in that environment and
are not part of the current counting architecture.

An earlier analysis concluded from session `usage` fields that replayed
thinking cost nothing. The counters were real; the client was not sending the
thinking.

`npm:pi-anthropic-oauth` replaced pi's Anthropic stream function with its own
converter. Its assistant branch (`src/convert.ts`) handled only `text` and
`toolCall` blocks, so every thinking block was silently dropped from the
outgoing payload. It also never populated `usage.reasoning`, so neither the
exact count nor the signature fallback could fire. Captured wire payloads for
the same prompt showed:

- default, extensions on — 0 thinking blocks sent, thinking parameter
  `{"type":"enabled","budget_tokens":10240}`, `usage.reasoning` undefined;
- `pi -ne`, stock pi — 1 thinking block sent with its signature intact,
  thinking parameter `{"type":"adaptive","display":"summarized"}`,
  `usage.reasoning` populated.

Stock pi's `transformMessages` kept signed thinking whenever the stored
assistant `provider`, `api`, and `model` all matched the runtime model; any one
mismatch dropped the blocks. All three matched in these sessions, so the loss
came from the extension, not from pi or Anthropic.

Direct API replay of the same Fable prefix confirmed the cost: 21,671 input
tokens with thinking versus 15,347 with it stripped, about 6.3k billed tokens
that the instrumented session never paid because the blocks never left the
client.

Stripping thinking mid-tool-loop did not raise an API error. Anthropic
documented that a thinking block must accompany the matching tool results, but
replaying that history without it was accepted and answered normally under both
the extension's beta set and one including
`interleaved-thinking-2025-05-14`. The failure mode was silent quality loss,
not a visible break, which is why it survived unnoticed.

The converter also mishandled the thinking level. It mapped effort through a
table keyed `minimal`/`low`/`medium`/`high`/`xhigh`, but Fable 5 and Opus 5
exposed only `xhigh` and `max`, so `max` missed the table and fell through to a
fixed `?? 10240` budget. Both models declared `forceAdaptiveThinking`, so stock
pi sent `type: "adaptive"` and let the model allocate. On one identical prompt:
the extension's `enabled`/10240 mode spent 941 thinking tokens, stock adaptive
`xhigh` spent 1,434, and stock adaptive `max` spent 5,102. This was independent
of the stripping bug.

Caching was unaffected: the converter did set `cache_control` on the system
prompt and the last content block.

Method note: pi called `undici.install()` after startup, which replaced
`globalThis.fetch`. A `--require` hook had to re-wrap `fetch` periodically or it
observed nothing. `before_provider_request` did not fire on this transport.
