# UI specification

This is the canonical UI reference for pi-context-view v0.2.1. Both `/context`
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

Both views have `list` and `preview` states:

- Up/Down navigate selectable rows.
- PgUp/PgDn page through lists or previews.
- Home/End jump to boundaries.
- Enter opens the selected row's preview.
- Escape returns to the same list row, then closes the view.

Navigation skips non-selectable rows and remains bounded after terminal resize.
All content is terminal-sanitized before rendering. Raw content appears only
after explicit Enter selection.

## Usage view

`/context` and `/context usage` open **Context Usage**.

The overview contains a proportional 14×14 map and an interactive category
legend. Cells use themed `■` for full occupancy, `◧` for partial occupancy, `▦`
for compacted data, dim `⛝` for the auto-compact buffer, and dim `⛶` for free
space. Allocate occupied cells from estimated category totals against the
context window; display pi-reported usage separately because the values may
differ. A dedicated `Map: ■ Full · ◧ Part` key appears beside the map, followed
by one empty detail row before `Category:`. Compacted, buffer, and free glyphs
need no key because their category rows identify them.

When auto-compaction is enabled, the tail of the map shows the settings
`reserveTokens` reserve as `⛝` cells after the free cells: tokens that content
will never occupy because compaction triggers first. The buffer shrinks once
estimated content grows into the reserve and disappears when auto-compaction is
disabled or settings are unreadable. Read the reserve from pi's merged
global/project settings at view-open time, honoring project trust.

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

Do not append the redundant word `tokens` to Usage header or category-preview
summaries. Preserve `≈` when the usage total is estimated.

The legend uses a distinct semantic theme color for each top-level category,
except the intentionally shared System Prompt/System Tools color. Category
names have no trailing colons. Fill the gap before values with `dim` dot
leaders; shorten or remove leaders before truncating labels or values. Token
and percentage values align in separate columns. Categories include:

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
with it but are skipped by cursor navigation and excluded from the
selectable-row counter.

At widths of 72 columns and above, map cells have spacing. From 52–71 columns,
remove inter-cell spacing. Below 52 columns, hide the map and its fill key while
keeping the selectable category list. Height-only resizing must also reflow and
clamp the viewport.

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

Indent content by two spaces and separate entries with one blank row. In User
Messages only, replace complete attached `<skill name="…">…</skill>` expansions
with pi-colored `[skill] name` badges; leave malformed wrappers visible. This is
a preview-only transformation, and the full content still contributes to token
estimates. Cap each entry at 20 wrapped lines and append a dim `… +N lines`
marker. Empty categories and unknown usage after compaction must have explicit
preview states.

## Injections view

`/context injections` opens **Context Injections**. Its header is:

```text
Context Injections · [INITIAL]  RUNTIME
```

`INITIAL` uses the active `mdHeading` treatment. `RUNTIME` is dim, disabled, and
cannot receive focus in v0.2.0. There is no switching key or Runtime status. If
the combined header does not fit, put the title and tabs on separate lines with
one empty row before and after the tabs.

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
layout-affecting dimensions and theme state.

Test at 60, 80, and 120 columns, narrow fallbacks, short heights, height-only
resizing, overflow navigation, preview return position, and theme invalidation.

## Release media

Keep sanitized captures under `doc/images/` in Git LFS:

- gallery thumbnail: 1224×574;
- Usage capture: 3041×1227;
- Injections capture: 3054×1232.

Capture from a no-session TUI. Remove project paths, credentials, and private
prompt or message content. Verify all README images and the absolute `pi.image`
URL before release.
