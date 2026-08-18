# Development Plan

## Status

- [AGENTS.md](AGENTS.md) - current architecture;
- [doc/UI.md](doc/UI.md) - the UI specification;
- [doc/HISTORY.md](doc/HISTORY.md) - legacy, superseded designs and architecture decisions;
- [CHANGELOG.md](CHANGELOG.md) for completed work.


## v0.4.3

- [x] Refine category preview for context usage view:
  - Change scrolling from current line by line to block by block.
  - Full content preview of capped blocks with `Enter`; complete blocks have no open action.
  - Cap block streams at 14 content lines and keep their collapse indicator left-aligned.
  - Highlight the selected block with an accent `┃` gutter.
- [ ] Add mouse wheel support for scrolling.
- [ ] Add `Ctrl+u/d` as alias for `PgUp/PgDn`.


## v0.5.0

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


## v0.6.0

- [ ] **Persistent zoom preference.**
  - Depends on the extension config introduced with icon styles.
  - Persist the chosen map scale instead of resetting to Window on every open.
  - Scope the preference to context windows of 1M tokens and above, where
    Window scale is least useful.
  - Keep the in-view toggle authoritative for the current view.


## v0.7.0

- [ ] **Add bounded opt-in Runtime mutation logging.**
  - Enable the Runtime view and restore `/context runtime on|off`.
  - Record only hidden provider-bound mutations; exclude normal transcript
    growth and unchanged context.
  - Keep logging disabled by default, memory-only, and bounded to 200 entries
    and 1 MiB, with request indexing and eviction reporting.
  - Context-only message mutations, should the Runtime view explain
    chain-position visibility limits inline or leave that detail to documentation?
