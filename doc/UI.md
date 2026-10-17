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
  the overlay. Reopening content starts at the top.
- Skip non-selectable rows and keep selection and scrolling bounded after
  resize. View-specific actions must be available and advertised together.

Use pi's keybinding APIs. In fullscreen mode, the mouse wheel follows keyboard
navigation; in regular mode it remains terminal scrollback. Keep hints usable
without mouse support.

Raw content appears only after explicit Enter selection, never in overview
rows, descriptions, or status bars. Sanitize dynamic text before styling and
rendering; [privacy.md](architecture/privacy.md#privacy) owns the full contract.

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
