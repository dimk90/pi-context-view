# Request snapshot overhead

## Scope and method

- Current `src/capture/request.ts`, `src/capture/builder.ts`, `src/capture/diff.ts`, and `src/snapshot.ts`, called directly without changing production code.
- Node v26.4.0, Pi 1.0.2, Intel Core i7-8650U, virtualized Linux. Results are machine- and workload-specific, not universal budgets.
- Synthetic data only. Actual `SessionManager.inMemory()` and `ProbeFilter`, including two recorded probe identities that do not match the synthetic conversation.
- Mixed user, assistant thinking/text/tool-call, and tool-result messages; 16 KiB of prompt sections and 12 synthetic tool definitions. No real provider calls or real session content.
- Each scenario: 30 warmups, 150 paired capture/build samples. Repeat in reverse scenario order in a fresh process, again with 30 warmups and 150 samples.
- `captureRequest()` measured synchronously. `buildRequestSnapshot()` and `SnapshotStore.publish()` measured inside a real `setImmediate` callback. Total is the paired sum of those two execution times, excluding queue waiting.
- Fixture generation, Pi's original request preparation/clone, and imports are outside timing. These measurements exclude extension dispatch, `ctx.getSystemPrompt()` prompt construction, the separate request-side probe filter, tracker/guard bookkeeping, provider serialization, network time, and UI rendering. They measure the recurring capture/build core, not total Pi request latency.
- The first run also times isolated components. Those overlap (message keys are part of the conversation diff), have different cache/GC conditions, and must not be added as if they were paired samples.
- Two runs show appreciable VM/load/GC variation, especially for large binary payloads and extensive edits. Report ranges, not false precision.
- All normal, image, metadata, signature, and compacted cases assert empty changes. The addition, rewrite, and reorder cases assert their expected change counts. A tiny result therefore does not bypass the measured work.

## Results

All times below are milliseconds per request. Ranges span the two runs' medians, not min/max individual requests. Sizes in names describe conversation text; JSON size includes system prompt, metadata, and encoding overhead. MiB = 1,048,576 bytes. Estimated tokens include the prompt and tool definitions, using Pi's heuristic described below; they are not tokenizer measurements.

| Scenario                                      | Conversation messages | Request JSON MiB | Est. tokens (Pi) | Synchronous capture | Deferred build | Combined execution | Combined p95, range of two runs |
| --------------------------------------------- | --------------------: | ---------------: | ---------------: | ------------------: | -------------: | -----------------: | ------------------------------: |
| 32 KiB text                                   |                    40 |            0.061 |           13,664 |           0.26–0.39 |      0.46–0.63 |          0.73–1.02 |                       1.23–1.26 |
| 256 KiB text                                  |                   160 |            0.310 |           71,582 |           0.93–1.04 |      2.13–2.21 |          3.07–3.27 |                       3.73–3.84 |
| 1 MiB text                                    |                   500 |            1.146 |          269,841 |           2.80–3.69 |      7.17–9.07 |        10.00–12.74 |                     12.13–13.79 |
| 4 MiB text                                    |                 1,000 |            4.293 |        1,058,762 |           8.44–8.69 |    24.82–26.62 |        33.51–35.69 |                     39.50–42.32 |
| 1 MiB text plus one 2 KiB injection            |                   501 |            1.148 |          270,354 |           3.11–3.15 |      7.78–7.95 |        10.98–11.07 |                     12.53–12.68 |
| 1 MiB text across many small messages          |                 5,000 |            2.188 |          292,466 |         27.17–30.13 |    44.74–47.83 |        72.07–78.92 |                    89.33–114.03 |
| 1 MiB text plus 8 MiB base64 image data         |                   500 |            9.146 |          274,641 |          9.98–10.09 |    50.64–57.94 |        60.39–68.68 |                    76.77–144.93 |
| 1 MiB text plus 8 MiB tool-result details       |                   500 |            9.233 |          269,841 |          8.32–13.72 |     8.26–14.73 |        16.82–28.25 |                     22.97–60.10 |
| 1 MiB text plus 4 MiB synthetic signatures      |                   500 |            5.146 |          269,841 |          6.19–10.75 |    27.14–54.87 |        33.80–64.74 |                    42.06–132.06 |
| Rewrite all messages, 1 MiB text               |                 1,000 |            1.289 |          274,762 |           6.80–9.93 |    38.82–63.38 |        46.39–74.08 |                     64.85–93.93 |
| Reverse conversation order, 1 MiB text         |                   500 |            1.146 |          269,841 |           3.14–3.59 |    14.31–17.42 |        17.44–21.02 |                     20.43–23.85 |
| 256 KiB text after 20,000 old compacted messages |         160 + summary |            0.310 |           71,589 |           3.67–5.48 |      2.18–2.75 |          5.85–8.32 |                       8.25–9.79 |

