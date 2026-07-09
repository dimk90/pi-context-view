# pi-context-inspect

Pi extension: adds a `--context-inspect` CLI flag that prints a report of
**initial context injections** — source (pi native or extension) and size in
estimated tokens — then exits. Startup injections only; no per-turn tracking,
no slash command.

## Architecture

Capture strategy — "Option B revised", validated by PoC against pi 0.80.3:

```
session_start      → pi.sendUserMessage("probe")     // always triggers a turn
before_agent_start → capture event.systemPrompt + event.systemPromptOptions
turn_start         → ctx.abort()                     // provider call prevented
agent_end          → print report, ctx.shutdown()    // honored right after agent_end
```

Hard-won constraints (do not regress):

- `ctx.getSystemPromptOptions` is unavailable on `session_start` event ctx;
  extension system-prompt additions are only observable inside a turn.
- `pi.sendMessage(..., { triggerTurn: true })` does NOT start a turn in print
  mode without `-p`; `pi.sendUserMessage()` does.
- `before_provider_request` never fires with custom providers whose transport
  skips `onPayload` (e.g. pi-anthropic-oauth) — never rely on it.
- `ctx.abort()` must happen at `turn_start`; later is too late.
- Per-extension attribution of chained system-prompt edits is impossible via
  the API; report extension prompt additions as one aggregate line.

## Layout

- `index.ts` — extension factory, event wiring (entry point via `package.json`
  `pi.extensions`).
- Pure logic (measurement, formatting) goes to helper modules with no `pi`
  access, unit-testable.
- `PLAN.md` — full development plan, PoC findings, step checkboxes. Keep the
  checkboxes current.
- `poc.ts`, `poc-b.ts`, `marker.ts` — throwaway PoC spikes, reference only;
  `marker.ts` doubles as a test helper that simulates an injecting extension.

## Testing

```bash
# print mode (fastest check)
pi -e ./marker.ts -e ./index.ts --context-inspect --no-session

# TUI mode (run under `script` when no tty; pi must exit by itself in ~2s)
script -qec "pi -e ./marker.ts -e ./index.ts --context-inspect --no-session" /tmp/tui.log

# no-op check: without the flag the extension must do nothing
pi -e ./index.ts --no-session -p "say hi"
```

Verify after changes: no provider call during inspection (add a temporary
`after_provider_response` sentinel if in doubt), clean self-exit in both modes.

## Dependencies

`@earendil-works/pi-coding-agent` is declared twice on purpose:

- `peerDependencies: "*"` — published compatibility contract (pi docs convention).
- `devDependencies: <exact>` — local types snapshot; MUST match the installed
  pi version. When touching this project, compare `pi --version` with the pin
  and, on mismatch, update the pin and re-run `npm install`.

## Code style

Follow the `code-style` and `typescript-code` skills (tabs, double quotes,
ESM, named exports for helpers, no `any`, `undefined` over `null`).
