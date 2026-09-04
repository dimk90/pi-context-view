
## `[v0.5.1]` - Unreleased

- [x] Rename `Memory (AGENTS.md)` to `Instruction Files`, to match pi naming.

- [x] Add `Instruction Files` item to injections view and group all there (sub-items): AGENTS.md, etc.

- [x] **Match `/export` ordering and naming:**
   - Items become `System Prompt`, `Instruction Files`, `Skills`, `Built-in Tools`, `Custom Tools`, in that order.
   - The names stay consistent between `/context usage` and `/context injections`.

- [ ] **Break `System Prompt` into sub-items in `/context injections`.**
   - The base prompt already contains the guidelines and the tool list, but that isn't obvious from the current view.
   - Sub-items should make it visible: `Available Tools`, `Guidelines`, `Documentation`, `Current Dir: ...`.

- [ ] **Keep extension-related guidelines excluded from the base count.**
   - Today the extension shows extension-provided guidelines in each extension's preview rather than in the `Guidelines` section where they actually sit.
   - Show those guidelines inside `System Prompt & Guidelines` (so the structure doesn't diverge from `/export`), in a distinct color, with an explicit note that they're attributed to their extension instead.

- [ ] **Mark the parts a `--system-prompt` replacement drops.**
   - `--system-prompt` replaces pi's whole base prompt, so pi's guidelines, its `Available tools:` list, and its documentation block are never sent. Tool definitions still are; extension-contributed guidelines and tool snippets are dropped along with pi's own.
   - Keep `Available Tools`, `Guidelines`, and `Documentation` visible under `System Prompt & Guidelines`, each marked `Dropped` at 0 tokens, so the view shows what the custom prompt gave up instead of silently omitting it.
   - Show no pi-authored content in a dropped section: only extension-contributed entries stay visible (guidelines, tool snippets), each `Dropped` at 0 tokens in the color that attributes it to its extension. A section with no extension content renders empty.
   - Mark each extension's own guidelines `Dropped` at 0 tokens as well, so no extension preview claims tokens pi never sent.
   - `Dropped` uses one fixed theme color rather than a configurable category color: it marks a state, not a usage category, and a 0-token entry never colors map cells.

- [ ] Show `--append-system-prompt` text inside `System Prompt` item but in separate section.

- [ ] Update logo for package and README.
