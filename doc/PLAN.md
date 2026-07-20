# Development Plan

## Status

- [AGENTS.md](AGENTS.md) - current architecture;
- [doc/UI.md](doc/UI.md) - the UI specification;
- [doc/HISTORY.md](doc/HISTORY.md) - legacy, superseded designs and architecture decisions;
- [CHANGELOG.md](CHANGELOG.md) for completed work.

## v0.3.0

- [ ] 1. **Icon and category for auto-compat buffer**.
  - Add "Auto-compat Buffer" category shows tokens which will be never occupied
    because compaction will be triggered before it.
  - The "Auto-compat Buffer" category should be showed before "Free Space" category.
  - The "Auto-compat Buffer" icons (⛝) should be showed at the end of the usage map.
  - The "Auto-compat Buffer" category is not selectable item.
  - Add empty line after "Free Space" and "Auto-compat Buffer".
- [ ] 2. **Change a dialog description color to dim**.


## v0.4.0

- [ ] 1. **Add bounded opt-in Runtime mutation logging.**
  - Enable the Runtime view and restore `/context runtime on|off`.
  - Record only hidden provider-bound mutations; exclude normal transcript
    growth and unchanged context.
  - Keep logging disabled by default, memory-only, and bounded to 200 entries
    and 1 MiB, with request indexing and eviction reporting.

## Open question

- For v0.4.0 context-only message mutations, should the Runtime view explain
  chain-position visibility limits inline or leave that detail to documentation?
