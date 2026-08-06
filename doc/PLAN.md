# Development Plan

## Status

- [AGENTS.md](AGENTS.md) - current architecture;
- [doc/UI.md](doc/UI.md) - the UI specification;
- [doc/HISTORY.md](doc/HISTORY.md) - legacy, superseded designs and architecture decisions;
- [CHANGELOG.md](CHANGELOG.md) for completed work.


## v0.4.0

- [x] **Zoom for the usage map.**
  - Toggle the map between `Window` and `Fit` scale with `z`.
  - Fit is estimated occupancy plus 15% headroom, rounded up to two significant
    digits, floored at 10k and capped at the context window.
  - Scale changes the map denominator only: anchored at token 0, never pans,
    and cell classification is unchanged.
  - Show `Zoom 1M → 120k` in the header while Fit is active.
  - Put the `Z Zoom` hint directly before `Esc Close`.
  - Keep legend tokens and percentages against the true context window.
  - Hide the binding, hint, and label below 52 columns, without a context
    window, and when Fit would reach the window.
  - Open at Window, preserving current behavior; the scale lives only for the
    open view.
  - Clear the render cache when the scale toggles.

- [ ] **Track pi 0.84.**
  - Bump the `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`
    development pins to `0.84.0` and run `pnpm install`.
  - Keep the peer ranges at `"*"`; the extension still registers no tools, so
    `typebox` stays out of `package.json`.
  - Already verified unaffected on 0.84: the type surface, both views under
    fullscreen TUI and `fullscreenScrollbar: "always"`, and
    `AGENTS.override.md` context files, which measure by path. Only the generic
    "Memory (AGENTS.md)" Usage label reads oddly for an override file.

- [ ] **Restore silent-probe invisibility on pi 0.84.**
  - pi 0.84 resolves provider auth with the request signal, so a probe aborted
    at `turn_start` now fails during stream setup instead of inside the
    provider stream.
  - The synthetic assistant therefore arrives as `stopReason: "error"` with
    `errorMessage: "This operation was aborted"`. `sanitizeAssistant()` matches
    only `"aborted"`, so pi renders an `Error:` row, persists the message, and
    re-renders it on every resume.
  - Sanitize that shape too, still keyed on the probe-owned run and the
    recorded role/timestamp identity, so genuine aborts and genuine provider
    errors stay visible.
  - An unsanitized `error` message also reaches pi's auto-retry check; only the
    absence of a retryable-pattern match currently stops it from turning the
    probe into a real provider request.
  - Cover both stop reasons in `test/capture.test.ts` and re-verify in a real
    PTY, in regular and fullscreen TUI, including resume.

- [ ] **Skip the probe while compaction runs.**
  - pi 0.84 rejects `prompt()` during compaction, and `waitForIdle()` still
    tracks only the agent run, so `/context` mid-compaction shows an
    extension-error row and then waits out the 5 s probe timeout.
  - `pi.sendUserMessage()` swallows that rejection into pi's extension-error
    channel, so the existing `try`/`catch` around it cannot observe the
    failure.
  - Detect the compaction state before probing and return the pi-native
    fallback with a precise degraded reason instead.


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

## Open question

- For v0.7.0 context-only message mutations, should the Runtime view explain
  chain-position visibility limits inline or leave that detail to documentation?
