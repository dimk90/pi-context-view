# Changelog

## `[v0.2.1]` - Unreleased

### Fixed
* `[usage]` Add fallback (`≈`) calculation of context usage after compaction and pi estimation is not available.

## `[v0.2.0]` - 13.07.2026

### New
* `[usage]` Add `/context` and `/context usage` fullscreen views with estimated token usage by context category.
* `[usage]` Add a proportional context map with used, compacted, and free-space visualization.
* `[usage]` Add keyboard navigation and explicit Enter previews for category content.
* `[injections]` Add `/context injections` for exploring the initial system prompt, tool definitions, skills, context files, extension prompt additions, and injected messages.
* `[injections]` Add hierarchical navigation, token estimates, and sanitized raw-content previews.
* `[context]` Add an on-demand silent probe for capturing initial context before the first real turn without making a provider request.

#### Changed
* `[context]` Replace the v0.1 `--context-inspect` print-and-exit workflow with focused interactive `/context` views.
* `[measure]` Improve prompt decomposition, tool ownership, skill measurement, and context-file attribution.

## `[v0.1.0]` - 10.07.2026

### New
* `[context]` Add the initial `--context-inspect` CLI workflow for measuring startup prompt, tool, and extension injections.
* `[measure]` Add prompt-component and tool-definition token estimation.
* `[report]` Add a plain-text context injection report.
