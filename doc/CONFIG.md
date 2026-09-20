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
  "mapRows": 16
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
> `autoCompactBufferColor` and `freeSpaceColor` also color the `⛝`
> and `⛶` glyphs in the Block Size key.


## Map Size

`mapCols` and `mapRows` set how many cells the `Context Usage` map is wide and
tall. Both accept a whole number between `4` and `64`; anything else is ignored
with a warning shown above the map.

The map is a request, not a guarantee: every frame renders the largest
configured size that still fits, dropping columns before the legend becomes
narrower than 32 columns and rows before the map outgrows the terminal height.
A clamped map is rebuilt at the smaller size, so it still maps the whole context
window.
