# Development Plan

## Status

- [AGENTS.md](AGENTS.md) - current architecture;
- [doc/UI.md](doc/UI.md) - the UI specification;
- [doc/HISTORY.md](doc/HISTORY.md) - legacy, superseded designs and architecture decisions;
- [CHANGELOG.md](CHANGELOG.md) for completed work.

## v0.2.4

- [ ] 1. **Fix base-prompt boundary detection for pi 0.81.**
  - Pi 0.81 removed the `Current date: YYYY-MM-DD` line from the system
    prompt; the native footer is now only
    `Current working directory: <cwd>`.
  - `src/measure.ts` `findBasePromptFooter()` no longer finds the boundary,
    so extension `before_agent_start` prompt additions collapse into
    Pi's Base Prompt instead of `prompt-addition:aggregate`.
  - Recognize the CWD line alone as the footer, still accepting the
    preceding date line for 0.80 compatibility.
  - Harden the CWD-only match: require the exact resolved cwd and line
    boundaries (preceded by `\n`, followed by `\n` or end of prompt), since
    the date line no longer serves as a second validation factor.
  - Add regression tests for both footer forms; current
    `test/measure.test.ts` fixtures only use the old date+CWD footer.
  - Add a regression test against real `buildSystemPrompt()` output rather
    than only hand-written fixtures, so future upstream footer changes are
    caught.
  - Update `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`
    development pins and `pnpm-lock.yaml` to 0.81.1.

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
- [ ] 2. **Drop pi 0.80 compatibility.**
  - Remove the legacy date+CWD footer form from `src/measure.ts`
    base-prompt boundary detection; recognize only the 0.81
    `Current working directory: <cwd>` footer.
  - Remove the corresponding 0.80 footer fixtures and regression tests
    from `test/measure.test.ts`.

## Open question

- For v0.4.0 context-only message mutations, should the Runtime view explain
  chain-position visibility limits inline or leave that detail to documentation?
