# Injection demo results

Tracks what each version shows for the demo extensions that
[`demo-injections.sh`](demo-injections.sh) loads. **Target** is the design in
[REQUEST-ONLY-INJECTIONS.md](../doc/REQUEST-ONLY-INJECTIONS.md). Add a column
when a version changes a result.

Columns per version:

- **Before:** selected demo extensions load before pi-context-view (default order).
- **After:** pi-context-view loads first (add `--after` to the same fixture flags).

## Explicit fixture selection

The launcher loads only pi-context-view by default. Select related fixtures
with group flags. Place demo flags before Pi arguments; groups load in flag
order, with each group's fixtures in the order below. `--after` moves
pi-context-view before all selected fixtures.

| Flag              | Fixtures                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `--context`       | `context-modify`, `context-in-place`, `context-delete`, `context-reorder`, `context-add`, `context-add-user` |
| `--system`        | `system-append`, `section-patch`, `section-modify`, `section-delete`, `in-place-mutation`                    |
| `--payload`       | `payload-late-edits`, `payload-delete`, `payload-remove-tool`                                                |
| `--forced`        | `forced-prompt` (forced system prompt)                                                                       |
| `--codemode-only` | none; Pi's built-in codemode in `only` mode                                                                  |

Flags combine without enabling unselected groups. For example:

```sh
./scripts/demo-injections.sh --codemode-only --forced --no-session
```

This loads only built-in codemode and the forced-prompt fixture alongside pi-context-view.
Individual fixture flags are no longer demo flags. For isolated checks, load
any fixture directly with Pi's `-e` option. `--forced` replaces the old `--force`
spelling; `--force` is no longer a demo flag.

Marks:

- ✅ shown as the target describes
- ⚠️ shown, but not as the target describes
- ❌ not shown
- ➖ not visible by design

## Automatic section demo

Run the selected section fixtures and open `/context injections` in a fresh
session. No marker prompts are needed:

```sh
./scripts/demo-injections.sh --system --no-session
```

| Fixture          | Changes                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `section-patch`  | Adds `context-view-fixture`, `context-view-fixture-checklist`, and `context-view-fixture-summary`. |
| `section-modify` | Modifies `cwd`, `context-view-fixture-review`, and `context-view-fixture-output`.                  |
| `section-delete` | Deletes `docs`, `context-view-fixture-obsolete`, and `context-view-fixture-scratch`.               |

The modification and deletion fixtures seed four synthetic sections through
`before_agent_start`. Pi records those originals as the session baseline;
`context_with_system` changes only the outgoing request. Modified section previews
show the request text; Deleted previews keep the original at zero tokens. With normal
Pi defaults, this gives three examples of each section change on the first
capture, including a silent probe. `--system` also loads `system-append` and
`in-place-mutation`; conversation additions require `--context`.

The silent probe needs a configured model and credentials and must pass the
usual probe safety checks. Alternatively, send an ordinary prompt first.
`--after` puts these section edits after capture, so they are not marked in the
structured view. `--forced` replaces the sectioned system prompt entirely.
Conversation deletion and reordering require `--context` plus their marker
prompts (`XYZZY_CONTEXT_DELETE` and `XYZZY_CONTEXT_REORDER`).

## Automatic late-edit demo

Run `./scripts/demo-injections.sh --payload --no-session`, send an ordinary
prompt, then open `/context injections`. `payload-late-edits` produces one of each marker in
`late edits` on the first real request:

| Change   | Preview                                                              |
| -------- | -------------------------------------------------------------------- |
| Modified | `-` original `XYZZY_PAYLOAD_LATE_MODIFY` note, `+` replacement note. |
| Deleted  | `-` `XYZZY_PAYLOAD_LATE_DELETE` note, at 0 tokens.                   |
| Added    | `+` `XYZZY_PAYLOAD_LATE_ADD` note.                                   |

