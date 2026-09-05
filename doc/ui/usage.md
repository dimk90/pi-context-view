# Context Usage view

`/context` and `/context usage` open **Context Usage**. Frame, color,
description, and interaction rules live in the [UI specification](../UI.md);
rules shared with Injections previews live in [previews.md](previews.md).

Three width tiers apply throughout:

- `SPACED_MAP_MIN_WIDTH` (72) columns and above: map cells have inter-cell
  spacing;
- `MAP_SIDE_BY_SIDE_MIN_WIDTH` (52) to 71 columns: the map renders without
  inter-cell spacing;
- below 52 columns (the narrow layout): the map, its key, and the zoom hint and
  label are hidden, and the selectable category list remains.

## Header and notices

At map widths, render the header as:

```text
Context Usage                         model · used/window (percent)
```

Omit the model completely if the full metadata does not fit; never abbreviate
it. Keep the usage summary right-aligned. In the narrow layout, hide the model
and render header, summary, and category heading flush at column 0, with one
blank row before and after the summary:

```text
Context Usage

used/window (percent)

Category:
```

While Fit scale is active, append the zoom label to the title with the shared
` · ` separator, dropping the model first:

```text
Context Usage · Zoom 1M → 120k        model · used/window (percent)
```

The label reads `Zoom window → scale` using the same token formatting as the
usage summary. If title and label still do not fit on one line, put them on
separate lines with one empty row before and after the label, as the Injections
header does. The label is absent at Window scale and in the narrow layout.

Do not append the redundant word `tokens` to Usage header or category-preview
summaries. Preserve `≈` when the usage total is estimated.

Non-fatal problems appear as `warning` notices between the header and the
dashboard, indented like other body content and wrapped to the width: the
degraded-capture reason first, then configuration problems such as ignored
entries. Sanitize every notice, since configuration text is untrusted. Cap the
block at `MAX_NOTICE_LINES` (3) rows; when notices do not fit, keep the rows
that fit and close with `… +N more`, counting the notices not shown in full.
They render here rather than through a notification, which the overlay hides.

## Context map

