
# v0.8.5

- [ ] **Recheck `doc/architecture/pi-requests.md` against Pi 1.5.2**:
  - The page says it was last checked in full against Pi `1.3.0`.
  - Follow "After a Pi Upgrade" in `doc/architecture/validation.md`, then update the version in that note.
  - Known difference: the request flow says a standard probe ends with an assistant error; since Pi 1.5.1 its
    stop reason is `aborted` (see the first item of this section).

- [ ] **Check usage numbers with Anthropic message threads** (Pi 1.5.1, on by default for `api.anthropic.com`):
  - Needs a real provider request: confirm that reported input and cache tokens still cover the whole
    context when a request sends only the new messages.

- [ ] **Fail fast when the probe run never starts**:
  - Problem: `pi.sendUserMessage()` returns nothing and Pi catches its rejection, so the probe cannot see
    a failed start. When another extension's `input` handler returns `handled`, or Pi rejects the prompt,
    the attempt waits the full 5 s and reports `timeout` ("Preconditions, Failures, and Fallback" in
    `doc/architecture/probe.md`).
  - No exact fix with the current Pi API: only `ReplacedSessionContext.sendUserMessage()` returns a promise.
  - Possible fix: two short stage limits instead of one long timeout.
    - From the send to this extension's `input` handler seeing the token.
    - From that `input` to `before_agent_start`.
  - Risk: slow `input` handlers of earlier extensions and Pi's authentication check run inside these
    stages, so a limit that is too short fails a probe that would have started.
  - Keep tracking the run after the failure, as the timeout does today, so a late probe run is still
    aborted and sanitized.
  - Add a failure cause of its own, for example `no-run`, so the reason is not `timeout`.
  - Upstream: ask Pi to return the send's promise or result from `pi.sendUserMessage()`.

# v0.9.0

- [ ] **Evaluate a custom-message probe**:
  - Idea: start the probe with `pi.sendMessage({ customType, display: false }, { triggerTurn: true })`
    instead of `pi.sendUserMessage("")`.
  - Gain: `before_agent_start` carries the message, so its `customType` identifies the run exactly. This
    would remove the `AsyncLocalStorage` token, the nested-send limitation, the `input` reset, matching by
    role and timestamp, and the user row that stays on screen.
  - Cost: `input` handlers and handlers limited to `messageType === "user"` do not run, so the snapshot
    misses their contributions. Handlers that read `event.prompt` without checking `messageType` may throw.
  - `doc/architecture/probe.md` rejects this today as a worse approximation of a user prompt. Decide
    whether the safer run identity is worth the lower fidelity: a probe snapshot is already an
    approximation that the first real request replaces.
  - Check first: a custom message can be blanked and omitted like the probe prompt, ProbeFilter can match
    it by `customType`, and `ctx.abort()` at `turn_start` ends the run the same way.

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
