# Development Plan

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
- [x] **Add "Customization" section to README**:
  - Tip to start with `/context config`, plus the override-only semantics.
  - Link to [doc/CONFIGURATION.md](CONFIGURATION.md) with the default file and
    key descriptions.
  - "Category Colors" sub-section: theme color names and literal hex values,
    with a link to [doc/PI-THEME-COLORS.md](PI-THEME-COLORS.md).

- [x] **Accept literal hex category colors**:
  - Take `#rrggbb` and `#rgb` beside theme color names, so a category color can
    stay fixed across themes.
  - Paint literal values through pi's own theme conversion, keeping its
    256-color down-conversion on terminals without truecolor.

- [ ] Update demo recordings to S-VHS v0.4:
  - [x] New commands + SKILL.
  - [x] Make zoom recording shorter (map only).
  - [ ] Update links in README.

- [x] **Add a color customization demo to README**:
  - Media distinguishable from the current usage GIF, which already shows the
    default palette.
  - One still of the same session per palette — defaults, `terrain`, `rainbow` —
    composited side by side by `scripts/palettes.sh`.
  - Example palettes live in `doc/palettes/` and double as the recording input;
    each panel reads one through a throwaway mirror of the agent directory.

- [ ] **Check if JSON prettified could be used**:
  - For tools definition ? Other JSON objects?
  - Is it possible to reliably detected JSON objects?