The overview pairs a proportional map, `DEFAULT_MAP_COLUMNS` ×
`DEFAULT_MAP_ROWS` (14×14) cells by default, with an interactive category
legend. Map geometry is an input rather than a constant: derive the key, Block
Size, and every layout decision from the live geometry, and clamp a requested
size to what the viewport can render, so
[Responsive rendering](../UI.md#responsive-rendering) always wins over a
requested size.

Cells use themed `■` for full occupancy, `◧` for partial occupancy, `▦` for
compacted data, `⛝` for the auto-compact buffer, and `⛶` for free space. Each
glyph follows its category color; buffer and free space are dim by default.
Allocate occupied cells from estimated category totals against the current map
scale, which is the context window unless [Fit](#map-scale) is active; display
pi-reported usage separately, because the values may differ.

A dedicated key appears beside the map, below the `Category:` legend and its
scroll counter, separated by one empty detail row:

```text
Map:
  ■ - Single category block
  ◧ - Shared block, largest category shown
  ⛶ - Block Size: 5.1k (0.5%)
```

Compacted, buffer, and free glyphs need no key row, because their category rows
identify them. Block Size is the mapped range divided by the cell count — the
map's resolution, or what the smallest visible cell is worth. Its percentage is
the cell's share of the mapped range, not of the context window, and both values
derive from live map geometry rather than an assumed grid size. Only the token
value follows the active scale: `muted` at Window, and the same `mdHeading`
treatment as the header's zoom label while Fit is active, so zooming visibly
shrinks and highlights it.

The key claims only the rows the complete legend leaves over, counted as the
detail column minus the `Category:` heading and every legend row:

- `MAP_KEY_DETAILED_SPARE_ROWS` (5) or more spare rows: the full key;
- `MAP_KEY_COMPACT_SPARE_ROWS` (2) to 4: the single-line
  `Map: ■ One category · ◧ Mixed · ⛶ 5.1k (0.5%)` key, dropping the percentage
  and then shortening `One category` to `One` before the line would truncate;
- fewer than 2: no key.

Only after the key is gone may the legend hide a category row or start
scrolling, and the `Category:` heading with at least one legend row always
survives. The dashboard description collapses before the key degrades.

When auto-compaction is enabled, the tail of the map shows the settings
`reserveTokens` reserve as `⛝` cells after the free cells: tokens content will
never occupy because compaction triggers first. The buffer shrinks once
estimated content grows into the reserve, and disappears when auto-compaction is
disabled or settings are unreadable. Read the reserve from pi's merged
global/project settings at view-open time, honoring project trust. At Fit scale
the reserve lies past the mapped range, so no `⛝` cells render while the
`⛝ Auto-Compact Buffer` legend row remains.

## Map scale

The map has two scales, toggled by `z`: `Window` maps the full context window
and matches pi-reported fullness; `Fit` maps a smaller range so low occupancy
stays legible. Scale changes the denominator only — the map is always anchored
at token 0 and never pans, so no content falls outside it, and cell
classification, segment order, and the `■`/`◧` thresholds are unchanged.

Fit scale is the estimated occupied total plus headroom (`FIT_SCALE_PERCENT`,
115%), rounded up to a `FIT_SCALE_SIGNIFICANT_DIGITS` (2) boundary, floored at
`MINIMUM_FIT_SCALE_TOKENS` (10k) and capped at the context window. The headroom
keeps a visible band of `⛶` cells, so the map still reads as occupancy rather
than as a pure composition chart.

Render `Z Zoom` in the hint row directly before `Esc Close`. Hide the hint,
header label, and binding together whenever the toggle cannot help: in the
narrow layout, when the map is unavailable for lack of a context-window
denominator, or when the Fit scale would reach the context window. The view
opens at Window and holds the chosen scale only until it closes.

## Category legend

Each top-level category uses a configurable semantic theme color; built-in
defaults are distinct except for the intentionally shared System Prompt/Built-in
Tools color. A category override colors its map cells and legend marker, while
labels and values retain the shared selector styles. Buffer and free-space
overrides also color their map cells, legend markers, and Block Size key glyph.

Category names have no trailing colons. Fill the gap before values with `dim`
dot leaders; shorten or remove leaders before truncating labels or values. Token
and percentage values align in separate columns, always denominated against the
true context window regardless of map scale. Categories follow the order pi
assembles them into a request, and both views name them identically:

- System Prompt, Instruction Files, and Skills;
- Built-in Tools, Custom Tools, and MCP Tools;
- User Messages, Assistant Messages, Assistant Thinking, and Tool Calls;
- Tool Output and Extensions;
- Compacted Data and Free Space.

Extensions groups what extensions contributed outside their tool definitions:
one child per injected `customType`, plus one per source whose system-prompt
additions were attributed, named by that source. Those additions stay out of the
System Prompt total, which counts pi's own prompt alone.

Prefix each Tool Output breakdown row with a full-size `•` bullet rather than
the smaller middle dot `·`. Keep aggregate breakdowns collapsed except Tool
Output, whose per-tool results and bash executions appear directly and scroll
independently; map allocation always uses top-level totals. The trailing
`⛝ Auto-Compact Buffer` (when enabled) and `⛶ Free Space` rows directly follow
the last category, and Free Space excludes the buffer so all rows still sum to
the context window. Neither row has anything to preview: they scroll with the
legend but are skipped by cursor navigation.

When the legend overflows, show the dim `(current/total)` counter on the row
directly below the last visible legend row, indented two spaces, never beside
the `Category:` heading. It counts every legend row, including the trailing
buffer and free-space rows, and its left number is the last visible row, so
scrolling to the end reaches the total. Height-only resizing must also reflow
and clamp the viewport.

## Category preview

Render the selected category as chronological entries headed by:

```text
[DD-MM-YYYY HH:MM:SS] [breadcrumb…] tokens
```

Use dim for datetime and tokens, bold `mdHeading` for the first breadcrumb cell
naming the producing tool, message role, or skill, and muted for the rest.
Snapshot-backed categories omit datetime and retain category order. Assistant
messages split into constituent text, thinking, and tool-call entries; tool
calls include the tool name. Add a `text i/n` cell only for multi-block text or
thinking content.

### Thinking notation

Assistant Thinking entries carry an invisible-reasoning cell after the visible
estimate, with `T` as the visible-plus-invisible message total:
`+ Encoded ≈N (≈T)` for a provider-reported share on a message with a captured
signature, `+ Encoded ~N (~T)` for the signature-size proxy, and
`+ Reasoning ≈N (≈T)` without a captured signature. `≈` marks a
provider-reported count and `~` a rough proxy that must never be rendered as an
upper bound; omit zero-size shares.

Keep one wrapped dim explanation after the scrollable entries and before the
hints, opening with the schematic pattern
`[DD-MM-YYYY] [assistant] visible + Reasoning ≈invisible (≈total)` and then
defining `≈`, `~`, and `Encoded`; the per-block cap shrinks around it. Never
render, preview, or log raw signature bytes. [THINKING.md](../THINKING.md) owns
the estimate.

### Blocks

Treat each entry as one navigable block with a two-column gutter before its
header and content. Mark every line of the selected block, including blank
content lines, with an accent `┃` (`BLOCK_GUTTER`); leave the blank separator
row between blocks unmarked. Unselected blocks keep the same spacing with no
gutter. When the stream overflows, show the selected block ordinal as a dim
`(i/n)` counter.

Up/Down and `k`/`j` move block by block, keeping the selected block fully
visible with minimal scrolling when it fits. If it is taller than the viewport,
expose its approached edge and scroll line by line within it before moving on.
PgUp/PgDn move by viewport height and select the first fully visible block,
falling back to the first intersecting block; once paging reaches the first or
last viewport, the next PgUp/PgDn selects the corresponding boundary block, so
paging alone reaches `(1/n)` and `(n/n)`. Home/End select the first or last
block.

Indent content two spaces after the gutter and separate blocks with one blank
row. An entry carrying labeled parts — a tool's prompt lines and definition, the
System Prompt's blocks — renders them inside its own block under the
[labeled part rules](previews.md#labeled-parts), never as separate blocks, and
its entry header keeps the whole estimate. In User Messages only, replace
complete attached `<skill name="…">…</skill>` expansions with pi-colored
`[skill] name` badges and leave malformed wrappers visible; the full content
still contributes to token estimates.

### Block cap and full content

Cap each block so two whole blocks stay visible: derive the cap from terminal
height and reserved footer rows — never from the viewport, whose counter row
depends on the capped stream — and clamp it between `PREVIEW_BLOCK_MIN_LINES`
(4) and `PREVIEW_BLOCK_MAX_LINES` (10) wrapped content lines. When content is
hidden, left-align a dim `… +N lines` marker with the block content; for the
selected block only, append dim ` · ` and accent `Enter - View Content`, never
repeated in the footer hint row. Fully visible blocks show no Enter action, and
Enter is a no-op for them.

Enter on a capped block opens a separate fullscreen level with the category
header, one blank separator row, the selected entry header, and its complete
uncapped content. That level uses line and page scrolling with
`↑↓/jk Scroll · PgUp/PgDn Page · Esc Back`, and Escape returns to the same block
and viewport. A category without entries instead shows
`No content captured for this category.` without a gutter; Enter is a no-op and
the hint row offers `Esc Back` alone. Unknown usage after compaction retains an
explicit preview state.
