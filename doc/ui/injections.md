# Context Injections view

`/context injections` opens **Context Injections**. Frame, color, description,
and interaction rules live in the [UI specification](../UI.md); rules shared
with Usage previews live in [previews.md](previews.md).

Its header is:

```text
Context Injections · [INITIAL]
```

`INITIAL` uses the active `mdHeading` treatment. Runtime inspection is
roadmap-only, so no Runtime label, switching key, or Runtime status renders
until that step lands. If the combined header does not fit, put title and label
on separate lines with one empty row before and after the label.

## Initial request

Initial is the first request snapshot of the extension runtime. Its
composition is the session projection at the snapshot's leaf, rebuilt when the
view opens, with the snapshot's request-only changes applied: the prompt and
tools replayed from the recorded system messages, the forced prompt in place of
the replayed prompt when the request had one, and the custom messages of the
projection. Ordinary session messages are not listed unless a request-only
change touches them.

When Initial came from a silent probe, the description block carries a wrapped
bullet with only `request probe` in `warning` color; the rest is dim:

```text
- Captured by a request probe with an empty prompt. Prompt-dependent injections may be missing.
```

The bullet collapses with the rest of the description block. The payload guard
will compare late edits against the provider payload; it is not implemented yet. While that
comparison is pending or incomplete, the description block carries one dim
bullet with the reason, for
example `Late edits were not checked: No provider payload was observed for this
request.` It is never shown as "no edits". The bullet collapses with the rest of
the block.

## Contribution tree

Present Initial contributions in this order:

- `pi`
  - System Prompt, including when `--system-prompt` replaced pi's default,
    with one child per part pi assembles it from, in prompt order: `Preamble`,
    `Available Tools`, `Guidelines`, `Documentation`, `Appended Prompt`
    (`--append-system-prompt` text), `Current Dir`, and `Extension Additions`.
    A custom XML section keeps its own tag as the child label, at its actual
    position, including after `Current Dir`. Parts pi rendered no text into are
    absent. A replaced prompt keeps its whole
    body as the `Preamble` part and still lists `Available Tools`, `Guidelines`,
    and `Documentation`, each at 0 tokens with the
    [`Dropped` marker](../UI.md#color-and-casing) after its estimate, so the
    tree shows what the replacement gave up; a section the replacement kept is
    an ordinary part instead. `Extension Additions` holds no
    counted text of its own: it always reads 0 tokens and exists to present the
    additions its owners count. Moved `Available Tools` and `Guidelines`
    sections remain System Prompt children, at their actual prompt position
    with a [`Moved` marker](../UI.md#color-and-casing). For example, sections
    relocated past `cwd` follow `Current Dir`, not `Preamble`.
    `Extension Additions` still consolidates all unwrapped additions at the end.
    A forced prompt without XML sections has no children: System Prompt is one
    undivided part holding the whole forced text, with no `Dropped`, `Moved`,
    or `Extension Additions` parts, and each tool shows only its `Definition`.
  - `Instruction Files (M)`, with one child per context file, abbreviating home
    paths with `~`
  - Skills (K), with one content-only child per skill
  - Built-in Tools (N), with one child per active built-in tool
- each extension/tool source
  - one child per active tool
  - `system prompt additions` when unwrapped text around pi's sections was
    attributed to that source
  - injected messages identified by `customType` where available
- `unattributed` for prompt additions no signal could attribute, and for
  request-only changes to messages without a `customType`

### Request-only changes

Changes from all `context` handlers and earlier `context_with_system` handlers
stay in place in the tree, with a marker after the estimate:

| Marker     | Color             | Row                                                                                   |
| ---------- | ----------------- | ------------------------------------------------------------------------------------- |
| `Added`    | `toolDiffAdded`   | A message, System Prompt part, or tool the request has and the session does not       |
| `Modified` | `warning`         | A message, System Prompt part, or tool whose request version differs from the session |
| `Deleted`  | `toolDiffRemoved` | A message, System Prompt part, or tool the request removed; it reads 0 tokens         |

- **Messages.** An added or modified custom message sits under its
  `customType` source with the `message` label; any other message sits under
  `unattributed` with a `<role> message` label, such as `user message`. A
  deleted message uses the `customType` of the session message it removed. A
  modified or deleted session custom message replaces its unchanged row.
- **System Prompt.** A changed section marks its part, at its position in the
  request prompt. The recorded layout also identifies inline XML, unwrapped,
  and empty sections. Pi renders changed plain content before the first section, so
  it marks `Preamble`. A deleted section follows the parts the request sent, in
  session order, before `Extension Additions`. A forced prompt replaces every
  section, so section and content changes do not apply to it.
- **Tools.** A changed declaration marks its tool. A deleted tool keeps a
  0-token row under its source; `Built-in Tools (N)` counts only the tools the
  request declared.

These source groups identify the affected content, not the extension that
edited it. Changes to a pi part or a custom message remain unattributed to an
editor.

A row can carry `Moved` and a change marker together; markers keep the order
`Dropped`, `Moved`, then the change. The estimate counts the request version.
`TOTAL` covers these contributions only, not unchanged ordinary conversation;
it is not a provider-payload size.

Within the `pi` group, keep the fixed semantic order above and sort remaining
prompt additions by size. Children break down parent contributions and do not
increase totals. Measurements and previews exclude XML transport wrappers and
section-introduction scaffolding; pi sends its `cwd` section with every
request, so it is measured as the `Current Dir` part.

Use dim `├─`, `└─`, and `│` connectors for source, item, and constituent
hierarchy. Align every token estimate to one shared column capped near the tree
(`MAX_TOKEN_VALUE_COLUMN`) on wide terminals, leaving unused space to the right.
Fill label/value gaps with dim dot leaders; as width shrinks, shorten or remove
leaders before truncating labels or token values, and retain tree connectors
where space permits.

Place one empty row before `TOTAL`. It is the last row in the scrollable Initial
list, counts only the frozen Initial snapshot, and is not selectable: cursor
navigation, the selectable-row counter, and Enter preview skip it.

The list description survives scrolling, per the floor in
[Descriptions](../UI.md#descriptions); the `(current/total)` counter never
collapses it by itself. When capture is degraded, wrap the precise reason below
the header and show a `[Degraded: …]` indicator beside the description, keeping
the fallback hierarchy usable. Below both come the probe and late-edit bullets,
when shown, and one [legend bullet](previews.md#marker-legend) per marker the rows
carry — `Dropped`, `Moved`, `Added`, `Modified`, `Deleted`, or none. All of them
collapse with the rest of the block.

## Injection preview

Enter on an injection item opens its sanitized raw text. Show item title,
source, and estimated tokens in the header; wrap content to available width and
support arrow and page scrolling. Escape returns to the same selected row. Raw
text must never appear in row descriptions.

A tool item renders its labeled parts under the
[labeled part rules](previews.md#labeled-parts) instead of one undivided block
of raw text. An item with children — System Prompt, Instruction Files, Skills,
Built-in Tools — renders one part per child under the same rules, so children
stay separated by two blank rows instead of running together. The whole preview
is full content, so marked JSON expands here, in an aggregate part as much as in
a tool's own definition.

The preview header carries the item's markers after its estimate. A changed
message previews both versions:

- **Modified** renders a `Request` part with the counted request version and a
  `Session` part with the session original at 0 tokens.
- **Deleted** renders the session original undivided; the header reads 0
  tokens.

A deleted System Prompt part or tool previews the session text it removed, at 0
tokens. A modified System Prompt part or tool shows only the request version.
