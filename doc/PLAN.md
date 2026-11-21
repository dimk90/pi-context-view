
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

- [x] **Cycle icon styles via hotkeys**
  - Add hotkey to cycle icons styles in context usage view.
  - The hotkey should be aligned to the right.
  - The icon style hotkey should change style in persistent way (save it to the config).

- [x] Reverse dim/muted colors for hotkey line.

- [x] **Bump Pi pins to 1.6.0**:
  - Update the four development pins, run `pnpm install` and `pnpm check`.
  - `render()` now returns `readonly string[]`. Our views return `string[]`, which still fits. Fix any type errors that appear.

- [x] Increase right and left padding for views content.

- [x] **Check payload guard against 1.6.0 adapters**:
  - OpenAI Completions now sends `system` instead of `developer` to every host except OpenAI. Check test fixtures that expect `developer` for other hosts.
  - Unstarted tool calls cancelled with Esc now get stored "Operation aborted" results. Keep the `No result provided` synthesis for older sessions and check that tests still pass.
  - `read` no longer stores the "model does not support images" note in the tool result. Check tests that expect the note.

- [ ] **Check reasoning-token accounting**:
  - OpenAI Completions now also reads `usage.reasoning_tokens`, and Copilot reports reasoning tokens. Check that `reportedReasoningTokens()` handles the new values. Update `doc/THINKING.md` if needed.

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
