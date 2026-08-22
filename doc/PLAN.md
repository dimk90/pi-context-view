# Development Plan

## Status

- [doc/ARCHITECTURE.md](ARCHITECTURE.md) - current capture and usage architecture;
- [doc/UI.md](UI.md) - the UI specification;
- [doc/HISTORY.md](HISTORY.md) - legacy, superseded designs and architecture decisions;
- [CHANGELOG.md](../CHANGELOG.md) for completed work.


## v0.5.0

- [x] **Add override-only config loading and configurable category colors**:
  - Keep defaults in code; never auto-create the file or backfill omitted keys.
  - Read global `getAgentDir()/extensions/pi-context-view.json` only, lazily on
    the first `/context` open; cache per runtime and re-read on mtime change.
  - Degrade invalid files and entries to defaults and warn once per revision.
  - Keep configurable state and validation in `src/config.ts`.
  - Accept Pi foreground theme color names for every Usage category, the
    auto-compact buffer, and free space.
- [x] **Add `/context config` writer**:
  - Write the file populated with defaults; refuse and print the path when it
    already exists. Keep parsing, completions, registration text, README usage,
    and command tests synchronized with the new grammar.
  - The create-only write is one atomic `O_EXCL` create and skipped outside
    `ctx.mode === "tui"`. Debouncing and fresh-read merging remain requirements
    for later actions that update an existing file.
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
