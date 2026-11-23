
# v0.9.0

- [x] Move "Window/Content" % to back to hotkey bar:
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

- [ ] **Measure OpenRouter reasoning replay**:
  - OpenAI Completions messages count visible thinking only, so encrypted reasoning that OpenRouter replays in `reasoning_details` is not counted. See `doc/THINKING.md`.
  - Measure first: send the same history twice, with and without `reasoning_details`, to an Anthropic keep-all model with caching off, and compare `prompt_tokens` with `usage.reasoning`.
  - If they match, count `usage.reasoning` for messages whose details all have `format: "anthropic-claude-v1"`. Keep other formats visible-only until they are measured too.
  - Record the measurements in `doc/THINKING.md`.
