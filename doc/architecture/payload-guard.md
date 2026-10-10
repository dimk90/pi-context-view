# Payload Guard

Part of the [architecture](../ARCHITECTURE.md). The payload guard compares each
captured request with the provider payload that reaches this extension's
`before_provider_request` handler. It finds **late edits**: changes from
`context_with_system` handlers after this extension and from
`before_provider_request` handlers before it, which the
[structured capture](capture.md) cannot see. It runs in every mode and
publishes through the same SnapshotBuilder.

The guard compares two channels:

- **Tool declarations:** tool names and descriptions, including the inline
  tool changes of Anthropic and OpenAI Responses.
- **Messages:** model-facing message and system text, excluding `details` and
  other unsent metadata.

The guard is `complete` only when both channels were compared. Otherwise it is
`incomplete`, with a fixed reason and the findings of any channel that
succeeded. A complete guard may have findings; complete does not mean no edits,
and incomplete never means "no edits". Unexplained differences are reported
without structure or attribution. Pi's captured hidden tools are excluded from
the expected declarations. Payload handlers after this extension remain
invisible.

## Components

| Component         | Module                    | Hook                                                                        | Responsibility                                                                                 |
| ----------------- | ------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| RequestTracker    | `src/capture/tracker.ts`  | `context_with_system`, `cache_warming_decision`, `before_provider_request`  | Pair payloads with captures; mark warm refreshes                                               |
| PayloadParser     | `src/capture/payload.ts`  | `before_provider_request` copy, then deferred                               | Copy payloads; select the parser by API; extract the message and tool-declaration channels     |
| PayloadGuard      | `src/capture/guard.ts`    | Deferred                                                                    | Normalize Pi's adjustments; report unexplained differences or an incomplete comparison         |
| DispatchConfirmer | `src/capture/dispatch.ts` | Assistant `message_start`, `provider_stream_event`, assistant `message_end` | Record identity once per paired request; confirm the request model or supply the virtual route |

`src/capture/adjustments.ts`, `src/capture/messages.ts`, and
`src/capture/tools.ts` hold PayloadGuard's normalization and channel
comparisons. SilentProbe and DispatchConfirmer both handle assistant
`message_start` and `message_end`; neither depends on the other's result.

## Pairing

RequestTracker pairs each payload with the latest unpaired local capture ID,
not `turnIndex`.

- An agent-level retry (`retry.enabled`) starts a new run, repeats routing and
  context capture, and can choose a different physical model. A failure before
  streaming still produces an assistant message naming the model.
- A provider-level retry (`retry.provider.maxRetries`) resends the same payload
  without repeating `before_provider_request`.