The deferred time runs on the same thread, not a worker. Combined execution is not necessarily added time to first provider token: deferred work can overlap network waiting. Synchronous capture directly delays request preparation; either phase can delay other main-thread activity.

### Token estimates and realistic sizes

Counts were calculated separately from the same fixtures, without changing or rerunning the timed measurements. They follow Pi 1.0.2's projection fallback: replay system messages with `getCurrentSystemMessage()`, estimate that state once with `estimateTokens()`, then add `estimateTokens()` for every non-system message. This ignores the synthetic assistant messages' zero usage counters.

- Pi uses roughly four characters per token, with per-message rounding. It includes visible thinking text, tool-call names/arguments, prompt sections, and tool declarations. The prompt and tool definitions contribute **5,294 estimated tokens** in every fixture.
- Images use Pi's fixed **1,200-token proxy per image**, independent of base64 size. The four images add 4,800 estimated tokens, not 8 MiB divided by four.
- Tool-result `details` and opaque signatures add no tokens under this heuristic, despite increasing capture work. This is Pi's estimate, not the extension's separate signature-size reasoning proxy or a provider's billed token count.
- The many-small-messages case has additional tool-call content and per-message rounding, so its token estimate differs from the 500-message case despite the same nominal text budget.
- Old compacted messages are not counted: only the active projection and its summary contribute. Their saved entries still affect baseline reconstruction time.

The suite mixes working-size and stress cases; it was not calibrated to a particular model's window. **13.7k and 71.6k tokens** are plausible working sizes for 128k/200k windows. **269.8k tokens** is a large-context case that exceeds those windows under this estimate, before reserving output space. **1.059 million tokens** is a stress case, slightly above even a one-million-token window. The image/metadata/signature cases additionally stress bytes processed independently of token count.

These synthetic fixtures use repeated code-like ASCII text, not sampled real conversations. Their byte and object sizes are useful for measuring capture cost, but their true token counts depend on the model's tokenizer. The report does not yet contain dedicated 128k or 200k fixtures, so it should not claim measured overhead specifically at those sizes.

## Where the work goes

Isolated component medians from run 1:

| Work                                                              | 1 MiB text | 4 MiB text |
| ----------------------------------------------------------------- | ---------: | ---------: |
| `structuredClone(event.messages)`                                 |       2.58 |       6.10 |
| Reconstruct/filter baseline                                       |       0.29 |       0.59 |
| Detect forced prompt against baseline                             |       0.04 |       0.07 |
| Conversation diff, including keys                                 |       7.36 |      22.79 |
| Canonical key creation alone, both sides (included in diff above) |       6.01 |      18.87 |
| Replay/compare system state                                       |       0.12 |       0.21 |

Main findings:

1. Full-context canonical serialization dominates the ordinary conversation diff. It happens even when no message changed; common-prefix/suffix alignment only helps after keys have already been computed.
2. Every message is re-cloned on every request, including metadata not used for matching. Large `details` values increase capture cost even though conversation keys exclude them.
3. Images and signatures are serialized into keys before redaction. Redacting changed messages after the diff does not avoid this cost for unchanged history.
4. Message count matters independently of text size, because structuredClone, projection wrappers, canonical object handling, and alignment bookkeeping all allocate objects.
5. The baseline calls Pi's projection builder, which traverses saved history. With 20,000 compacted old entries, its isolated median was 4.25 ms, versus 0.08 ms for the equally sized short session.
6. Extensive modifications/reordering also make Myers alignment costly. Ordinary empty-diff performance should not be used as its worst-case bound.

## Work that can move to `/context`

Subject to an explicit architecture change, not implemented here:

| Work                                                   | Can be delayed?                          | Required capture-time data                                                                   |
| ------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| Baseline projection and source-entry mapping           | Yes                                      | Historical `leafId`; session entries remain append-only. Preserve probe-filter semantics.    |
| Forced-prompt detection                                | Yes, the comparison                      | Capture the effective prompt string now; idle prompt options are not the past run's options. |
| System replay and section/tool comparison              | Yes                                      | Owned captured system messages plus the historical baseline.                                 |
| Conversation canonicalization and Myers alignment      | Yes                                      | Owned captured message contents and historical baseline.                                     |
| Attribution, change assembly, and snapshot publication | Yes, with a changed publication contract | Retain the small provenance fields actually needed; do not rely on mutable handler objects.  |
| Token estimates and UI composition                     | Already command-time                     | No recurring request-time savings available here.                                            |

Cannot simply postpone:

