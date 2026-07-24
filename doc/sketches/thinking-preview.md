# Sketch: Agent Thinking Messages preview

UI sketch for PLAN.md v0.3.0 step 3 (better token estimation for Agent
Thinking Messages). Not yet part of [UI.md](../UI.md); fold it in when the
step is implemented.

Entry headers carry both numbers: the visible-text estimate first, then the
invisible (encoded) reasoning estimate. `≈` marks a provider-reported
(`usage.reasoning`) derivation; `≤` marks a chars/4 upper bound over the
encrypted blobs (`thinkingSignature` on thinking blocks plus
`thoughtSignature` on tool-call blocks) when the provider reports no
reasoning breakdown. Entries without either signature render the header
unchanged.

One dim dialog description explains the encoded part once, placed after the
scrollable entry area and before the hotkeys row. No per-entry marker rows.

```text
Agent Thinking Messages · 2/7 · ≈8.4K

  [24-07-2026 17:15:02] [assistant] 594 · Encoded ≈547
    I need to check how the session context is built
    before deciding where the filter belongs…
    … +3 lines

  [24-07-2026 17:16:48] [assistant] 131 · Encoded ≤1,126
    Now wire the estimate into the category totals.

  [24-07-2026 17:18:03] [assistant] 88
    Done; totals already reconcile.

  Encoded: provider-specific encrypted reasoning replayed with the
  message but never shown. Estimated from provider-reported reasoning
  tokens minus the visible-text estimate; ≤ marks a chars/4 upper
  bound when the provider reports no reasoning breakdown.

  ↑↓ scroll · Esc back
```

Styling:

- the `· Encoded ≈N` / `· Encoded ≤N` header cell uses the same dim
  treatment as the token count;
- the description block uses `dim` (standard dialog-description color),
  wraps with width, and does not scroll with the entry area;
- raw signature bytes are never rendered, previewed, or logged.
