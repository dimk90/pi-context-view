# Development Plan

## Status

- [AGENTS.md](AGENTS.md) - current architecture;
- [doc/UI.md](doc/UI.md) - the UI specification;
- [doc/HISTORY.md](doc/HISTORY.md) - legacy, superseded designs and architecture decisions;
- [CHANGELOG.md](CHANGELOG.md) for completed work.

## v0.2.1

- [x] 1. Fix "Usage unknown" in **Usage View** after session resume.
  - Fall back to the category-total estimate, marked with `≈`, when pi cannot
    report post-compaction usage.

- [x] 2. **Compact attached skills in User Message previews.**
  - Replace complete `<skill name="…">…</skill>` expansions with themed
    skill-name badges in previews only.
  - Preserve stored/model content and token estimates; leave malformed wrappers
    visible and test multiple skills, wrapping, and unsafe names.

- [ ] 3. **Refine context usage view.**
  - Add dim dot leaders between Usage category names and aligned values without
    weakening narrow-width behavior.
  - **Usage View**: Move model name and total tokens (166.5k/372k tokens (45%))
    to the dialog header and alight to the right.
  - Add full and part icons to the map legend.
  - Prepare UI sketch and ask my option before implementation it.

## v0.2.2

- [ ] 1. **Preserve silent-probe filtering across extension runtimes.**
  - Retain exact synthetic user and assistant role/timestamp identities across
    resume and reload so prior probe entries remain excluded from later model
    contexts and Usage.
  - Do not identify probes from empty content; preserve genuine empty messages
    and aborts without persisting raw captured content.

## v0.3.0

- [ ] 1. **Add bounded opt-in Runtime mutation logging.**
  - Enable the Runtime view and restore `/context runtime on|off`.
  - Record only hidden provider-bound mutations; exclude normal transcript
    growth and unchanged context.
  - Keep logging disabled by default, memory-only, and bounded to 200 entries
    and 1 MiB, with request indexing and eviction reporting.


## Open question

- For v0.3.0 context-only message mutations, should the Runtime view explain
  chain-position visibility limits inline or leave that detail to documentation?