- Saving the request message state: later handlers share and can mutate the event's arrays, content blocks, schemas, and tool arguments. A shallow array copy or retaining the event reference is unsafe.
- Capturing the effective prompt, leaf ID, origin, request ID, and time.
- Privacy-preserving treatment of data that will now remain retained until replacement or inspection.
- Required request/probe tracking and guard settlement.

## Recommended direction

1. Build Initial once, preserving the first-per-origin behavior where required. It does not need repeated work as Latest advances.
2. Retain only the newest owned capture needed for Latest, replacing the previous pending capture without analyzing it.
3. Materialize Latest when `/context` or `/context usage` needs it; cache the built result by capture ID. `/context injections` should not force analysis of an unrelated Latest capture. `/context config` should do neither.
4. Rebuild the historical baseline and detect the forced prompt only during that materialization.
5. Keep materialization behind the existing layer boundary: view modules should not import capture internals.

For ordinary text cases, deferring the build alone removes about 70–75% of the measured recurring work. Deferring baseline reconstruction and forced-prompt comparison removes additional capture-time work, particularly with long saved histories. The measured 2.58 ms clone cost for 1 MiB text is an indication of the remaining work, not a benchmark of a finished lazy implementation. Sanitization, equality evidence, storage, getters, and tracking still cost time.

### Retention and privacy trade-off

Today the full transcript clone is short-lived. A lazy build keeps request data longer. In separate forced-GC samples, retaining the current captured request added roughly 1.3 MiB heap for the 1 MiB text fixture, 4.6 MiB for 4 MiB text, and 9.3 MiB for the image fixture. The unchanged built snapshot serialized to just 181 bytes. JSON size is not heap size, and these are approximate retention deltas, not peak memory measurements.

Do not implement lazy retention by simply holding the existing raw clone indefinitely. It would retain base64 images and opaque provider signatures beyond the current short-lived capture boundary. A retained representation must remove those raw bytes, keep required size information, and preserve sufficient equality evidence for the intended diff semantics. In particular, image size alone cannot distinguish different images of the same size. Comparing only redacted size markers would silently lose changes. Signature handling must also respect the existing length-only privacy contract.

A second optimization, after the lazy architecture is agreed, is an owned, field-selective copy instead of whole-object `structuredClone`: copy mutable containers that consumers actually use, share immutable strings where safe, and avoid unrelated tool `details`, display-only metadata, and usage data when genuinely unused. This needs correctness tests across all message roles and unknown-role handling. It is not safe to replace the deep clone with a shallow spread.

### Contract change

`doc/ARCHITECTURE.md` and D11 in `doc/REQUEST-ONLY-INJECTIONS.md` currently promise ready structured snapshots and subscriber publications for every request, independently of view consumers. Lazy materialization changes that promise and probe readiness semantics; update the contract and focused tests rather than silently making existing synchronous readers/subscribers stale. This report proposes a direction, not an implemented API or performance guarantee.

## Reproduction and verification

Files are outside the repository in `/tmp/pi-context-view-bench.nNKHpS/`:

- `benchmark.ts`: benchmark harness, with `node_modules` symlinked to the current worktree dependencies.
- `results-1.jsonl`: first run, including component and memory measurements.
- `results-2.jsonl`: reverse-order repeat, paired pipeline and memory measurements.
- `token-estimates.jsonl`: Pi token estimates for the same fixtures, including prompt/tool and conversation subtotals.
- `check.log`: `pnpm check`, 386 tests passed, zero failures.

Run:

```text
node --expose-gc /tmp/pi-context-view-bench.nNKHpS/benchmark.ts
SAMPLES=150 WARMUPS=30 DETAILS=0 REVERSE=1 node --expose-gc /tmp/pi-context-view-bench.nNKHpS/benchmark.ts
TOKENS_ONLY=1 node /tmp/pi-context-view-bench.nNKHpS/benchmark.ts
```

Optional `CASE=text-1MiB` selects one fixture. Imports point to this worktree, so rerunning after production edits measures the edited code. This is a temporary artifact, not an installed extension or a repository benchmark addition.

The harness passes strict TypeScript checking. No production or test code in the repository was changed by this investigation; only this report was saved and updated. Existing/concurrent user edits were left untouched.

Capture source SHA-256 values:

```text
0556beb8e2f793372c4de746792c7584a08458010e8da4a4890f0286f80be174  src/capture/request.ts
2c4446a264e00d904f8034bd7eced7eaf2df66e0e263aa6c52b44ef481570fa2  src/capture/builder.ts
03b3bc604dcce4e7d17bee7b701ca3e782168ff3d4db66b6f9e9dba2e267cf97  src/capture/diff.ts
```
