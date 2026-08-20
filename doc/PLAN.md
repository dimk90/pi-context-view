# Development Plan

## Status

- [doc/ARCHITECTURE.md](ARCHITECTURE.md) - current capture and usage architecture;
- [doc/UI.md](UI.md) - the UI specification;
- [doc/HISTORY.md](HISTORY.md) - legacy, superseded designs and architecture decisions;
- [CHANGELOG.md](../CHANGELOG.md) for completed work.


## v0.5.0

- [ ] **Add config file for customization**:
  - Override-only: defaults live in code, the file is never auto-created on
    first run and never backfilled with missing defaults, so later default
    changes still reach users who did not override them.
  - Global `getAgentDir()/extensions/pi-context-view.json` only; no project-local
    override, so no `ctx.isProjectTrusted()` gate is needed.
  - Load lazily on first `/context` open, never in the factory; cache per
    runtime and re-read on mtime change so edits apply without restarting pi.
  - Failure = defaults: a missing, unparseable, or invalid entry (unknown key,
    unknown color name, out-of-range size) falls back to the built-in value and
    warns once, never fails the view.
  - Introduce a class in `src/config.ts` holding configurable state.
  - Make colors configurable for all categories.
  - The Pi's theme color names should be allowed in config.
  - Add `/context config` to write the file populated with defaults; refuse and
    print the path when it already exists. Keep parsing, completions,
    registration text, README usage, and command tests synchronized with the
    new grammar.
  - Writes are atomic (tmp file + rename), debounced, and skipped outside
    `ctx.mode === "tui"`; re-read and merge before writing so concurrent edits
    and unknown keys survive.
- [ ] Add "Customization" section to README with:
    - Short tip to start with `/context config`.
    - Link to md file with content of the default settings (json) + description.
    - "Category Colors" sub-section:
      - Supported theme-depended and independent colors.
      - Link to the theme color names & default dark theme visualization (doc/PI-THEME-COLORS.md)
      - Any idea for color demo distinguishable from the current one?
- [ ] **Make context usage map size (rows, cols) configurable**:
  - Add rows and cols parameters to the config.
  - Increase default rows and cols, especially rows.
  - Add subsection "Map Size" to README "Customization" section.
  - Add image with demo for different map shapes.


## Backlog

- [ ] **Different Icon Styles for the usage map**.
  - Default icon style is "Square" = "⛝⛶◧■▩".
  - Add hotkey to cycle icons styles in context usage view.
    - The hotkey should be aligned to the right.
  - All icon styles should be listed in config file for extension.
  - Current icon style should be in the config.
  - The icon style hotkey should change style in persistent way (save in the config).
  - Other styles:
    - "Claude"="⛝⛶⛀⛁⛃";
    - "Nerd"="󰅗󰆼";
    - "Circle"="⮾·◕●♼";

- [ ] **Persistent zoom preference.**
  - Depends on the extension config introduced with icon styles.
  - Persist the chosen map scale instead of resetting to Window on every open.
  - Scope the preference to context windows of 1M tokens and above, where
    Window scale is least useful.
  - Keep the in-view toggle authoritative for the current view.

- [ ] **Add bounded opt-in Runtime mutation logging.**
  - Enable the Runtime view and restore `/context runtime on|off`.
  - Record only hidden provider-bound mutations; exclude normal transcript
    growth and unchanged context.
  - Keep logging disabled by default, memory-only, and bounded to 200 entries
    and 1 MiB, with request indexing and eviction reporting.
  - Context-only message mutations, should the Runtime view explain
    chain-position visibility limits inline or leave that detail to documentation?
