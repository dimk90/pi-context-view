# Default Configuration

`pi-context-view` reads one global file:

```
~/.pi/agent/extensions/pi-context-view.json
```

The config file created with `/context config` will contain:

```json
{
  "systemPromptColor": "mdHeading",
  "instructionFilesColor": "mdCodeBlock",
  "skillsColor": "customMessageLabel",
  "builtInToolsColor": "mdHeading",
  "customToolsColor": "accent",
  "mcpToolsColor": "mdLink",
  "userMessagesColor": "syntaxString",
  "assistantMessagesColor": "syntaxFunction",
  "assistantThinkingColor": "thinkingXhigh",
  "toolCallsColor": "syntaxKeyword",
  "toolOutputColor": "toolOutput",
  "extensionsColor": "syntaxType",
  "compactedDataColor": "thinkingHigh",
  "autoCompactBufferColor": "dim",
  "freeSpaceColor": "dim",

  "mapCols": 16,
  "mapRows": 16,

  "iconStyle": "Square",
  "iconStyles": {
    "CC": "⛝⛶⛀⛁⛃",
    "Nerd": "󰅗⛶󰆼",
    "Circle": "⮾·◕●♼",
    "Square": "⛝⛶◧■▦"
  },

  "autoProbing": true
}
```

> [!TIP]
> The config file holds overrides only: remove a key to fall back to the
> built-in default.

> [!TIP]
> Reopen `/context` to apply config changes. No need for pi `/reload`.

> [!NOTE]
> Several keys were renamed in `v0.5.1`: `systemToolsColor` to
> `builtInToolsColor`, `memoryColor` to `instructionFilesColor`,
> `agentTextMessagesColor` to `assistantMessagesColor`,
> `agentThinkingMessagesColor` to `assistantThinkingColor`,
> `agentToolCallMessagesColor` to `toolCallsColor`.


## Category Colors

Each `*Color` key colors one `Context Usage` category: its legend marker and its
cells in the usage map.

A value is either a Pi theme color name or a literal hex color:

- theme names, such as `accent`, `warning`, `syntaxString`, follow the active theme,
  so the category is recolored along with everything else when the theme changes.
  [PI-THEME-COLORS](PI-THEME-COLORS.md) lists every theme color name with its swatch in the built-in dark theme.

- hex values, written `#rrggbb` or shorthand `#rgb` (like `#f0a`), stay
  the same under every theme. On terminals without truecolor support they
  down-convert to the closest 256-color index, exactly as Pi does with hex
  values in its own theme files.

> [!NOTE]
> `autoCompactBufferColor` and `freeSpaceColor` also color the buffer and free
> glyphs (`⛝` and `⛶` in the default icon style) in the Block Size key.


## Map Size

`mapCols` and `mapRows` set how many cells the `Context Usage` map is wide and
tall. Both accept a whole number between `4` and `64`; anything else is ignored
with a warning shown above the map.

The map is a request, not a guarantee: every frame renders the largest
configured size that still fits, dropping columns before the legend becomes
narrower than 32 columns and rows before the map outgrows the terminal height.
A clamped map is rebuilt at the smaller size, so it still maps the whole context
window.


## Icon Styles

`iconStyle` names the icon style that draws the `Context Usage` map, its legend
markers and the map key. `iconStyles` lists the styles to choose from.

Each style is a string of exactly 5 glyphs, in this order:

| Position | Glyph in `Square` | Meaning                                |
| -------- | ----------------- | -------------------------------------- |
| 1        | `⛝`               | Auto-compact buffer                    |
| 2        | `⛶`               | Free space                             |
| 3        | `◧`               | Block shared by several categories     |
| 4        | `■`               | Block of a single category             |
| 5        | `▦`               | Compacted data                         |

Press `i` in `Context Usage` to switch to the next style in the list. The
selected style is saved to `iconStyle` when the view closes. Without a config
file, this creates one that holds only `iconStyle`.

Add your own style under any name and select it with `iconStyle`:

```json
{
  "iconStyle": "Ascii",
  "iconStyles": {
    "Ascii": "x.+#%",
    "Square": "⛝⛶◧■▦"
  }
}
```

- `iconStyles` replaces the whole list, so keep the pre-defined styles you
  still want. Without the key, the four pre-defined styles stay available.
- Every glyph must be one terminal cell wide; a style that is not exactly 5
  such glyphs is ignored with a warning shown above the map.
- When `iconStyle` is omitted or names an unknown style, the map uses `Square`,
  or the first listed style when the list has no `Square`.
- `Nerd` needs a [Nerd Font](https://www.nerdfonts.com/) in the terminal.


## Silent Probe

`autoProbing` controls the [silent probe](architecture/probe.md): when a view
opens before any request was captured, it runs one empty prompt to observe
what Pi and other extensions add to a request. The run is aborted before it
reaches the model, but other extensions' handlers still run.

Set `autoProbing` to `false` to never start the probe.
