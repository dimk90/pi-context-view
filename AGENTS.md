# pi-context-view

TypeScript pi extension (`src/index.ts`) with two TUI-only overlays:

- `/context` or `/context usage` — estimate current context composition.
- `/context injections` — inspect the frozen Initial snapshot with opt-in raw previews.

The command accepts only `usage` and `injections`; keep it unavailable outside TUI mode.

## Sources of truth

| Path | Read before |
| --- | --- |
| `doc/ARCHITECTURE.md` | Changing lifecycle capture, silent probes, attribution, usage accounting, the semantic model, configuration semantics, or privacy behavior. |
| `doc/UI.md` | Changing rendering, interaction, previews, responsive behavior, or release media. |
| `doc/THINKING.md` | Changing reasoning-token accounting, signature handling, or thinking-preview notation. |
| `doc/PLAN.md` | Adding commands, configuration, runtime inspection, or other roadmap work. |
| `doc/HISTORY.md` | Reusing the removed CLI lifecycle or investigating older capture and transport approaches. |
| `doc/RELEASE.md` | Changing versions, tagging, publishing, or preparing a release. |

## Repository rules

- **Architecture contract.** Preserve the invariants in `doc/ARCHITECTURE.md`; update that document with any lifecycle, capture, attribution, or usage behavior change.
- **Privacy gate.** Keep raw prompts and messages process-local and terminal-sanitized; expose them only after explicit Enter preview, and never log them, persist extra copies, include them in notifications, or inject them into later requests.
- **Module boundaries.** Keep `src/index.ts` to pi event and command wiring; put independently testable state, measurement, and rendering behavior in focused modules under `src/` and `src/ui/`.
- **Command contract.** Keep parsing, completions, registration text, README usage, and command tests synchronized whenever the `/context` grammar or mode guard changes.
- **Config contract.** Keep user-configurable state override-only: defaults in code, no auto-created or default-backfilled config file, invalid entries degrading to defaults. `doc/ARCHITECTURE.md` holds the full load and write contract.
- **UI contract.** Treat `doc/UI.md` as canonical; update it and focused tests whenever the specified TUI behavior changes.
- **Dependency contract.** Keep both pi packages as `"*"` peer dependencies and exact development pins matching `pi --version`; run `pnpm install` after changing either pin.

## Verification

```bash
pnpm check
```

- **Lifecycle changes.** Load `test/fixtures/marker.ts` in both extension orders and use an `after_provider_response` sentinel to prove a probe makes no provider request.
- **TUI changes.** Follow the `pi-extension` skill for real-PTY and provider smoke tests, and exercise the dimensions and interactions required by `doc/UI.md`.
