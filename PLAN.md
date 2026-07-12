# Development Plan

## Status

- [AGENTS.md](AGENTS.md) - current architecture;
- [doc/UI.md](doc/UI.md) - the UI specification;
- [doc/HISTORY.md](doc/HISTORY.md) - legacy, superseded designs and architecture decisions;
- [CHANGELOG.md](CHANGELOG.md) for completed work.

## v0.2.0 release

- [x] 13. **Perform a release code review.**
  - Review capture/probe safety, synthetic-message filtering, owned-copy
    freezing, terminal sanitization, explicit-Enter privacy, command grammar,
    responsive layout, theme invalidation, and package/API compatibility.
  - Check the complete release diff for accidental Runtime functionality,
    persisted or logged raw content, unsupported CLI behavior, and unnecessary
    scope.
  - Resolve findings, then repeat `npm run check`, real-TTY coverage, and the
    no-provider-call and normal-turn smoke tests.
- [ ] 14. **Release v0.2.0.**
  - Set the package version to `0.2.0`; add repository, homepage, bugs, and
    gallery metadata; verify development pins match `pi --version`.
  - Inspect the npm package, then verify installation with `pi install`,
    discovery with `pi list`, and temporary loading with `pi -e`.
  - Tag `v0.2.0` only after review and installation checks pass.

## v0.3.0 roadmap

- [ ] 15. **Add bounded opt-in Runtime mutation logging.**
  - Enable the Runtime view and restore `/context runtime on|off`.
  - Record only hidden provider-bound mutations; exclude normal transcript
    growth and unchanged context.
  - Keep logging disabled by default, memory-only, and bounded to 200 entries
    and 1 MiB, with request indexing and eviction reporting.
- [ ] 16. **Compact attached skills in User Message previews.**
  - Replace complete `<skill name="…">…</skill>` expansions with themed
    skill-name badges in previews only.
  - Preserve stored/model content and token estimates; leave malformed wrappers
    visible and test multiple skills, wrapping, and unsafe names.
- [ ] 17. **Refine context-view scanning.**
  - Evaluate dim hierarchy guides in the Initial view.
  - Add dim dot leaders between Usage category names and aligned values without
    weakening narrow-width behavior.

## Open question

- For v0.3.0 context-only message mutations, should the Runtime view explain
  chain-position visibility limits inline or leave that detail to documentation?
