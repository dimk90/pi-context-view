# Validation

Part of the [architecture](../ARCHITECTURE.md). How lifecycle, capture, payload,
and UI behavior is verified, and what to recheck after a Pi upgrade.
UI design decisions belong to [UI.md](../UI.md).

## Harness

Runtime tests run the pinned Pi packages in process, through
`createAgentSession()`, against a local mock provider:

| Path                            | Purpose                                                                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/harness/mock-provider.ts` | `startMockProvider()`: loopback OpenAI Completions, OpenAI Responses, and Anthropic streaming with scripted replies, tool calls, delayed stream events, and HTTP failures; records every request body |
| `test/harness/settings.ts`      | Replaces `SettingsManager.create()` once: `useSettings()` registers a test's settings for its own working directory; any other directory gets empty in-memory settings                                |
| `test/harness/run-command.ts`   | `runCommand()`: runs a child process without blocking the event loop, so concurrent tests overlap                                                                                                     |
| `test/run.ts`                   | `pnpm test` entry point: all test files in one process, with the top-level tests of every file running concurrently                                                                                   |
| `test/fixtures/`                | Independent regular-test extensions; the header comment states the expected result in both load orders                                                                                              |

Runtime tests disable discovered resources, including Pi's built-in extensions,
and add the built-ins they need as extension factories, such as
`createCodemodeExtension()`.

Because every test shares one process and runs concurrently, a test must not
change process-wide state in a way other tests can observe, and a file must not
register top-level hooks, which would apply to every file. Mock
shared static methods through a registry such as `test/harness/settings.ts`,
keyed by a per-test temporary directory. Use asynchronous child processes, and
never probe a closed loopback port: another test may already have reused it.
Loopback provider servers answer with
`Connection: close`: a long synchronous test can block the event loop past the
server's keep-alive timeout, and the server then closes an idle connection just
as the client reuses it.
After hooks run in registration order, so register a hook that stops a session
or awaits a child's exit before the hook that removes the directory it uses.

`scripts/demo-injections.sh` and `scripts/demo-injections/` are for demos only:
`pnpm test` does not run them, and `pnpm check` only typechecks them. Check
demo changes by running the launcher, as
[demo-injections.md](../../scripts/demo-injections.md) describes.
Probe cases that open a view need TUI
mode: run them in a real PTY as the `pi-extension` skill describes.

## Validation Matrix

| Check                     | Required cases                                                                                                                                                                                                                                                                                                                                                           | Tests                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Core calibration          | With only this extension loaded, both diffs are empty for first and later prompts, tool follow-ups, resume with another model, compaction, truncated-response recovery, and requests after a silent probe.                                                                                                                                                                                            | `capture-runtime`, `payload-runtime`                                                                                                                                                                                                                                                                                                                                     |
| Handler ordering          | Load each fixture before and after the monitor. Pi's resource order matches [Handler Order](pi-requests.md#handler-order), with project trust resolved; check that order by hand after a Pi upgrade.                                                                                                                                                                     | `capture-runtime`, `payload-runtime`, `probe-runtime`              |
| Structured edits          | Add, modify, and delete conversation messages; patch system sections; mutate messages in place; change active tools on a later prompt.                                                                                                                                                                                                                                   | `capture-runtime`, `capture-diff`, `hidden-tools-runtime`          |
| Payload changes           | Rewrite the payload before and after the monitor and confirm the stated visibility limits, including the four injection points of [#9](https://github.com/dimk90/pi-context-view/pull/9).                                                                                                                                                                                | `payload-runtime`, `capture-runtime`, `payload-guard`              |
| Combined edits            | Every change kind in one request, with all three APIs and both orders, stays distinct. A path-loaded tool owns its Tools and Rules lines exactly.                                                                                                                                                                                                                        | `combined-runtime`                                                 |
| Forced prompt             | Return `systemPrompt` from `before_agent_start`; the capture applies it in both load orders, in real and probe runs, and the guard in real runs. Injections marks the section edits it replaced, uncounted.                                                                                                                                                                                                        | `capture-runtime`, `forced-prompt`, `payload-runtime`              |
| Built-ins                 | Codemode with an active `codemode` tool in normal and `"codemode": { "mode": "only" }` settings; tool-search; MCP with a minimal direct-tool server. Recorded prompt/description changes stay apart from hidden declarations.                                                                                                                                            | `payload-runtime`, `hidden-tools-runtime`                          |
| Usage tools               | With codemode `only`, Usage counts only `codemode` before and after a request, including probes and incomplete guards. Injections leaves out and counts the snapshot's hidden tools before the first prompt. Active-tool changes apply to Usage at once and to Injections at the next request. Payload removals do not affect Usage. The placeholder never appears.      | `hidden-tools-runtime`, `hidden-tools`                             |
| Routing and normalization | Alternate physical providers, directly and through a virtual model; route image input to a text-only model; cover every [Pi adjustment](payload-guard.md#pis-own-adjustments).                                                                                                                                                                                           | `payload-runtime`, `message-channel`                               |
| Retries                   | Fail once with agent retries enabled, then with `"retry": { "enabled": false, "provider": { "maxRetries": 2 } }`. Each capture pairs once.                                                                                                                                                                                                                               | `payload-runtime`                                                  |
| Cache warming             | Model `"promptCache": { "short": 12 }`, `"cacheWarming": "idle"`, and `test/fixtures/cache-warm.ts`. Successful and failed refreshes publish nothing, and the next real request pairs normally. Probes are skipped while idle warming is enabled.                                                                                                                        | `payload-runtime`, `probe-guards`                                  |
| Dispatch timing           | Delay stream events after HTTP headers; confirm from assistant `message_start`, fall back to `message_end`, and never repeat findings. Include failures before streaming. On a physical selection, the guard settles before the response; `pi.setModel()` during preparation leaves it incomplete.                                                                                    | `dispatch-runtime`, `payload-runtime`                              |
| Incomplete comparison     | Missing model metadata and unsupported or mismatched payloads never appear as empty diffs. A compared channel keeps its findings when the other fails.                                                                                                                                                                                                                   | `payload-guard`, `payload`, `capture-payload`                      |
| Format selection          | Parsers are selected by API on both paths. A payload that does not match its API settles incomplete. An image placeholder needs model evidence.                                                                                                                                                                                                                          | `dispatch-runtime`, `payload`, `message-channel`                   |
| Inline tool changes       | Anthropic with `supportsMidConvoToolChanges`, with API-key and OAuth casing; OpenAI Responses with `supportsAdditionalTools` or `supportsToolSearch`; Completions system-message additions. Activate, remove, and redefine tools after the first request: both diffs stay empty.                                                                                         | `payload-runtime`, `dispatch-runtime`                              |
| Silent probe              | Probe before the first request with the lifecycle fixtures in both orders; the `after_provider_response` sentinel stays silent. On a model with `supportsMidConvoSystemMessages`, system messages keep their positions after probes.                                                                                                                                     | `probe-runtime`, `payload-runtime`                                 |
| Probe payload             | A standard probe produces a structured capture but no payload; its guard settles incomplete at settlement. Virtual selections fall back without probing.                                                                                                                                                                                                                 | `probe-runtime`, `probe-guards`                                    |
| Probe ownership           | An earlier extension's async `input` handler starts an idle custom-message run during the probe and waits until it settles: that run gets its provider response and fails the attempt, and the probe prompt is still claimed, aborted, and never sent. A custom-message run with the token is never claimed. Nested user sends: see below the table.                     | `probe-runtime`, `silent-probe`                                    |
| Messages during probe     | An extension in either order steers a user message and sends a custom message from `before_agent_start` during the probe. Both stay visible in the session and in the next real request, the probe makes no provider request, and the extra turn's abort is blanked. A user message with the prompt's timestamp is not recorded, blanked, omitted, or filtered.          | `probe-runtime`, `silent-probe`, `probe-filter`                    |
| Custom-message runs       | After an active-tool change, an idle `pi.sendMessage(..., { triggerTurn: true })` run's `real-turn` snapshot has the new hidden set and, with `forced-prompt.ts` in either order, the forced prompt.                                                                                                                                                                     | `hidden-tools-runtime`                                             |
| Probe trigger             | One automatic attempt per runtime; concurrent callers share it; every precondition falls back without consuming the attempt.                                                                                                                                                                                                                                             | `probe-trigger`, `probe-guards`                                    |
| Snapshot store            | Keeps only the latest snapshot by ID; same-ID guard updates replace it, older ones only notify; a real request replaces a probe. Capture runs with no consumer and in RPC mode. Consumers import no capture or probe internals.                                                                                                                                          | `snapshot`, `capture-runtime`, `module-boundaries`                 |
| Cleanup and privacy       | Pending data is released on settlement and shutdown; raw content stays out of logs, session entries, and notifications. Persisted probe records contain only role and timestamp.                                                                                                                                                                                         | `capture-builder`, `payload-guard`, `silent-probe`, `probe-filter` |

Test names refer to `test/<name>.test.ts`. `pnpm check` runs all of them.

`probe-runtime` and `silent-probe` cover nested user sends: an async `input`
handler sends an idle user message during the probe and waits until its run
settles. With the sender after this extension, the second idle input with the
token fails the attempt: no input is reset, no run is claimed, and both runs
reach the provider. With the sender before it, the nested run is claimed in the
probe's place, and the probe prompt's later run is left untouched and raises
one warning without message content.

`message-channel` and `payload-runtime` cover Pi 1.3's foreign-thinking removal
and Anthropic error-image relocation: signed and unsigned thinking, unchanged
same-model replay, successful and failed image results, grouped captions after
all tool results, foreign ID normalization, text-only models, and blocked images.
Caption edits remain payload findings.

`payload` and `payload-runtime` cover the thinking-level messages of
`supportsMidConvoEffort`: OpenAI Responses `configuration_update` items and
Anthropic empty system messages with `output_config`, the latter with
`forceAdaptiveThinking`. A thinking-level change between prompts keeps the
guard complete and both diffs empty.

### Prompt source rows

`system-prompt-rows`, `injections`, and `injections-view` test the diff-only
`system prompt` rows: exact tool lines, guessed additions, unknown edits and
deletions, cumulative rounding, and unchanged group values and diffs. Cases
include forced prompts, dropped blocks, fallback, instruction-file and skill
edits and deletions, request-only line comparison, plain-text previews,
terminal sanitization, theme invalidation, and width/height reflow. These are
pure composition and render tests; real-PTY checks remain explicit opt-in.

### Injections source and aggregate rows

`model`, `system-prompt-rows`, `injections`, `injections-model`, and
`injections-view` test the `pi` / extension / trailing `unattributed` source
contract. Cases include unregistered tools sharing the unknown source,
customType and cooperative provenance creating no source group, non-context
`pi.share` entries, absent empty rows, deletion-only rows, and section-level
changed-line ownership. Message parts preserve session order with additions
following in capture order; payload parts preserve guard order. Counts exclude
message deletions but include every payload finding; estimates and diffs sum
without double-counting a modified message's original. Render checks cover dim
`tool:` prefixes, value alignment, aggregate status, per-part token shares and
markers, sanitization, preview return, narrow widths, and height reflow.
Real-PTY checks remain explicit opt-in.

### Message and payload previews

`message-sections` tests branch-wide `user prompt #N` numbers: messages before
the first prompt, compaction, saved context omissions, abandoned branches,
entries appended after capture, excluded probe prompts, and request-only
additions. It also checks that a modified message keeps only its redacted,
signature-free original. `token-diff` checks that preview word runs rebuild
both texts and match the counted characters, including the bounded fallback.
`diff-preview` and `injections-view` cover context lines, multi-line word
highlighting, whole-line additions and deletions, expanded marked JSON, payload
guard order, sanitization before styling, Unicode, and wrapped inverse words.

