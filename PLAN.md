# pi-context-inspect — Development Plan

Pi extension that adds a `--context-inspect` CLI flag. When set, pi prints a
report of **initial context injections** — source (pi native or extension name)
and size in tokens — then exits. No slash command, no per-turn tracking.

```
$ pi --context-inspect
Context injections:

  SOURCE                          TOKENS
  pi: base system prompt             820
  pi: tool descriptions              412
  pi: AGENTS.md (~/.pi/agent)        135
  pi: AGENTS.md (./AGENTS.md)         96
  pi: skills                         240
  extension: plan-mode                85
  extension: <aggregate>             123
  ------------------------------------
  TOTAL                             1911
```

## Scope

**In scope**
- One boolean flag: `--context-inspect` (via `pi.registerFlag`).
- Breakdown of pi-native contributions from `BuildSystemPromptOptions`:
  base/custom prompt, tool snippets, guidelines, `--append-system-prompt`,
  context files (each file separately, with path), skills.
- Extension contributions to the startup context that are observable:
  system-prompt delta added by other extensions' `before_agent_start` handlers
  (aggregate) and injected startup messages (attributed by `customType`).
- Token counts via pi's own `estimateTokens` (estimate, not provider-exact).
- Print report to stdout, then exit.

**Out of scope**
- Injections/modifications during subsequent prompts (steering, tool results,
  compaction, `context` event mutations).
- Per-extension attribution of chained system-prompt edits (API limitation —
  handlers only see the cumulative prompt; report as one aggregate line).
- `pi context --report` subcommand syntax (pi has no extension subcommand API;
  positional args become prompt text). Optional shell alias instead.
- TUI widgets / interactive UI.

## Design

### Structure

- Single file during Prof-of-Concept: `~/.pi/agent/extensions/pi-context-inspect.ts`.
- Move to the directory after successful PoC: `~/projects/pi-context-inspect`.

### Flow

1. **Factory**: `pi.registerFlag("context-inspect", { type: "boolean", default: false })`
   plus event subscriptions. No side effects when the flag is off — every
   handler returns early on `!pi.getFlag("context-inspect")`.
2. **Capturing the data.** The base prompt inputs (`BuildSystemPromptOptions`)
   are exposed via `ctx.getSystemPromptOptions()` (command context; optional on
   plain event ctx — feature-detect) and via `event.systemPromptOptions` in
   `before_agent_start`. The chained system prompt including other extensions'
   additions only exists inside a turn. Therefore:
   - Register the `before_agent_start` handler; since extension load order
     determines chain position, document that the extension should load last
     (alphabetical/manual `-e` ordering) for accurate aggregate measurement.
   - In the handler: capture `event.systemPromptOptions` and
     `event.systemPrompt` (cumulative prompt at our chain position).
3. **Triggering a turn without a user prompt.** With just `pi --context-inspect`
   there is no prompt, so `before_agent_start` never fires.
   **DECIDED (PoC): Option B, revised.** Option A failed — see PoC findings.
   Verified flow (works in both `print` and `tui` modes, no `-p` needed):

   ```
   session_start      → pi.sendUserMessage("probe")     // always triggers a turn
   before_agent_start → capture event.systemPrompt + event.systemPromptOptions
   turn_start         → ctx.abort()                     // provider call prevented
   agent_end          → print report, ctx.shutdown()    // honored right after agent_end
   ```

   PoC findings (pi 0.80.3):
   - **Option A dead:** `ctx.getSystemPromptOptions` is NOT available on the
     `session_start` event ctx (command-context only), and
     `ctx.getSystemPrompt()` at `session_start` does NOT include other
     extensions' `before_agent_start` additions.
   - `pi.sendMessage(..., { triggerTurn: true })` does NOT start a turn in
     print mode without `-p`; `pi.sendUserMessage()` does.
   - `before_provider_request` never fires with custom providers whose
     transport skips the `onPayload` hook (observed with `pi-anthropic-oauth`)
     — unreliable as an abort point.
   - `ctx.abort()` at `turn_start` reliably prevents the provider request
     (verified via an `after_provider_response` sentinel that never fired).
   - `ctx.shutdown()` in TUI mode is deferred and honored right after
     `agent_end` (`checkShutdownRequested`); clean exit ~2s in both modes.
   - Cosmetic: the probe user message and a red "Request was aborted." flash
     in the TUI before exit. Acceptable for v1.
   - Startup messages injected by other extensions via `sendMessage` at
     `session_start` were NOT visible in `ctx.sessionManager.getBranch()` at
     `before_agent_start`; capturing them likely needs the `context` event
     during the probe turn.
