# UI specification

This is the canonical UI reference for pi-context-view v0.4.3. Both `/context`
views are focused fullscreen TUI overlays. Usage and Injections are separate
views; there is no tab state.

## Shared layout and styling

Follow pi's native selector style (`/settings`, `/model`):

- horizontal top and bottom borders with one blank row inside each;
- one blank row after the dialog header;
- accent title and responsive summary alignment as specified by each view;
- fixed-column `→` cursor flush at column 0;
- dim description wrapped onto indented continuation lines, never ellipsized,
  between blank rows above the hints;
- dim key plus muted description hints joined by ` · `;
- dim `(current/total)` shown only when content overflows.

Headers, subheaders, and the cursor start at column 0. Indent descriptions,
scroll counters, hint rows, and preview bodies by two spaces. Use `dim` for dialog
descriptions and bright `text` for primary rows, `muted` for subordinate rows and
values, and `dim` for deeper
breakdowns. Selected labels and values use `accent` with no background.
Subheaders are bold and use `mdHeading`.

Always use current-theme semantic colors through `theme.fg(...)` and themed
border colorizers. Never hardcode ANSI escapes, hex values, or named terminal
colors. Use pi's injected keybindings, `matchesKey`, ANSI-aware width helpers,
render caching, and theme invalidation.

Titles, section names, and hint labels use Title Case (`Context Injections`,
`Esc Close`). Key names use conventional casing (`PgUp/PgDn`). Preserve literal
identifiers such as `pi`, `edit`, and `web_search`; descriptions use sentence
case.

## Interaction

The Injections view has list and raw-preview states. The Usage view has a
category legend, a category block stream, and a full-content view for one block:

- Up/Down, and the vim-style `k`/`j`, navigate selectable rows or blocks and
  scroll full-content previews. Hints render the pair as one `↑↓/jk` key label.
- PgUp/PgDn page through lists or previews. From the first or last page of a
  Usage block stream, another page key selects the first or last block.
- Home/End jump to boundaries.
- Enter opens the selected row's preview; in a Usage block stream it opens full
  content only when the selected block is capped.
- Escape returns one level while preserving selection, then closes the view.

Views may add their own keys; the Usage view adds `z` for the map scale.

Pi 0.84.2 delivers PgUp, PgDn, Home, and End to a focused overlay in both TUI
modes, so every key above works identically in regular and fullscreen mode.
Older releases consume them for the transcript viewport in fullscreen mode.

The mouse wheel scrolls wherever the keys navigate: one notch moves the
selection one row or one block, and scrolls a full-content preview by the step
pi's own viewport uses, defaulting to one line when that step is unreadable.
Only fullscreen mode enables mouse reporting, so in regular mode the wheel keeps
scrolling the terminal's scrollback and no view ever sees it. Hint rows stay
keyboard-only, since they must not advertise an affordance one mode lacks.

Navigation skips non-selectable rows and remains bounded after terminal resize.
All content is terminal-sanitized before rendering. Raw content appears only
after explicit Enter selection.

## Usage view

`/context` and `/context usage` open **Context Usage**.

