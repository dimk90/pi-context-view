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
Pi 1.0.2 at `053aa57`, in a real TUI (tmux, 180×70), in both load orders.
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

Unreleased Usage counts the current branch with the latest request snapshot
applied, the one Injections uses for the first request. v0.6.0 used the older
Initial capture; its `--after` results come from the notes of that check.

| Content in Usage                                     | Target: before            | Target: after                     | v0.6.0: before                        | v0.6.0: after      | Unreleased: before              | Unreleased: after |
| ---------------------------------------------------- | ------------------------- | --------------------------------- | ------------------------------------- | ------------------ | ------------------------------- | ----------------- |
| Prompt `two`, deleted by `context-delete`            | not counted               | same as before                    | ⚠️ counted                            | ⚠️ counted         | ✅ not counted                   | ✅ not counted     |
| Prompt `four`, modified by `context-modify`          | counted once, as modified | same as before                    | ⚠️ counted twice: original and copy ⁴ | ⚠️ original only ⁴ | ✅ counted once ⁵                | ✅ counted once ⁵  |
| Additions by `context-add` and `context-add-user`    | counted                   | same as before                    | ✅ counted under Extensions            | ❌ not counted      | ✅ counted ⁶                     | ✅ counted ⁶       |
| System changes from `context_with_system`            | counted while fresh       | not counted: edited after monitor | ❌ not counted                         | ➖                  | ✅ counted under System Prompt ⁷ | ➖                 |
| `XYZZY_IN_PLACE`, appended by `in-place-mutation`    | counted                   | not counted: edited after monitor | not checked                           | not checked        | ✅ counted                       | ➖                 |
| `write` declaration removed by `payload-remove-tool` | not counted               | counted                           | ⚠️ counted under Built-in Tools       | ✅ counted          | ⚠️ counted under Built-in Tools | ✅ counted         |

4. [Issue #6](https://github.com/dimk90/pi-context-view/issues/6). With `--after`,
   only the original `four` is counted; its edited copy is missing.
5. As in Injections (footnote 3), the `context-add-user` message replaces the
   original `four`, and the edited copy of `four` counts as an addition. Each
   text is counted once, so the total is right. Usage shows no markers.
6. The `context-add` message counts under Extensions, and the
   `context-add-user` message under User Messages, by role.
7. `system-append`, `section-modify`, and `section-patch` text counts under
   System Prompt, and the section that `section-delete` removes is not counted.

Payload edits from `before_provider_request` are not applied to Usage, in
either load order: prompt `three`, removed by `payload-delete`, is still
counted, and the text that `payload-modify` and `payload-rewrite` add is not.

## Forced system prompt

`--force` also loads `forced-prompt.ts`, which returns `systemPrompt` from
`before_agent_start` on every run (`./scripts/demo-injections.sh --force`, and
`--after --force`). Pi then sends that text instead of its structured prompt,
so `system-append`, `section-patch`, `section-modify`, and `section-delete`
do not reach the request. Pi still sends the tool declarations of the
recorded system state with the forced text.

Checked with Pi 1.0.2 at `053aa57`, using the same setup and prompts as above;
the `Forced` markers were checked on the uncommitted changes that add them.
The payload log confirmed that, in both load orders, the system message of
every request was the forced text alone, and the tools were still declared.
Built-in Tools therefore stays in both views.

| Content                                             | Target                                       | Unreleased: before                    | Unreleased: after |
| --------------------------------------------------- | -------------------------------------------- | ------------------------------------- | ----------------- |
| Injections: forced prompt                           | System Prompt holds the forced text, Forced  | ✅ 17 tokens, `Forced` ⁸              | ✅ same as before |
| Injections: `system-append` and `section-*` changes | not in the request                           | ➖                                    | ➖                |
| Usage: forced prompt                                | counted as System Prompt, Forced             | ✅ 17 tokens, `Forced` in the preview | ✅ same as before |
| Usage: system changes from `context_with_system`    | not counted                                  | ➖                                    | ➖                |

8. The System Prompt row stays under `pi`, unattributed, with no parts. Its
   row and preview header carry `Forced`, and both the list and the preview
   explain it with a legend bullet.

The conversation demos still reached the request and appeared in Injections
as `Added`, `Modified`, and `Deleted` user messages.
