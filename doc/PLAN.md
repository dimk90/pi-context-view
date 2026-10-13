
## `Backlog`

- [ ] **Fix Flaky Mock-Provider Keep-Alive Race**:
  - Symptom: `a custom-message run reports the hidden tools after a change`
    (`test/hidden-tools-runtime.test.ts`) sometimes fails with
    `provider.requests.length` 1 instead of 2; the custom run ends with
    "Connection error.". Seen in about 1 of 10 `pnpm test` runs, more often
    with parallel runs.
  - Cause: the synchronous render tests (`injections-view`, `usage-view`) run
    back to back without yielding and block the shared event loop for 7-11 s.
    That is longer than the mock server's 5 s keep-alive timeout. When the loop
    resumes, timers run before network input, so the server closes the idle
    connection just as the client sends the next request on it.
  - Fix: send `Connection: close` from `test/harness/mock-provider.ts` and the
    inline server in `test/probe-runtime.test.ts`, so every request opens a new
    connection; note it in `doc/architecture/validation.md`, "Harness".
    Tested: no failures in 9 runs with three suites in parallel (before: 3 of 7).

- [ ] **Fix Visualization for > 100% After Model Switch**:
  - e.g. Opus 1M (50%) -> switch -> Sol 200k (120%).
