
# Backlog

- [x] **Update to Pi 1.6.1**:
  - Bump the four Pi development pins to `1.6.1` and run `pnpm install`.
  - Pi 1.6.1 fires `after_provider_response` for HTTP 4xx/5xx responses and for each retried attempt on OpenAI, Azure OpenAI, Anthropic, and Google models ([#12376](https://github.com/earendil-works/pi/issues/12376)).
  - Fix `test/dispatch-runtime.test.ts` ("assistant events carry the dispatch identity, also for a failure"): the HTTP 500 case now expects `after_provider_response` before the assistant events.
  - Update `doc/architecture/payload-guard.md` (Event order) and `doc/architecture/pi-requests.md` (response side), which say error responses skip `after_provider_response`.
  - Run `pnpm check`.

- [ ] **Stop repeating probe identities in the session**:
  - Each `pi-context-view:probe-identities` entry stores every known identity, restored ones included (`SilentProbe.persistIdentities()`), so the session file grows quadratically with probe count.
  - Seen in a long session: 369 entries took 6.2 MB of 9.7 MB, and the last one alone held all 752 identities.
  - Write only the identities recorded since the last write. `session_start` already merges every entry, so old sessions keep working.
  - Update `doc/architecture/probe.md` and the persistence tests.

- [ ] Fix more than 100% context windows:
  - Discuss what to do.

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