### Selected-row status bar

`injections`, `system-prompt-rows`, `injections-model`, `status-bar`, and
`injections-view` test saved, request-only, mixed, and payload-only changes,
known and guessed saved-line editors, unknown request editors, session-original
presence, parent removals, and diff-only accounting. Render cases cover field
colors, sanitized names, selection and preview return, description collapse,
height-only resize, narrow wrapping, empty reserved lines, theme invalidation,
and the compact frame that keeps the selected row and bar on short terminals.
`model` checks that editor metadata owns its sources and arrays.

## UI Checks

`pnpm check` includes pure rendering and interaction tests. Cover the design
rules in [UI.md](../UI.md) without freezing incidental copy or layout values:

- Width and height bounds at 60, 80, and 120 columns, narrower fallbacks, very
  short terminals, and height-only resizing; include Unicode and styled text.
- Navigation through overflow, previews, and tall blocks; selection and viewport
  restoration on return; keyboard aliases and fullscreen wheel behavior.
- Whole-block description collapse and restoration, with essential capture
  status, degraded reasons, totals, and selected-row details still available.
- Both map scales, unavailable denominators, oversized configured geometry,
  legend accessibility, and controls that disappear with their unavailable action.
- Theme and view-state invalidation, safe text rendering, and no raw content
  before explicit preview.
