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

The v0.6.0 results were checked with Pi 1.0.0. Unreleased was rechecked with
Pi 1.0.2 at `de563ca`, in a real TUI (tmux, 180×70), in both load orders.
Both checks used the mock provider from `test/harness/` (`mock-openai/vision`),
`--no-session --no-skills --no-context-files`, and
`test/fixtures/payload-logger.ts` loaded last. The Unreleased run also disabled
prompt templates, cache warming, and auto-compaction, with isolated agent
settings. Prompts, in order:

1. `XYZZY_CONTEXT_REORDER one`
2. `XYZZY_CONTEXT_DELETE two`
3. `XYZZY_PAYLOAD_DELETE three`
4. `/reload`, so that Initial is captured from a request that has history
5. `four`

Then `/context injections` and `/context usage`, including message previews.
The payload log confirmed that every change reached the provider request in
both load orders; the Unreleased run logged four requests per order, with no
extra request from opening either view.

These are results for all demo extensions loaded together, not isolated tests
of each extension. Their edits can interact, especially message modification,
reordering, and addition.

## Injections view

| Demo extension        | Event                     | Target: before                       | Target: after        | v0.6.0: before | v0.6.0: after | Unreleased: before | Unreleased: after |
| --------------------- | ------------------------- | ------------------------------------ | -------------------- | -------------- | ------------- | ------------------ | ----------------- |
| `context-add`         | `context`                 | addition, `context-view-fixture-add` | same as before       | ✅             | ❌            | ✅                 | ✅                |
| `context-add-user`    | `context`                 | addition, unattributed               | same as before       | ✅             | ❌            | ⚠️³              | ⚠️³             |
| `context-modify`      | `context`                 | modification, unattributed           | same as before       | ⚠️¹          | ❌            | ⚠️¹              | ⚠️¹             |
| `context-in-place`    | `context`                 | modification, unattributed           | same as before       | ⚠️¹          | ❌            | ⚠️¹              | ⚠️¹             |
| `context-delete`      | `context`                 | deletion, unattributed               | same as before       | ❌             | ❌            | ✅                 | ✅                |
| `context-reorder`     | `context`                 | deletion plus addition               | same as before       | ❌             | ❌            | ✅                 | ✅                |
| `system-append`       | `context_with_system`     | system change, unattributed          | edited after monitor | ❌             | ❌            | ✅                 | ❌                |
| `section-patch`       | `context_with_system`     | system change, unattributed          | edited after monitor | ❌             | ❌            | ✅                 | ❌                |
| `section-modify`      | `context_with_system`     | system change, unattributed          | edited after monitor | ❌             | ❌            | ✅                 | ❌                |
| `section-delete`      | `context_with_system`     | system change, unattributed          | edited after monitor | ❌             | ❌            | ✅                 | ❌                |
| `in-place-mutation`   | `context_with_system`     | modification, unattributed           | edited after monitor | ❌             | ❌            | ⚠️³              | ❌                |
| `payload-modify`      | `before_provider_request` | edited after monitor                 | not visible          | ❌             | ➖            | ❌                 | ➖                |
| `payload-delete`      | `before_provider_request` | edited after monitor                 | not visible          | ❌             | ➖            | ❌                 | ➖                |
| `payload-remove-tool` | `before_provider_request` | edited after monitor²                | not visible          | ❌             | ➖            | ❌                 | ➖                |
| `payload-rewrite`     | `before_provider_request` | edited after monitor                 | not visible          | ❌             | ➖            | ❌                 | ➖                |

1. Both extensions edit the latest prompt. The edited copy (`four` with both
   markers) appears as a new unattributed user message, not as a modification
   of the session message. In Unreleased it has the `Added` marker in both
   load orders; `context-reorder` has also moved it to the start of the conversation.
2. A missing declaration with no `model-only` candidates.
3. In Unreleased, the `context-add-user` message appears as `Modified`, with
   the original `four` as its `Session` preview, rather than as an addition.
   Before the monitor, `in-place-mutation` appends its marker to that added
   message, so its preview also compares against the wrong session message.
   After the monitor, that marker is absent from the snapshot.

In Unreleased, earlier system edits appear on `Preamble` (`Modified`),
`context-view-fixture` (`Added`), `Current Dir` (`Modified`), and
`Documentation` (`Deleted`, 0 tokens). The reordered `one` appears as both
`Added` and `Deleted`; `two` appears as `Deleted`, at 0 tokens.

Late-edit detection is not implemented yet. In both load orders the view says:
“Late edits were not checked: No provider payload was observed for this
request.” This is an incomplete-check warning, not an `edited after monitor`
finding. The `❌` marks for late edits therefore remain, even though the
external payload log confirms those changes reached the request.

## Usage view

Demo extensions loaded before pi-context-view. With `--after`, the Extensions
category is empty; the other counts are the same. The Unreleased rerun confirmed
these results are unchanged: Usage still uses the older Initial capture, not
the structured snapshot used by Injections.

| Content in Usage                                     | Target                                          | v0.6.0                                  | Unreleased                              |
| ---------------------------------------------------- | ----------------------------------------------- | --------------------------------------- | --------------------------------------- |
| Prompt `two`, deleted by `context-delete`            | not counted                                     | ⚠️ counted                            | ⚠️ counted                            |
| Prompt `four`, modified by `context-modify`          | counted once, as modified                       | ⚠️ counted twice: original and copy ⁴ | ⚠️ counted twice: original and copy ⁴ |
| Additions by `context-add` and `context-add-user`    | counted                                         | ✅ counted under Extensions             | ✅ counted under Extensions             |
| System changes from `context_with_system`            | to decide (D11 lists only conversation changes) | ❌ not counted                          | ❌ not counted                          |
| `write` declaration removed by `payload-remove-tool` | not counted; counted with `--after`             | ⚠️ counted under Built-in Tools       | ⚠️ counted under Built-in Tools       |

4. [Issue #6](https://github.com/dimk90/pi-context-view/issues/6). With `--after`,
   only the original `four` is counted; its edited copy is missing.
