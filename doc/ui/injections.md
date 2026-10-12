# Context Injections view

`/context injections` opens **Context Injections**. Frame, color, description,
and interaction rules live in the [UI specification](../UI.md); rules shared
with Usage previews live in [previews.md](previews.md).

Its header is:

```text
Context Injections · [Latest Request]
```

`[Latest Request]` and a silent probe's `[Request Probe]` label use bold
`mdHeading`. Runtime inspection is roadmap-only, so no Runtime label, switching
key, or Runtime status renders until that step lands.

Compact payload status uses a `muted` `Payload` label with a `dim` colon and
value, without bold or warning highlighting. It is right-aligned on the header
when the complete title, origin label, and status fit with at least one
separating space:

| Comparison | Status |
| --- | --- |
| Pending | `Payload: pending` |
| Incomplete, nothing compared | `Payload: not checked` |
| Incomplete, one channel compared, even with no findings | `Payload: partly checked` |
| Complete, with or without findings | None |
| Absent, such as a degraded fallback without a request | None |

The compact status and origin label never collapse with the description. If
status cannot fit beside the complete header, move it below the header and wrap
it with a two-space indent, without ellipsizing or dropping it. If title and
origin cannot fit together (below 37 columns for Latest Request, 36 for Request
Probe), put them on separate lines with one empty row before the label and one
after the whole header block. Wrap the origin label too if necessary. At 90
columns, a standard probe reads:

```text
Context Injections · [Request Probe]                                  Payload: not checked
```

