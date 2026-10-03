# Injection demo results

Tracks what each version shows for the demo extensions that
[`demo-injections.sh`](demo-injections.sh) loads. **Target** is the design in
[REQUEST-ONLY-INJECTIONS.md](../doc/REQUEST-ONLY-INJECTIONS.md). Add a column
when a version changes a result.

Columns per version:

- **Before:** demo extensions load before pi-context-view (`./scripts/demo-injections.sh`)
- **After:** pi-context-view loads first (`./scripts/demo-injections.sh --after`)

Marks:

- ✅ shown as the target describes
- ⚠️ shown, but not as the target describes
- ❌ not shown
- ➖ not visible by design

## How the results were checked

Pi 1.0.0 with the mock provider from `test/harness/` (`mock-openai/vision`),
`--no-session --no-skills --no-context-files`, and
`test/fixtures/payload-logger.ts` loaded last. Prompts, in order:

1. `XYZZY_CONTEXT_REORDER one`
2. `XYZZY_CONTEXT_DELETE two`
3. `XYZZY_PAYLOAD_DELETE three`
4. `/reload`, so that Initial is captured from a request that has history
5. `four`

Then `/context injections` and `/context usage`. The payload log confirmed
that every change reached the provider request in both load orders.

## Injections view

| Demo extension        | Event                     | Target: before                       | Target: after        | v0.6.0: before | v0.6.0: after | Unreleased: before | Unreleased: after |
| --------------------- | ------------------------- | ------------------------------------ | -------------------- | -------------- | ------------- | ------------------ | ----------------- |
| `context-add`         | `context`                 | addition, `context-view-fixture-add` | same as before       | ✅             | ❌            | ✅                 | ❌                |
| `context-add-user`    | `context`                 | addition, unattributed               | same as before       | ✅             | ❌            | ✅                 | ❌                |
| `context-modify`      | `context`                 | modification, unattributed           | same as before       | ⚠️¹          | ❌            | ⚠️¹              | ❌                |
| `context-in-place`    | `context`                 | modification, unattributed           | same as before       | ⚠️¹          | ❌            | ⚠️¹              | ❌                |
| `context-delete`      | `context`                 | deletion, unattributed               | same as before       | ❌             | ❌            | ❌                 | ❌                |
| `context-reorder`     | `context`                 | deletion plus addition               | same as before       | ❌             | ❌            | ❌                 | ❌                |
| `system-append`       | `context_with_system`     | system change, unattributed          | edited after monitor | ❌             | ❌            | ❌                 | ❌                |
| `section-patch`       | `context_with_system`     | system change, unattributed          | edited after monitor | ❌             | ❌            | ❌                 | ❌                |
| `section-modify`      | `context_with_system`     | system change, unattributed          | edited after monitor | ❌             | ❌            | ❌                 | ❌                |
| `section-delete`      | `context_with_system`     | system change, unattributed          | edited after monitor | ❌             | ❌            | ❌                 | ❌                |
| `in-place-mutation`   | `context_with_system`     | modification, unattributed           | edited after monitor | ❌             | ❌            | ❌                 | ❌                |
| `payload-modify`      | `before_provider_request` | edited after monitor                 | not visible          | ❌             | ➖            | ❌                 | ➖                |
| `payload-delete`      | `before_provider_request` | edited after monitor                 | not visible          | ❌             | ➖            | ❌                 | ➖                |
| `payload-remove-tool` | `before_provider_request` | edited after monitor²                | not visible          | ❌             | ➖            | ❌                 | ➖                |
| `payload-rewrite`     | `before_provider_request` | edited after monitor                 | not visible          | ❌             | ➖            | ❌                 | ➖                |

1. Both extensions edit the latest prompt. The edited copy (`four` with both
   markers) appears as a new unattributed user message, not as a modification
   of the session message.
2. A missing declaration with no `model-only` candidates.

## Usage view

Demo extensions loaded before pi-context-view. With `--after`, the Extensions
category is empty; the other counts are the same.

| Content in Usage                                     | Target                                          | v0.6.0                                  | Unreleased                              |
| ---------------------------------------------------- | ----------------------------------------------- | --------------------------------------- | --------------------------------------- |
| Prompt `two`, deleted by `context-delete`            | not counted                                     | ⚠️ counted                            | ⚠️ counted                            |
| Prompt `four`, modified by `context-modify`          | counted once, as modified                       | ⚠️ counted twice: original and copy ³ | ⚠️ counted twice: original and copy ³ |
| Additions by `context-add` and `context-add-user`    | counted                                         | ✅ counted under Extensions             | ✅ counted under Extensions             |
| System changes from `context_with_system`            | to decide (D11 lists only conversation changes) | ❌ not counted                          | ❌ not counted                          |
| `write` declaration removed by `payload-remove-tool` | not counted; counted with `--after`             | ⚠️ counted under Built-in Tools       | ⚠️ counted under Built-in Tools       |

3. [Issue #6](https://github.com/dimk90/pi-context-view/issues/6).
