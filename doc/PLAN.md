# Development Plan

## Status

- [AGENTS.md](AGENTS.md) - current architecture;
- [doc/UI.md](doc/UI.md) - the UI specification;
- [doc/HISTORY.md](doc/HISTORY.md) - legacy, superseded designs and architecture decisions;
- [CHANGELOG.md](CHANGELOG.md) for completed work.

## v0.3.0

- [x] 1. **Icon and category for Auto-Compact buffer**.
  - Add "Auto-Compact Buffer" category shows tokens which will be never occupied
    because compaction will be triggered before it.
  - The "Auto-Compact Buffer" category should be showed before "Free Space" category.
  - The "Auto-Compact Buffer" icons (⛝) should be showed at the end of the usage map.
  - The "Auto-Compact Buffer" category is not selectable item.
  - Hide the buffer entirely when auto-compaction is disabled in settings.
- [x] 2. **Change a dialog description color to dim**.
- [ ] 3. **Better token estimation for Agent Thinking Messages**.
  - Some providers (e.g. `gpt-5.6-sol`) return only a short visible thinking
    summary while the full reasoning travels as an opaque encrypted blob in the
    untyped `thinkingSignature` field on thinking blocks — or, for
    Gemini-style providers, in the typed `ToolCall.thoughtSignature` field on
    tool-call blocks. The chars/4 heuristic sees only the summary and badly
    undercounts; chars/4 over the blob overcounts (~3×). The provider-reported
    `usage.reasoning` (typed, subset of `output`) is the accurate measurement
    when present.
  - Category estimate, per assistant message:

    ```text
    thinkingTokens = max(ceil(visibleThinkingChars / 4), usage.reasoning ?? 0)
    ```

    `max`, not sum: for providers with full visible thinking text the chars/4
    estimate already covers the reasoning tokens, and adding `usage.reasoning`
    would double count. Access `usage.reasoning` defensively; it is `undefined`
    for providers without a reasoning breakdown.
  - Invisible-part estimate for the preview, per assistant message:

    ```text
    invisibleTokens = usage.reasoning !== undefined
        ? max(0, usage.reasoning - ceil(visibleThinkingChars / 4))
        : ceil(signatureChars / 4)   // upper bound, render with "≤"
    ```

    `signatureChars` sums `thinkingSignature` chars across thinking blocks and
    `thoughtSignature` chars across tool-call blocks of the message. When the
    provider reports `usage.reasoning`, the invisible share is what the
    visible text does not explain. Without it, chars/4 over the signatures is
    only an upper bound because encrypted blobs do not tokenize at text
    ratios; mark it `≤` so the number is not read as exact.
  - Preview changes for the Agent Thinking Messages category:
    - visible thinking content renders exactly as before (same wrapping and
      20-line cap);
    - entry headers of messages carrying a `thinkingSignature` or
      `thoughtSignature` append an `· encoded ≈N` (or `≤N` for the chars/4
      upper bound) cell next to the visible token count;
    - one dim dialog description — after the scrollable entry area, before
      the hotkeys row — explains the encoded part and the estimation method;
      no per-entry repetition. Raw signature bytes are never rendered,
      previewed, or logged.
  - UI sketch: [doc/sketches/thinking-preview.md](doc/sketches/thinking-preview.md).
  - Update [doc/UI.md](doc/UI.md) Usage-preview section accordingly.
- [ ] 4. **Count replayed tool-exchange identifiers and summary wrappers**.
  - pi's `estimateTokens` ignores provider-replayed structural text that is
    verifiably sent on the wire:
    - `ToolCall.id` (sent as `tool_use_id`/`call_id`; OpenAI-style APIs send
      the ID twice — on the call and on its output) and
      `ToolResultMessage.toolCallId` plus `toolName` — ~1K tokens on a
      measured 42K-token branch;
    - `convertToLlm` wrapper text around compaction and branch summaries
      (prefix + `<summary>` tags, ~25–30 tokens each) — we currently count
      only the bare `summary`.
  - Additions, all exact chars/4 accounting:
    - Agent Tool Call Messages: add `block.id.length` per tool-call block;
    - Tool Output: add `toolCallId.length + toolName.length` per tool result;
    - Compacted Data: estimate the wrapped text
      (`PREFIX + summary + SUFFIX`), matching what `convertToLlm` actually
      sends, for both compaction and branch summaries.
  - Do not add a per-message framing constant: role/block serialization
    overhead (~4 tokens/message) is real but provider-internal and not
    exactly measurable; keep it out of totals rather than introduce a fudge
    factor. Document it as a known residual next to the existing
    reconciliation caveats.
  - Preview entries are unchanged: IDs and wrapper text are structural, not
    content; only the token numbers move. Totals must still equal the exact
    sum of entry estimates, so fold the additions into each entry's `tokens`.

## v0.4.0

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


## v0.5.0

- [ ] **Add bounded opt-in Runtime mutation logging.**
  - Enable the Runtime view and restore `/context runtime on|off`.
  - Record only hidden provider-bound mutations; exclude normal transcript
    growth and unchanged context.
  - Keep logging disabled by default, memory-only, and bounded to 200 entries
    and 1 MiB, with request indexing and eviction reporting.

## Open question

- For v0.5.0 context-only message mutations, should the Runtime view explain
  chain-position visibility limits inline or leave that detail to documentation?
