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
unchanged. Moved native text still counts under System Prompt, and extension
tool lines keep their usual tool ownership. Never invent missing or withheld
tool lines.

Pi always renders a `cwd` section, so only a forced prompt can have no sections.
Measure such a prompt as one undivided System Prompt part. Text shaped like
pi's own blocks is not evidence of them there: it has no Moved, Dropped, or
Extension Additions parts, and its tools keep only their definitions. A forced
prompt that contains sections is measured like any other sectioned prompt.

## Tool Ownership and Preview References

Use `ToolInfo.sourceInfo` for tool ownership. A package source (`npm:`, `git:`)
identifies its extension. The path kinds `cli`, `local`, and `auto` do not, so
tools and prompt additions from such an extension are owned by its kind and
entry path, and labelled by path against every extension that registered a
tool or command.

Separate a tool's complete prompt bullets only from the first `tools` and
`rules` sections, including moved ones. Never match unrelated text or only a prefix
of a longer bullet. Give each shared guideline bullet to the first tool that
declares it in pi's active-tool order, so it counts once. Pi's own bullets stay
in the base prompt.

For each separated extension line, retain its original position, source, and
owning tool as a typed preview reference. Keep that reference on the System
Prompt section and standalone child from which the line was removed. This
applies to both Available Tools snippets and Guidelines bullets.

References restore prompt order for inspection. They add no counted text,
characters, or tokens to the base item; the owning tool counts the content.
Only exactly matched, rendered lines receive references, except for the
explicit dropped-block case below.

## Blocks Dropped by a Custom System Prompt

When `--system-prompt` drops Available Tools, Guidelines, or Documentation,
keep those parts in the model and mark them as dropped. They must contain no
pi-authored counted text. They may contain preview references to extension
lines that pi would otherwise have rendered.

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

Count an addition under its assigned source, never again under pi's own prompt.
System Prompt holds these additions only as references in its Extension
Additions part.

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
