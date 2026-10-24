# Preview rules

Shared design decisions for previews in both views. Apply the
[shared design rules](../UI.md); [privacy](../architecture/privacy.md#privacy)
and [measurement](../architecture/measurement.md) own what content may be shown
and how it counts.

## Labeled parts

Use labeled parts when content has meaningful constituents, such as prompt
sections, tool definitions, or aggregate messages. Make the hierarchy clear
without extra navigation levels or repeated headings. Keep related metadata
with its part and use whitespace to separate bodies.

Token shares explain the parent estimate; they never add to it. Retain parts
whose state matters even without counted text, such as deletions or dropped
content. Diff-only references show changes, not misleading zero-token shares.
Otherwise omit empty placeholders. Preserve the content's meaningful order,
not an order chosen for visual convenience.

## Diff bodies

Follow pi's diff style: distinguish added, removed, and unchanged lines with
both signs and semantic colors; emphasize changed words within replacements.
Keep wrapped text aligned and the signs distinct from captured content.

Show a diff body only when there is something to compare with. A wholly added
message or part reads as plain content: its `+N` already says it is new, and
all-added lines only make it harder to read. Payload findings and Forced parts
keep their signs, because their lines are the change itself.

A message comparison may include unchanged context. A payload finding contains
only retained changed lines and must not suggest it shows the entire payload.
Display transformations must not alter estimates or imply a different
comparison from the one measured. [Token diffs](../architecture/measurement.md#token-diffs)
own the comparison and its bounds.

## Extension lines

Highlight extension contributions in System Prompt previews and attach their
source annotations to the corresponding text. Keep pi-authored text visually
distinct. Owning-tool previews need not repeat annotations naming themselves.

Distinguish reported ownership from inferred attribution. Keep guesses visibly
qualified, including a guessed tool or command qualifier; an unknown source
must not become known merely because it appears inside a named section. Show
only attribution supplied by the semantic model, never inferred from labels by
the renderer.

Annotations are preview-only and add no counted content. Sanitize source labels
as well as bodies, and keep their association readable through wrapping. They
must remain part of the scrollable content rather than leak into overview rows.
[Measurement](../architecture/measurement.md#tool-ownership-and-preview-references)
owns attribution and the special treatment of dropped prompt lines.

## Marker legend

Explain the marks relevant to the open preview, using the same semantic colors
as the marks themselves. Keep these meanings distinct:

| Mark | Meaning to communicate |
| --- | --- |
| Highlighted | Text contributed by extensions to pi's prompt |
| (guess) | Attribution inferred rather than reported |
| Dropped | Replaced content that counts nowhere |
| Moved | A different prompt position, not a different owner |
| Forced | An extension's prompt replaced pi's for this request, or replaced a part's request edit |
| +N / -N | Added and removed tokens against the stated base |
| Request-Only | Changes the session does not keep |

These meanings are stable; the explanatory sentences and their arrangement are
not fixed copy. Do not show legends for unrelated states. Explanations belong
outside the scrollable body, stay available as marked content scrolls away,
and collapse as a whole under the shared description rules. The Injections list
uses its [selected-row status bar](injections.md#selected-row-status-bar) instead.

## Display-only transformations

Improve readability without changing captured content or its token estimate:

- Omit a leading line that only repeats the heading above it; keep lines that
  add information.
- Keep previews focused on model-facing content, not message-envelope
  bookkeeping. Summary and bash content follow the
  [privacy contract](../architecture/privacy.md#raw-text-and-message-previews).
- Usage may replace complete skill expansions in user messages with recognizable
  skill badges; leave malformed wrappers visible.
- Base content caps and hidden-line counts on the transformed, wrapped text the
  full-content view actually opens. Clearly distinguish a cap from absent data.

### Marked JSON

Expand structurally marked JSON for readability at every preview level, so the
same content does not change format merely because it fits below a block cap.
Never guess that ordinary captured text is JSON from its appearance. If marked
text no longer parses, leave it unchanged. The estimate still uses the original
representation, not display indentation.
