
# Backlog

- [x] **Check Responses tool changes without inline declarations**:
  - Since Pi 1.7.0, Copilot `gpt-5.3-codex` and `mai-code-*` (`openai-responses`) have `supportsMidConvoSystemMessages` without `supportsAdditionalTools` or `supportsToolSearch`.
  - Pi keeps their system messages in place, but sends the current tool set in the request-level list and adds no removal notice (`resolveTranscriptTools()` with `"none"`).
  - `renderExpectedUnits()` in `src/capture/adjustments.ts` uses `grammarInputs.declared` whenever system messages are kept. Check whether this case needs `grammarInputs.current`, as `gpt-5.3-codex` has `supportsOpenAIGrammarTools`.
  - Add a test that activates, removes, and redefines tools on such a model: both diffs stay empty. Update the "Inline tool changes" row in `doc/architecture/validation.md` and the Tool-Declaration Channel in `doc/architecture/payload-guard.md`.

- [x] **Update Copilot Completions reasoning in `doc/THINKING.md`**:
  - Since Pi 1.7.0, Copilot `openai-completions` models replay the latest `reasoning_opaque` value ([#12418](https://github.com/earendil-works/pi/issues/12418)). Their `thinkingSignature` is a JSON envelope (`{ field, reasoning_opaque }`), not a field name.
  - `doc/THINKING.md` says hidden reasoning is never sent back for Completions and that the signature holds a field name. Fix both statements.
  - Decide whether to keep these messages visible-only until the opaque cost is measured, as for OpenRouter `reasoning_details`.

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
