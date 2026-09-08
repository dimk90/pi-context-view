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

## Contribution tree

Present Initial contributions in this order:

- `pi`
  - System Prompt, including when `--system-prompt` replaced pi's default,
    with one child per part pi assembles it from, in prompt order: `Preamble`,
    `Available Tools`, `Guidelines`, `Documentation`, `Appended Prompt`
    (`--append-system-prompt` text), `Current Dir`, and `Extension Additions`.
    Parts pi rendered no text into are absent. A replaced prompt keeps its whole
    body as the `Preamble` part and still lists `Available Tools`, `Guidelines`,
    and `Documentation`, each at 0 tokens with the
    [`Dropped` marker](../UI.md#color-and-casing) after its estimate, so the
    tree shows what the replacement gave up. `Extension Additions` holds no
    counted text of its own: it always reads 0 tokens and exists to present the
    additions its owners count. Structurally recovered `Available Tools` and
    `Guidelines` blocks remain System Prompt children, at their actual prompt
    position with a [`Moved` marker](../UI.md#color-and-casing). For example,
    blocks relocated past the footer follow `Current Dir`, not `Preamble`.
    `Extension Additions` still consolidates all other additions at the end;
    recovered block text is excluded from those owners' counts.
  - `Instruction Files (M)`, with one child per context file, abbreviating home
    paths with `~`
  - Skills (K), with one content-only child per skill
  - Built-in Tools (N), with one child per active built-in tool
- each extension/tool source
  - one child per active tool
  - `system prompt additions` when text appended after pi's footer was
    attributed to that source
  - injected messages identified by `customType` where available
- `unattributed` for prompt additions no signal could attribute

Within the `pi` group, keep the fixed semantic order above and sort remaining
prompt additions by size. Children break down parent contributions and do not
increase totals. Measurements and previews exclude transport wrappers and
section-introduction scaffolding; pi sends its working-directory footer with
every request, so it is measured as the `Current Dir` part instead.

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
the fallback hierarchy usable.

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
