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
  - The create-only write is one atomic `O_EXCL` create, available in every run
    mode because it opens no view. Debouncing and fresh-read merging remain
    requirements for later actions that update an existing file.
- [ ] Add "Customization" section to README with:
    - Short tip to start with `/context config`.
    - Link to md file with content of the default settings (json) + description.
    - "Category Colors" sub-section:
      - Supported theme-depended and independent colors.
      - Link to the theme color names & default dark theme visualization (doc/PI-THEME-COLORS.md)
      - Any idea for color demo distinguishable from the current one?

- [ ] **Check if JSON prettified could be used**:
  - For tools definition ? Other JSON objects?
  - Is it possible to reliably detected JSON objects?
