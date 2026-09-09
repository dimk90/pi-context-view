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

A recovered block out of pi's normal order keeps its ordinary token share and
adds the [`Moved` marker](../UI.md#color-and-casing) after it. This applies in
both views, including the direct System Prompt Usage preview and standalone
Injections part metadata. Its extension lines still render with their known
owning-tool references; movement alone never guesses a rewriting extension's
identity, and its [legend bullet](#marker-legend) explains position only.

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

## Marker legend

Every frame explains the marks it shows, as one dash bullet per mark. A preview
places its bullets at the bottom, outside the scrollable content and
block-selection gutter, between blank rows immediately above the hints; the
Injections list appends them to its own description sentence. Bullets always
render in this order, each opening with the keyword in the fixed color that mark
uses, followed by dim text:

> - **Highlighted** parts are injected by extensions into pi’s system prompt.
>   They are excluded from the System Prompt token count and included in the
>   injecting extension’s count.
> - **(guess)** sources are inferred from the injected text itself.
> - **Dropped** parts were replaced by a custom system prompt and are counted
>   nowhere.
> - **Moved** blocks sit outside the region pi renders them into and count
>   normally.

Each sentence is fixed and states its own accounting, so the `Dropped` bullet
reads as the exception to the `Highlighted` one wherever a preview shows both.
The `(guess)` bullet covers a guessed `:<tool>` qualifier as well, which is
inferred the same way and never gets a marker of its own.

A bullet renders only where its mark is visible on that frame:

- `Highlighted` and `(guess)` follow injected-reference metadata, so native-only
  System Prompt and part previews, sibling parts without references, and
  owning-tool previews show neither. Restored lines appear in the System Prompt
  preview of both views, including the direct single-entry Usage preview, in the
  standalone `Available Tools` and `Guidelines` children in Injections, and in
  multi-entry Usage streams and their full content levels.
- `Dropped` and `Moved` follow the part states a frame renders: preview
  subheaders and item metadata in any category, and Injections hierarchy rows.
  They follow the captured state, not each row's fit, so a row too narrow for
  its own marker keeps the bullet that explains it.

The Usage category stream inspects all entries; full content, opened directly or
from a block, inspects only its open entry.

Wrap bullets onto hanging-indented continuation lines without truncation and
keep them pinned while scrolling, even when the marked content is offscreen or
hidden by a block cap. The block collapses whole, including its preceding blank
row, below the floor in [Descriptions](../UI.md#descriptions), allowing for the
overflow counter, and returns on height-only resize. It never contributes to
scroll counters or `… +N lines` counts, though its reserved rows affect the
viewport and block cap. For a Usage stream, decide collapse from the uncapped
content plus entry headers and separators, before deriving the legend-dependent
block cap — otherwise the layout decision is circular.

## Repeated headings

A preview body never repeats the heading directly above it: drop a first content
line identical to the item title, part label, or entry name, as a skill block
that opens with its own name has. Matching ignores case and a trailing colon, so
pi's own block headers (`Available tools:`, `Guidelines:`) disappear under the
parts named after them; a line carrying more than its heading, such as pi's
`Pi documentation (…):` sentence, stays visible. This preview-only omission
still counts the dropped line toward the estimate shown in that heading.

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
