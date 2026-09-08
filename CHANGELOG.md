# Changelog

## `[v0.5.2]` - 08.09.2026

### Fixed
* `[injections]` Recover and mark relocated Available Tools and Guidelines blocks.


## `[v0.5.1]` - 08.09.2026

### Changed
* `[context]` Align category ordering and naming with Pi terminology - [#2](https://github.com/dimk90/pi-context-view/issues/2).
* `[injections]` Show prompt additions as the `Extension Additions` part of `System Prompt`, counted by their owner.
* `[injections]` Align item naming with the category names in the injections view.
* `[injections]` Add sub-items for `System Prompt`: `Preamble`, `Available Tools`, `Guidelines`, etc - [#2](https://github.com/dimk90/pi-context-view/issues/2)..
* `[injections]` Show injected stuff by extensions in `System Prompt`, highlighted and marked `<- <extension>:<tool>`.
* `[injections]` Attribute system-prompt additions to the injecting extension, marked `(guess)`.
* `[injections]` Mark the prompt parts a `--system-prompt` replacement drops as `Dropped` at 0 tokens.
* `[usage]` Open single-entry categories directly as uncapped, scrollable content.

### Fixed
* `[context]` Count tokens for `Current working directory`.


## `[v0.5.0]` - 30.08.2026

### New
* `[config]` Add an global config for `Usage` category colors, see [customization](https://github.com/dimk90/pi-context-view#customization).
* `[config]` Add `/context config` to create a defaults-populated config file.

### Changed
* `[ui]` Expand JSON runs in every preview level (tool defs, tool-calls, etc).
* `[ui]` Label tool guidelines, and definitions in `Injections` and `Usage` previews.
* `[ui]` Drop a preview line that only repeats the heading above it.

### Fixed
* `[context]` Rebuild the session baseline once, not on every LLM request ([#1](https://github.com/dimk90/pi-context-view/pull/1) by [@kaushikvira](https://github.com/kaushikvira)).
* `[injections]` Count a guideline bullet shared by several tools once, like Pi renders it.
* `[probe]` Unblock the silent probe after a failed compaction (Pi `0.84.3` `session_compact_failed`).
* `[ui]` Collapse view descriptions on short terminals before map, legend, or list rows.


## `[v0.4.3]` - 19.08.2026

### Changed
* `[usage]` Add a full-content view for collapsed blocks.
* `[usage]` Change category-view scrolling from line-by-line to block-by-block.
* `[ui]` Add experimental mouse-wheel scrolling support (`fullscreen` mode only).
* `[ui]` Add `Ctrl+U`/`Ctrl+D` aliases for page navigation.


## `[v0.4.2]` - 14.08.2026

### Fixed
* `[ui]` Drop the `fullscreen` paging workaround (Pi 0.84.2 delivers `PgUp/PgDn` to the view in both TUI modes).


## `[v0.4.1]` - 10.08.2026

### Changed
* `[usage]` Add a "Block Size" row with the tokens and map share.
* `[usage]` Move the map legend below the category legend.
* `[usage]` Explain the map glyphs on separate rows.

### Fixed
* `[ui]` Add workaround for `PgUp/PgDn` keys in `fullscreen` mode -> map to `Ctrl+U/Ctrl+D`.


## `[v0.4.0]` - 06.08.2026

### New
* `[usage]` Zoom context map with `z`.

### Changed
* `[package]` Bump dev dependencies to Pi 0.84.

### Fixed
* `[probe]` Restore silent-probe invisibility on Pi 0.84.
* `[probe]` Skip silent probe during compaction.


## `[v0.3.1]` - 28.07.2026

### Changed
* `[ui]` Scroll lists and previews with `↑↓` and the vim-style `j`/`k` keys.


## `[v0.3.0]` - 26.07.2026

### New
* `[usage]` Show the auto-compaction reserve as "Auto-Compact Buffer" row (`⛝`).
* `[usage]` Use provider-reported reasoning for thinking category estimates (to include encoded-signatures).

### Changed
* `[usage]` Show the category scroll counter below the last legend row.
* `[usage]` Use full-size bullets (•) for Tool Output breakdown rows.

### Fixed
* `[usage]` Count the text pi's LLM transform adds to bash executions and compaction/branch summaries.
* `[usage]` Use an uppercase "M" for millions in compact token counts instead of "m".
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
