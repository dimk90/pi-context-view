
## `[v0.5.1]` - Unreleased

- [x] Rename `Memory (AGENTS.md)` to `Instructions / AGENTS.md`, to match pi naming.

- [x] Add `Instructions` item to injections view and group all there (sub-items): AGENTS.md, etc.

- [ ] **Match `/export` ordering and naming:**
   - Items become `System Prompt`, `Instructions / AGENTS.md`, `Skills`, `System Tools`, `Custom Tools`, in that order.
   - The names stay consistent between `/context usage` and `/context injections`.

- [ ] **Rename the top-level item to `System Prompt & Guidelines`.**

- [ ] **Break `System Prompt` into sub-items in `/context injections`.**
   - The base prompt already contains the guidelines and the tool list, but that isn't obvious from the current view. 
   - Sub-items should make it visible: `Available Tools`, `Guidelines`, `Documentation`, `Current Dir: ...`.

- [ ] **Keep extension-related guidelines excluded from the base count.**
   - Today the extension shows extension-provided guidelines in each extension's preview rather than in the `Guidelines` section where they actually sit.
   - Show those guidelines inside `System Prompt & Guidelines` (so the structure doesn't diverge from `/export`), in a distinct color, with an explicit note that they're attributed to their extension instead.
