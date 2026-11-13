
# v0.9.0

- [ ] **Probe only after the view is known to open**:
  - Problem: the command resolves the snapshot, and may probe, before it calls `ctx.ui.custom()`. In Pi's
    `--mode rpc` the probe runs and then the view is refused ("Plain RPC cost" in `doc/ARCHITECTURE.md`).
  - Fix: open the view with the fallback first. Start the probe only after the host called the view's
    factory, then rebuild the view when the snapshot arrives or the probe fails.
  - Needs: a view that can replace its input while open, and a "probing" note until the result arrives.
  - Check: `waitForIdle()`, `pi.sendUserMessage("")` and `setWorkingVisible()` behave the same while the
    overlay is open.
  - Decide: start the probe automatically after the factory call, or on a key press in the fallback view.
    A key press makes the probe explicit, as `doc/architecture/probe.md` already calls it.
  - Update the hosts table and limits in `doc/ARCHITECTURE.md`, "Resolving the Snapshot" in
    `doc/architecture/views.md`, the lifecycle in `doc/architecture/probe.md`, and the command tests.

- [ ] **Collapse/Expand groups in Injection view**:
  - Show max 4 items.
  - Collapse group automatically if it contains more than 4 items.
  - When collapse still show 3 items + one '...'.
  - Show "Use <-/-> to Collapse/Expand" (accent color) in addition to ... when corresponding group (or item inside group) is selected.
  - When Search/Filter should active it should show everything expanded.
  - No need to extra hotkey in hotkey bar.

- [ ] Icon styling via config.

- [ ] Move "Window/Used" % to back to hotkey bar:
  - to reduce visual noise.
  - use underline for the current mode.

- [ ] Fix more than 100% context windows:
  - Discuss what to do.
