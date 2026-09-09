
## `Backlog`

- [x] Can we identifies and mark which extension move it ?
  - Closed as infeasible: pi chains `before_agent_start` prompt results and
    records no author, `BeforeAgentStartEvent` carries no provenance, and
    `getExtensionPaths()` stays internal to the runner. The only factual signals
    are our own handler boundary (`promptAtHandler`, which orders the move
    before or after this extension) and the tool/command roster, which sees
    extensions registering neither. That never identifies a mover, so `Moved`
    stays positional inference, as `doc/ARCHITECTURE.md` already states.

- [x] Change description style from prose to bullets.
  - "Highlighted parts are injected by extensions into pi’s system prompt ..."
  - "Sources marked (guess) are inferred from the injected text itself."
  - "Dropped ..."
  - "Moved ..."
  - [x] Use corresponding color for "Highlighted", "Dropped", "Moved"...
  - [x] Show description bullets for "Highlighted"/"Dropped"/"Moved"/... in all views where these marks can be visible.

- [x] The separator "·" should be not colorful:
  - dim or muted.
  - Done: state markers now render a dim ` · ` and keep the fixed color on the
    keyword alone (`Dropped`, `Moved`). Every other `·` already renders dim or
    inside muted metadata.