- A capture can end without a payload, as a standard silent probe does
  ([what a probe run reaches](probe.md#what-a-probe-run-reaches)), or when a
  provider does not call `onPayload`. A new capture or the run's
  `agent_settled` settles a capture that is still unpaired as incomplete.
- A payload without a waiting capture is ignored.

### Warm Refreshes

A cache-warm refresh fires `before_provider_request` without a new capture. A
`cache_warming_decision` after the latest capture plus a one-token output limit
marks it; OpenAI Responses raises that limit to 16, which also marks a refresh.
No payload copy, comparison, or findings are produced, and nothing is
published. Its stream events cannot confirm the waiting agent request;
assistant events can.

The decision alone is not enough: handler results do not update
`event.action`, so a later handler's choice is invisible, and a decision alone
must not skip an agent payload. The marker is a heuristic. Failed warm
refreshes have no assistant-message fallback and need none, because their
comparison is skipped.

## Payload Copy

The payload hook synchronously copies arrays and plain objects, sharing
strings. Later handlers can replace a string but cannot change it in place, and
a full `structuredClone` of a large payload costs milliseconds and its whole
size ([evidence](#evidence)). The hook returns nothing and changes no event
data. Copy failures use a fixed reason, never exception text containing raw
payload content. A payload with other objects, such as Bedrock's image bytes,
is not a supported format and settles incomplete. Parsing and publication run
in `setImmediate` jobs.

## Request Model and Dispatch

Extraction and model-dependent normalization need the physical model.
`before_provider_request` exposes only the payload: the lower-level
`onPayload(payload, model)` receives the model, but Pi drops that argument
before calling extension handlers. A payload's `model` field does not identify
its provider or API.

Pi resolves the request model before the context handlers run. A physical
selection is used as is, so `ctx.model` in `context_with_system` already
describes the dispatched model; only an auth `baseUrl` override can differ, and
it does not affect the payload format. A virtual selection
(`ctx.model.api === "pi-virtual"`) is routed at that point too, but the routed
model is not exposed before dispatch. Capture records `ctx.model` as the
request model, and the guard chooses its path from it:

- **Physical selection: parse at once.** After the payload copy, select the
  parser by the request model's API, extract both channels, and normalize with
  that model's capabilities, such as `input` and `compat`. Keep only the
  comparison data and release the payload copy. The guard settles without
  waiting for a response.
- **Virtual selection: parse after dispatch.** Keep the payload copy until a
  dispatch identity arrives, then look up the physical model with
  `ctx.modelRegistry.find(provider, model)`. Select the parser by the
  dispatched API. Missing or mismatched catalog metadata settles incomplete.

Rules for both paths:

- **Dispatch identity.** Assistant `message_start` or `provider_stream_event`,
  whichever arrives first, supplies it; assistant `message_end` is the
  fallback. Do not require either to come first: the order varies even on one
  adapter. Accept one identity per paired request, return at once from stream
  handlers, and read only identity fields, never `event.data`. A request that
  fails before streaming has only the assistant events, and both carry the
  identity.
- **Dispatch confirmation.** On the physical path, the identity confirms the
  request model. A different provider, API, or model replaces the guard with an
  incomplete result and drops its provisional findings, without parsing again.
  This detects `pi.setModel()` during preparation: `ctx.model` changes, but the
  prepared request does not. Missing dispatch metadata also invalidates the
  result. Hidden tools are unaffected.
- **Shape check.** The payload must match the representation of the selected
  API; a mismatch or an unsupported API settles incomplete. The shape never
  selects the parser: shape alone cannot establish model capabilities, and
  providers that share one format can differ in `compat`. Normalization that is
  too broad would hide real edits.

A single session may use several formats through virtual routing or model
changes.

## Parsers

Supported APIs are `openai-completions`, `openai-responses`, and
`anthropic-messages`. The selected API chooses the parser; shape checks only
reject mismatches.

### Tool-Declaration Channel

- Unsupported APIs or malformed declarations leave the tool channel incomplete
  and record no names.
- OpenAI function and grammar declarations are supported; unknown
  provider-native Responses tools leave the channel incomplete.
- Anthropic's native mid-conversation tool changes
  (`compat.supportsMidConvoToolChanges` with an initial tool set): the
  request-level `tools` list holds only the initial tools and
  `__pi_deferred_placeholder__`. Later system messages add tools inline in
  `tool_addition` blocks with a `tool_definition` and withdraw them in
  `tool_removal` blocks; a redefinition under the same name has no
  `tool_removal`. The parser removes these blocks from the message channel and
  replays them in order on the initial list; a later definition wins.
- OpenAI Responses tool additions (`compat.supportsMidConvoSystemMessages` with
  `supportsAdditionalTools` or `supportsToolSearch`): while the tool history
  only adds tools, later additions appear inline at their system message, as an
  `additional_tools` developer item or a `tool_search_call` and
  `tool_search_output` pair. After a removal or redefinition, the
  request-level list holds the current tool set and nothing is inline. The
  parser removes these items from the message channel and adds their tools.
- OpenAI Completions with `supportsMidConvoSystemMessages` and
  `supportsMidConvoToolAdditions` can declare later tools in a system
  message's `tools` list; these additions join the same channel.
- `__pi_deferred_placeholder__` is excluded. With an Anthropic OAuth token,
  tool names that match Claude Code tools change case, such as `read` to
  `Read`, so Anthropic names match case-insensitively, as Pi does when it maps
  tool calls back.

Compare names and whitespace-insensitive descriptions, not schemas that Pi
adapts for each provider. Added declarations, changed descriptions, and
removed declarations are late tool edits; they keep the changed description
lines. A tool Pi hid is excluded before comparison, so its absence is expected,
not a late removal; if the payload adds it back, that is a late addition.
Missing non-hidden declarations are deletions whose previews keep the removed
description lines.

### Message Channel

`src/capture/payload.ts` extracts ordered text units: system, user, assistant,
tool call, and tool result. Text blocks merge within one message part, not
across message boundaries. Tool calls keep their name and canonical JSON
arguments, or raw grammar input. Tool IDs, unsent metadata, images, reasoning
blocks, and inline declaration changes are not message text. Only Pi's exact
leading Claude Code identity block is skipped in Anthropic's top-level `system`
array. Unknown message roles, item types, or content blocks leave the channel
unsupported rather than silently disappearing. Tool-channel support is checked
separately, so malformed declarations do not hide message findings.

## Pi's Own Adjustments

Pi changes the request after capture. None of these changes are late edits.
Hidden declarations and the forced prompt projection are request-only changes
Pi makes on an extension's behalf; capture reports them
([hidden tools](capture.md#hidden-tools), [forced prompt](capture.md#forced-prompt)).
The guard normalizes the others without reporting them.

`src/capture/adjustments.ts` rebuilds the captured request from its baseline
ends, copied middle, and system text positions. It applies the forced prompt
projection and Pi's exported `convertToLlm()`, then reproduces only the text
behavior of the supported adapters. Per-model message transforms are not
exported, so uncertain differences are never treated as proven Pi adjustments.

- **Conversion.** `convertToLlm()` turns custom messages into user messages,
  wraps bash executions and summaries, and drops bash executions excluded from
  context.
- **Images.** Read `images.blockImages` through `pi.getSettings()` at the
  payload hook. Only an enabled setting justifies `Image reading is disabled.`;
  unreadable settings count as off. Without `image` in the dispatched model's
  `input`, image runs become Pi's user or tool-result placeholder
  (`(image omitted: model does not support images)`). With image input,
  unexplained placeholder text remains a finding.
- **System messages.** Without `compat.supportsMidConvoSystemMessages`, system
  messages collapse into one leading prompt and declarations become the current
  tool set. With support, later system messages remain and later section
  patches render as updates. A system message between a tool call and its
  results moves after the results; Anthropic holds each later system message
  until just before the next assistant message, or the transcript end.
- **Assistant replay.** Apply cross-model thinking-to-text conversion and drop
  redacted or empty thinking. Drop error and aborted assistant messages, and
  synthesize `No result provided` error results for unanswered tool calls.
  Tool-call ID changes do not affect text keys.
- **OpenAI.** Account for empty or image-only tool-result fillers, Completions'
  attached-image user message, `requiresAssistantAfterToolResult`, and
  `requiresThinkingAsText`. Responses keeps assistant text blocks as separate
  items. Grammar inputs require `supportsOpenAIGrammarTools` and a captured
  grammar declaration with one required string property; that property is sent
  as raw input, not JSON arguments. Declarations come from the captured
  request, not from baseline tool history.
- **Anthropic.** Unsigned thinking becomes text unless `allowEmptySignature`
  accepts it as thinking. Signed and redacted thinking remains outside the text
  channel. Inline tool additions and removals belong to the declaration channel.

## Alignment and Findings

`src/capture/messages.ts` aligns whitespace-insensitive unit keys with the same
LCS helper as structured capture. Keys also remove unpaired UTF-16 surrogates,
as Pi does. Empty system, user, and assistant text does not count; empty tool
results do. In each unmatched gap, units of the same part pair in order as
modifications; unpaired units are additions or deletions. Findings keep the
message part, the change kind, and the added and removed lines, without
attribution or baseline entry IDs. Blank lines and whitespace-only differences
are ignored. Anthropic tool-call names match case-insensitively for OAuth
casing. Image and opaque signature changes alone are deliberately outside this
text-only comparison.

A complete guard without findings means the payload matched the captured
request, excluding Pi's known hidden declarations, up to this extension's own
payload handler. Injections renders the findings
([views.md](views.md#injections)). Payload findings do not change Usage.

## Retention

- Physical payload copies are released after parsing; only the snapshot and
  identity wait for confirmation.
- The guard's first deferred job reduces the capture to non-hidden tool names
  and descriptions, grammar input properties, and a converted transcript
  without image or signature bytes. Baseline and capture references are
  released, even while a virtual request waits for dispatch; the converted
  transcript remains until comparison.
- Virtual payload copies are released after dispatch parsing or settlement.
  The virtual path keeps its copy until the HTTP response, including
  provider-level retries and their delays. One request is in flight per run,
  plus at most one warm refresh, so this retention is small.
- SnapshotBuilder accepts guard replacements until the guard releases that ID.
- Shutdown cancels deferred work and drops all pending data. Neither payload
  copies nor guard findings are logged or persisted.

## Evidence

A spike on Pi 1.0.2 checked the assumptions of this design against the mock
provider for all three APIs; `test/dispatch-runtime.test.ts` keeps these
checks, and `test/payload-runtime.test.ts` exercises the guard on the real
adapters. Other adapters were checked in the source only.

- **Request model.** On a physical selection, `ctx.model` in
  `context_with_system` and `before_provider_request` named the dispatched
  provider, API, and model for first prompts, tool follow-ups, and after a
  model change between prompts. `ctx.modelRegistry.find()` for the dispatched
  identity returned the same `input` and `compat`.
- **Model change during preparation.** After an earlier `context` handler
  awaits `pi.setModel()`, `ctx.model` in both handlers names the new model,
  while the request, its payload format, and its dispatch identity keep the
  prepared model. Dispatch confirmation detects this. Before it does, the
  physical path has already parsed with the new model: a change to another API
  fails the shape check, but a change within one API can publish a provisional
  result normalized with the wrong capabilities. `ctx.model` at the request's
  `turn_start` still names the prepared model.
- **Event order.** These adapters push their assistant start after the HTTP
  response and before they read the stream, but the agent loop delivers that
  start through more asynchronous steps than the adapter's
  `provider_stream_event`. When stream data is already buffered as the response
  resolves, the first `provider_stream_event` often reaches handlers first.
  `after_provider_response` came before both, and assistant `message_end` after
  both. A failure before streaming (HTTP 500) had only assistant
  `message_start` and `message_end`, both with the identity, and no
  `after_provider_response`. In the source, Bedrock and Pi Messages emit
  `provider_stream_event` before they push the start.
- **Routed models.** Under a virtual selection, `ctx.model` in
  `context_with_system` and `before_provider_request` is the virtual model. Pi
  replaces the route's model with the catalog model of the same provider and
  ID, so `ctx.modelRegistry.find()` for the dispatch identity returned the
  dispatched capabilities, even when the router returned a copy with a changed
  `input`. `find()` misses only when the provider is unregistered before
  parsing.
- **Payload copy.** A payload's JSON is about as large as its context: about
  0.8 MB at 200k tokens and 4 MB at 1M tokens, plus base64 images. On an
  i7-8650U with Node.js 26, `structuredClone` took 1–13 ms and kept a full
  copy. A copy of only arrays and objects that shares strings took 0.2–3 ms and
  kept 2–5% of the JSON size.
- **Payload shapes.** Payloads with tools, a tool call and result, and a
  mid-conversation system message each passed only their own API's structural
  check. OpenAI Responses sends `input` items instead of `messages`. OpenAI
  Completions keeps the system prompt in `messages`, sends tool results with
  role `tool`, and nests declarations under `function`. Anthropic sends the
  prompt in a top-level `system` and declarations with a top-level `name`.
  Roles alone do not separate Completions from Anthropic: with
  `supportsMidConvoSystemMessages`, Anthropic payloads contain
  `role: "system"` messages. A payload without a system prompt, tools, or tool
  history can pass both checks; the check only rejects clear mismatches.
