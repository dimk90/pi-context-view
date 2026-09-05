# Capture and usage architecture

Canonical contract for how pi-context-view captures hidden context, estimates current usage, and keeps raw data isolated. The roadmap lives in [PLAN.md](PLAN.md), and the rendering contract lives in [UI.md](UI.md).

## Module boundaries

| Path                      | Responsibility                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `src/index.ts`            | Register pi lifecycle handlers, dispatch `/context`, and assemble view inputs.            |
| `src/command.ts`          | Parse command arguments and resolve Initial through capture, probe, or degraded fallback. |
| `src/config.ts`           | Load, validate, cache, resolve, and explicitly create global override-only configuration. |
| `src/capture.ts`          | Own Initial, silent-probe, compaction, identity persistence, and injected-message state.  |
| `src/measure.ts`          | Carve and estimate prompt and tool contributions without pi API access.                   |
| `src/usage.ts`            | Classify provider-bound messages and build current usage totals and previews.             |
| `src/model.ts`            | Define semantic capture and usage types, ownership, hierarchy, and grouping.              |
| `src/text.ts`             | Sanitize dynamic text for the terminal before reporting or rendering it.                  |
| `src/ui/`                 | Keep navigation, layout, preview shaping, and fullscreen rendering isolated from capture. |
| `test/fixtures/marker.ts` | Exercise capture visibility and extension load order in lifecycle smoke tests.            |

Keep pi API wiring in `src/index.ts`; keep state machines and transformations independently testable.

## Initial snapshot

Capture Initial once per extension runtime:

```text
before_agent_start → own structured prompt options
context            → read the final system prompt and active tools, then freeze
                     prompt, tools, and injected messages as owned copies
```

`event.systemPromptOptions` is available in `before_agent_start`, not `session_start`. Copy the structured options there, but do not freeze the prompt or tool set: later `before_agent_start` handlers may edit the prompt or call `pi.setActiveTools()`. Finalize in the first `context` event with `ctx.getSystemPrompt()` and pi's then-active tools.

Build the finalization inputs lazily: `context` fires once per request, but only the freezing call reads them, so later events skip the `buildSessionContext()` rebuild while still filtering persisted synthetic identities from the event messages.

Initial represents the first context observable by this extension runtime, whether from a real turn or the explicit silent probe. Never overwrite it. Conditional contributions inactive for that run are absent. Prompt and tool capture is load-order independent; message changes from later `context` handlers and provider-payload rewrites remain unobservable.

Compare context-event messages with `buildSessionContext()` for the current session branch. Preserve custom messages and structurally unmatched non-custom messages so provider-context-only injections are not lost. Own every nested prompt, tool, message, source, and child value retained by the snapshot.

## On-demand silent probe

Request a probe only when a user opens a view before Initial exists. Allow one attempt per extension runtime; concurrent callers share it, and never probe automatically.

```text
/context           → wait idle; if compaction is active, use the degraded fallback
                   → otherwise hide the working row and sendUserMessage("")
input               → mark the exact extension-originated empty input
before_agent_start → associate the run and prepare Initial
turn_start         → abort before provider
context            → finalize Initial and filter the synthetic user
message_end        → sanitize only the synthetic aborted assistant
agent_settled      → restore UI, persist identities, resolve, and open the view
```

Use `sendUserMessage("")`; `pi.sendMessage(..., { triggerTurn: true })` bypasses `before_agent_start`. Abort at `turn_start`, not `before_provider_request`, because some transports skip the latter. Other extensions still observe the lifecycle, and probe entries remain in pi's session tree.

Track synthetic user and assistant messages only by exact role and timestamp. Filter only those identities from every later model context and Usage calculation so genuine empty messages and genuine aborts remain visible. Sanitize only the recorded probe assistant's abort result.

Persist role-and-timestamp identities, never content, in `pi-context-view:probe-identities` custom entries on `agent_settled` and `session_shutdown`. Restore all prior identities on `session_start` so filtering survives resume, reload, and fork. Never infer probe identity from empty content.

`waitForIdle()` does not cover manual compaction. Track `session_before_compact` until its signal aborts or pi reports the outcome: pi 0.84.3 and newer close every observed compaction with exactly one of `session_compact` or `session_compact_failed`, so do not re-derive the end from later runs. On older pi the failure event never arrives and a failed compaction keeps the degraded fallback until the session ends. While compaction is active, return the degraded fallback without starting or consuming the probe attempt.

Always restore the working-row state in `finally`. A missing model, missing authentication, startup failure, timeout, or active compaction returns a current pi-native prompt/tool snapshot with a precise reason that extension additions were not observed. A timed-out run remains owned until it settles so its delayed synthetic messages are still sanitized and filtered.

## Usage and attribution

Build Usage only when its view opens:

1. Resolve Initial so frozen provider-context-only messages are available.
2. Build a fresh pi-native prompt/tool snapshot from the command context.
3. Merge Initial's context-only messages into that current snapshot.
4. Build messages from `buildSessionContext(session entries, leaf id).messages` and remove persisted synthetic identities.
5. Classify the snapshot and messages; read `ctx.getContextUsage()` separately for pi's reported usage and context window.

