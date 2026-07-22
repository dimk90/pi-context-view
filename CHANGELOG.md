# Changelog

## `[v0.3.0]` - Unreleased

### Changed
* `[package]` Exclude demo images and GIFs from the npm package.

## `[v0.2.4]` - 22.07.2026

### Fixed
* `[measure]` Fix base-prompt boundary detection for the Pi 0.81.


## `[v0.2.3]` - 20.07.2026

### Fixed
* `[doc]` Update broken links in README.

## `[v0.2.2]` - 20.07.2026

### Changed
* `[usage]` Skip the preview-less "Free Space" row during category navigation in the Usage view.

### Fixed
* `[context]` Persist silent-probe message identities as a session custom entry
              so probe entries stay excluded from model contexts across resume, reload, and fork.

## `[v0.2.1]` - 13.07.2026

### Changed
* `[usage]` Compact complete attached-skill expansions into pi-themed badges in User Message previews.
* `[usage]` Refine the Usage dashboard with responsive header totals, a full/part map key, and dim dot leaders.
* `[injections]` Clarify injection hierarchy with tree connectors, nearby aligned token values, and dim dot leaders.

### Fixed
* `[usage]` Add fallback (`≈`) calculation of context usage after compaction and pi estimation is not available.
* `[ui]` Wrap dialog descriptions onto indented continuation lines instead of truncating them in narrow terminals.

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
