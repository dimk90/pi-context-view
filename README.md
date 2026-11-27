# pi-context-view

<p align="center">
  <img width="490" src="https://media.githubusercontent.com/media/dimk90/pi-context-view/a553932768bba22995a70a6c2f9fa4f4f50d8dee/doc/images/pi-context-view.png">
  <br>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://www.npmjs.com/package/pi-context-view"><img src="https://img.shields.io/npm/v/pi-context-view?style=flat-square&amp;logoColor=white" alt="npm version"></a>
  <a href="https://pi.dev/packages/pi-context-view"><img src="https://img.shields.io/badge/Pi-Package-6366F1?style=flat-square" alt="Pi Package"></a>
  <a href="https://www.npmjs.com/package/pi-context-view"><img src="https://img.shields.io/npm/dm/pi-context-view?label=Downloads&style=flat-square" alt="npm downloads"></a>
  <a href="https://discord.com/channels/1456806362351669492/1531004733873979532"><img src="https://img.shields.io/static/v1?label=%20&message=Community&color=5865F2&labelColor=555&style=flat-square&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<br>

[Pi](https://pi.dev) extension that visualizes context usage and lets you inspect the parts you
normally can't see: the system prompt, tool definitions, and instructions
injected by other extensions.

## Features

- **Context usage map** - visualize used and free context space, grouped by
  category (tools, skills, messages, and more).

- **Context injections** - explore the hidden parts of the context: the
  system prompt, tool definitions, and extension injections.

## Commands

- `/context` - shorthand for `/context usage`.
- `/context usage` - open the context usage visualization.
- `/context injections` - explore the latest request's injections: its system
  prompt, tool definitions, and extension contributions.
- `/context config` - create the global configuration file populated with
  defaults, useful for
  [customization](https://github.com/dimk90/pi-context-view#customization).

## Demo: `/context`

See what fills your context, for example, what survives compaction:

![Context usage view showing estimated context composition](https://media.githubusercontent.com/media/dimk90/pi-context-view/a553932768bba22995a70a6c2f9fa4f4f50d8dee/doc/images/context-usage.gif)  
➥ Pi theme in this demo: [`dark-legacy`](https://github.com/dimk90/pi-context-view/blob/master/doc/dark-legacy.json).


## Demo: `injections`

Inspect hidden parts of the context, such as tool definitions:

![Context injections view and item preview](https://media.githubusercontent.com/media/dimk90/pi-context-view/a553932768bba22995a70a6c2f9fa4f4f50d8dee/doc/images/context-injections.gif)  

## Demo: `zoom`

Zoom in for a more detailed breakdown of large context windows, such as
1M-token windows:

![Zoom feature](https://media.githubusercontent.com/media/dimk90/pi-context-view/a553932768bba22995a70a6c2f9fa4f4f50d8dee/doc/images/zoom.gif)  
➥ Pi theme in this demo: [`dark-legacy`](https://github.com/dimk90/pi-context-view/blob/master/doc/dark-legacy.json).

## Install

```bash
pi install npm:pi-context-view
```

## Customization

You can customize the colors, dimensions and icons of the `Context Usage` map.

To get started, create a configuration file populated with the current defaults:

```text
/context config
```
➥ This creates `~/.pi/agent/extensions/pi-context-view.json`.

See the [configuration reference](https://github.com/dimk90/pi-context-view/blob/master/doc/CONFIG.md)
for each parameter's meaning and default value.

### Icon Styles

Press `i` in `Context Usage` to switch between the pre-defined icon styles.
You can also add your own icons with [`iconStyles`](https://github.com/dimk90/pi-context-view/blob/master/doc/CONFIG.md#icon-styles) in the config.

![Icon styles demo](https://media.githubusercontent.com/media/dimk90/pi-context-view/a553932768bba22995a70a6c2f9fa4f4f50d8dee/doc/images/icon-styles.gif)  


### Category Colors

You can use theme color names to match your current theme or hex values for
colors that stay the same across themes. Here are examples of custom
[terrain](https://github.com/dimk90/pi-context-view/blob/master/doc/palettes/terrain.json) and
[rainbow](https://github.com/dimk90/pi-context-view/blob/master/doc/palettes/rainbow.json) palettes:

![Terrain and rainbow palettes](https://media.githubusercontent.com/media/dimk90/pi-context-view/a553932768bba22995a70a6c2f9fa4f4f50d8dee/doc/images/palettes.png)  
➥ Pi theme in this demo: [`dark-legacy`](https://github.com/dimk90/pi-context-view/blob/master/doc/dark-legacy.json).

See the [theme color reference](https://github.com/dimk90/pi-context-view/blob/develop/doc/PI-THEME-COLORS.md)
for color names that follow the current theme.

### Map Size

You can configure the number of rows and columns in the `Context Usage` map:

![Map size demo](https://media.githubusercontent.com/media/dimk90/pi-context-view/e56929607b3fc83c4efdc3ba65f6feee19dff192/doc/images/map-sizes.png)  


## Context Footprint

`pi-context-view` adds nothing to the model context. Opening a view before the
first turn may run one [silent probe](https://github.com/dimk90/pi-context-view/blob/master/doc/architecture/probe.md)
that sends no request and leaves only blank entries, omitted from future context.
Set `"autoProbing": false` in the [config](https://github.com/dimk90/pi-context-view/blob/master/doc/CONFIG.md#silent-probe) to disable it.

## My Other Stuff

📌 [S-VHS](https://github.com/dimk90/s-vhs) - terminal recorder used to create the demo GIFs.

📌 [pi-tui-prompt-box](https://github.com/dimk90/pi-tui-prompt-box) - Pi extension with an alternative style for the prompt input.

## License

[MIT](https://github.com/dimk90/pi-context-view/blob/master/LICENSE)
