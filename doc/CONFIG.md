# Default Configuration

`pi-context-view` reads one global file:

```
~/.pi/agent/extensions/pi-context-view.json
```

The config file created with `/context config` will contain:

```json
{
  "systemPromptColor": "mdHeading",
  "systemToolsColor": "mdHeading",
  "customToolsColor": "accent",
  "mcpToolsColor": "mdLink",
  "memoryColor": "mdCodeBlock",
  "skillsColor": "customMessageLabel",
  "userMessagesColor": "syntaxString",
  "agentTextMessagesColor": "syntaxFunction",
  "agentThinkingMessagesColor": "thinkingXhigh",
  "agentToolCallMessagesColor": "syntaxKeyword",
  "toolOutputColor": "toolOutput",
  "extensionsColor": "syntaxType",
  "compactedDataColor": "thinkingHigh",
  "autoCompactBufferColor": "dim",
  "freeSpaceColor": "dim"
}
```

> [!TIP]
> The config file holds overrides only: remove a key to fall back to the
> built-in default.

> [!TIP]
> Reopen `/context` to apply config changes. No need for pi `/reload`.


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
