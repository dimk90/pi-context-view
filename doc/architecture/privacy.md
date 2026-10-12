# Privacy and Configuration

Part of the [architecture](../ARCHITECTURE.md). What this extension may keep,
show, and persist, and how it loads and writes its configuration.

## Privacy

### Raw Text and Message Previews

Keep raw prompt and message content in this process only. Sanitize it before
terminal rendering, and reveal it only after explicit Enter preview. Never log
it, include it in notifications, persist extra copies, or inject it into a
later model request. This applies to request copies, payload copies, guard
findings, and snapshots alike: snapshots live only in memory and are never
saved with the session.

Capture message content, not the whole message object:

- System previews contain plain `content` followed by non-deleted section text,
  even when `content` is empty. Omit text-block signatures. Deleted sections
  have no preview text or text-token contribution.
- Branch and compaction previews contain only `summary`.
- Bash previews use Pi's `convertToLlm` text, including failure/cancellation
  notices and truncated-output file references.
- A bash message excluded from context has no preview text.
- Fields such as `timestamp`, `fromId`, and `tokensBefore` are not preview
  content.

This extraction does not change source messages, baseline matching, or token
estimates.

### Images and Provider Signatures

Never retain or render captured image payloads. Before serializing a preview,
replace an image block's base64 `data` with its captured size. Keep the rest of
the block, including `mimeType`, as captured. The size measures the base64
text, not the decoded image; token estimates still use Pi's image proxy.

Treat `textSignature`, `thinkingSignature`, and `thoughtSignature` as opaque
provider metadata. Gemini can also store reasoning data in `textSignature` on
text blocks. For accounting, inspect signature bytes only for length. The
payload guard also checks absence, emptiness, and whitespace-only content to
follow Pi's thinking-to-text rules; it keeps only those states, never the
bytes. Never tokenize, render, preview, or log the bytes themselves.

Strip those fields from assistant text, thinking, and tool-call blocks,
respectively, before serializing injected-message previews. This includes
request-only replacements. Do not change the provider-bound message or tool
arguments, even if an argument has the same name as a signature field.

Request snapshots redact the messages they retain before publication, so no
consumer receives these bytes: image `data` becomes the same `<size omitted>`
marker, `textSignature` is removed, and `thinkingSignature` and
`thoughtSignature` become filler of the same length. Only that length remains,
for the [signature-size proxy](../THINKING.md#counting-architecture). Token
estimates do not change: Pi counts images by a fixed proxy and never counts
signatures.

The short-lived request copy used for the diff is raw and released after
building and payload pairing or settlement. It holds only the replayed system
state, historical declarations, positioned system text, and messages that
differ from the baseline. Payload copies duplicate arrays and objects, sharing
string values (including image and signature strings) until parsing. The tool
parser keeps only declared names and descriptions. The message parser excludes
image data and opaque signatures; findings keep only changed model-facing text
lines. The guard's converted transcript strips image data and replaces
signature bytes with presence and emptiness states before waiting for a
virtual dispatch. All comparison inputs are released after comparison or
settlement.

### Persisted Records

The silent probe persists only role-and-timestamp identities in
`pi-context-view:probe-identities` custom entries, plus `context_edit`
omissions with target entry IDs and `null` replacements
([probe messages](probe.md#keeping-probe-messages-out-of-real-context)).
Neither record stores content. The probe token stays in this process and is
never persisted, rendered, or logged.

## Configuration

### Defaults and Loading

Defaults live in code. The global file at
`getAgentDir()/extensions/pi-context-view.json` holds overrides, so omitted
keys follow later default changes.

Never auto-create the file or write missing defaults into an existing file.
Load it only when a view needs it, not in the extension factory: the factory
also runs in commands that never start a session. Cache per runtime and reload
when the file's modification time changes.

- An absent file or omitted key silently uses the default.
- An unreadable or unparseable file, unknown key, invalid color, or
  out-of-range value falls back to the applicable default. Warn once per file
  revision, never fail the view.
- A renamed key keeps its old name as a silently accepted alias. If both names
  are present, the current name wins.

### Explicit Writes

`/context config` is the create-only action. It writes every default with one
atomic `O_EXCL` create and never overwrites or modifies an existing path. It
works in every run mode on a
[supported Pi](pi-requests.md#supported-pi-versions). Only the views require
`ctx.mode === "tui"`.

Any later action that updates an existing file must debounce writes and merge
over a fresh read, preserving concurrent edits and unknown keys.

Configuration stores preferences only, never captured prompts or messages.
See [CONFIG.md](../CONFIG.md) for the settings,
[UI.md](../UI.md#color-and-casing) for colors, and
[ui/usage.md](../ui/usage.md#context-map) for map geometry.
