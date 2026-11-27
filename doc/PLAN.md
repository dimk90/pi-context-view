
# Backlog

- [ ] Fix more than 100% context windows:
  - Discuss what to do.
  - Since Pi 1.7.0, Pi's own estimate no longer counts `!!` output ([#12513](https://github.com/earendil-works/pi/issues/12513)). Usage already excluded it. Check whether the overflow still happens.

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

- [ ] **Measure Copilot `reasoning_opaque` replay**:
  - Copilot Completions messages (Gemini, Kimi) count visible thinking only, so the replayed `reasoning_opaque` is not counted. See `doc/THINKING.md`.
  - Measure first: send the same history twice, with and without `reasoning_opaque`, and compare `prompt_tokens` with `usage.reasoning` and the opaque length.
  - Only the latest opaque value per message is replayed, so `usage.reasoning` may cover more reasoning than the replay holds.
  - Record the measurements in `doc/THINKING.md`.