The fixture prepends three synthetic user notes in `context`: the modification
original, an unchanged separator, and the deletion original. They appear as
structured request-only additions under `unattributed`, not in saved history.
The separator keeps modification and deletion distinct in the payload diff.
`before_provider_request` edits those originals and adds a new message, leaving
real prompts unchanged. It supports OpenAI Completions, OpenAI Responses, and
Anthropic Messages.

`--payload` leaves out the older `payload-modify` and `payload-rewrite`
fixtures to avoid duplicate automatic findings. They remain available through
Pi's `-e` option for isolated checks. The group also loads `payload-delete`,
which removes prompts containing `XYZZY_PAYLOAD_DELETE`, and
`payload-remove-tool`, which manually removes the `write` declaration.

Send the prompt **before first opening Injections**: a silent probe has no
provider payload, and Initial stays frozen. If a probe already captured Initial,
run `/reload`, send a prompt, then reopen the view. With `--after`, these payload
edits run after the monitor's payload hook and are not visible; the later
explicitly selected `context_with_system` edits still appear as late edits.
`--forced` does not stop these message demos.

## Optional codemode hidden-tools demo

```sh
./scripts/demo-injections.sh --codemode-only --no-session
```

`--codemode-only` loads Pi's built-in codemode with `-e builtin:codemode`,
without adding fixtures. Add `--forced`, `--context`, `--system`, or
`--payload` to include those demos. Pi loads explicit `builtin:` entries after
other `-e` paths, so `--after` moves only pi-context-view and the fixtures.

Pi reads codemode settings only from settings files, so the launcher runs pi
with `PI_CODING_AGENT_DIR` set to a temporary directory. It links every entry of
the real agent directory (auth, models, sessions, themes) except
`settings.json`, which is a copy of your settings with `codemode.mode` set to
`"only"` and `+codemode` added to `defaultTools`. Your settings file is not
changed, and settings changed during the run are lost. The directory is removed
when pi exits.

As in a real session, `codemode` has the `builtin` source and is listed under
Built-in Tools.

Open `/context injections` immediately: its silent probe records Pi's hidden
tools, so the other active tools already show `Hidden` at 0 tokens. They remain
callable through codemode scripts. With the default tool selection, `read`,
`bash`, `edit`, and `write` are hidden; Usage counts only `codemode`. This works
in both extension load orders. Tool-selection arguments can change that set.

With no other fixture flags, this mode demonstrates codemode hiding alone,
without section, conversation, or payload edits. Manual `write`-declaration
removal runs only when the `--payload` group is explicitly selected. To inspect
late payload edits, send a real prompt before first opening Injections; this is
no longer necessary for codemode hiding alone.

On Pi 1.1, `--payload` without codemode reports the `write` removal as a `Deleted`
tool under `late edits`. Its normal tool row and Usage count remain unchanged,
like other late edits; it is not marked `Hidden`.

The tables below are historical checks of earlier fixture sets; their recorded
results have not been rewritten.

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

| Content in Usage                                     | Target: before            | Target: after                     | v0.6.0: before                          | v0.6.0: after        | Unreleased: before                | Unreleased: after |
| ---------------------------------------------------- | ------------------------- | --------------------------------- | --------------------------------------- | -------------------- | --------------------------------- | ----------------- |
| Prompt `two`, deleted by `context-delete`            | not counted               | same as before                    | ⚠️ counted                            | ⚠️ counted         | ✅ not counted                    | ✅ not counted    |
| Prompt `four`, modified by `context-modify`          | counted once, as modified | same as before                    | ⚠️ counted twice: original and copy ⁴ | ⚠️ original only ⁴ | ✅ counted once ⁵                 | ✅ counted once ⁵ |
| Additions by `context-add` and `context-add-user`    | counted                   | same as before                    | ✅ counted under Extensions             | ❌ not counted       | ✅ counted ⁶                      | ✅ counted ⁶      |
| System changes from `context_with_system`            | counted while fresh       | not counted: edited after monitor | ❌ not counted                          | ➖                   | ✅ counted under System Prompt ⁷  | ➖                |
| `XYZZY_IN_PLACE`, appended by `in-place-mutation`    | counted                   | not counted: edited after monitor | not checked                             | not checked          | ✅ counted                        | ➖                |
| `write` declaration removed by `payload-remove-tool` | not counted               | counted                           | ⚠️ counted under Built-in Tools       | ✅ counted           | ⚠️ counted under Built-in Tools | ✅ counted        |

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

