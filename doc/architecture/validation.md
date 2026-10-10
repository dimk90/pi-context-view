# Validation

Part of the [architecture](../ARCHITECTURE.md). How lifecycle, capture, and
payload behavior is verified, and what to recheck after a Pi upgrade.
Rendering checks belong to [UI.md](../UI.md#responsive-rendering).

## Harness

Runtime tests run the pinned Pi CLI against a local mock provider:

| Path                            | Purpose                                                                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/harness/mock-provider.ts` | `startMockProvider()`: loopback OpenAI Completions, OpenAI Responses, and Anthropic streaming with scripted replies, tool calls, delayed stream events, and HTTP failures; records every request body |
| `test/harness/pi-rpc.ts`        | `startPi()`: Pi in RPC mode with an isolated `PI_CODING_AGENT_DIR`, a scratch working directory, no discovered resources, a `vision` and a text-only model per mock API, and deterministic settings   |
| `test/harness.test.ts`          | Checks the harness and every fixture's effect on the request                                                                                                                                          |
| `test/fixtures/`                | Extensions that change a request at one lifecycle point each; the header comment states the expected result in both load orders                                                                       |
| `scripts/demo-injections.sh`    | Starts Pi with selected fixture groups in either load order; [demo-injections.md](../../scripts/demo-injections.md) records the results per version                                                   |

`--no-extensions` also disables Pi's built-in extensions; runtime tests add the
ones they need with `builtin:<name>`. Probe cases that open a view need TUI
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
| Probe trigger             | One automatic attempt per runtime; concurrent callers share it; every precondition falls back without consuming the attempt.                                                                                                                                                                                                                                             | `probe-trigger`, `probe-guards`                                    |
| Snapshot store            | Keeps only the latest snapshot by ID; same-ID guard updates replace it, older ones only notify; a real request replaces a probe. Capture runs with no consumer and in RPC mode. Consumers import no capture or probe internals.                                                                                                                                          | `snapshot`, `capture-runtime`, `module-boundaries`                 |
| Cleanup and privacy       | Pending data is released on settlement and shutdown; raw content stays out of logs, session entries, and notifications. Persisted probe records contain only role and timestamp.                                                                                                                                                                                         | `capture-builder`, `payload-guard`, `silent-probe`, `probe-filter` |

Test names refer to `test/<name>.test.ts`. `pnpm check` runs all of them.

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
form and where Pi checks its abort signal (authentication resolution), whether
dispatch metadata is now exposed to `before_provider_request`, and whether Pi
now reports which tool hid a declaration. `test/dispatch-runtime.test.ts`
re-runs the [payload guard evidence](payload-guard.md#evidence).
