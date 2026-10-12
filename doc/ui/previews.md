# Preview rules

Rules shared by every preview in both views. Frame, color, description, and
interaction rules live in the [UI specification](../UI.md).

## Labeled parts

Content that decomposes into labeled parts — a tool's `Definition` and the
prompt lines a replacement dropped, the System Prompt's blocks — renders every
part under its own bold `syntaxKeyword` subheader followed by a muted
` · N tokens` share, with exactly two blank rows between parts. Replace any
trailing blank rows of the preceding part with this separator; preserve blank
rows inside its body and leave captured text and token estimates unchanged.
Part shares reconcile exactly with the item or entry estimate and never add to
it. In Injections, a deleted part keeps its removed text at 0 tokens; a
modified message counts only its request version. The `messages (N)` and `payload changes (N)` rows each use labeled
parts, without child rows, for every message or finding.
Show the applicable subheader even when `Definition` is the only captured
part; omit parts with no captured text rather than rendering zero-token
placeholders. Message and payload-finding parts stay even when empty: their
count and changes still matter. In addition to those request-only change
references, one kind of part carries no counted text by design and still renders
at 0 tokens: any part
a `--system-prompt` replacement dropped, which keeps its subheader with
the [`Dropped` marker](../UI.md#color-and-casing) after its estimate — even with
an empty body, since the point is to show what the replacement gave up.

In Injections, a part that stands for a child row — a System Prompt part, an
instruction file, a skill, a built-in tool — or stands for a message also
carries its [`+N`/`-N` diff](injections.md#token-diffs) after its share, behind a
dim ` · `, and its [`Request-Only` marker](injections.md#request-only-changes)
among its markers: `Current Dir · 31 tokens · +14 · Request-Only`.
Message labels are the `customType` or role, followed by muted
` · user prompt #N` before the share when the message follows a user prompt:
`user · user prompt #2 · 7 tokens · +6 · Request-Only`.

Message bodies use the [diff body](#diff-bodies): unchanged messages show only
context lines, additions and deletions show whole added or removed lines, and a
modified message shows a word-level diff of its session and request versions
in its one part.

Each payload finding's part carries its estimate and diff against the captured
request, with no `Request-Only`. Its body shows the retained changed lines
instead of only the counted added text, including removed lines of a deletion,
as a [diff body](#diff-bodies) without context lines.
A tool declaration subheader adds a dim `tool:` before its bold tool name, so
it reads apart from a `tool call`. These parts retain the guard's order, never
sorting by token size. Changed words compare all of a finding's removed lines
with all of its added lines, the same comparison as its token diff.

### Diff bodies

Injections message and payload-finding parts render diff bodies in the style of
pi's `renderDiff()`. A line only in the request or payload opens with `+ ` in
`toolDiffAdded`, a line only in the base opens with `- ` in `toolDiffRemoved`,
and an unchanged line keeps the two-column gap in `toolDiffContext`, so text
stays aligned. The whole line takes its color; wrapped continuation lines hang
under its text.

Where removed and added lines replace each other, changed words are inverse,
excluding their leading whitespace. The comparison runs across all lines of a
changed block, not just one line pair, and uses the word alignment of the
[token diff](injections.md#token-diffs). Whole-line additions and deletions
have no inverse words. A comparison too large to align marks its whole middle
as changed, keeping the common start and end. Marked JSON expands on both sides before the
comparison. Text is sanitized before styling; the diff changes no estimate.

Diff-only Injections [`system prompt` rows](injections.md#system-prompt-rows)
and their parts have no token estimate. Part subheaders show only their diffs,
such as `Available Tools · +20`. A part attributed by guess adds dim
` (guess)` after its diff and triggers the same guess legend as a guessed
source annotation. These parts repeat text and changes counted elsewhere;
their 0-token model fields are not displayed as token shares.

A moved block out of pi's normal order keeps its ordinary token share and
adds the [`Moved` marker](../UI.md#color-and-casing) after it. This applies in
both views, including the direct System Prompt Usage preview and standalone
Injections part metadata. Its extension lines still render with their known
owning-tool annotations; movement alone never guesses a rewriting extension's
identity, and its [legend bullet](#marker-legend) explains position only.

Why `syntaxKeyword`: parts nest under item and entry headings that already carry
`mdHeading`.

## Extension lines

The System Prompt `Available Tools`, `Guidelines`, and `Extension Additions`
previews mark the text extensions contributed to those blocks, in prompt order
alongside pi's own. A dropped block holds only the extension lines pi would
have rendered into it and shows no pi-authored content at all, so it renders
empty when no extension contributed to it; the tools themselves keep the same
lines as their own dropped sections, unannotated like any other owning-tool
preview. Each extension line uses `syntaxNumber` followed by a
`borderMuted` ` <- ` and the owning extension's source label in `mdLink` — fixed
semantic theme colors, independent of category color overrides. A tool
contributes at most one `Available Tools` snippet, and a shared guideline bullet
names only the first owning tool's source, never every tool declaring it.
Built-in tool lines are pi's own and carry no annotation.

When the line belongs to one tool or slash command of that extension, the label
gains a `mdLinkUrl` `:<tool>` — colon included, e.g.
`<- npm:pi-web:web_search` or `<- npm:@eko24ive/pi-ask:/ask`. Tool lines
always carry it; an `Extension Additions` block carries it only when its text
names exactly one of that extension's registered names. An extension label
without a qualifier means no single owner was identified, never that the
extension registered none.

A source pi did not report, but this extension inferred from the injected text,
carries a `dim` ` (guess)` after its label, once for the whole
`extension:tool` label. `Extension Additions` is the only block with such owners
today: tool lines name a source pi reported. A part that opens with an
extension line drops its captured leading blank lines, as plain part text does.

Non-breaking spaces on both sides of the arrow join the preceding content word,
arrow, and source label into one wrapping unit. Move that whole unit to the next
line when it fits the content width but not the remaining space. If the unit is
wider than the content width, hard-wrap it to fit; this may split the label or
leave the arrow at the end of a line.

The annotations are preview-only and add no tokens: the part and System Prompt
estimates count these lines like the rest of their text, except in a dropped
part, and the tool preview counts only its `Definition`. Sanitize line text and
source labels before applying colors, preserve styling through wrapping, and
include annotations in preview scrolling and cap line counts. Never show raw
lines in the overview list or dashboard.

## Marker legend

Every preview explains the marks it shows, as one dash bullet per mark. It
places its bullets at the bottom, outside the scrollable content and
block-selection gutter, between blank rows immediately above the hints. The
Injections list uses its [selected-row status bar](injections.md#selected-row-status-bar)
instead of legend bullets. Preview bullets always render in this order, each
opening with the keyword in the fixed color that mark
uses, followed by dim text:

> - **Highlighted** parts are injected by extensions into pi’s system prompt.
> - **(guess)** sources are inferred from the injected text itself.
> - **Dropped** parts were replaced by a custom system prompt and are counted
>   nowhere.
> - **Moved** blocks appear in a different position in the system prompt than
>   usual.
> - **Forced** prompts replace pi’s system prompt for this request.
> - **+N -N** Tokens extensions added or removed, compared with pi’s default
>   prompt.
> - **Request-Only** Includes changes made only in this request, not saved in
>   the session.

Each sentence is fixed. The `Dropped` bullet explains that replaced parts count
nowhere, including highlighted extension lines wherever a preview shows both.
Only the `+N -N` sentence names the
[base](injections.md#token-diffs) of the preview's diffs: pi's default prompt,
as above, for pi's items; `compared with the session.` for extension tools and
messages; and `Tokens added or removed, compared with the captured request.`
for payload changes.
The `(guess)` bullet covers a guessed `:<tool>` qualifier as well, which is
inferred the same way and never gets a marker of its own.

A bullet renders only where its mark is visible on that frame:

- `Highlighted` and `(guess)` follow injected-reference metadata, so native-only
  System Prompt and part previews, sibling parts without references, and
  owning-tool previews show neither. A diff-only `system prompt` part's
  guessed attribution also triggers `(guess)`, without `Highlighted` when
  its own lines have no source annotations. Extension lines appear in the System Prompt
  preview of both views, including the direct single-entry Usage preview, in the
  standalone `Available Tools` and `Guidelines` children in Injections, and in
  multi-entry Usage streams and their full content levels.
- `Dropped`, `Moved`, `Forced`, `+N -N`, and `Request-Only` follow the part
  states a frame renders: preview subheaders and item metadata in any
  category. Only Injections renders the last two; Usage renders `Forced`
  only in [System Prompt previews](usage.md#forced-prompt). In the Injections
  list they follow the selected row's captured state, not its fit, so a row
  too narrow for a marker keeps its status-bar explanation.

The Usage category stream inspects all entries; full content, opened directly or
from a block, inspects only its open entry.

An Injections preview of a payload change adds the dim note bullet
that [explains it](injections.md#injection-preview) after its legend bullets.
The note belongs to the same block and follows the same collapse rules.

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

## Captured message content

Captured branch and compaction summaries show only the summary text, without
message-envelope bookkeeping. Captured bash executions show pi's provider-facing
text, including failure, cancellation, and truncation notices; a full-output
path appears only when pi includes it in a truncation notice. These previews are
plain text, not marked JSON, even when a summary itself looks like JSON.
Injections message rows use this captured form; Usage previews request messages
like session messages of the same role.

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
