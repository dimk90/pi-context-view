# Validation

Part of the [architecture](../ARCHITECTURE.md). How lifecycle, capture, and
payload behavior is verified, and what to recheck after a Pi upgrade.
Rendering checks belong to [UI.md](../UI.md#responsive-rendering).

## Harness

Runtime tests run the pinned Pi packages in process, through
`createAgentSession()`, against a local mock provider:

| Path                            | Purpose                                                                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/harness/mock-provider.ts` | `startMockProvider()`: loopback OpenAI Completions, OpenAI Responses, and Anthropic streaming with scripted replies, tool calls, delayed stream events, and HTTP failures; records every request body |
| `test/harness/settings.ts`      | Replaces `SettingsManager.create()` once: `useSettings()` registers a test's settings for its own working directory; any other directory gets empty in-memory settings                                |
| `test/harness/run-command.ts`   | `runCommand()`: runs a launcher without blocking the event loop, so concurrent launcher tests overlap                                                                                                 |
| `test/run.ts`                   | `pnpm test` entry point: all test files in one process, with the top-level tests of every file running concurrently                                                                                   |
| `test/fixtures/`                | Independent regular-test extensions; the header comment states the expected result in both load orders                                                                                              |
| `scripts/demo-injections/`      | Demo-only extensions, independent of `test/fixtures/`, and the `--mock` runner (`demo-mock*.ts`); fixture changes do not change regular-test behavior                                                 |
| `scripts/demo-injections.sh`    | Starts Pi with selected groups from `scripts/demo-injections/` in either load order; [demo-injections.md](../../scripts/demo-injections.md) records the results per version                           |

Runtime tests disable discovered resources, including Pi's built-in extensions,
and add the built-ins they need as extension factories, such as
`createCodemodeExtension()`.

Because every test shares one process and runs concurrently, a test must not
change process-wide state in a way other tests can observe, and a file must not
register top-level hooks, which would apply to every file. Mock
shared static methods through a registry such as `test/harness/settings.ts`,
keyed by a per-test temporary directory. Use asynchronous child processes, and
never probe a closed loopback port: another test may already have reused it.

`demo-injections.test.ts` checks launcher
selection, order, and demo fixture paths without starting a provider.
`demo-mock.test.ts` checks the launcher's optional `--mock` mode: a separate,
Completions-only loopback endpoint that discards bodies, appearance-only
configuration, in-memory sessions, conflicting-argument rejection, signal and
failure cleanup, and ordinary prompts through the pinned CLI with and without
codemode. Theme cases cover selected installed-package assets, automatic
light/dark pairs, manifest paths and exclusions, configured paths, and local
packages, without executing package extensions during discovery or installing
missing packages. `--mock --local` cases cover global configured, auto-discovered,
and package extensions, relative imports, resource and built-in exclusions,
project rejection even when a global extension would grant trust, unchanged
original files, and lifecycle hooks through a normal mock request. Without
`--local`, the same installed extensions stay disabled.
No real provider or PTY is involved. The demo mock is not the recording provider
in `test/harness/`, and imports no regular test module.
`demo-fixtures.test.ts` loads demo files by path through Pi's resource loader
and checks the combined overview against the mock provider: distinct message
and section edits, exact tool/prompt attribution, payload edits, both load
orders, all three supported APIs, and reversed group order. It also checks
conversation edits without the other groups and both payload findings against
the launcher's body-discarding mock. No demo fixture is imported by a regular
test.
`module-boundaries.test.ts` rejects imports between demo fixtures and regular
tests, fixtures, or harness modules, including indirect imports. Both fixture
sets are typechecked by `pnpm check`, but they are not required to stay identical.
Probe cases that open a view need TUI
mode: run them in a real PTY as the `pi-extension` skill describes.

## Validation Matrix

| Check                     | Required cases                                                                                                                                                                                                                                                                                                                                                           | Tests                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Core calibration          | With only this extension loaded, both diffs are empty for first and later prompts, tool follow-ups, resume with another model, compaction, and requests after a silent probe.                                                                                                                                                                                            | `capture-runtime`, `payload-runtime`                               |
| Handler ordering          | Load each fixture before and after the monitor. Pi's resource order matches [Handler Order](pi-requests.md#handler-order), with project trust resolved; check that order by hand after a Pi upgrade.                                                                                                                                                                     | `capture-runtime`, `payload-runtime`, `probe-runtime`              |
| Structured edits          | Add, modify, and delete conversation messages; patch system sections; mutate messages in place; change active tools on a later prompt.                                                                                                                                                                                                                                   | `capture-runtime`, `capture-diff`, `hidden-tools-runtime`          |
| Payload changes           | Rewrite the payload before and after the monitor and confirm the stated visibility limits, including the four injection points of [#9](https://github.com/dimk90/pi-context-view/pull/9).                                                                                                                                                                                | `payload-runtime`, `capture-runtime`, `payload-guard`              |
| Forced prompt             | Return `systemPrompt` from `before_agent_start`; the capture applies it in both load orders, in real and probe runs, and the guard in real runs.                                                                                                                                                                                                                         | `capture-runtime`, `forced-prompt`, `payload-runtime`              |
| Built-ins                 | Codemode with an active `codemode` tool in normal and `"codemode": { "mode": "only" }` settings; tool-search; MCP with a minimal direct-tool server. Recorded prompt/description changes stay apart from hidden declarations.                                                                                                                                            | `payload-runtime`, `hidden-tools-runtime`                          |
| Usage tools               | With codemode `only`, Usage counts only `codemode` before and after a request, including probes and incomplete guards. Injections leaves out and counts the snapshot's hidden tools before the first prompt. Active-tool changes apply to Usage at once and to Injections at the next request. Payload removals do not affect Usage. The placeholder never appears.      | `hidden-tools-runtime`, `hidden-tools`                             |
| Routing and normalization | Alternate physical providers, directly and through a virtual model; route image input to a text-only model; cover every [Pi adjustment](payload-guard.md#pis-own-adjustments).                                                                                                                                                                                           | `payload-runtime`, `message-channel`                               |
| Retries                   | Fail once with agent retries enabled, then with `"retry": { "enabled": false, "provider": { "maxRetries": 2 } }`. Each capture pairs once.                                                                                                                                                                                                                               | `payload-runtime`                                                  |
| Cache warming             | Model `"promptCache": { "short": 12 }`, `"cacheWarming": "idle"`, and `test/fixtures/cache-warm.ts`. Successful and failed refreshes publish nothing, and the next real request pairs normally. Probes are skipped while idle warming is enabled.                                                                                                                        | `payload-runtime`, `probe-guards`                                  |
| Dispatch timing           | Delay stream events after HTTP headers; accept whichever identity-bearing event arrives first, and never repeat findings. Include failures before streaming. On a physical selection, the guard settles before the response; `pi.setModel()` during preparation leaves it incomplete.                                                                                    | `dispatch-runtime`, `payload-runtime`                              |
| Incomplete comparison     | Missing model metadata and unsupported or mismatched payloads never appear as empty diffs. A compared channel keeps its findings when the other fails.                                                                                                                                                                                                                   | `payload-guard`, `payload`, `capture-payload`                      |
| Format selection          | Parsers are selected by API on both paths. A payload that does not match its API settles incomplete. An image placeholder needs model evidence.                                                                                                                                                                                                                          | `dispatch-runtime`, `payload`, `message-channel`                   |
| Inline tool changes       | Anthropic with `supportsMidConvoToolChanges`, with API-key and OAuth casing; OpenAI Responses with `supportsAdditionalTools` or `supportsToolSearch`; Completions system-message additions. Activate, remove, and redefine tools after the first request: both diffs stay empty.                                                                                         | `payload-runtime`, `dispatch-runtime`                              |
| Silent probe              | Probe before the first request with the lifecycle fixtures in both orders; the `after_provider_response` sentinel stays silent. On a model with `supportsMidConvoSystemMessages`, system messages keep their positions after probes.                                                                                                                                     | `probe-runtime`, `payload-runtime`                                 |
| Probe payload             | A standard probe produces a structured capture but no payload; its guard settles incomplete at settlement. Virtual selections fall back without probing.                                                                                                                                                                                                                 | `probe-runtime`, `probe-guards`                                    |
| Probe ownership           | An earlier extension's async `input` handler starts an idle custom-message run during the probe and waits until it settles: that run gets its provider response and fails the attempt, and the probe prompt is still claimed, aborted, and never sent. A custom-message run with the token is never claimed.                                                             | `probe-runtime`, `silent-probe`                                    |
| Messages during probe     | An extension in either order steers a user message and sends a custom message from `before_agent_start` during the probe. Both stay visible in the session and in the next real request, the probe makes no provider request, and the extra turn's abort is blanked. A user message with the prompt's timestamp is not recorded, blanked, omitted, or filtered.          | `probe-runtime`, `silent-probe`, `probe-filter`                    |
| Custom-message runs       | After an active-tool change, an idle `pi.sendMessage(..., { triggerTurn: true })` run's `real-turn` snapshot has the new hidden set and, with `forced-prompt.ts` in either order, the forced prompt.                                                                                                                                                                     | `hidden-tools-runtime`                                             |
| Probe trigger             | One automatic attempt per runtime; concurrent callers share it; every precondition falls back without consuming the attempt.                                                                                                                                                                                                                                             | `probe-trigger`, `probe-guards`                                    |
| Snapshot store            | Keeps only the latest snapshot by ID; same-ID guard updates replace it, older ones only notify; a real request replaces a probe. Capture runs with no consumer and in RPC mode. Consumers import no capture or probe internals.                                                                                                                                          | `snapshot`, `capture-runtime`, `module-boundaries`                 |
| Cleanup and privacy       | Pending data is released on settlement and shutdown; raw content stays out of logs, session entries, and notifications. Persisted probe records contain only role and timestamp.                                                                                                                                                                                         | `capture-builder`, `payload-guard`, `silent-probe`, `probe-filter` |

Test names refer to `test/<name>.test.ts`. `pnpm check` runs all of them.

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

## Lifecycle Smoke Tests

For lifecycle changes, load `test/fixtures/marker.ts`,
`test/fixtures/forced-prompt.ts`, and `test/fixtures/input-transform.ts` before
and after this extension. Use an `after_provider_response` sentinel to prove
that a probe makes no provider request, and load
`test/fixtures/payload-logger.ts` last to compare the views with the payload
that reached the provider. For TUI changes, also run the real-PTY and
rendering checks of the `pi-extension` skill and [UI.md](../UI.md).

## After a Pi Upgrade

Recheck event shapes, handler order, provider adjustments, the probe's abort
form and where Pi checks its abort signal (authentication resolution),
`before_agent_start.messageType` and which runs fire that event, the run-start
busy window (what `waitForIdle()` waits through and how messages sent
meanwhile are queued, delivered, or cleared by the TUI abort), whether
dispatch metadata is now exposed to `before_provider_request`, and whether Pi
now reports which tool hid a declaration. `test/dispatch-runtime.test.ts`
re-runs the [payload guard evidence](payload-guard.md#evidence).
