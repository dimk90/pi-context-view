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

- [ ] **Check if JSON prettified could be used**:
  - For tools definition ? Other JSON objects?
  - Is it possible to reliably detected JSON objects?
