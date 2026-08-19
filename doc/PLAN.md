# Development Plan

## Status

- [doc/ARCHITECTURE.md](ARCHITECTURE.md) - current capture and usage architecture;
- [doc/UI.md](UI.md) - the UI specification;
- [doc/HISTORY.md](HISTORY.md) - legacy, superseded designs and architecture decisions;
- [CHANGELOG.md](../CHANGELOG.md) for completed work.


## v0.5.0

- [ ] **Add config file for customization**:
  - Should be created on the first run if missing.
  - Introduce class for holding configurable state.
  - Missing default values (from configurable state) should be stored to the config file.
  - Make colors configurable for all categories.
  - The Pi's theme color names should be allowed in config.
  - Add "Customization" section to README with note about configurable colors.
- [ ] **Make context usage map size (rows, cols) configurable**:
  - Add rows and cols parameters to the config.
  - Increase default rows and cols, especially rows.


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
