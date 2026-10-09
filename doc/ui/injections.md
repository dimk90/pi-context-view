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
compares tool declarations and message text with the provider payload. While
that comparison is pending or incomplete, the description block carries one dim
guard-status bullet with the reason:

| Guard                        | Bullet                                                               |
| ---------------------------- | -------------------------------------------------------------------- |
| Pending                      | `Late edits are not checked yet: the payload comparison is pending.` |
| Incomplete, nothing compared | `Late edits were not checked: <reason>`                              |
| Incomplete, one channel only | `Late edits were checked only in part: <reason>`                     |

A standard probe says `Late edits were not checked: No provider payload was
observed for this request.` None of these means "no edits". A partial check
still shows the [late edits](#late-edits) of the channel it compared.
[Hidden tools](#hidden-tools) come from Pi's prompt options, independently of
the guard, so a probe counts them too. A complete guard adds no bullet:
without late edits, the payload matched the request, excluding Pi's known
hidden declarations, up to this extension's own `before_provider_request`
handler. Handlers after it stay invisible.

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
    Any forced prompt carries the
    [`Forced` marker](#request-only-changes) on System Prompt.
  - `Instruction Files (M)`, with one child per context file, abbreviating home
    paths with `~`
  - Skills (K), with one content-only child per skill
  - Built-in Tools (N), with one child per active built-in tool
- each extension/tool source, labelled by its package (`npm:pi-web`). An
  extension loaded from a path (`-e`, settings, or auto-discovery) is its own
  source, labelled like Pi's startup list: the shortest path tail no other such
  extension shares, without `/index.ts` (`hidden-tools.ts`, `my-ext`)
  - one child per active tool
  - `system prompt additions` when unwrapped text around pi's sections was
    attributed to that source
  - injected messages identified by `customType` where available
- `unattributed` for prompt additions no signal could attribute, and for
  request-only changes to messages without a `customType`
- `late edits` for changes found only in the provider payload
  ([Late edits](#late-edits))

### Request-only changes

Changes from all `context` handlers and earlier `context_with_system` handlers
stay in place in the tree, with a marker after the estimate:

| Marker     | Color             | Row                                                                                   |
| ---------- | ----------------- | ------------------------------------------------------------------------------------- |
| `Added`    | `toolDiffAdded`   | A message, System Prompt part, or tool the request has and the session does not       |
| `Modified` | `warning`         | A message, System Prompt part, or tool whose request version differs from the session |
| `Deleted`  | `toolDiffRemoved` | A message, System Prompt part, or tool the request removed; it reads 0 tokens         |
| `Forced`   | `warning`         | System Prompt, when the request carried an extension's forced prompt instead of pi's  |

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
  section, so section and content changes do not apply to it. `Forced` marks
  the System Prompt row and its preview header, never its parts.
- **Tools.** A changed declaration marks its tool. A deleted tool keeps a
  0-token row under its source; `Built-in Tools (N)` counts only the tools the
  request declared. A [hidden](#hidden-tools) tool has no row.

These source groups identify the affected content, not the extension that
edited it. Changes to a pi part or a custom message remain unattributed to an
editor.

A row can carry `Moved` and a change marker together; markers keep the order
`Dropped`, `Moved`, then the change. The estimate counts the request version.
`TOTAL` covers these contributions only, not unchanged ordinary conversation;
it is not a provider-payload size.

### Late edits

Late edits are payload differences the structured capture cannot explain: they
come from `context_with_system` handlers after this extension, or from
`before_provider_request` handlers before it. They carry no structure or
source, so they cannot stay in place. The `late edits` group, after
`unattributed`, lists one row per finding:

- A changed message part: `system message`, `user message`,
  `assistant message`, `tool call`, or `tool result`.
- A tool declaration the payload added, removed, or describes differently: the
  tool name. A removal Pi did not report in `hiddenTools` is a `Deleted` late
  edit, not a [hidden tool](#hidden-tools).

Each row carries the `Added`, `Modified`, or `Deleted` marker of its change.
The guard keeps only the changed lines, so a row's estimate counts the lines
the payload added, and a deleted row reads 0 tokens. These estimates count
toward the group and `TOTAL`. Rows sort like other source groups. While the
group is shown, the description carries a dim bullet:

```text
- Late edits were made after pi-context-view captured the request. Their sources are unknown; only changed lines are known, and estimates count the added lines.
```

### Hidden tools

A tool in the snapshot's `hiddenTools` is hidden: Pi leaves its declaration
out while it stays active and callable through another tool, such as codemode.
The tree leaves a hidden tool out, whatever structured change it had: it has no
row, marker, or preview, and `TOTAL` does not count it. A source left without
rows has no group, and `Built-in Tools (N)` has no row without children. Its
prompt lines, if the prompt still has them, stay in pi's prompt text.

While the request declared any hidden tool, the description carries one dim
bullet with their count and all their names in alphabetical order, wrapping as
needed, such as the first line below, or the second for a single tool:

```text
- 4 tools hidden by pi: bash, edit, read, write.
- 1 tool hidden by pi: bash.
```

A hidden name the request did not declare is not counted. Previews do not
repeat the bullet.

Capture reads Pi's `before_agent_start.systemPromptOptions.hiddenTools`, so
the count works for a silent probe before the first ordinary prompt. It is
independent of payload comparison and stays frozen with Initial. A degraded
fallback without a snapshot uses the live list instead.

Pi does not report which tool's `prepareLoadout()` hid each declaration. Do
not guess from `model-only` exposure or name a candidate. Capture's observation
limits are documented in
[ARCHITECTURE.md](../ARCHITECTURE.md#structured-request-capture).

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
the fallback hierarchy usable. Below both come, when shown, the probe bullet,
the guard-status bullet, the [hidden-tools bullet](#hidden-tools), one
[legend bullet](previews.md#marker-legend) per marker the rows carry —
`Dropped`, `Moved`, `Forced`, `Added`, `Modified`, `Deleted`, or none — then
the late-edits bullet. All of them collapse with the rest of the block.

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

A late edit previews its changed lines in payload order, without labeled parts.
A line only in the payload opens with `+ ` in `toolDiffAdded`; a line only in
the captured request opens with `- ` in `toolDiffRemoved`. The whole line takes
that color, and wrapped continuation lines hang under its text.

After the legend bullets of its markers, a late-edit preview repeats the
late-edits bullet. Descriptions collapse under the rules in
[previews.md](previews.md#marker-legend).
