# Sketch: Agent Thinking Messages preview

UI sketch for PLAN.md v0.3.0 step 3 (better token estimation for Agent
Thinking Messages). [UI.md](../UI.md) is the canonical implemented behavior.

Entry headers carry three numbers: the visible-text estimate first, then the
invisible reasoning estimate, then the visible-plus-invisible message total in
parentheses. `≈` marks a provider-reported (`usage.reasoning`) derivation;
`≤` marks a chars/4 upper bound over the encrypted blobs (`thinkingSignature`
on thinking blocks plus `thoughtSignature` on tool-call blocks) when the
provider reports no reasoning breakdown. If provider-reported reasoning
exceeds the visible estimate without either signature, `+ Reasoning ≈N (≈T)`
keeps that counted share explicit. Zero-size invisible shares render no extra
cell.

One dim dialog description explains the encoded part once, placed after the
scrollable entry area and before the hotkeys row. No per-entry marker rows.

```text
Agent Thinking Messages                                      1.4k

  [24-07-2026 17:15:02] [assistant] 594 + Encoded ≈547 (≈1.1k)
    I need to check how the session context is built
    before deciding where the filter belongs…
    … +3 lines

  [24-07-2026 17:16:48] [assistant] 131 + Encoded ≤1.1k (≤1.3k)
    Now wire the estimate into the category totals.

  [24-07-2026 17:18:03] [assistant] 56 + Reasoning ≈32 (≈88)
    Done; totals already reconcile.

  Entry headers read: [DD-MM-YYYY] [assistant] visible + Reasoning
  ≈invisible (≈total). ≈ is a provider-reported count; ≤ is a chars/4
  upper bound shown when no breakdown is reported and excluded from
  category totals. Encoded replaces Reasoning when the provider replays
  encrypted reasoning with its message.

  ↑↓ Scroll · PgUp/PgDn Page · Esc Back
```

Styling:

- the `+ Encoded ≈N (≈T)` / `+ Encoded ≤N (≤T)` / `+ Reasoning ≈N (≈T)`
  header cell uses the same dim treatment as the token count;
- the description block uses `dim` (standard dialog-description color),
  wraps with width, and does not scroll with the entry area;
- raw signature bytes are never rendered, previewed, or logged.