Do not use `buildContextEntries()`, which includes non-context metadata. Injections remains the frozen Initial view; Usage intentionally reflects the current prompt, active tools, session branch, and reported window at view-open time.

Estimates need not reconcile with pi or provider totals because serialization, images, tokenizers, compaction timing, handler order, and payload rewrites differ. Do not add guessed role/block framing constants. Do not count protocol metadata such as `ToolCall.id`, `ToolResultMessage.toolCallId`, or `ToolResultMessage.toolName` merely because it appears on the wire.

Estimate compaction summaries, branch summaries, and context-visible `bashExecution` messages from `estimateTokens(convertToLlm([message])[0])`, because conversion adds provider-bound wrapper text. Exclude messages that conversion drops. This may produce a larger, intentionally more provider-shaped estimate than pi's own heuristic.

Follow [THINKING.md](THINKING.md) for reasoning counts, opaque signatures, model retention, and preview notation. It is the sole source for the thinking formula and measurement rationale.

Keep semantics in typed model fields rather than display labels:

- derive tool ownership from `ToolInfo.sourceInfo`;
- split pi's own system prompt into the parts it assembles — the preamble, the
  blocks it renders under `Available tools:`, `Guidelines:`, and
  `Pi documentation`, any `--append-system-prompt` text, and the
  working-directory footer pi sends with every request — as parts that
  concatenate back to the item text and share out its estimate;
- carve a tool's prompt lines only from the blocks pi renders them into, and
  give each rendered guideline bullet to the first tool that declares it in
  pi's active-tool order, so a bullet several tools share is measured once and
  pi's own bullets stay in the base prompt;
- represent chained prompt edits as one unattributable extension aggregate;
- treat `customType` as a message type, not necessarily a package identity;
- detect non-custom context-only injections by diffing against the session branch;
- treat children as a breakdown of their parent, never additional tokens in totals;
- retain labeled preview sections as typed parts of an item, with token shares
  that reconcile to the parent rather than adding to it; an item with children
  exposes every child as one such part, carrying the child's label, estimate,
  and marked JSON run;
- mark JSON that capture and classification serialized themselves — tool
  parameter schemas, tool-call arguments, non-string message content — with a
  span on the item, section, or entry instead of detecting JSON in preview text;
  the compact provider-bound form always backs the estimate, and expansion stays
  a rendering concern owned by [UI.md](UI.md).

## Configuration

Every user-configurable value follows one contract, whatever it configures:

- defaults live in code, and the global `getAgentDir()/extensions/pi-context-view.json` carries overrides only, so later default changes still reach users who never overrode them;
- never auto-create the file and never write missing defaults into it; only an explicit user action may create or modify it;
- load lazily at view-open time, never in the extension factory, which also runs in invocations that never start a session; cache per runtime and re-read on mtime change;
- an absent file and omitted keys silently use defaults; an unreadable or unparseable file, unknown key, unrecognized color, or out-of-range value falls back to the applicable default and warns once per file revision, never failing a view;
- renaming a key keeps its previous name as a silently accepted alias, so a rename never drops an override an existing file already carries; the current name wins when a file carries both;
- `/context config` is the explicit create-only action: it writes every default through one atomic `O_EXCL` create, never overwrites or modifies an existing path, and stays available in every run mode because it needs no UI — only the views are gated on `ctx.mode === "tui"`;
- later actions that update an existing file must be debounced and merge over a fresh read so concurrent edits and unknown keys survive.

Configuration holds preferences only; the privacy contract below forbids storing captured prompt or message content there. [PLAN.md](PLAN.md) tracks which values are configurable, and [UI.md](UI.md) owns the rendering rules for configurable colors and map geometry.

## Privacy

Raw prompt and message content stays process-local. Sanitize it before terminal rendering and reveal it only after explicit Enter preview. Never log it, add it to notifications, persist additional copies, or inject it into a later model request.

Opaque `thinkingSignature` and `thoughtSignature` bytes may be inspected only for length. Never retain, tokenize, render, preview, or log the bytes themselves. Persisted probe records contain only role and timestamp identities.

## Required invariants

Lifecycle or accounting changes must preserve all of these:

- normal turns are unchanged when inspection is not invoked;
- probes make no provider request and leave no visible transcript artifact;
- active compaction uses the degraded fallback without consuming the probe attempt;
- genuine messages and genuine aborts remain visible;
- synthetic entries never reach later model contexts or Usage, including after resume, reload, or fork;
- Initial freezes exactly once per extension runtime;
- raw content appears only after Enter and is never logged or newly persisted;
- parent and child contributions are never double-counted;
- every rendered line respects width, and views reflow with width and height.

For lifecycle smoke tests, load `test/fixtures/marker.ts` before and after this extension and use an `after_provider_response` sentinel for provider-call detection. Follow [UI.md](UI.md) for the rendering matrix.
