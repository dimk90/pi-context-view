
# v0.9.0

- [x] **Different Icon Styles for the usage map**.
  - Add possibility to define custom icon theme via config (array of strings in the config).
  - Pre-defined icon themes (should be written to config on `/context config`):
    - "CC"="⛝⛶⛀⛁⛃";
    - "Nerd"="󰅗󰆼";
    - "Circle"="⮾·◕●♼";
    - "Square" = "⛝⛶◧■▩";
  - Default icon style should be set to "Square" = "⛝⛶◧■▩".
  - Update CONFIG.md

- [ ] **Cycle icon styles via hotkeys**
  - Add hotkey to cycle icons styles in context usage view.
  - The hotkey should be aligned to the right.
  - The icon style hotkey should change style in persistent way (save it to the config).

- [ ] Move "Window/Used" % to back to hotkey bar:
  - to reduce visual noise.
  - use underline for the current mode.

- [ ] Fix more than 100% context windows:
  - Discuss what to do.

- [ ] **Collapse/Expand groups in Injection view**:
  - Show max 4 items.
  - Collapse group automatically if it contains more than 4 items.
  - When collapse still show 3 items + one '...'.
  - Show "Use <-/-> to Collapse/Expand" (accent color) in addition to ... when corresponding group (or item inside group) is selected.
  - When Search/Filter should active it should show everything expanded.
  - No need to extra hotkey in hotkey bar.