The overview contains a proportional 14×14 map and an interactive category
legend. Cells use themed `■` for full occupancy, `◧` for partial occupancy, `▦`
for compacted data, dim `⛝` for the auto-compact buffer, and dim `⛶` for free
space. Allocate occupied cells from estimated category totals against the
current map scale, which is the context window unless Fit is active (see
[Map scale](#map-scale)); display pi-reported usage separately because the
values may differ. A dedicated key appears beside the map, below the `Category:`
legend and its scroll counter, separated from them by one empty detail row:

```text
Map:
  ■ - Single category block
  ◧ - Shared block, largest category shown
  ⛶ - Block Size: 5.1k (0.5%)
```

The legend is the more important section, so it comes first and the key is what
shrinks as the terminal gets shorter.

Compacted, buffer, and free glyphs need no key because their category rows
identify them. Block Size is the mapped range divided by the cell count, so it
states the map's resolution: what the smallest visible cell is worth. Its
percentage is the cell's share of the mapped range, not of the context window,
and is derived from the live map geometry rather than assumed from a fixed
14×14 grid. Only the token value follows the active scale; it renders in
`muted` at Window and, while Fit is active, in the same `mdHeading` treatment as
the header's zoom label, so zooming visibly shrinks and highlights it.

The key claims only rows the complete legend leaves over, counted as the detail
column minus the `Category:` heading and every legend row. With five spare rows
it renders in full. With two to four, degrade to the single-line
`Map: ■ One category · ◧ Mixed · ⛶ 5.1k (0.5%)` key. Before the line would
truncate, drop the percentage and then shorten `One category` to `One`. Below
two spare rows, drop the key entirely. So a shrinking terminal collapses the key
in that order before the legend hides a single category row or starts scrolling,
and the `Category:` heading with at least one legend row always survives.

When auto-compaction is enabled, the tail of the map shows the settings
`reserveTokens` reserve as `⛝` cells after the free cells: tokens that content
will never occupy because compaction triggers first. The buffer shrinks once
estimated content grows into the reserve and disappears when auto-compaction is
disabled or settings are unreadable. Read the reserve from pi's merged
global/project settings at view-open time, honoring project trust. At Fit scale
the reserve lies past the mapped range, so no `⛝` cells render while the
`⛝ Auto-Compact Buffer` legend row remains.

At map widths, render the header as:

```text
Context Usage                         model · used/window (percent)
```

Omit the model completely if the full metadata does not fit; never abbreviate
it. Keep the usage summary right-aligned. Below 52 columns, hide the model and
render the header, summary, and category heading flush at column 0, with one
blank row before and after the summary:

```text
Context Usage

used/window (percent)

Category:
```

At map widths, while Fit scale is active, append the zoom label to the title
with the shared ` · ` separator:

```text
Context Usage · Zoom 1M → 120k        model · used/window (percent)
```

The label reads `Zoom window → scale` using the same token formatting as the
usage summary. Drop the model before the label. If the title and label still do
not fit on one line, put them on separate lines with one empty row before and
after the label, as the Injections header does. The label is absent at Window
scale and at the narrow widths that hide the map.

Do not append the redundant word `tokens` to Usage header or category-preview
summaries. Preserve `≈` when the usage total is estimated.

### Map scale

The map has two scales, toggled by `z`:

- `Window` maps the full context window, matching pi-reported fullness;
- `Fit` maps a smaller range so that low occupancy stays legible.

Scale changes the map's denominator only. The map is always anchored at token 0
and never pans, so no content can fall outside it, and cell classification,
segment order, and the `■`/`◧` thresholds are unchanged.

Fit scale is the estimated occupied total plus 15% headroom, rounded up to a
two-significant-digit boundary, floored at 10k tokens and capped at the context
window. The headroom keeps a visible band of `⛶` free cells, so the map still
reads as occupancy rather than as a pure composition chart.

At 1M windows the difference is the point of the feature: Window scale gives
196 cells of about 5.1k tokens each, so categories under roughly 2.5k tokens
claim no cell at all and vanish from a map whose legend still lists them. The
key's Block Size row states that number at the active scale.

Render `Z Zoom` in the hint row directly before `Esc Close`. Hide the hint, the
header label, and the binding together whenever the toggle cannot help:

- below 52 columns, where the map itself is hidden;
- when the map is unavailable for lack of a context-window denominator;
- when the Fit scale would reach the context window, leaving nothing to zoom.

The view opens at Window, preserving the behavior of releases without a scale
toggle, and holds the chosen scale only until it closes. There is no
persistence yet; see [PLAN.md](PLAN.md).

The legend uses a distinct semantic theme color for each top-level category,
except the intentionally shared System Prompt/System Tools color. Category
names have no trailing colons. Fill the gap before values with `dim` dot
leaders; shorten or remove leaders before truncating labels or values. Token
and percentage values align in separate columns, and both always denominate
against the true context window regardless of map scale. Categories include:

- System Prompt, System Tools, Custom Tools, and MCP Tools;
- Memory (`AGENTS.md`) and Skills;
- User Messages, Agent Text Messages, Agent Thinking Messages, and Agent Tool
  Call Messages;
- Tool Output and Extensions;
- Compacted Data and Free Space.

Prefix each Tool Output breakdown row with a full-size `•` bullet rather than
the smaller middle dot `·`. Keep aggregate breakdowns collapsed except
Tool Output, whose per-tool results and bash executions appear directly and
scroll independently. Map allocation always uses top-level totals. The trailing `⛝ Auto-Compact
Buffer` (when enabled) and `⛶ Free Space` rows directly follow the last
category. Free Space excludes the buffer so all rows still sum to the context
window. Neither row has anything to preview: they trail the legend and scroll
with it but are skipped by cursor navigation.

When the legend overflows its viewport, show the dim `(current/total)` counter
on the row directly below the last visible legend row, indented two spaces, and
never beside the `Category:` heading. It counts every legend row, including the
trailing buffer and free-space rows, and its left number is the last visible
row, so scrolling to the end reaches the total.

At widths of 72 columns and above, map cells have spacing. From 52–71 columns,
remove inter-cell spacing. Below 52 columns, hide the map, its fill key, and the
zoom hint and label while keeping the selectable category list. Height-only
resizing must also reflow and clamp the viewport.

### Usage preview

Render the selected category as chronological entries. Each entry has a header
like:

```text
[DD-MM-YYYY HH:MM:SS] [breadcrumb…] tokens
```

Use dim for datetime and tokens, `mdHeading` for the first breadcrumb cell, and
muted styling for the rest. Snapshot-backed categories omit datetime and retain
category order. Assistant messages split into constituent text, thinking, and
tool-call entries; tool calls include the tool name. Add a `text i/n` cell only
for multi-block text or thinking content.

For Agent Thinking Messages, estimate each assistant message as the greater of
the visible-thinking chars/4 estimate and provider-reported `usage.reasoning`
when available. If the message carries an opaque `thinkingSignature` or
`thoughtSignature`, append `+ Encoded ≈N (≈T)` to one entry header for a
positive provider-reported invisible share, or `+ Encoded ~N (~T)` for a
signature-chars/4 proxy when no reasoning breakdown is available; `T` is
the visible-plus-invisible message total. The proxy is not an upper bound and
must never be rendered as one. Without a captured signature, show a
positive provider-reported invisible share as `+ Reasoning ≈N (≈T)`; omit
zero-size shares. Keep one wrapped dim explanation after the scrollable entries
and before the hints; it opens with the schematic header pattern
`[DD-MM-YYYY] [assistant] visible + Reasoning ≈invisible (≈total)`, then defines
`≈`, `~`, and `Encoded`. Never render, preview, or log raw signature bytes.

Treat each entry as one navigable block. Reserve a two-column gutter before its
header and content. Mark every line of the selected block, including blank
content lines, with an accent `┃`; leave the blank separator row between blocks
unmarked. Unselected blocks retain the same two-column spacing with no gutter.
When the stream overflows, show the selected block ordinal as a dim `(i/n)`
counter.

Up/Down and `k`/`j` move block by block. Keep the selected block fully visible
with minimal scrolling when it fits. If it is taller than the viewport, expose
its approached edge and scroll line by line within it before moving to the next
block. PgUp/PgDn move by the viewport height and select the first fully visible
block, falling back to the first intersecting block. Once paging reaches the
first or last viewport, the next PgUp/PgDn selects the corresponding boundary
block so paging alone can reach `(1/n)` and `(n/n)`. Home/End select the first or
last block.

Indent content by two spaces after the gutter and separate blocks with one blank
row. In User Messages only, replace complete attached
`<skill name="…">…</skill>` expansions with pi-colored `[skill] name` badges;
leave malformed wrappers visible. This is a preview-only transformation, and
the full content still contributes to token estimates.

Cap each block so two whole blocks stay visible: derive the cap from terminal
height alone — never from the viewport, whose counter row depends on the capped
stream — and clamp it between 4 and 10 wrapped content lines. When content is
hidden, left-align a dim `… +N lines` marker with the block content. For the
selected block only, append dim ` · ` and accent `Enter - View Block`. Do not
repeat that action in the footer hint row. Fully visible blocks show no Enter action, and Enter is a
no-op for them.

Enter on a capped block opens a separate fullscreen level containing the
category header, one blank separator row, the selected entry header, and its
complete uncapped content. That level uses line and page scrolling with
`↑↓/jk Scroll · PgUp/PgDn Page · Esc Back`, and Escape returns to the same block
and viewport. A category without entries instead shows
`No content captured for this category.` without a gutter; Enter is a no-op and
the hint row offers `Esc Back` alone.
Unknown usage after compaction retains an explicit preview state.

## Injections view

`/context injections` opens **Context Injections**. Its header is:

```text
Context Injections · [INITIAL]
```

`INITIAL` uses the active `mdHeading` treatment. Runtime inspection is
roadmap-only, so no Runtime label, switching key, or Runtime status is rendered
until that step lands. If the combined header does not fit, put the title and
label on separate lines with one empty row before and after the label.

Present Initial contributions in this order:

- `pi`
  - Base or Custom Prompt
  - Built-in Tools (N), with one child per active built-in tool
  - Skills (K), with one content-only child per skill
  - context files, abbreviating home paths with `~`
  - appended prompt content
- each extension/tool source
  - one child per active tool
  - injected messages identified by `customType` where available
- `extensions (aggregate)` for unattributable chained prompt additions

Within the `pi` group, keep the fixed semantic order above and sort remaining
prompt additions by size. Children break down parent contributions and do not
increase totals. Measurements and previews exclude transport wrappers,
section-introduction scaffolding, and the dynamic date/working-directory
footer.

Use dim `├─`, `└─`, and `│` connectors to show source, item, and constituent
hierarchy. Align every token estimate to one shared column capped near the tree
on wide terminals, leaving unused space to the right. Fill label/value gaps with
dim dot leaders. As width shrinks, shorten or remove leaders before truncating
labels or token values, and retain tree connectors where space permits.

Place one empty row before `TOTAL`. It is the last row in the scrollable Initial
list, counts only the frozen Initial snapshot, and is not selectable. Cursor
navigation, the selectable-row counter, and Enter preview skip it.

When capture is degraded, wrap the precise reason below the header and show a
`[Degraded: …]` indicator beside the description. Keep the fallback hierarchy
usable.

### Injection preview

Enter on an injection item opens its sanitized raw text. Show the item title,
source, and estimated tokens in the header; wrap content to available width and
support arrow and page scrolling. Escape returns to the same selected row. Raw
text must never appear in descriptions, notifications, reports, or logs.

## Responsive rendering

Every rendered line must fit the supplied width. Fullscreen output must respect
both terminal width and height, including borders, wrapped degraded warnings,
descriptions, hints, counters, and blank rows. Cache keys must include all
layout-affecting dimensions and theme state. State changed from within a view,
such as the Usage map scale, must invalidate cached output instead.

Test at 60, 80, and 120 columns, narrow fallbacks, short heights, height-only
resizing, overflow navigation, preview return position, and theme invalidation.
Cover both map scales, the header label's line-splitting fallback, the
conditions that hide the zoom binding, and every map-key degradation.

## Release media

Keep sanitized captures under `doc/images/` in Git LFS:

- gallery thumbnail: 1224×574;
- Usage capture: 3041×1227;
- Injections capture: 3054×1232.

Capture from a no-session TUI. Remove project paths, credentials, and private
prompt or message content. Verify all README images and the absolute `pi.image`
URL before release.