- Filtered and empty lists, live preview search, and every hint state of the
  search prompt, within the width.

`usage-view`, `usage-map`, `injections-view`, `usage-preview`, `injected-preview`,
`diff-preview`, `json-preview`, `skill-preview`, `status-bar`, `notes`, `color`, and
`search` cover these areas; the focused cases above cover accounting and attribution.

Keep these tests independent of display wording:

- **Typed decisions.** Test decisions such as change scope, payload check, note
  kind, marker, and probe failure cause as typed values in the module that makes them.
- **Copy checks.** For each set of messages, check that every case has text, the
  texts are distinct, dynamic values appear, and unsafe text is sanitized.
- **Component output as the expected block.** View tests render the expected block
  with its owning function, such as `statusBarLines()`, `markerLegendLines()`, or
  `descriptionNoteLines()`, then check it with `test/harness/frame.ts`: whole,
  absent, or contained after wrapping.
- **Layout rules.** Sweep widths and heights and check bounds, priorities,
  whole-or-absent blocks, and restoration, not exact thresholds or line indexes.
  Check colors with `theme.fg()` instead of raw escape codes.
- **Fixed terminal height.** Pass the row count to every view a test builds.
  The default reads `process.stdout.rows`, so results would depend on the
  terminal that runs `pnpm test`.