4. **Measuring.** For each component, wrap text in a minimal `AgentMessage`
   shape and use `estimateTokens` from `@earendil-works/pi-coding-agent`
   (exported from the compaction module); or replicate its chars/4 heuristic if
   the message-shape ceremony is awkward.
   Components:
   - `pi: base system prompt` — `buildSystemPrompt({...options, contextFiles: [], skills: [], appendSystemPrompt: undefined})`
   - `pi: tool descriptions` — diff of prompt with/without `selectedTools`/`toolSnippets` (or measure snippets directly)
   - `pi: --append-system-prompt` — `options.appendSystemPrompt`
   - `pi: <context file path>` — one line per `options.contextFiles[]` entry
   - `pi: skills` — `options.skills` rendered size
   - `extension: <aggregate>` — `capturedChainedPrompt.length` minus reconstructed base (only if ≥ 0 and non-trivial)
   - `extension: <customType>` — startup messages in `ctx.sessionManager.getBranch()` with `role: "custom"`/custom entries present before first user prompt
5. **Output & exit.** Plain text table to `console.log` (works in `print`/`tui`
   modes; guard `ctx.hasUI` if using `ctx.ui`). Then `ctx.shutdown()`.
   Recommend running as `pi --context-inspect --no-session` (document it); the
   extension does not need `-p`.

### Edge cases

- `getSystemPromptOptions` unavailable on event ctx (it's optional in
  `ExtensionContextActions`) → feature-detect, degrade to totals-only report
  using `ctx.getSystemPrompt()`.
- No other extensions loaded → aggregate line shows 0 / omitted.
- `--no-extensions` combined with the flag → flag itself won't exist if loaded
  via discovery; document that `-e path/to/pi-context-inspect.ts` still works.
- Non-TUI modes (`-p`, `--mode json`) → stdout printing must not corrupt JSON
  mode; skip or write to stderr when `ctx.mode === "json"`.
- Token numbers are estimates → label the column `TOKENS (est.)`.

## Proof-of-Concept Steps

Goal: verify that intercepting initial context injections works at all, and
decide between capture strategies (Option A vs B). Throwaway single file,
no project setup.

- [x] 1. **Skeleton** — single file `poc.ts`: factory, flag registration,
  `session_start` handler that logs a stub and calls `ctx.shutdown()`. Verify:
  `pi -e ./poc.ts --context-inspect` exits after printing.
- [x] 2. **Spike Option A** — at `session_start`, read
  `ctx.getSystemPromptOptions?.()`, reconstruct base prompt with
  `buildSystemPrompt()`, dump raw components. Check whether
  `ctx.getSystemPrompt()` at this point includes other extensions' static
  system-prompt additions (test with `marker.ts` helper loaded).
  **Result: negative** — `getSystemPromptOptions` unavailable at
  `session_start`; extension injections not visible in `getSystemPrompt()`.
- [x] 3. **Spike Option B** — synthetic turn, capture in `before_agent_start`,
  abort at `turn_start`; verified no API call, clean exit in print + TUI.
  Files: `poc-b.ts` (spike), `marker.ts` (simulated injecting extension).
- [x] 4. **Decision: A or B** — recorded in Design § Flow item 3.
    - **Decided**: **Option B (revised)** — `sendUserMessage` probe +
      `before_agent_start` capture + `turn_start` abort + `agent_end`
      report/shutdown.

## Development Steps

Starts fresh from project initialization; PoC code is reference material only.

