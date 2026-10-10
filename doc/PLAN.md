

## `Backlog`

- [ ] **Improve Silent Probe Robustness with v1.1.0 features**:
  - Check especially "Added aborted to agent_settled session, extension, and JSON events, so integrations can tell a cancelled run from a finished one (#10607)".

- [ ] **Manual probe trigger** ([probe.md](architecture/probe.md#probe-layer)):
  - An explicit user action starts a new probe; one probe at a time, concurrent requests share it.
  - Choose a command or a view key; keep parsing, completions, registration text, README usage, and command tests in sync.

- [ ] **Request model at `turn_start`** ([payload-guard.md](architecture/payload-guard.md#evidence)):
  - Record `ctx.model` at the request's `turn_start` and take the virtual path when it differs from the request model, so `pi.setModel()` during preparation cannot publish a provisional result normalized with the wrong capabilities.

- [ ] **Shape-based payload extraction for virtual selections**:
  - Extract both channels early from a recognized payload shape, keep only comparison data, and normalize when dispatch arrives. Ambiguous shapes still wait or settle incomplete.
  - Only if payload retention or result delay on virtual selections becomes a measured problem; the spike found the retention small.

- [ ] **Upstream: dispatched model in `before_provider_request`**:
  - Ask Pi to forward the model that `onPayload()` already receives. It replaces the request model and the wait for dispatch, but not the blind spot for later handlers.
  - Rejected alternatives: cooperative announcements over `pi.events` need router and provider participation; wrapping provider streaming adds registration, reload, and compatibility risks to an observe-only monitor.

- [ ] **Fix Visualization for > 100% After Model Switch**:
  - e.g. Opus 1M (50%) -> switch -> Sol 200k (120%).
