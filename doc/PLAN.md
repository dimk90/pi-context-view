
## `Backlog`

- [x] Add recording for map row/col customization demo.

- [x] **Update demo recordings**:
  - [x] Switch to the new `S-VHS` version.
  - [x] Update Wait/WaitLine to new regex format.
  - [x] Move recording to the same folder with rendered results.

- [x] **Pi 0.86: transcript-backed system prompt and tool changes**:
  - [x] Update `src/prompt-blocks.ts` and `src/measure.ts` for XML-wrapped prompt sections: `tools`, `rules`, `docs`, `addendum`, `skills`, and `cwd`.
  - [x] Handle custom `systemPromptOptions.sections`; do not assume all text after the old footer is an extension addition.
  - [x] Account for `system` messages, section patches, and tool additions/removals in Usage without double-counting separately measured prompt/tool content.
  - [x] Include section-backed content in captured system-message previews, even when `content` is empty.
  - [x] Update the normalized `systemPromptOptions` fixture in `test/index-context.test.ts`, the 14 failing measurement tests, and the relocation fixture.
  - [x] Cover resume, branch navigation, and compaction checkpoints; update `doc/ARCHITECTURE.md` and affected UI docs.

- [x] **Pi 0.86: forced system-prompt handling**:
  - [x] Review Initial capture and Usage inputs for `before_agent_start` results returning `systemPrompt` or setting `forceSystemPrompt`.
  - [x] Pi projects forced text onto the request after `context` handlers; the transcript retains structured sections instead.
  - [x] Preserve Initial's effective-prompt read and do not treat the idle base prompt as the prompt used by the last request: Pi clears per-run options on settlement.
  - [x] Test structured and forced prompt changes in both extension orders, including a silent probe with an `after_provider_response` sentinel.
  - [x] Update the documented capture coverage and Usage semantics.

- [x] **Pi 0.86: per-model compaction budgets**:
  - [x] Pass `context.model` to `getCompactionReserveTokens()` in `src/index.ts` so the Usage map honors `compaction.modelOverrides`.
  - [x] Test model-specific reserves, fallback values, model switching, and disabled auto-compaction.

- [x] **Pi 0.86: verify cache-warming accounting**:
  - Verified no defect: warming usage/cost entries are not model context, and `buildSessionContext()` already excludes them.
  - Regression tests cover nonzero warming records before, between, and after messages, plus warming-only sessions, resume, and branch navigation.
  - Context-category totals and message previews stay unchanged for legacy and transcript-backed Usage.

- [ ] Refuse to show usage during compaction:
  - Current behavior: "If compaction is active, return a partial fallback without probing".
  - Show warning message without opening usage map?
