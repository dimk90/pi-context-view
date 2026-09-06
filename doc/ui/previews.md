# Preview rules

Rules shared by every preview in both views. Frame, color, description, and
interaction rules live in the [UI specification](../UI.md).

## Labeled parts

Content that decomposes into labeled parts — a tool's `Available Tools`,
`Guidelines`, and `Definition`, the System Prompt's own blocks — renders every
part under its own bold `syntaxKeyword` subheader followed by a muted
` · N tokens` share, with exactly two blank rows between parts. Replace any
trailing blank rows of the preceding part with this separator; preserve blank
rows inside its body and leave captured text and token estimates unchanged.
Part shares reconcile exactly with the item or entry estimate and never add to
it. Show the applicable subheader even when `Definition` is the only captured
part; omit parts with no captured text rather than rendering zero-token
placeholders. Two kinds of part carry no counted text by design and still
render at 0 tokens: `Extension Additions` whenever it hosts restored lines, and
any part a `--system-prompt` replacement dropped, which keeps its subheader with
the [`Dropped` marker](../UI.md#color-and-casing) after its estimate — even with
an empty body, since the point is to show what the replacement gave up.

Why `syntaxKeyword`: parts nest under item and entry headings that already carry
`mdHeading`.

## Restored extension lines

The System Prompt `Available Tools`, `Guidelines`, and `Extension Additions`
previews restore the text extensions contributed to those blocks in prompt
order, alongside pi's own. A dropped block restores the extension lines pi would
have rendered into it and shows no pi-authored content at all, so it renders
empty when no extension contributed to it; the tools themselves keep the same
lines as their own dropped sections, unannotated like any other owning-tool
preview. Each restored line uses `syntaxNumber` followed by a
`borderMuted` ` <- ` and the owning extension's source label in `mdLink` — fixed
semantic theme colors, independent of category color overrides. A tool
contributes at most one `Available Tools` snippet, and a shared guideline bullet
names only the first owning tool's source, never every tool declaring it.
Built-in tool lines are pi's own and carry no annotation.

When the line belongs to one tool or slash command of that extension, the label
gains a `mdLinkUrl` `:<tool>` — colon included, e.g.
`<- npm:pi-web:web_search` or `<- npm:@eko24ive/pi-ask:/ask`. Carved tool lines
always carry it; an `Extension Additions` block carries it only when its text
names exactly one of that extension's registered names. An extension label
without a qualifier means no single owner was identified, never that the
extension registered none.

A source pi did not report, but this extension inferred from the injected text,
carries a `dim` ` (guess)` after its label, once for the whole
`extension:tool` label. `Extension Additions` is the only block with such owners
today: carved tool lines name a source pi reported. A part that opens with a
restored line drops its captured leading blank lines, as plain part text does.

Non-breaking spaces on both sides of the arrow join the preceding content word,
arrow, and source label into one wrapping unit. Move that whole unit to the next
line when it fits the content width but not the remaining space. If the unit is
wider than the content width, hard-wrap it to fit; this may split the label or
leave the arrow at the end of a line.

The annotations are preview-only: the part and System Prompt estimates still
exclude these lines, while the tool preview keeps its counted `Available Tools`
and `Guidelines` sections unchanged. Sanitize line text and source labels before
applying colors, preserve styling through wrapping, and include annotations in
preview scrolling and cap line counts. Never show raw lines in the overview list
or dashboard.

## Attribution footer

Restored lines appear in the System Prompt preview of both views, including the
direct single-entry Usage preview, and in the standalone `Available Tools` and
`Guidelines` children in Injections. Multi-entry Usage streams and their full
content levels retain the same attribution treatment. Each of those previews
shows one dim description at the bottom, outside the scrollable content and
block-selection gutter, between blank rows immediately above the hints:

> Highlighted parts are injected by extensions into pi’s system prompt. They are
> excluded from the System Prompt token count and included in the injecting
> extension’s count.

When every highlighted part in that preview was dropped, the accounting sentence
is replaced rather than extended, because nothing counts those lines:

> Highlighted parts are injected by extensions into pi’s system prompt. A custom
> system prompt replaced them, so they are counted neither by the System Prompt
> nor by the injecting extension.

A preview mixing dropped parts with parts pi still sends — the System Prompt
item preview under a replacement, whose `Extension Additions` survived it — keeps
the original sentence and adds:

> Parts marked Dropped were replaced by a custom system prompt and are counted
> nowhere.

When any restored line in that preview names a guessed owner, the footer gains
one more sentence:

> Sources marked (guess) are inferred from the injected text itself.

It covers a guessed `:<tool>` qualifier as well, which is inferred the same way
and never gets a marker of its own.

Wrap it without truncation and keep it pinned while scrolling, even when the
highlighted text is offscreen or hidden by a block cap. It renders only for
content carrying injected-reference metadata: native-only System Prompt and part
previews, sibling parts without references, and owning-tool previews have none.
The Usage category stream inspects all entries; full content, opened directly or
from a block, inspects only its open entry.

It collapses whole, including its preceding blank row, below the floor in
[Descriptions](../UI.md#descriptions), allowing for the overflow counter, and
returns on height-only resize. It never contributes to scroll counters or
`… +N lines` counts, though its reserved rows affect the viewport and block cap.
For a Usage stream, decide collapse from the uncapped content plus entry headers
and separators, before deriving the footer-dependent block cap — otherwise the
layout decision is circular.

## Repeated headings

A preview body never repeats the heading directly above it: drop a first content
line identical to the item title, part label, or entry name, as a skill block
that opens with its own name has. This preview-only omission still counts the
dropped line toward the estimate shown in that heading.

## Marked JSON

Preview text may carry a JSON document that the model marks structurally — a
tool's parameter schema, tool-call arguments, serialized message content. Every
preview level re-serializes that run across lines indented `JSON_INDENT` (2)
spaces per level, so a block small enough to escape the cap still shows its
expanded form, and block caps and `… +N lines` counts measure the expanded lines
the Enter level opens. Marking is structural, never heuristic: text that merely
looks like JSON stays as captured, and a marked run that no longer parses
renders unchanged. Like skill badges, this transformation never changes token
estimates.
