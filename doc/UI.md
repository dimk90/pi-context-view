# UI specification

Canonical rendering contract for pi-context-view. Both `/context` views are
focused fullscreen TUI overlays; Usage and Injections are separate views, with
no tab state. `/context config` opens no overlay, so it runs in every run mode
and reports creation, refusal, or failure through a notification, or through
stderr where no UI is available.

This file holds the rules both views share. Load only the page your change
touches:

| Document | Covers |
| --- | --- |
| This file | Frame, color, casing, descriptions, interaction, responsive rendering |
| [ui/previews.md](ui/previews.md) | Labeled parts, restored extension lines, attribution footer, repeated headings, marked JSON |
| [ui/usage.md](ui/usage.md) | Context Usage: header, notices, map, map scale, legend, category preview |
| [ui/injections.md](ui/injections.md) | Context Injections: contribution tree, injection preview |

Constants are named where a rule needs a number; the module owning the constant
is authoritative.

| Area | Module |
| --- | --- |
| Frame, viewport, description blocks | `src/ui/layout.ts` |
| Configurable color resolution | `src/ui/color.ts` |
| Map cell model, Fit scale | `src/ui/usage-map.ts` |
| Usage rendering and interaction | `src/ui/usage-view.ts` |
| Usage entry and block model | `src/ui/usage-preview.ts` |
| Injections tree model / rendering | `src/ui/injections-model.ts`, `src/ui/injections-view.ts` |
| Labeled parts, attribution footer | `src/ui/section-preview.ts` |
| Marked JSON, skill badges, wheel | `src/ui/json-preview.ts`, `src/ui/skill-preview.ts`, `src/ui/wheel.ts` |

## Style rules

### Frame

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
scroll counters, hint rows, and preview bodies by two spaces (`BODY_INDENT`).

### Color and casing

Use `dim` for dialog descriptions, bright `text` for primary rows, `muted` for
subordinate rows and values, and `dim` for deeper breakdowns. Selected labels
and values use `accent` with no background. Subheaders are bold `mdHeading`.

Always use current-theme semantic colors through `theme.fg(...)` and themed
border colorizers; never hardcode ANSI escapes, hex values, or named terminal
colors. Use pi's injected keybindings, `matchesKey`, ANSI-aware width helpers,
render caching, and theme invalidation.

Content a `--system-prompt` replacement dropped carries a fixed `toolDiffRemoved`
` · Dropped` marker directly after the estimate it explains, in hierarchy rows
and preview subheaders alike. It marks a state rather than a usage category, so
it is never configurable, and its 0-token entries never color map cells. A row
too narrow for the whole marker drops it instead of truncating it.

Recovered `Available Tools` and `Guidelines` blocks outside pi's normal order
carry a fixed `warning` ` · Moved` marker after the estimate, in hierarchy rows,
preview subheaders, and the standalone part preview's metadata. A narrow row or
standalone header omits the whole marker when it will not fit. It describes
position, not ownership or a dropped contribution: these parts count normally,
and extension tool lines keep their own attribution. Like `Dropped`, it is not
configurable and does not change category/map colors.

A user-configurable color names either a pi theme color key, which tracks the
active theme, or a literal `#rgb`/`#rrggbb` value, which pins the element across
themes. Literals render through pi's own theme conversion, so they down-convert
to the closest 256-color index wherever pi itself would. ANSI escapes and
terminal color names stay invalid in configuration, and code keeps naming theme
keys alone. An unrecognized value falls back to the built-in color for that
element and warns once instead of failing the view.
[PI-THEME-COLORS.md](PI-THEME-COLORS.md) lists the keys.

Titles, section names, and hint labels use Title Case (`Context Injections`,
`Esc Close`). Key names use conventional casing (`PgUp/PgDn`). Preserve literal
identifiers such as `pi`, `edit`, and `web_search`; descriptions use sentence
case.

### Descriptions

A description is the least important block on a frame. It renders completely or
not at all: when the terminal is too short it collapses whole, together with the
blank row above it, and reappears once the terminal grows back. It is never
partial and never ellipsized.

| Description | Renders while |
| --- | --- |
| Usage dashboard | Map, complete legend, and full key all fit |
| Injections list | `LIST_DESCRIPTION_MIN_ROWS` (26) rows visible, or a shorter list in full |
| Attribution footer | `DESCRIPTION_MIN_CONTENT_ROWS` (22) content rows visible, or a shorter preview in full |

Hints, borders, capture warnings, and configuration notices are not descriptions
and never collapse. The Injections `[Degraded: …]` indicator belongs to its
description block and collapses with it, while the wrapped reason below the
header stays. The Usage thinking-notation explanation is view content, not a
description, and also never collapses.

Why the floors differ: the Usage dashboard has a bounded legend and can drop its
description early, while the unbounded Injections list and attributed previews
would otherwise hide theirs permanently.

## Interaction

The Injections view has list and raw-preview states. The Usage view has a
category legend and opens a single-entry category directly as full content.
Multi-entry categories have a block stream with a full-content level for capped
blocks; empty categories keep their explicit no-content state.

- Up/Down and vim-style `k`/`j` navigate selectable rows or blocks and scroll
  full-content previews. Hints render the pair as one `↑↓/jk` label
  (`STEP_KEY_HINT`).
- PgUp/PgDn and `Ctrl+U`/`Ctrl+D` page through lists or previews. From the first
  or last page of a Usage block stream, another page key selects the first or
  last block.
- Home/End jump to boundaries.
- Enter opens the selected row's preview; in a Usage block stream it opens full
  content only when the selected block is capped.
- Escape returns one level while preserving selection, then closes the view.
- Views may add keys; Usage adds `z` for the map scale.

The mouse wheel scrolls wherever the keys navigate: one notch moves the
selection one row or block, and scrolls a full-content preview by pi's own
viewport step, defaulting to `DEFAULT_WHEEL_SCROLL_LINES` (3) when that step is
unreadable. Only fullscreen mode enables mouse reporting, so in regular mode the
wheel keeps scrolling the terminal's scrollback; hint rows therefore stay
keyboard-only and never advertise an affordance one mode lacks.

Navigation skips non-selectable rows and remains bounded after terminal resize.
All content is terminal-sanitized before rendering and raw content appears only
after explicit Enter selection; [ARCHITECTURE.md](ARCHITECTURE.md) owns the full
privacy contract.

## Responsive rendering

Every rendered line must fit the supplied width. Fullscreen output must respect
terminal width and height, including borders, wrapped notices, descriptions,
hints, counters, and blank rows. Cache keys must include all layout-affecting
dimensions and theme state; state changed from within a view, such as the Usage
map scale, must invalidate cached output instead.

UI cases `pnpm check` must cover, beyond the general matrix in
[AGENTS.md](../AGENTS.md):

- 60, 80, and 120 columns, the narrow fallback, and height-only resizing;
- description collapse and restoration, with no height rendering a partial one;
- both map scales, the header label's line-splitting fallback, the conditions
  hiding the zoom binding, and every map-key degradation;
- overflow navigation, preview return position, and theme invalidation.
