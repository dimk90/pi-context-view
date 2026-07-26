# Agent thinking token counting

Implementation and measurement notes behind the **Agent Thinking Messages**
estimate and preview. Measurements were taken on 26.07.2026 against pi 0.82.1,
`claude-opus-5` and `claude-fable-5`, using OAuth transport.
[UI.md](UI.md) remains the canonical UI specification.

## Summary

Opaque reasoning can occupy the context window even when only a short summary
is visible. Prefer the provider-reported `usage.reasoning` count when present.
A `thinkingSignature` or `thoughtSignature` is an authenticated envelope, not
the thinking text: never tokenize its bytes as text or copy them into extension
state, previews, or logs. Its character count supplies only a rough fallback
proxy, which is excluded
from category totals.

## Counting architecture

The estimator accounts for thinking once per assistant message. It computes:

```text
visibleTokens  = ceil(sum(visible thinking chars) / 4)
reportedTokens = finite non-negative usage.reasoning, when present
countedTokens  = max(visibleTokens, reportedTokens ?? 0)
signatureChars = sum(thinkingSignature chars + thoughtSignature chars)
```

`countedTokens` contributes to the **Agent Thinking Messages** category. `max`
is used instead of addition because `usage.reasoning` describes reasoning
already represented, at least partly, by the visible text.

The preview derives one invisible-reasoning annotation per message:

```text
if reportedTokens is present:
    invisibleTokens = max(0, reportedTokens - visibleTokens)
    basis = provider-reported
else if signatureChars > 0:
    invisibleTokens = ceil(signatureChars / 4)
    basis = signature proxy
```

A positive provider-reported invisible share is already included in
`countedTokens`. A signature-only proxy is metadata for the preview and is
**not** added to category totals. The annotation records only its token count,
basis, and whether a signature was present; raw signature bytes are not copied
into the view model. It is attached once to the first thinking preview entry,
or to an empty assistant entry when the message has encoded reasoning but no
visible thinking block.

For messages with multiple visible thinking blocks, chars/4 rounding is pooled
across the message and then allocated back to the individual preview entries.

## Retention is model-dependent

Current Anthropic documentation ([Context
windows](https://docs.claude.com/en/docs/build-with-claude/context-windows),
"The context window with thinking") splits behavior by model:

- Opus 4.5 and later Opus, Sonnet 4.6 and later Sonnet, Fable 5, Mythos 5,
  and Mythos Preview keep previous thinking blocks by default, and they count
  toward the context window like any other input tokens;
- earlier Opus and Sonnet models and all Haiku models strip previous thinking
  from the history automatically when it is passed back.

Thinking tokens are billed as output when generated. On keep-all models the
retained blocks are then billed again as ordinary input on later requests. The
older "thinking blocks from previous turns are ignored" rule still exists but
is no longer universal, so a retention claim is only meaningful per model.

## The signature is an envelope, not the content

Measured on one real 15,656-character `thinkingSignature` from a
`claude-fable-5` turn, using the free `count_tokens` endpoint:

- assistant text only, no thinking — 16 tokens;
- the same signature as a signed `thinking` block — 4,127 tokens;
- the same signature bytes as a `text` block — 14,860 tokens.

The block form costs about 3.6× less than the identical bytes as text: the
server replaces the envelope with the reconstructed thinking rather than
tokenizing base64. The envelope is also authenticated — corrupting a span
while preserving length, or truncating it by half, both fail with HTTP 400
`Invalid \`signature\` in \`thinking\` block`. It therefore cannot be decoded,
re-tokenized, or length-adjusted client-side.

Two consequences for estimation:

- never count signature characters as text tokens;
- `ceil(signatureChars / 4)` is **not** an upper bound. On the Fable session
  97,916 signature characters give 24,479 by chars/4, while the measured
  context cost is 25,936. Describe it as a proxy, never with `≤`.

## Calibration

Marginal `count_tokens` cost of including each message's signed thinking
blocks, against the same history with those blocks removed:

- session `019f9aeb`, `claude-fable-5`, 10 messages: 97,916 signature chars,
  25,936 context delta, 3.78 chars per token;
- session `019f9902`, `claude-opus-5`, 22 messages: 58,532 signature chars,
  13,313 context delta, 4.40 chars per token.

The ratio is model-dependent and not 4, and it drifts with block size (small
blocks reach 5–8 chars/token because envelope overhead dominates), so a single
shared constant is not defensible.

`usage.reasoning` avoids the constant entirely. Across nine stock-pi assistant
turns where the field is populated — six `claude-fable-5` and three
`claude-opus-5`, signatures from 340 to 968 characters — the provider-reported
value matched the measured context delta **exactly in every case** (29/29,
11/11, 56/56, 261/261, 50/50, 183/183, and 50/50 three times).

The same nine turns show why the visible thinking text cannot stand in for it:
chars/4 over the visible summary misses the true cost by −9 to +219 tokens,
because a short summary can front an arbitrarily long encoded reasoning trace.

Prefer `usage.reasoning`; fall back to the signature proxy only when it is
absent, and present the fallback as approximate.

## Preview presentation

Entry headers show the visible-text estimate first, then the invisible
reasoning estimate, then their total in parentheses. `≈` marks a
provider-reported (`usage.reasoning`) derivation. `~` marks the rough chars/4
signature proxy when no reasoning breakdown is available. If
provider-reported reasoning exceeds the visible estimate without either
signature, `+ Reasoning ≈N (≈T)` keeps the counted share explicit. Zero-size
invisible shares render no extra cell.

```text
Agent Thinking Messages                                      1.4k

  [24-07-2026 17:15:02] [assistant] 594 + Encoded ≈547 (≈1.1k)
    I need to check how the session context is built
    before deciding where the filter belongs…
    … +3 lines

  [24-07-2026 17:16:48] [assistant] 131 + Encoded ~1.1k (~1.3k)
    Now wire the estimate into the category totals.

  [24-07-2026 17:18:03] [assistant] 56 + Reasoning ≈32 (≈88)
    Done; totals already reconcile.

  Entry headers read: [DD-MM-YYYY] [assistant] visible + Reasoning
  ≈invisible (≈total). ≈ is a provider-reported count; ~ is a rough
  signature-size proxy shown when no breakdown is reported and excluded
  from category totals. Encoded replaces Reasoning when the provider
  replays encrypted reasoning with its message.

  ↑↓ Scroll · PgUp/PgDn Page · Esc Back
```

The `+ Encoded ≈N (≈T)`, `+ Encoded ~N (~T)`, or
`+ Reasoning ≈N (≈T)` header cell uses the same dim treatment as the token
count. One dim, width-wrapped description appears after the scrollable entries
and before the hotkeys row; there are no per-entry marker rows. Raw signature
bytes are never rendered, previewed, or logged.

## Reading provider counters

Cache and input counters describe what was billed for the payload actually
sent. They cannot prove what a correct payload would cost, and they cannot
prove that the server stripped anything. Separating the two questions requires
either a captured wire payload or a `count_tokens` comparison of the same
history with and without the blocks. Whole-session arithmetic over
`cacheRead`/`cacheWrite` deltas conflates them and will confirm whichever
client behavior is present.