- [x] 1. **Project initialization** — init `pi-context-inspect/` directory:
  - `package.json` (name, version `0.0.1`, `"pi": { "extensions": ["./index.ts"] }`,
  deps if any);
  - `tsconfig.json` if needed;
  - `.gitignore` (`node_modules/`);
  - `git init` + initial commit;
  - Empty `index.ts` with factory skeleton;
  - Init `AGENTS.md`, move to it relevant parts of `PLAN.md`.
  - Verify `pi -e ./pi-context-inspect/index.ts` loads.
- [x] 2. **Capture implementation** — implement the chosen strategy (A or B)
  properly: flag no-op guard, feature detection, clean shutdown.
  Also captures extension-injected startup messages via the `context` event
  (resolves the open question: they ARE visible there, with `customType`),
  filtering out the probe message itself.
- [x] 3. **Component measurement** — per-component token estimation; pure
  functions in helper module (unit-testable, no `pi` access).
  Implemented in `measure.ts` by carving the captured system prompt on
  structural markers emitted by pi's `buildSystemPrompt()` (the function
  itself is not importable — blocked by the package `exports` map):
  `<project_instructions path>` spans, skills block, `appendSystemPrompt`
  substring, and the trailing `Current date/cwd` line as the base-prompt end
  marker; everything after it is the extensions aggregate. Context messages
  measured with pi's `estimateTokens`.
- [x] 4. **Report rendering** — aligned plain-text table, total row, sorting by size
  descending within groups (pi first, extensions second).
  Implemented in `report.ts` (pure module): dynamic column widths,
  `TOKENS (est.)` header, thousands separators, `renderReport()` called from
  `agent_end`.
- [ ] 5. **Edge-case handling** — mode guards, missing options, zero extensions.
- [ ] 6. **Manual test matrix**
  - `pi -e ./pi-context-inspect/index.ts --context-inspect` (no other extensions)
  - with another injecting extension loaded (e.g. plan-mode example)
  - with project `AGENTS.md` present/absent
  - with `--append-system-prompt "text"`
  - with `--no-context-files`, `--no-skills`
  - normal run without the flag → extension must be a no-op
- [ ] 7. **Docs** — README with usage, the "load last for accurate aggregate" note,
  and the `alias pi-context='pi --context-inspect --no-session'` tip.
- [ ] 8. **Install locally** — add the directory to discovery
  (`~/.pi/agent/extensions/` symlink or settings `"extensions"` path),
  verify discovery + `/reload`.
- [ ] 9. **Publish** — push to a public git repo (GitHub), tag `v0.1.0`; optionally
  publish to npm so it installs via `pi install npm:pi-context-inspect` /
  `git:github.com/<user>/pi-context-inspect`. Verify `pi install` + `pi list`.

## Further Enhancements

- [ ] **Interactive TUI browser** (like `pi config`) — instead of (or in addition
  to) the plain table, open a `ctx.ui.custom()` component listing all injections
  (source + token size); arrow keys / j/k to navigate, Enter to expand an item
  and view the full injected text (scrollable), Esc to go back / exit.
  - Only in `ctx.mode === "tui"`; fall back to the plain-text table in
    `print`/`json`/`rpc` modes.
  - Reuse pi TUI components (`SettingsList` pattern from the `tools.ts`
    example, scrollable text view) — see skill `references/tui.md`.
  - Consider a second flag or making it the default TUI behavior of
    `--context-inspect`, with `--context-inspect-plain` for the table.

## Open Questions

- ~~Does `ctx.getSystemPrompt()` at `session_start` include other extensions'
  static system-prompt contributions, or only pi's base?~~ **Resolved (PoC):
  no — Option B chosen.**
- ~~Exact `estimateTokens` input shape~~ **Resolved (PoC):**
  `estimateTokens(message: AgentMessage)`; wrapping text as
  `{ role: "user", content: text }` works.
- ~~How to capture startup **messages** injected by other extensions?~~
  **Resolved (step 2):** visible in the `context` event during the probe turn
  as `role: "custom"` messages with `customType`; probe message filtered out.
- Can the TUI probe flash ("probe" + "Request was aborted.") be suppressed or
  is it acceptable for v1? (v1: accept.)
- Should the report also print the injected **text** (the earlier idea) behind
  a second flag like `--context-inspect-full`, or keep v1 sizes-only? (v1:
  sizes-only per current scope; TUI browser covers it later.)
