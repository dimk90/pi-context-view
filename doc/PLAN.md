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
- [x] 3. **Better token estimation for Agent Thinking Messages**.
  - Some providers (e.g. `gpt-5.6-sol`) return only a short visible thinking
    summary while the full reasoning travels as an opaque encrypted blob in the
    optional `thinkingSignature` field on thinking blocks — or, for
    Gemini-style providers, in the `ToolCall.thoughtSignature` field on
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
      `thoughtSignature` append a `+ Encoded ≈N (≈T)` (or `≤N (≤T)` for the
      chars/4 upper bound) cell next to the visible token count, where `T` is
      the visible-plus-invisible message total;
    - when provider-reported reasoning exceeds the visible estimate without a
      captured signature, append `+ Reasoning ≈N (≈T)` so the extra counted
      tokens remain explicit; omit zero-size invisible shares;
    - one dim dialog description — after the scrollable entry area, before
      the hotkeys row — explains the invisible part and the estimation method;
      no per-entry repetition. Raw signature bytes are never rendered,
      previewed, or logged.
  - UI sketch: [doc/sketches/thinking-preview.md](doc/sketches/thinking-preview.md).
  - Update [doc/UI.md](doc/UI.md) Usage-preview section accordingly.
- [x] 4. **Count text added by pi's LLM transform**.
  - pi's `estimateTokens` undercounts message roles for which `convertToLlm`
    adds literal user text:
    - compaction and branch summaries gain a prefix and `<summary>` tags;
    - context-visible `bashExecution` messages gain `Ran ...`, output fences or
      `(no output)`, and optional cancellation, exit-code, and truncation text.
    This transformed text is part of provider-bound input. `bashExecution`
    represents pi's user/direct bash message type, not agent `bash` tool calls,
    which remain tool calls and tool results.
  - Use the public root exports as the source of truth instead of copying pi's
    wrapper literals:

    ```ts
    const converted = convertToLlm([message])[0];
    const tokens = converted === undefined ? 0 : estimateTokens(converted);
    ```

    Apply this to compaction summaries, branch summaries, and bash executions.
    The transform handles `excludeFromContext` bash messages by returning no
    converted message.
  - Do not count `ToolCall.id`, `ToolResultMessage.toolCallId`,
    `ToolResultMessage.toolName`, or other protocol metadata merely because a
    provider sends the fields on the wire. This does not change the existing
    counting of `ToolCall.name` and its JSON-serialized arguments. Wire presence
    does not prove that a field is tokenized, and provider serializers replay
    different subsets. A paired Anthropic token-count measurement produced the
    same input count for otherwise identical tool exchanges with 1-, 16-, and
    64-character IDs.
  - Do not add a per-message framing constant: role/block serialization
    overhead may be real but is provider-internal and not exactly measurable;
    keep it out of totals rather than introduce a fudge factor. Document it as
    a known residual in the reconciliation caveat at [AGENTS.md](../AGENTS.md).
  - The extension may consequently exceed pi's heuristic fallback or trailing
    estimate, which has the same undercount; prioritizing provider-bound text
    over parity with that heuristic is intentional. Provider-reported usage,
    when available, may instead align more closely.
  - Keep preview text unchanged and add no separate wrapper annotation: the
    transform-added text is structural. Only the affected entry token numbers
    move, and totals must still equal the exact sum of entry estimates.
  - Update the exact bash and summary expectations in `test/usage.test.ts` and
    cover normal, no-output, failed or cancelled, truncated, and
    `excludeFromContext` bash messages.
- [x] 5. **Small Visual Fixes**:
  - Use big "M" letter for millions tokens. Now the small "m" is using in
    usage view for context window size: "claude-fable-5 · 0/1m".
  - The categories are scrollable but counter "(1/14)" is on the right-top
    location (the same row with "Category") move it to bottom-left - the
    row after last category item to make it move obvious.
    when not all of categories are visible.
    The counter counts all legend rows, including the non-selectable
    Auto-Compact Buffer and Free Space rows, and its left number is the last
    visible row so it reaches the total when scrolled to the end.
  - Hide not implemented [Runtime] tab from injections view; the header keeps
    the `[INITIAL]` label alone.

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
