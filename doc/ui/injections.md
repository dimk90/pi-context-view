# Context Injections view

`/context injections` explains the latest request's contributions and changes.
Apply the [shared design rules](../UI.md) and [preview rules](previews.md).
[Views on snapshots](../architecture/views.md#injections) owns composition and
snapshot behavior; [measurement](../architecture/measurement.md) owns estimates
and attribution.

## Latest request

Make the request's origin and capture limits clear. A silent probe is not an
ordinary user request and may miss prompt-dependent injections. Keep that
origin recognizable even when optional explanations collapse.

Distinguish pending, unchecked, and partially checked payload comparisons from
a completed comparison. No findings from an incomplete check must never imply
that the payload matched. Keep incomplete status near the header; detailed
reasons can live in the description. A degraded fallback also needs its precise
reason visible, not only a generic warning. Configuration problems follow it in
a bounded notice block that makes omitted notices apparent; the degraded reason
itself is never cut. Disabled probing is an expected state, not a degradation:
explain it only as a description note.

The view describes one request, not the whole session or necessarily the last
user prompt. Do not blur this distinction with Usage's current-branch estimate.
Hidden-tool details and longer probe or payload explanations are supporting
information and may collapse with the description.

## Contribution tree

Group contributions by source: pi first, identified extensions by size, then
one shared unattributed group. Within pi, preserve the prompt's meaningful
structure and order. Children explain a parent's contribution; they are not
extra usage. Omit empty sources while retaining meaningful zero-token states,
such as deletions and dropped parts.

Keep ownership distinct from editing: a source group identifies affected
content, not who changed it. Messages and payload findings use aggregate rows
with labeled preview parts rather than expanding every detail in the tree.
The architecture's [source rules](../architecture/measurement.md) determine
which contributions have known, guessed, or unknown owners.

Use hierarchy and stable value columns to make comparisons easy. Prefer
filenames over middle directories when shortening paths; leave captured paths
and preview identities unchanged. Preserve estimates before decorative leaders
or optional metadata when width is limited.

Keep the total outside the scrollable tree so it remains available through
navigation and resizing. Make its scope clear: these contributions are neither
the full conversation nor the provider payload's size. The total is not a
selectable or previewable row.

### System prompt rows

Source-level system prompt rows explain changes already counted under pi.
Show their diffs without a token estimate and explain the existing accounting;
a displayed zero would suggest that the contributed text costs nothing.
[Measurement](../architecture/measurement.md#system-prompt-rows) owns the split
and no-double-counting rule.

### Request-only changes

Separate the amount of a change from whether the session keeps it. Token diffs
alone cannot communicate that distinction. Mark affected request-only content
consistently between the tree and previews; a forced prompt explains a
replacement of the whole prompt, not a separate forced state on every part.
Only a part whose captured request edit the forced prompt replaced carries
Forced itself: the edit would otherwise vanish silently. Show such a part once,
with the estimate of what Pi sent; its status says whether Pi still sent the
part, and its preview diffs from the replaced edit to the sent text, so added
lines are what Pi sent, as in the row's diff. The preview legend explains every
marked part at once, so it never claims whether a particular part was sent.

Keep dropped, moved, forced, and request-only states distinct. They describe
absence, position, replacement, and persistence respectively, not source
ownership or usage categories. Payload findings are a separate observation
layer and must not be presented as captured request-only edits.

### Selected-row status bar

Keep a persistent area outside the tree for the selected row's change and state
details. Explain where changes live, whether an editor is known or inferred,
and whether a diff is already counted elsewhere. Show only relevant details;
never raw content or an editor guessed from the source group.

Parents summarize the contributions they count rather than claiming a single
editor. Unknown attribution must remain explicit. Selecting another row updates
the explanation; returning from a preview restores it.

This area and the total take priority over optional descriptions. On short
terminals, reduce decoration before sacrificing capture status, the degraded
reason, the selected row, the total, or its explanation. Restore the normal
frame when space returns. If narrow rows omit diff columns or markers, the
selected-row explanation must still make their meaning available.

### Token diffs

Use signed added/removed values with consistent semantic colors, separate from
the sent-content estimate. Keep their columns stable while scrolling. Explain
the comparison base when inspecting a diff; different contribution kinds do
not all compare against the same thing.
[Token diff accounting](../architecture/measurement.md#token-diffs) owns those
rules and their limits.

## Filter

`/` filters the tree under the shared
[search and filter rules](../UI.md#search-and-filter). It compares names by
default; Tab in the open prompt switches between names and content. Instead of
a label, the prompt leads with both modes, the active one emphasized, like pi's
own selector scope toggles, so the alternative stays visible without a
state-dependent hint; the hint names only the key.

- Name mode matches group and item labels. A matching group or item keeps its
  whole subtree, since naming a container asks for its contents; rows inside it
  whose own label matches still count as matches.
- Content mode matches each item's sanitized text. An item with children
  matches through them: its own text concatenates theirs, so it stands alone
  only when no child matches. Group labels are names and never match here.

A filter only hides rows. Shown rows keep their tree connectors, estimates,
diffs, and status as in the whole tree, and the total still counts the whole
request. Name mode highlights the query inside matched labels. Content mode
highlights nothing, because rows never show raw text. An empty result says so
explicitly, and Enter then opens nothing.

Enter on a content-mode match opens its preview with the same query already
searched, at its first match.

## Injection preview

Enter opens sanitized full content with enough identity and accounting context
to understand it. Aggregates expose labeled parts; a preview must not turn
repeated attribution into a second counted contribution.

Keep list and preview states consistent. Explain visible markers and the diff
base without repeating unrelated list-wide details. Message previews compare
with the session original; payload previews compare retained changed lines with
the captured request. A changed System Prompt part previews a diff against the
same base as its `+N`/`-N`, so its body never contradicts its subheader; a
part without a base is wholly added and reads as plain content. A part
with extension lines keeps its highlighted, annotated text instead: its
owners' rows split its diff, and the annotations show their sources. Preserve their meaningful order and distinguish tool
declarations from tool calls. Deleted content remains inspectable as a
zero-token reference, not content the request sent.

Use the shared [preview rules](previews.md) for diff bodies, source annotations,
and display-only transformations. `/` searches the preview under the shared
[search and filter rules](../UI.md#search-and-filter). Escape returns to the
same tree position.