Hidden-tool counts and names stay in the description, never the header. The
precise degraded-capture reason stays wrapped below the header. On exceptionally
short terminals the [compact frame](#selected-row-status-bar) omits the title and
spare spacing, not capture status or the degraded reason, whenever physically
possible.

The list description reads:

```text
Injections into the model context, with token estimates.
```

## Latest request

The view shows the latest request snapshot of the extension runtime, the same
one Usage applies. A silent-probe snapshot is shown only until the first real
request's snapshot is published. Its composition is the session projection at
the snapshot's leaf, rebuilt when the view opens, with the snapshot's
request-only changes applied: the prompt and tools replayed from the recorded
system messages, the forced prompt in place of the replayed prompt when the
request had one, and the custom messages of the projection. Ordinary session
messages are not listed unless a request-only change touches them.

The view describes the request as it was sent, so a tool follow-up or a
one-time injection can change it between two prompts. Usage instead estimates
the current branch; [views.md](../architecture/views.md#one-snapshot-two-views)
lists the differences.

When the snapshot came from a silent probe, the description block carries a
wrapped bullet with only `request probe` in `warning` color; the rest is dim:

```text
- Captured by a request probe with an empty prompt. Prompt-dependent injections may be missing.
```

The bullet collapses with the rest of the description block, while the header's
`Request Probe` label stays. The payload guard compares tool declarations and
message text with the provider payload. While that comparison is pending or
incomplete, its compact header status stays visible and the description block
keeps one detailed dim guard-status bullet with the reason:

| Guard                        | Bullet                                                            |
| ---------------------------- | ----------------------------------------------------------------- |
| Pending                      | `Payload changes are not checked yet: the comparison is pending.` |
| Incomplete, nothing compared | `Payload changes were not checked: <reason>`                      |
| Incomplete, one channel only | `Payload changes were checked only in part: <reason>`             |

A standard probe says `Payload changes were not checked: No provider payload was
observed for this request.` None of these means "no changes". A partial check
still shows the [payload changes](#payload-changes) of the channel it compared.
[Hidden tools](#hidden-tools) come from Pi's prompt options, independently of
the guard, so a probe counts them too. A complete guard adds no bullet:
without payload changes, the payload matched the request, excluding Pi's known
hidden declarations, up to this extension's own `before_provider_request`
handler. Handlers after it stay invisible.

## Contribution tree

Present the request's contributions in this order:

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
    an ordinary part instead. System Prompt counts all its text: extension
    tool lines in `Available Tools` and `Guidelines`, and the unwrapped text
    extensions added around pi's sections in `Extension Additions`. Moved
    `Available Tools` and `Guidelines` sections remain System Prompt
    children, at their actual prompt position
    with a [`Moved` marker](../UI.md#color-and-casing). For example, sections
    relocated past `cwd` follow `Current Dir`, not `Preamble`.
    `Extension Additions` still consolidates all unwrapped additions at the end.
    A forced prompt without XML sections has no children: System Prompt is one
    undivided part holding the whole forced text, with no `Dropped`, `Moved`,
    or `Extension Additions` parts.
    Any forced prompt carries the
    [`Forced` marker](#request-only-changes) on System Prompt.
  - `Instruction Files (M)`, with one child per context file, abbreviating home
    paths with `~`. When a path exceeds its list-label space, replace middle
    directories with `…`, keeping the root and as many whole trailing
    directories as fit (`~/…/injection-redesign/AGENTS.md`). At narrow widths,
    drop directories before shortening the filename; truncate the filename
    only if it cannot fit by itself. This is list-only formatting: captured
    paths and preview labels stay unchanged.
  - Skills (K), with one content-only child per skill
  - Built-in Tools (N), with one child per active built-in tool
- each identified extension, largest total first, labelled by its package
  (`npm:pi-web`). An extension loaded from a path (`-e`, settings, or
  auto-discovery) is its own source, labelled like Pi's startup list: the
  shortest path tail no other such extension shares, without `/index.ts`
  (`hidden-tools.ts`, `my-ext`)
  - one child per active tool, counting only its definition: its prompt lines
    count in System Prompt. A dim `tool:` prefix (`tool:web_search`) stays dim
    on selection and participates in label width and value-column alignment.
    Tools under `Built-in Tools (N)` keep plain names.
  - [`system prompt`](#system-prompt-rows) when that source contributed prompt
    lines, showing only their `+N`/`-N`, with no value or children
- one trailing `unattributed` group for content from an unknown extension:
  - tools whose extension is no longer registered, with the same dim `tool:`
    prefix, never another group labelled `unattributed`
  - one [`system prompt`](#system-prompt-rows) row for prompt changes with an
    unknown source, saved or request-only
  - one `messages (N)` row for all custom messages and request-only message
    changes, with no child rows
  - one [`payload changes (N)`](#payload-changes) row for findings from the
    provider payload, with no child rows

A custom message's `customType` labels only its preview part, never a source
group. It does not identify an extension, even when cooperative provenance is
present. Pi adds no custom messages to the context: `pi.share` is a session and
export entry only, not a context message. Empty sources have no group.

### System prompt rows

The extension and `unattributed` `system prompt` rows repeat prompt changes
already counted under `pi`: they show only `+N`/`-N`, never a token value. Dim
dot leaders run through the empty value column. Their changes count toward
neither their group diff nor `TOTAL (Prompt, Tools, Injections)`; a source
with only this row therefore reads 0 tokens with no group diff. No row appears
without a nonzero diff. Within each source, it follows tools and precedes
messages.

An extension's row holds its tools' exactly matched prompt lines and additions
attributed to it by a guess. It shows only `+N` in practice: Pi reports no
editor for prompt modifications or deletions. The `unattributed` row holds all
remaining changes, including custom sections, unowned additions, edits and
deletions, and changes to Instruction Files and Skills. Together these rows
sum to the prompt diffs under `pi`, excluding tool definitions. The split and
rounding contract lives in
[measurement.md](../architecture/measurement.md#system-prompt-rows).

The extension row carries `Request-Only` when its attributed lines differ
from those in the session, not merely when pi's containing part is
request-only. The `unattributed` row carries it when any of its contributing
changes is request-only. Source ownership never identifies an unknown editor.

### Request-only changes

Changes from all `context` handlers and earlier `context_with_system` handlers
mark the affected prompt parts and tools in place; message changes share one
row. Each changed row shows its [token diff](#token-diffs) after the tokens the
request sent: an added contribution reads `10 +10`, a deleted part `0 -466`,
and a modified one can show both columns. Two change markers follow the diff
columns:

| Marker         | Color     | Row                                                                                  |
| -------------- | --------- | ------------------------------------------------------------------------------------ |
| `Forced`       | `warning` | System Prompt, when the request carried an extension's forced prompt instead of pi's |
| `Request-Only` | `dim`     | Any row whose sent content differs from the session                                  |

`Request-Only` shows what `+N` and `-N` cannot: whether a change is saved in
the session or exists only in this request. It marks request-only additions,
edits, and deletions, alone or mixed with saved changes, so a request-only
edit that folds into a saved `+N` still shows. Saved extension text, such as
an extension tool's lines in `Available Tools`, keeps its `+N` without the
marker. One rule covers every row, so it also marks extension tool rows and
`messages (N)` when any message changed, though their numbers already imply
it. It never marks:

- **Parent rows and groups**, such as System Prompt, `Instruction Files (M)`,
  and `Built-in Tools (N)`; `Forced` likewise never marks parts.
- **Payload changes**: they are not in the captured request, and their row
  name says so.

Pi never saves a forced prompt, so every System Prompt part, instruction file,
or skill whose forced text differs from the session's version carries
`Request-Only`, such as text appended in `Extension Additions`. System Prompt
itself carries only `Forced`.

- **Messages.** All custom messages and request-only conversation changes
  form one `messages (N)` row under `unattributed`. `N` counts the messages the
  request sent, excluding deletions.
  Its value sums the sent messages' estimates; its diff sums their changes
  against the session. A modified or deleted session custom message replaces
  its unchanged part, never counting it twice. Parts follow session order,
  with modifications and deletions in place; additions have no captured
  position and follow in capture order. Unchanged ordinary history is absent.
- **System Prompt.** A changed section changes its part, at its position in the
  request prompt. The recorded layout also identifies inline XML, unwrapped,
  and empty sections. Pi renders changed plain content before the first section, so
  it changes `Preamble`. A deleted section follows the parts the request sent, in
  session order, before `Extension Additions`. A forced prompt replaces every
  section, so section and content changes do not apply to it. `Forced` marks
  the System Prompt row and its preview header, never its parts.
- **Tools.** A changed declaration changes its tool. A deleted tool keeps a
  0-token row under its source; `Built-in Tools (N)` counts only the tools the
  request declared. A [hidden](#hidden-tools) tool has no row.

These source groups identify the affected content, not the extension that
edited it. Changes to a pi part or a custom message remain unattributed to an
editor.

Markers keep the order `Dropped`, `Moved`, then `Forced` or `Request-Only`,
after a row's diff columns or a preview's diff. The estimate counts the
request version. `TOTAL (Prompt, Tools, Injections)` covers these contributions only, not
unchanged ordinary conversation; it is neither the full context nor a
provider-payload size.

### Selected-row status bar

The selected row's status bar sits above the description, outside the scrollable
list and its counter. The fixed `TOTAL (Prompt, Tools, Injections)` row sits
between the list (and counter when visible) and the bar, with exactly one empty
row above and below the total in the normal frame. Do not pad a short list with
unused viewport rows; instead, fill the terminal height with empty rows between
the bar and the description, so the description, hints, and bottom border sit
at the bottom. The bar changes with selection and returns unchanged after
a preview. It shows only relevant change or state details, never
raw text, the row's source, or its location. Compact capture status stays in the header and
degraded warning, with detailed explanations in the view-wide description,
separate from selected-row details.

Each field occupies its own line: four-space indent, `muted` field names, `dim`
values, and six-space hanging continuation lines. `+N` uses `toolDiffAdded` and
`-N` uses `toolDiffRemoved`, including when narrow list rows omit their diff
columns. The extra indent and brighter field names distinguish the bar from the
description. Fields appear in this order:

| Field | When shown | Meaning |
| --- | --- | --- |
| `Change` | A diff, a request-only change, or a forced prompt | Actual `+N -N`, when nonzero, followed by where the changes live |
| `Changed By` | A changed leaf, except a diff-only row | Known extension editors, with `(guess)` when inferred, or `Unknown` |
| `Already counted in System Prompt` | A diff-only `system prompt` row | Why the row has no value; replaces `Changed By` |
| `Dropped` | A dropped part | `a custom system prompt replaced this part; counted nowhere` |
| `Moved` | A moved part | `in a different position in the system prompt than usual` |
| `Forced` | System Prompt carries `Forced` | `an extension’s prompt replaced pi’s system prompt for this request` |

Marker field names use their markers' fixed colors. `Change` replaces the list's
`+N -N` and `Request-Only` legend bullets; the state fields replace its `Dropped`,
`Moved`, and `Forced` bullets. Previews keep all their full legend explanations.

`Change` uses these phrases:

- `saved in the session` when the session keeps every change.
- `only in this request; the session keeps the original` for a request-only
  edit or deletion. An addition with no session original says
  `only in this request; not in the session` instead.
- `saved in the session, with an edit only in this request` for a leaf whose
  saved extension text also has a request-only edit folded into its diff.
- `only in this request` on `messages (N)`, or a parent, group, or diff-only
  row whose changes are all request-only;
  `, some saved in the session, some only in this request` after the diff when
  some are saved and some request-only.
- `only in the provider payload` for `payload changes (N)` and a group whose
  counted changes are payload-only. Mixed request and payload changes use
  `only in this request`, since the session keeps neither.

Parents and groups summarize only the rows they count, including removals of
session-only children. Their bars omit `Changed By`; the leaf `messages (N)`
and `payload changes (N)` rows show `Unknown`. Diff-only rows count in neither
their groups nor totals. An editor is never inferred from a source
group, tool name, customType, or section tag. Exactly matched tool lines and
guessed additions name editors only on saved prompt parts. Any request-only
edit has an unknown editor, even if the edited part keeps a known extension's
lines. Remaining saved additions and every removal also have unknown editors.

A row with no change and no state marker leaves one empty reserved line. A
changed row reserves only its own wrapped fields, reducing the list viewport
instead of collapsing. The bar never collapses with the description or because
of a resize. If the normal frame cannot fit even one list row, remove spare
blank rows and the title. Wrap the origin label and payload status together,
joined by a dim ` · `, and keep the degraded reason, selected row, fixed total,
and full bar whenever physically possible. Add hints only when they fit, after
empty rows that fill the remaining height. Below
that minimum, keep both borders and clip content. Height-only resizing restores the regular
frame.

### Token diffs

`+N` and `-N` are the tokens a row gained and lost against its base. Counted
rows round so that the base estimate plus `+N` minus `-N` equals the value
exactly; diff-only `system prompt` rows repeat these changes without a value:

| Rows                         | Base                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| Under `pi`                   | Pi's default prompt: the session's version of a pi part without its extension lines |
| Extension tools and messages | The session                                                                         |
| `system prompt` rows         | The prompt diffs already measured under `pi`, split by source                       |
| Payload changes              | The captured request: the finding's removed lines                                   |

- **Saved extension text.** Rows under `pi` show saved and request-only
  extension text alike: an extension tool's lines in `Available Tools` and
  `Guidelines`, a custom section, and `Extension Additions`. Pi's default has
  no custom section and no `Extension Additions`, so their whole value is
  `+N`. A saved extension tool or message matches the session and shows no
  diff.
- **Deleted extension section.** A custom section the session has and the
  request deleted has no default; it compares with the session instead and
  reads `0 -N`, so the deletion stays visible.
- **Forced prompt.** A forced prompt with sections compares part by part; one
  without sections compares System Prompt with pi's whole default prompt,
  instruction files and skills included.
- **Word-level diff.** Changed words, not changed lines, make up `+N` and `-N`.
  Changed characters round up to tokens, and any rounding difference goes to
  the side with changed characters. Equal texts have no diff. A diff never
  removes more than the base or adds more than the value has; text the
  estimates leave out, such as JSON around content blocks, would otherwise
  inflate it, so such a row reads as a whole replacement.
- **Parents and groups.** A parent or group row sums the diffs of the rows it
  counts, plus the removal of parts or children only the session has. Group
  diffs leave out diff-only `system prompt` rows.
  `TOTAL (Prompt, Tools, Injections)` shows no diff.
- **Known limits.** A request-only edit of an extension's own section folds
  into its `+N`. A saved edit inside pi's own section text is not detectable:
  the session is pi's default there.

### Payload changes

Payload changes are payload differences the structured capture cannot
explain: they come from `context_with_system` handlers after this extension,
or from `before_provider_request` handlers before it. They carry no structure
or source, so they cannot stay in place. One `payload changes (N)` row under
`unattributed`, after `messages (N)`, holds every finding without child rows.
`N` counts all findings, including deletions: it counts changes, not messages
sent. A guard with no findings adds no row.

Each finding has one preview part, in the guard's order:

- A changed message part: `system message`, `user message`,
  `assistant message`, `tool call`, or `tool result`.
- A tool declaration the payload added, removed, or describes differently:
  `tool:<name>`, with the prefix dim so it reads apart from a `tool call`.
  A removal Pi did not report in `hiddenTools` is a deleted payload change
  (`0 -N`), not a [hidden tool](#hidden-tools).

Each part's [token diff](#token-diffs) compares the lines the payload added
with the lines it removed from the captured request. The guard keeps only
changed lines, so a part's estimate counts the added lines and a deleted part
reads 0 tokens. The row sums these estimates and diffs; they count toward
`unattributed` and `TOTAL (Prompt, Tools, Injections)`. Neither the row nor its
parts carry `Request-Only`. While the row is shown, the description carries a
dim bullet:

```text
- Payload changes appear only in the provider payload. Their sources are unknown.
```

### Hidden tools

A tool in the snapshot's `hiddenTools` is hidden: Pi leaves its declaration
out while it stays active and callable through another tool, such as codemode.
The tree leaves a hidden tool out, whatever structured change it had: it has no
row, marker, or preview, and `TOTAL (Prompt, Tools, Injections)` does not count
it. A source left without rows has no group, and `Built-in Tools (N)` has no row
without children. Its prompt lines, if the prompt still has them, stay in pi's
prompt text.

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
independent of payload comparison and stays with the snapshot until the next
request replaces it, even after the active tools change. A degraded fallback
without a snapshot uses the live list instead.

Pi does not report which tool's `prepareLoadout()` hid each declaration. Do
not guess from `model-only` exposure or name a candidate. Capture's observation
limits are documented in
[capture.md](../architecture/capture.md#hidden-tools).

Within the `pi` group, keep the fixed semantic order above. Children break
down parent contributions and do not increase totals. Measurements and previews exclude XML transport wrappers and
section-introduction scaffolding; pi sends its `cwd` section with every
request, so it is measured as the `Current Dir` part.

Use dim `├─`, `└─`, and `│` connectors for source, item, and constituent
hierarchy. Right-align every token estimate in one shared, fixed-width value
column, sized from the largest formatted estimate in the whole tree, including
`TOTAL (Prompt, Tools, Injections)`, so its right edge stays stable while
scrolling. Cap the column's start near the tree (`MAX_TOKEN_VALUE_COLUMN`) on
wide terminals, leaving unused space to the right.
The `+N` and `-N` columns follow the value column, each after two spaces and
right-aligned in a fixed width sized from the widest `+N` or `-N` in the whole
tree, so they also stay stable while scrolling. A column no row fills is
absent. `+N` uses `toolDiffAdded` and `-N` `toolDiffRemoved`, also on the
selected row. A row leaves a column blank when that side is zero, and ends
without trailing blanks unless a marker follows. Markers follow the right edge
of the `-N` column. When the diff columns do not fit the width, every row drops
them whole, like a marker; markers then follow the value column.
Fill label/value gaps with dim dot leaders, running through the value column
on diff-only `system prompt` rows; as width shrinks, shorten or remove
leaders before truncating labels or token values, and retain tree connectors
where space permits.

Keep `TOTAL (Prompt, Tools, Injections)` outside the scrollable list, below its
counter when visible and above the selected-row status bar. Reserve its row and
one preceding empty row so the total stays visible from the first render through
navigation and resizing, even when the description collapses. It counts only the
shown snapshot's contributions and shares the tree's value column. Neither the
total nor its separator participates in the viewport, cursor navigation,
selectable-row counter, or Enter preview. At narrow widths, truncate the label
before the token value, like other list labels. The compact frame omits the
separator but keeps the total whenever physically possible. Raw previews do not
show the list total.

The list description survives scrolling, per the floor in
[Descriptions](../UI.md#descriptions); the `(current/total)` counter never
collapses it by itself. When capture is degraded, wrap the precise reason below
the header, even in a compact frame whenever physically possible, and show a
`Degraded: pi-native fallback used` indicator beside the description, with only
`Degraded` in `warning` color and the colon and explanation in `dim`, keeping
the fallback hierarchy usable. Below both come, when shown, the probe bullet,
the guard-status bullet, the [hidden-tools bullet](#hidden-tools), then the
payload-changes bullet. All detailed notes collapse with the rest of the
description block; compact origin and payload status stay near the header. No
new details key or view is added. The
[selected-row status bar](#selected-row-status-bar), above the description,
explains changes and markers instead of list-wide legend bullets.

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

A `system prompt` row previews one labeled part per affected prompt part, in
prompt order, with no token estimates. Its header reads
`source · +N -N · counted in System Prompt`, followed by `Request-Only` when
applicable. Parts read `Available Tools · +20`; a guessed owner adds dim
` (guess)` after its diff, such as `Extension Additions · +63 (guess)`, with
the usual guess legend bullet. An extension's part shows only its own lines,
without source annotations. At narrow widths, the header drops the marker
first, then the accounting note, then the diff. An unattributed part shows the
whole request part with its existing source annotations, or the session text
of a deleted part.
Instruction-file and skill changes follow System Prompt parts. Session-only
children omitted from the request appear as a reference part with their
removed text. These previews are plain text for now; word-level diff lines
come later. The diff legend names pi's default prompt, like the original pi
parts whose diffs these rows repeat.

The preview header of a counted item carries its token diff, then its markers,
after its estimate: `pi · 547 tokens · +200 -466 · Forced`. A narrow header drops the
markers first, then the diff. A [labeled part](previews.md#labeled-parts)
that stands for a child row carries the row's diff and markers the same way:
`Current Dir · 31 tokens · +14 · Request-Only`. Like the list, previews show
no `Added`, `Modified`, or `Deleted` markers: the diff and the estimate tell
those changes apart, and `Request-Only` tells that the session does not keep
them. The `+N -N` legend bullet names the base: pi's default prompt for pi's
items, the session for extension tools and messages, and the captured request
for payload changes.

The messages preview header reads
`messages (N) … unattributed · N tokens · +N -N`, followed by `Request-Only`
when any message changed. Its parts use the message's `customType` or literal
role (`user`, `assistant`, `toolResult`, and so on), then muted
`· user prompt #N · N tokens`, the message's diff, and `Request-Only` when
changed. Session-backed parts stay in conversation order, including deletions;
additions follow in capture order.

`user prompt #N` counts the user prompts on the whole captured branch up to and
including the message's session entry, not only the compacted projection, so
numbers stay the same after compaction or a saved context omission. Probe
prompts do not count. A request-only addition takes the number of the
request's prompt. A message before the first prompt shows no number.

Each part body is a [diff body](previews.md#diff-bodies) against the session:

- An **unchanged** custom message shows context lines only.
- An **added** message shows only added lines.
- A **modified** message shows a word-level diff of its session and request
  versions in its one part; its estimate counts the request version.
- A **deleted** message shows its session original as removed lines at 0
  tokens, with its removal diff and `Request-Only`; it is excluded from the
  row's `N`.

Both versions expand their marked JSON before the comparison.

A deleted System Prompt part or tool previews the session text it removed, at 0
tokens. A modified System Prompt part or tool shows only the request version.

The payload preview header reads
`payload changes (N) … unattributed · N tokens · +N -N`. Each finding renders
under a labeled part subheader with its estimate and diff, in the guard's
order, including deletions at 0 tokens. Tool declaration labels carry a dim
`tool:` prefix. Findings have no captured position, so they have no user-prompt
number. Each body is a [diff body](previews.md#diff-bodies) of the retained
lines in guard order: a line only in the payload opens with `+ `, a line only
in the captured request with `- `. Changed words between a finding's removed
and added lines are inverse; the guard keeps no unchanged context lines.

After the legend bullets of its markers, a payload-change preview repeats the
payload-changes bullet. Descriptions collapse under the rules in
[previews.md](previews.md#marker-legend).
