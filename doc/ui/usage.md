# Context Usage view

`/context` and `/context usage` show current context composition. Apply the
[shared design rules](../UI.md) and [preview rules](previews.md).
[Views on snapshots](../architecture/views.md#usage) owns the data sources and
how the latest request's changes apply to the current branch.

## Header and notices

Keep the usage summary prominent. Distinguish pi-reported usage from category
estimates rather than making them appear to reconcile exactly. Preserve an
indication when the total is estimated or unavailable.

Model identity is secondary to the summary and active map scale. Narrow layouts
may omit it or stack metadata rather than abbreviating it ambiguously. Show
degraded-capture and configuration problems inside the overlay; bounded notice
blocks must make omitted notices apparent. Disabled probing is not a problem:
explain it in the description, not as a notice.

## Context map

Pair a proportional occupancy map with a selectable category legend. The map is
an overview, not the only way to inspect usage: on narrow terminals, keep the
category list usable without the map or its controls.

Derive cell allocation and the map's resolution from the rendered geometry.
Clamp configured dimensions to the viewport by rebuilding the map, never by
cropping its range. Resizing must not make occupied content disappear.

Use category colors consistently in map cells and legend markers. Distinguish
single-category and shared cells, compacted data, free space, and the
unavailable auto-compaction reserve. Explain the map's resolution relative to
its current scale. Degrade optional map explanations before sacrificing category
navigation; an oversized configured map must not crowd out the legend.

[Configuration](../CONFIG.md#map-size) owns size settings;
[views.md](../architecture/views.md#auto-compaction-reserve) owns the reserve's
source and accounting.

## Map scale

Window shows the full context window. Fit makes low occupancy readable by
showing a smaller range with headroom. Both start at zero and contain all
estimated occupied content; zoom changes the denominator, not the category
order, classification, or totals.

Make an active Fit scale clear so it cannot be mistaken for context-window
fullness. Category percentages always use the true context window, while cell
resolution uses the displayed range. Keep the auto-compaction reserve in the
legend even when it lies outside Fit's range.

The `z` toggle is local to the open view, which starts at Window. Hide its hint,
label, and binding together when the map is absent or Fit would offer no useful
change.

## Category legend

Use pi's terminology and request-assembly order, with consistent names across
both views. Keep estimates and percentages aligned. Category colors identify
markers and map cells, not selected labels or values.

Favor a compact top-level composition. Tool Output exposes its per-tool
breakdown for direct inspection; other aggregate breakdowns stay collapsed.
Free space and the auto-compaction reserve remain visible as capacity, not
previewable content. They scroll with the legend but cursor navigation skips
them. A scrolling legend must remain usable independently of the map.

Usage shows the resulting composition, not a history of changes. Request-only
edits belong to Injections; do not add change markers throughout this overview.

The legend has no filter: it holds only a few categories, so scanning beats
typing. Search starts inside a category preview.

## Category preview

Preserve chronology and entry identity for conversation content, and meaningful
source order for snapshot-backed content. Split assistant text, thinking, and
tool calls into inspectable entries. Keep producing roles, tools, and skills
recognizable without repeating headings that add no information.

A category with one entry opens directly as full, uncapped content. Multiple
entries form a navigable block stream: clearly mark the selected block, cap long
bodies to keep neighboring entries discoverable, and make hidden content
apparent. Enter opens full content only for capped blocks; Escape restores the
same block and viewport. Empty or unavailable content gets an explicit state,
not a misleading blank preview.

### Search

`/` searches the open category under the shared
[search and filter rules](../UI.md#search-and-filter). One search spans both
preview levels of a category:

- In a block stream it covers every entry header and each block's uncapped
  content, so a match can lie in lines the block cap hides. Moving to a match
  selects its block and highlights the match wherever it is visible; a hidden
  match leaves its block selected, one Enter away.
- Enter on that capped block opens its full content scrolled to the same
  match, with the status counting that block's matches. Escape returns to the
  stream with the search kept on the block; Escape from the stream ends it.
- Single-entry categories search their full content directly. A category
  without entries has nothing to search and offers no search.

### Thinking notation

Distinguish visible thinking, provider-reported invisible reasoning, and the
rough signature-size proxy. Keep their explanation available while inspecting
thinking; it is essential content rather than an optional description. Never
present the proxy as an upper bound or as counted category usage.
[THINKING.md](../THINKING.md) owns the accounting and notation meanings.

### Forced prompt

When the latest request's forced prompt applies, explain that replacement in
System Prompt previews using the same Forced state as Injections. Keep this
out of unrelated categories and dashboard rows.
