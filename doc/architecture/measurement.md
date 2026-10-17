# Measurement and Source Attribution

Part of the [architecture](../ARCHITECTURE.md). How both views split, estimate,
and attribute prompt, tool, and message contributions.

Attribution means deciding which source owns a contribution. Store source,
kind, and hierarchy in typed model fields. Never recover these facts by parsing
display labels.

## Token Estimates

Estimates need not match pi or provider totals. Tokenizers, images, provider
serialization, compaction timing, handler order, and payload rewrites can all
change the result.

- Do not add guessed token constants for message roles or content-block framing.
- Do not count protocol metadata just because it appears in the request.
  Examples include `ToolCall.id`, `ToolResultMessage.toolCallId`, and
  `ToolResultMessage.toolName`.
- Estimate compaction summaries, branch summaries, and context-visible bash
  messages with `estimateTokens(convertToLlm([message])[0])`. Conversion adds
  wrapper text that the provider receives. Exclude messages conversion drops.
  This estimate can intentionally exceed pi's own heuristic.
- Follow [THINKING.md](../THINKING.md) for reasoning counts, opaque signatures,
  model retention, and thinking-preview notation. That page is the source of
  truth for the thinking formula and its measurement evidence.

## Token Diffs

Injections measures added and removed tokens with the word-level comparison in
`src/token-diff.ts`. The [view composition](views.md#injections) defines each
base: pi's default text for prompt parts, the session for tools and messages,
and the captured request's removed lines for payload findings. Diff-only
system prompt rows repeat the prompt diffs split by source, not a new comparison.

- Changed characters round up to tokens. For changed text, reconcile rounding
  so the base estimate plus additions minus removals equals the request
  estimate; assign the difference to a side with changed characters.
- Equal texts have no diff, even when their allocated shares round differently.
  Never remove more than the base or add more than the request estimate. If
  uncounted framing would violate those bounds, use a whole replacement.
- A forced prompt with sections compares part by part. An undivided forced
  prompt compares with pi's whole default prompt, including instruction files
  and skills. A deleted custom section compares with the session so its
  removal remains visible despite having no pi-default base.
- Parents and groups sum the diffs they count, including removal of session-only
  children. Diff-only source rows increase neither group diffs nor totals;
  the overall total has no diff.

The same word alignment supplies preview runs. Whole-line additions and
removals need no word-level emphasis; an oversized comparison keeps common
ends and treats the unalignable middle as replaced. Expanding marked JSON for
display changes neither the counted estimate nor the diff.

Known limits: a request-only edit to saved extension text can fold into its
existing added-token count, so persistence needs separate metadata. A saved
edit within pi-authored text is not detectable because the session's text is
its default base.

## Prompt Parts and Moved Blocks

Pi wraps independently replaceable sections in XML. Map `tools`, `rules`,
`docs`, `addendum`, and `cwd` to Available Tools, Guidelines, Documentation,
Appended Prompt, and Current Dir. Keep the unwrapped preamble separately.
Read `project_context` instruction records and `skills` records as their existing
aggregates. Overridden content that is not those generated records stays visible
as a System Prompt part; never substitute stale loader content.

Custom `systemPromptOptions.sections` use their literal tag names as part labels;
overrides of known names retain existing labels. Sections can follow `cwd`, so
that section is not the end of structured content. Ignore nested tags and fenced
examples when locating top-level sections. The first occurrence of a tag owns
the part; later duplicates are unwrapped additions, not a second counted part.
Unwrapped text between or after sections uses the existing addition attribution.

Count and preview section bodies without the outer XML transport wrappers.
The tool sections retain leading bullet newlines for exact line attribution.
The counted parts concatenate back to the item's text and share its estimate.
Native tool surfaces use consecutive bullets and keep actual section order;
relocated `tools` and `rules` retain the Moved marker and tool references.
A custom prefix may restore individual native sections, so only absent ones
are marked Dropped.

A section after one pi normally renders later gets typed `moved` metadata.
This records position only: it does not prove who moved it or that its text is
unchanged. Moved text still counts under System Prompt, and extension tool
lines keep their usual tool references. Never invent missing or withheld tool
lines.

Pi always renders a `cwd` section, so only a forced prompt can have no sections.
Measure such a prompt as one undivided System Prompt part. Text shaped like
pi's own blocks is not evidence of them there: it has no Moved, Dropped, or
Extension Additions parts, and no tool line gets a reference. A forced prompt
that contains sections is measured like any other sectioned prompt.

## Tool Ownership and Preview References

Use `ToolInfo.sourceInfo` for tool ownership. A package source (`npm:`, `git:`)
identifies its extension. The path kinds `cli`, `local`, and `auto` do not, so
tools and prompt additions from such an extension are owned by its kind and
entry path, and labelled by path against every extension that registered a
tool or command. A recorded tool with no currently registered implementation
belongs to the shared `unattributed` source, never a second group with that
label. Its prompt references use the same unknown source.

A tool item counts only its definition: name, description, and parameter
schema. Pi renders the tool's snippet and guideline bullets into its prompt,
so System Prompt counts them with the rest of its text.

Match a tool's complete prompt bullets only in the first `tools` and `rules`
sections, including moved ones. Never match unrelated text or only a prefix of
a longer bullet. Give each shared guideline bullet to the first tool that
declares it in pi's active-tool order, so only that tool is named. Pi's own
bullets and built-in tool bullets get no reference.

For each matched extension line, retain its range in the part's text, source,
and owning tool as a typed preview reference. Keep that reference on the System
Prompt section and standalone child that hold the line. This applies to both
Available Tools snippets and Guidelines bullets.

References name the source of counted text for inspection. They add no text,
characters, or tokens. Only exactly matched, rendered lines receive
references, except for the explicit dropped-block case below.

## Blocks Dropped by a Custom System Prompt

When `--system-prompt` drops Available Tools, Guidelines, or Documentation,
keep those parts in the model and mark them as dropped. They must contain no
pi-authored text. Their text holds only the extension lines that pi would
otherwise have rendered, with references like rendered lines.

Each tool also keeps its dropped snippet and guideline sections. Every dropped
part or section has zero tokens and contributes no counted text, characters,
or token shares. Do not count text pi never sent.

## Extension Prompt Additions

For unwrapped gaps between or after XML sections:

- Split at blank lines and ignore whitespace-only gaps. Keep gaps on opposite
  sides of a section separate, so unrelated source evidence cannot mix.
- There is no `before_agent_start` handler boundary: adjacent unwrapped
  additions without a blank line may share a block.
- Name a source only when the text contains exactly one loaded package
  specifier or extension path from `getAllTools()`/`getCommands()` source data.
  Always mark that name as a guess: pi does not record who made each prompt edit.
- Add a tool or slash-command qualifier only when exactly one registered name
  from that same extension appears as a complete token. A path segment, a
  command without its slash, or a name shorter than three characters does not
  qualify. The qualifier changes only the display label.
- Keep everything else unattributed.

System Prompt counts every addition in its Extension Additions part, in prompt
order. Each addition has a preview reference to its guessed source, or to
`unattributed`; no extension item counts the text again.

## System Prompt Rows

Injections splits its prompt diffs by source in `src/system-prompt-rows.ts`.
Each extension gets one `system prompt` row: its exactly matched tool lines
and the additions guessed to belong to it. `unattributed` gets every other
prompt change, saved or request-only, including changes to instruction files
and skills. Custom-section names identify parts, never owners. An
unregistered recorded tool's snippet still has no known extension owner.

These are diff-only items (`InjectionItem.diffOnly`): 0 characters and tokens,
no displayed value, and no contribution to the group's value or diff. They
repeat changes already counted under `pi`, so the extension rows and
`unattributed` together sum to the System Prompt, Instruction Files, and
Skills diffs. Usage does not build these rows; its categories stay unchanged.

For each System Prompt part, group its non-unattributed references by source
in first-appearance order. Allocate the part's added tokens from those lines'
characters with cumulative chars/4 rounding, capped at the part's `+N`.
Give all remaining additions and every removal to `unattributed`: Pi does not
report who edited or deleted prompt content. Instruction-file and skill
diffs go there whole, including the removal of session-only children. Dropped
parts have no diff and contribute nothing.

An extension row is request-only when its attributed lines, with their part
IDs and prompt order, differ between the request and session. An unknown edit
to pi text in the same part does not mark unchanged extension lines. The
unattributed row is request-only when any of its contributing changes is,
including an undivided forced prompt or a removed session-only child. Its
preview uses the existing part text, with session text for deletions; the
extension preview uses only its own lines. Preview rules live in
[ui/injections.md](../ui/injections.md#injection-preview).

Each row records whether some changes are saved (`savedChange`). An extension's
row is saved when the session holds its lines; the unattributed row is saved
when a contributing diff includes a saved custom section or unowned extension
lines the session holds. Known owners' saved lines never turn the unknown
request-only edit beside them into a saved change.

The same source split supplies a saved System Prompt part's `editors`: known
extensions in prompt order, preserving guessed attribution, then `unknown`
for any remaining additions and every removal. Request-only parts always have
an unknown editor: ownership of their saved lines cannot identify who edited
them. Other changed leaves default to unknown in the row model. The selected
row's status bar uses this metadata, never the affected source group, tool name,
customType, or section name, to name an editor. Parents and groups omit editors,
and diff-only rows explain their accounting instead.

## Messages and Payload Changes

Injections groups every custom message and request-only conversation change
under the same `unattributed` source, regardless of `customType` or cooperative
provenance. Neither identifies an extension. Pi adds no custom context messages:
`pi.share` is a session/export entry only. Usage still classifies custom messages
by `customType`; its categories and message accounting are unchanged.

One `messages (N)` item holds labeled sections, not child items. `N` counts
messages sent, excluding deletions. Message estimates use Pi's
`estimateTokens`; the row sums the counted sections. Each changed message's
content-only preview compares with its session original, and the row sums
those diffs. A modified message's section counts the request version and keeps
the redacted original as preview-only metadata, never as a second section;
deleted messages retain the original at zero tokens. Only sent text
contributes to the item's counted text and characters. The row and changed
message sections carry `requestOnly`. Message sections also carry their
`user prompt #N`, which changes no estimate.

One `payload changes (N)` item of kind `payload-change` holds one section per
guard finding, in guard order. `N` counts every finding, deletions included.
Each section's estimate counts only added lines using chars/4; its diff compares
those lines with the removed captured-request lines. The row sums the section
estimates and diffs. Sections keep both sets of lines for previews, and typed
`toolDeclaration` metadata distinguishes tool names from message-part labels.
Neither the row nor its sections are request-only. Its estimate and diff count
toward `unattributed` and the total; this is not a payload-size estimate.

Both items disappear when there are no messages or findings to show. Their
labeled preview contract lives in
[ui/injections.md](../ui/injections.md#injection-preview).

## Totals and Structured Previews

- Children break down their parent; they are never extra tokens in a total.
- Labeled preview sections hold shares of the parent estimate. Their tokens
  must sum to the parent, not add to it.
- An item with children exposes each child as a labeled preview part with its
  estimate and any marked JSON range.
- Mark JSON ranges when capture or classification serializes them: tool
  schemas, tool-call arguments, and non-string message content. Do not guess
  whether preview text is JSON by inspecting its appearance.
- Compact provider-bound JSON backs the estimate. Expanding it for display is
  covered by [ui/previews.md](../ui/previews.md#marked-json).
