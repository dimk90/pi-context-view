# Injection demos

Demo instructions and expected results for the fixtures loaded by
[`demo-injections.sh`](demo-injections.sh). Expected results follow each
fixture's header comment and the [capture visibility rules](../doc/architecture/capture.md#scope).

The launcher loads demo-only extensions from [`scripts/fixtures/`](fixtures/).
Regular tests use independent fixtures in `test/fixtures/`; neither set imports
or re-exports the other. Change the demo fixtures without changing regular test
behavior. The launcher tests check selection and paths, and `pnpm check`
typechecks both sets and checks their import boundaries.

Load orders:

- **Before:** selected fixtures load before pi-context-view (default).
- **After:** pi-context-view loads first (add `--after`).

## Explicit fixture selection

The launcher loads only pi-context-view by default. Place demo flags before
Pi arguments; groups load in flag order, with each group's fixtures in the
order below.

Discovered extensions stay disabled unless you add `--local`, which omits
Pi's `--no-extensions` argument. The working copy and selected fixtures still
load explicitly, so an installed pi-context-view may load alongside them.

| Flag              | Fixtures                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `--context`       | `context-modify`, `context-in-place`, `context-delete`, `context-reorder`, `context-add`, `context-add-user` |
| `--system`        | `system-append`, `section-patch`, `section-modify`, `section-delete`, `in-place-mutation`                    |
| `--payload`       | `payload-changes`, `payload-delete`, `payload-remove-tool`                                                   |
| `--message`       | `agent-start-message`, `system-add-message`                                                                  |
| `--forced`        | `forced-prompt` (forced system prompt)                                                                       |
| `--codemode-only` | none; Pi's built-in codemode in `only` mode                                                                  |

Flags combine without enabling unselected groups:

```sh
./scripts/demo-injections.sh --codemode-only --forced --no-session
```

For isolated demo checks, load a file from `scripts/fixtures/` directly with
Pi's `-e` option, for example `pi -e ./scripts/fixtures/section-patch.ts`.
`--forced` replaces the system prompt; conversation and payload demos still run.

## Viewing the demos

Opening `/context injections` before the first prompt attempts a silent probe.
This requires a configured model, credentials, and the usual probe safety checks.
Probes have no provider payload, so payload changes require an ordinary prompt.
Reopen the view afterwards: the latest real request replaces the probe snapshot.

## Automatic section demo

The section fixtures need no marker prompts:

```sh
./scripts/demo-injections.sh --system --no-session
```

| Fixture          | Changes                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `section-patch`  | Adds `context-view-fixture`, `context-view-fixture-checklist`, and `context-view-fixture-summary`. |
| `section-modify` | Modifies `cwd`, `context-view-fixture-review`, and `context-view-fixture-output`.                  |
| `section-delete` | Deletes `docs`, `context-view-fixture-obsolete`, and `context-view-fixture-scratch`.               |

The modification and deletion fixtures seed their synthetic originals through
`before_agent_start`, making them part of the session baseline.
`context_with_system` changes only the outgoing request. Modified previews show
the request text; Deleted previews keep the original at zero tokens. With normal
Pi defaults, the first capture gives three examples of each section change.

With `--after`, these edits are not marked in the structured view; they appear
as payload changes only after a real prompt. For conversation deletion and reordering,
select `--context` and send their marker prompts (`XYZZY_CONTEXT_DELETE` and
`XYZZY_CONTEXT_REORDER`).

## Automatic payload-change demo

Run `./scripts/demo-injections.sh --payload --no-session`, send an ordinary
prompt, then open `/context injections`. `payload-changes` produces one of each marker in
`payload changes` on the first real request:

| Change   | Preview                                                                |
| -------- | ---------------------------------------------------------------------- |
| Modified | `-` original `XYZZY_PAYLOAD_CHANGE_MODIFY` note, `+` replacement note. |
| Deleted  | `-` `XYZZY_PAYLOAD_CHANGE_DELETE` note, at 0 tokens.                   |
| Added    | `+` `XYZZY_PAYLOAD_CHANGE_ADD` note.                                   |

The fixture seeds the modification and deletion originals in `context`, with
an unchanged separator to keep them distinct in the payload diff. These are
request-only additions under `unattributed`, not saved history.
`before_provider_request` edits them and adds a message, leaving real prompts
unchanged. It supports OpenAI Completions, OpenAI Responses, and Anthropic Messages.

The group also includes `payload-delete` (removes prompts containing
`XYZZY_PAYLOAD_DELETE`) and `payload-remove-tool` (removes the `write` declaration).

With `--after`, payload edits run after the monitor's payload hook and are not
visible. If `--system` is also selected, its later `context_with_system` edits
still appear as payload changes.

## Automatic message demo

Run `./scripts/demo-injections.sh --message --no-session`, open
`/context injections`, send an ordinary prompt, then open it again:

| Fixture               | Event                 | Target: before                              | Target: after                              |
| --------------------- | --------------------- | ------------------------------------------- | ------------------------------------------ |
| `agent-start-message` | `before_agent_start`  | no change: a saved message, no marker       | same as before                             |
| `system-add-message`  | `context_with_system` | addition, `context-view-fixture-system-add` | edited after monitor: `Added` user message |

Pi saves one `agent-start-message` per run under
`context-view-fixture-agent-message`, without a change marker. After the probe
and one prompt, the group has two messages.

With `--after`, `system-add-message` is absent from the probe. After a real
prompt, it appears in `payload changes`: provider conversion turns the custom
message into a user message, losing its `customType`.

## Optional codemode hidden-tools demo

```sh
./scripts/demo-injections.sh --codemode-only --no-session
```

The launcher loads codemode with `-e builtin:codemode`. Pi loads explicit
`builtin:` entries after other `-e` paths, so `--after` moves only
pi-context-view and the fixtures. The `codemode` tool appears under Built-in
Tools with the `builtin` source.

The launcher sets `PI_CODING_AGENT_DIR` to a temporary directory. It links the
real agent directory's entries except `settings.json`, which is copied with
`codemode.mode` set to `"only"` and `+codemode` added to `defaultTools`.
Your original settings stay unchanged; settings changed during the run are
lost when the temporary directory is removed on exit.

The silent probe records Pi's hidden tools in both load orders. Injections
omits their rows and lists their count and names in one description bullet;
they remain callable through codemode scripts. With the default tool selection,
`read`, `bash`, `edit`, and `write` are hidden; Usage counts only `codemode`.
Tool-selection arguments can change that set.

`--payload` without codemode reports its manual `write` removal as a `Deleted`
tool under `payload changes`, not a hidden tool. Its normal tool row and Usage count
remain unchanged.

## Comparison with v0.6.0

Recorded results: v0.6.0 was checked with Pi 1.0.0; **Unreleased** was checked
with Pi 1.0.2 at `053aa57`, not the current code. The checks loaded all fixtures
listed below together, not the current launcher's groups. Their edits can
interact, especially message modification, reordering, and addition.

Prompts, in order: `XYZZY_CONTEXT_REORDER one`, `XYZZY_CONTEXT_DELETE two`,
`XYZZY_PAYLOAD_DELETE three`, then `four`.

**Target** describes the expected result. Marks: ✅ matches the target;
⚠️ differs from it; ❌ not shown; ➖ not visible by design.

### Injections view

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

At that Unreleased revision, payload-change detection was not implemented. The view
reported an incomplete payload comparison in both load orders, although the
external payload log confirmed that the edits reached the provider request.

### Usage view

In the Unreleased check, Usage counted the current branch with the request
snapshot applied. v0.6.0 used the older Initial capture; its `--after` results
come from the notes of that check.

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
