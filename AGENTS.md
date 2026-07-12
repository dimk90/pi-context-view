# pi-context-view

Pi extension providing focused `/context` TUI views:

- `/context` or `/context usage` — on-demand estimated context composition.
- `/context injections` — frozen Initial snapshot with explicit raw-text
  previews.

v0.2.0 has no tab state, Runtime logging, Runtime command, or Runtime focus; its
Injections header contains only a dim, disabled `RUNTIME` roadmap label. The
implementation is feature-complete and release review is next in
[PLAN.md](PLAN.md). Do not add CLI compatibility.

## Current architecture

### Initial capture

Prepare once in `before_agent_start` and finalize once in the first `context`
event:

```text
before_agent_start → save structured prompt options
context            → read final system prompt, final active tools, and injected
                     messages; freeze Initial as owned copies
```

`before_agent_start` is the only point where structured system-prompt options
are available, but its prompt and active tools are not final. Later-loaded
handlers may still edit the prompt or call `pi.setActiveTools()`. Finalize with
`ctx.getSystemPrompt()` and the final active-tool set in `context`, then retain
owned copies so other extensions cannot mutate the snapshot.

Initial is the first context observable by this extension runtime. It comes
from the first real turn or one on-demand silent probe. Never overwrite it.
Conditional additions inactive during that run do not appear. Prompt and tool
capture is load-order independent, but message changes made by later `context`
handlers and provider-payload rewrites remain unobservable.

### Silent probe

When Usage or Injections is requested before a real turn, use at most one
on-demand probe:

```text
/context           → wait idle, hide working row, sendUserMessage("")
before_agent_start → prepare Initial
turn_start         → abort before provider
context            → finalize Initial; filter synthetic user message
message_end        → sanitize only the synthetic aborted assistant
agent_settled      → restore UI, resolve command, open requested view
```

Track the exact role and timestamp of both probe messages. Filter them from all
later model contexts and Usage without hiding genuine user aborts. Probe entries
remain in pi's session tree, and other extensions still observe lifecycle
events, so never probe automatically or more than once per extension runtime.
Always restore UI state in `finally`. If probing cannot run, show the pi-native
fallback snapshot with a precise degraded-capture reason.

### Usage

Compute Usage only when its view opens from the exported
`buildSessionContext(session entries, leaf id).messages`; do not use
`buildContextEntries()`, which includes non-context metadata. Filter synthetic
probe entries and classify:

- system prompt components, context files, skills, and extension additions;
- active built-in, custom, and MCP tool definitions;
- user text, assistant text/thinking/tool calls, and tool results;
- custom extension messages, summaries, and persisted bash output.

Use `ctx.getContextUsage()` separately for pi's reported usage and context
window. Category totals are estimates: provider serialization, images,
tokenizer differences, compaction timing, later handlers, and payload rewrites
can prevent exact reconciliation.

### Model and privacy

Keep hierarchy and ownership in typed fields; never parse display labels to
recover source, kind, or parent/child relationships. Tool ownership comes from
`ToolInfo.sourceInfo`. Prompt edits that pass through the public handler chain
are one unattributable extension aggregate. Use `customType` for injected
message identity when present, but do not assume it is a package name.

Children are breakdowns of a parent contribution and must not be counted again
in group or snapshot totals. Initial totals include only the frozen snapshot.
Raw prompt and message content is process-local, terminal-sanitized, and shown
only after explicit Enter preview. Never log it, persist additional copies,
include it in notifications, or inject captured content into later requests.

### Commands

The v0.2.0 grammar is:

```text
/context             → usage
/context usage       → usage
/context injections  → injections
```

Unknown or incomplete arguments show concise usage. Argument completions expose
only `usage` and `injections`. Commands are TUI-only; guard `ctx.ui.custom()`
with `ctx.mode === "tui"`.

## API constraints

- `ctx.getSystemPromptOptions()` is unavailable on `session_start` event
  contexts.
- Extension prompt additions are observable only inside an agent run.
- `pi.sendMessage(..., { triggerTurn: true })` bypasses
  `before_agent_start`; it cannot drive the capture probe.
- Abort probes at `turn_start`; later hooks may permit a provider call.
- Do not depend on `before_provider_request`; custom transports can skip its
  `onPayload` path.
- Later `context` handlers are not observable from earlier handlers.
- Extensions may inject non-custom-role messages; role-only detection is
  insufficient and requires session-branch diffing.

## Project layout

- `src/index.ts` — extension factory and event/command wiring only.
- `src/model.ts` — semantic snapshot, injection, and usage types and grouping.
- `src/capture.ts` — capture-once and silent-probe state machines.
- `src/command.ts` — command parsing, completions, and capture resolution.
- `src/measure.ts` — pure prompt/tool measurement.
- `src/usage.ts` — pure context classification and totals.
- `src/ui/injections-model.ts` — pure row flattening, navigation, and preview
  normalization.
- `src/ui/injections-view.ts` — fullscreen Injections view.
- `src/ui/layout.ts` — shared fullscreen layout helpers.
- `src/ui/usage-map.ts` — pure proportional-cell Usage map.
- `src/ui/usage-view.ts` — fullscreen Usage view.
- `test/fixtures/marker.ts` — prompt/message capture and load-order fixture.
- `test/` — Node `node:test` tests using native TypeScript type stripping.
- `doc/UI.md` — canonical UI and release-media specification.
- `doc/HISTORY.md` — superseded v1 findings; reference only.
- `PLAN.md` — remaining release work and roadmap.

## UI

Follow [doc/UI.md](doc/UI.md) for layout, interaction, styling, responsive
behavior, preview formatting, and release-media requirements. Keep pure UI
models separate from rendering classes.

## Verification

```bash
npm run check

# normal-turn no-op
pi --model anthropic/claude-haiku-4-5 -e ./src/index.ts --no-session \
  -p "Say one word: ok"

# interactive testing without tmux
script -qec "pi --no-extensions -e ./src/index.ts --no-session" /tmp/context-tui.log
```

Avoid provider calls when lifecycle-only tests suffice. If a model is genuinely
needed, use `anthropic/claude-haiku-4-5`. Test marker load order in both
directions and use an `after_provider_response` sentinel for silent probes.
Required invariants:

- normal turns remain unchanged when inspection is not invoked;
- no provider request or visible transcript artifact during a probe;
- genuine user aborts remain visible;
- synthetic entries never reach later model contexts or Usage;
- Initial freezes once per extension runtime;
- no Runtime state, command, completion, focus, or toggle ships in v0.2.0;
- raw content appears only after Enter and is never logged or newly persisted;
- every TUI line respects width, and views resize with width and height.

## Dependencies

`@earendil-works/pi-coding-agent` is a `"*"` peer compatibility contract and an
exact development pin matching `pi --version`. `@earendil-works/pi-tui` is also
a `"*"` peer and exact development pin; pi supplies it at runtime. Update pins
and run `npm install` when the installed pi version changes.

## Code style

Follow the `code-style`, `typescript-code`, and `pi-extension` skills. Use tabs,
double quotes, ESM, named helper exports, no `any`, and `undefined` instead of
`null`. Follow newspaper layout: public entry points and primary types first,
implementation details later. Keep `index.ts` registration-only and pure logic
or UI classes in focused modules.