Keep exact text only where it is a contract: command grammar and usage, config
file output, captured content shown in previews, and notation such as `≈`, `~`,
`+N -N`, and formatted token values. When changing these tests, reword the
relevant copy temporarily: the tests should pass. Then break the behavior
temporarily: they should fail.

Run real-PTY checks and provider smoke tests only when explicitly requested.
When requested, follow the `pi-extension` skill and exercise both views and
preview levels at the widths above, narrow and short fallbacks, resize recovery,
overflow navigation, preview return, and theme changes.

## Lifecycle Smoke Tests

For lifecycle changes, load `test/fixtures/marker.ts`,
`test/fixtures/forced-prompt.ts`, and `test/fixtures/input-transform.ts` before
and after this extension. Use an `after_provider_response` sentinel to prove
that a probe makes no provider request, and load
`test/fixtures/payload-logger.ts` last to compare the views with the payload
that reached the provider. For TUI changes, use the automated [UI checks](#ui-checks);
real-PTY and provider smoke tests remain explicit opt-in.

## After a Pi Upgrade

Recheck event shapes, handler order, provider adjustments, the probe's abort
form and where Pi checks its abort signal (authentication resolution),
`before_agent_start.messageType` and which runs fire that event, the run-start
busy window (what `waitForIdle()` waits through and how messages sent
meanwhile are queued, delivered, or cleared by the TUI abort), whether
dispatch metadata is now exposed to `before_provider_request`, and whether Pi
now reports which tool hid a declaration. `test/dispatch-runtime.test.ts`
re-runs the [payload guard evidence](payload-guard.md#evidence).