`--forced` selects `forced-prompt.ts`, which returns `systemPrompt` from
`before_agent_start` on every run (`./scripts/demo-injections.sh --forced`, and
`--after --forced`). Pi then sends that text instead of its structured prompt,
so `system-append`, `section-patch`, `section-modify`, and `section-delete`
do not reach the request. Pi still sends the tool declarations of the
recorded system state with the forced text.

Checked with Pi 1.0.2 at `053aa57`, using the same setup and prompts as above;
the `Forced` markers were checked on the uncommitted changes that add them.
The payload log confirmed that, in both load orders, the system message of
every request was the forced text alone, and the tools were still declared.
Built-in Tools therefore stays in both views.

| Content                                             | Target                                      | Unreleased: before                    | Unreleased: after |
| --------------------------------------------------- | ------------------------------------------- | ------------------------------------- | ----------------- |
| Injections: forced prompt                           | System Prompt holds the forced text, Forced | ✅ 17 tokens, `Forced` ⁸              | ✅ same as before |
| Injections: `system-append` and `section-*` changes | not in the request                          | ➖                                    | ➖                |
| Usage: forced prompt                                | counted as System Prompt, Forced            | ✅ 17 tokens, `Forced` in the preview | ✅ same as before |
| Usage: system changes from `context_with_system`    | not counted                                 | ➖                                    | ➖                |

8. The System Prompt row stays under `pi`, unattributed, with no parts. Its
   row and preview header carry `Forced`, and both the list and the preview
   explain it with a legend bullet.

The conversation demos still reached the request and appeared in Injections
as `Added`, `Modified`, and `Deleted` user messages.

## Late edits and hidden tools

Checked with Pi 1.0.4 after the payload guard results reached the views, with
the expanded fixtures above and the setup and prompts of
[How the results were checked](#how-the-results-were-checked), in tmux at
180×70. The payload log had four requests per order; opening the views added
none. Only results that changed are listed.

| Demo extension                                                       | Target: before       | Target: after        | Guard results: before    | Guard results: after |
| -------------------------------------------------------------------- | -------------------- | -------------------- | ------------------------ | -------------------- |
| `system-append`, `section-patch`, `section-modify`, `section-delete` | system change        | edited after monitor | ✅ structured, as before | ✅ late edit ⁹       |
| `in-place-mutation`                                                  | modification         | edited after monitor | ⚠️³, as before         | ✅ late edit         |
| `payload-modify`                                                     | edited after monitor | not visible          | ✅ late edit             | ➖                   |
| `payload-delete`                                                     | edited after monitor | not visible          | ✅ late edit             | ➖                   |
| `payload-remove-tool`                                                | edited after monitor | not visible          | ✅ `Hidden` ¹⁰           | ➖                   |
| `payload-rewrite`                                                    | edited after monitor | not visible          | ✅ late edit             | ➖                   |
| Usage: `write` removed by `payload-remove-tool`                      | not counted          | counted              | ✅ not counted           | ✅ counted           |

9. The system prompt is one message unit in the payload, so these demos
   appear together as the changed lines of one `system message` row
   (`Modified`) in the `late edits` group.
10. `write` stays under Built-in Tools as `Hidden`, at 0 tokens, and the
    description names it as a hidden tool without a `model-only` candidate,
    which a later handler may have removed.

Before the monitor, the `late edits` group shows `payload-modify` as a
`Modified` user message with its `+` marker line, `payload-rewrite` as an
`Added` one, and `payload-delete` as a `Deleted` one at 0 tokens with `-` and
prompt `three`. After the monitor, `in-place-mutation` is a `Modified` user
message with its marker line. Payload edits are still not applied to Usage;
only the declared tool names are.
