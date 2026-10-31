# UI design rules

Canonical design decisions for `pi-context-view`, not a transcript of its current
screens. Usage and Injections are separate fullscreen TUI overlays, with no tab
state. `/context config` opens no overlay and remains available in every mode.

| Document                             | Covers                                                                |
| ------------------------------------ | --------------------------------------------------------------------- |
| This file                            | Shared style, information hierarchy, interaction, responsive behavior |
| [ui/usage.md](ui/usage.md)           | Usage overview, map, category navigation                              |
| [ui/injections.md](ui/injections.md) | Request status, contribution tree, change inspection                  |
| [ui/previews.md](ui/previews.md)     | Content presentation, attribution, marker explanations                |

## Documentation boundary

Update these pages when a change alters a design decision, interaction contract,
or the meaning of displayed information. Wording, header composition, spacing,
glyphs, numeric breakpoints, and layout constants belong in code; changing them
alone does not require a documentation update. Use existing project terms
consistently without treating every displayed sentence as fixed.

Keep the reason for a non-obvious decision, not an inventory of its rendering
cases. Accounting, attribution, capture limits, and privacy belong in
[ARCHITECTURE.md](ARCHITECTURE.md) and its linked pages. Configuration formats
and defaults belong in [CONFIG.md](CONFIG.md). Tests protect behavior and
regressions; exact-string assertions do not make incidental copy a design rule.

## Style rules

### Frame

Follow pi's native selector style rather than building a separate visual system:

- Use a bordered frame, clear headings, and whitespace to separate content,
  explanations, and keyboard hints.
- Keep selection obvious with a stable cursor and accent foreground, without a
  selection background. Subordinate content must not compete with the selection.
- Align comparable values and keep their columns stable while scrolling.
- Keep hints concise and tied to actions available in the current state.
  Show progress counters only when content overflows.

### Color and casing

Use the active theme's semantic colors: accent for selection, bright text for
primary content, muted or dim text for supporting information, and heading styles
for hierarchy. Use pi's theme conversion and border styling, not hardcoded
terminal colors or ANSI escapes.

Category colors describe composition; state markers and diffs describe meaning.
Keep those roles separate: category overrides must not recolor warnings,
attribution, or change states. Pair color with text or symbols so color alone
never carries the distinction. Explicit user-configured colors follow
[CONFIG.md](CONFIG.md#category-colors).

Use Title Case for UI labels and sentence case for explanations. Preserve
literal identifiers, tool names, paths, and conventional key names.

### Descriptions

Optional descriptions and preview legends are lower priority than the content.
Wrap them fully or collapse the whole block; never leave a partial explanation
or ellipsize it. Restore the block when space returns. Long lists and previews
must still be able to show explanations without requiring all content to fit.

Do not collapse important status with these descriptions. Capture limitations,
degraded reasons, configuration problems, and the Injections total and selected
row's status must remain discoverable. Per-view pages define what stays visible
and what can yield on small terminals. Notices belong inside an open overlay,
not in notifications it would hide.

## Interaction

- Up/Down and `k`/`j` navigate selectable rows or blocks, or scroll full content.
- PgUp/PgDn and Ctrl+U/Ctrl+D page; Home/End reach the boundaries. Navigation
  must reach all content, including blocks taller than the viewport.
- Enter opens the selected content. Do not add an extra preview level when it
  would reveal nothing new.
- Escape returns one level with selection and viewport preserved, then closes
  the overlay. Reopening content starts at the top. A kept list filter counts
  as a level.
- `/` filters the Injections tree or searches a preview, per
  [Search and filter](#search-and-filter).
- `c` copies the highlighted row or block, or the open content when a single
  item is already open. Copy the captured, sanitized content itself, without
  preview wrapping, indentation, subheaders, or JSON expansion. A list filter
  applies: copy only what the view shows. The view reports the outcome, the
  copied size or the failure, as a flash message near the right end of its top
  border: `─ [ Copied: 486 chars ] ───`. The placement is the same in inline and
  fullscreen modes.
- The flash message text uses the dim color, so it stays quiet on the border.
- The flash message timing follows pi's fullscreen flash, and changes when
  pi's flash changes. Today that means it shows once the write settles, keys do
  not clear it, and the newest copy replaces it. It expires after 5 s for a failure, as in pi, and after 3 s for
  a success instead of pi's 1 s, so the copied size stays readable.
- Skip non-selectable rows and keep selection and scrolling bounded after
  resize. View-specific actions must be available and advertised together.

Use pi's keybinding APIs. In fullscreen mode, the mouse wheel follows keyboard
navigation; in regular mode it remains terminal scrollback. Keep hints usable
without mouse support.

Raw content appears on screen only after explicit Enter selection, never in
overview rows, descriptions, or status bars. Sanitize dynamic text before
styling and rendering; [privacy.md](architecture/privacy.md#privacy) owns the
full contract.

### Search and filter

Search follows pi's own fullscreen transcript search, so it needs no new
habits. The prompt sits below the header and edits through pi's `Input`, so
word deletion, kill/yank, and undo behave as in pi's editor. While it is open,
printable keys type into it, `j`, `k`, `n`, and `q` included; only the arrow and
page keys and the wheel keep navigating. Its right edge reports the match state.

Matching is case-insensitive and treats every whitespace run, line breaks
included, as one space, so a phrase wrapped across preview lines is still found.
Matches use pi's transcript-search theme styles, with the current match set
apart.

- **Lists** long enough to need a filter, such as the Injections tree, filter
  live and select the first row that matched itself. A
  match's ancestors stay as unmatched context and do not count as matches.
  Value columns stay where the unfiltered list puts them, so filtering never
  shifts them. Enter keeps the filter and opens the selected row; Escape while
  typing drops it, and Escape on a kept filter clears it, keeping the selected
  row, before it closes the view. Erasing the query or Escape while typing
  returns the selection and scroll to where they were before filtering.
- **Previews** highlight live and move to the first match at or below the top
  visible line. `n`/`N` step through matches, wrapping around, and scroll a
  hidden one into view with context above it. A search ends with its preview.

Hints follow the prompt state. `/` is an optional hint: on a narrow row it drops
out whole before any other hint is truncated.

## Responsive rendering

Every line must fit the supplied width, and the complete frame must fit the
available height. Measure styled text with ANSI-aware helpers. Reflow on width
and height changes, preserve navigation state where possible, and restore
omitted elements when space returns.

Prefer useful content and essential status over decoration and optional detail.
Shorten spacing and leaders before labels or values; wrap important explanations
rather than silently clipping their meaning. Omit optional markers as whole
units instead of displaying fragments. Extremely small terminals may require a
compact frame, but must not imply that unavailable information is complete.

Rendering caches must account for dimensions, theme changes, and view-local
state. [Validation](architecture/validation.md#ui-checks) owns the test coverage
and opt-in terminal checks.
