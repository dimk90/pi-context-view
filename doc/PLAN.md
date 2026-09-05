
## `[v0.5.1]` - Unreleased

- [x] Rename `Memory (AGENTS.md)` to `Instruction Files`, to match pi naming.

- [x] Add `Instruction Files` item to injections view and group all there (sub-items): AGENTS.md, etc.

- [x] **Match `/export` ordering and naming:**
   - Items become `System Prompt`, `Instruction Files`, `Skills`, `Built-in Tools`, `Custom Tools`, in that order.
   - The names stay consistent between `/context usage` and `/context injections`.

- [x] **Break `System Prompt` into sub-items in `/context injections`.**
   - The base prompt already contains the guidelines and the tool list, but that isn't obvious from the current view.
   - Sub-items should make it visible: `Available Tools`, `Guidelines`, `Documentation`, `Current Dir: ...`, `prompt-addition:aggregate`....
   - The `System Prompt` view should sub-items as sections, not blocks - for both usage and injections views.

- [x] Show `--append-system-prompt` text inside `System Prompt` item but in separate section.


- [x] **Keep extension-related guidelines excluded from the base count.**
   - Today the extension shows extension-provided guidelines in each extension's preview rather than in the `Guidelines` section where they actually sit.
   - Show those guidelines inside `System Prompt`, in a distinct color, with an explicit note that they're attributed to their extension instead.
   - For the guidlines items which are came from extensions show arrow (`->`) and extension which injected it.
   - Discussion about "distinct" color, `->` color and extension color.

- [x] Update style for injected stuff in `System Prompt`:
  - Better colors:
    - Injected text: `customMessageLabel`;
    - `->`: `dim`;
    - extension name: `mdLink`;
  - Descriptions at the bottom of the view as for other view.
  - More clear description: e.g. "Highlighted parts are injected by extension into the pi's system prompt, excluded from system prompt token count but included to extension that injects it".
  - Show description not only on sub-item preview but also on `System Prompt` preview.

- [x] Apply the same approach to mark injected stuff (by extension) for other `System Prompt` sub-items:
  - `Available Tools`
  - No other sub-items carry extension text: `Preamble`, `Documentation` and `Current Dir` are pi-authored, `Instruction Files`/`Skills` are carved out as their own items, and `prompt-addition:aggregate` is covered by the next item.

- [x] **prompt-addition:aggregate** extension attribution:
  - Moved to `System Prompt` as the reference-only `Extension Additions` sub-item.
  - Attribution is only ever a guess: pi chains `before_agent_start` prompt edits through one string and records no author, so blocks are named from package specifiers and extension paths in the text itself, bounded by this extension's own handler position.
  - An attributed block is counted by its extension, never by `System Prompt`; the rest stays one item in the `unattributed` group.
  - Guessed names carry a dim `(guess)` marker and the attribution footer explains it.

- [ ] **More detailed injections**:
  - In case when injection can be attributed to extension tool mark it: "<- <extension>:<tool>".
  - Use different color for ":<tool>".

- [ ] **Mark the parts a `--system-prompt` replacement drops.**
   - `--system-prompt` replaces pi's whole base prompt, so pi's guidelines, its `Available tools:` list, and its documentation block are never sent. Tool definitions still are; extension-contributed guidelines and tool snippets are dropped along with pi's own.
   - Keep `Available Tools`, `Guidelines`, and `Documentation` visible under `System Prompt`, each marked `Dropped` at 0 tokens, so the view shows what the custom prompt gave up instead of silently omitting it.
   - Show no pi-authored content in a dropped section: only extension-contributed entries stay visible (guidelines, tool snippets), each `Dropped` at 0 tokens in the color that attributes it to its extension. A section with no extension content renders empty.
   - Mark each extension's own guidelines `Dropped` at 0 tokens as well, so no extension preview claims tokens pi never sent.
   - `Dropped` uses one fixed theme color rather than a configurable category color: it marks a state, not a usage category, and a 0-token entry never colors map cells.

- [ ] Update logo for package and README.
