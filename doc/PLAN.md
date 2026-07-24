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
    untyped `thinkingSignature` field. The chars/4 heuristic sees only the
    summary and badly undercounts; chars/4 over the blob overcounts (~3×).
    The provider-reported `usage.reasoning` (typed, subset of `output`) is the
    accurate measurement when present.
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

    When the provider reports `usage.reasoning`, the invisible share is what
    the visible text does not explain. Without it, chars/4 over the signature
    is only an upper bound because encrypted blobs do not tokenize at text
    ratios; mark it `≤` so the number is not read as exact.
  - Preview changes for the Agent Thinking Messages category:
    - visible thinking content renders exactly as before (same wrapping and
      20-line cap);
    - entry headers of messages carrying a `thinkingSignature` append an
      `· encoded ≈N` (or `≤N` for the chars/4 upper bound) cell next to the
      visible token count;
    - one dim dialog description — after the scrollable entry area, before
      the hotkeys row — explains the encoded part and the estimation method;
      no per-entry repetition. Raw signature bytes are never rendered,
      previewed, or logged.
  - UI sketch: [doc/sketches/thinking-preview.md](doc/sketches/thinking-preview.md).
  - Update [doc/UI.md](doc/UI.md) Usage-preview section accordingly.

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
