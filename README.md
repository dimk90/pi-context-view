# pi-context-view

<p align="center">
  <img width="392" src="https://media.githubusercontent.com/media/dimk90/pi-context-view/c69c44d9ed0ee245183c3f82de11d8da312ba129/doc/images/pi-context-view.png">
  <br>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://www.npmjs.com/package/pi-context-view"><img src="https://img.shields.io/npm/v/pi-context-view?style=flat-square&amp;logoColor=white" alt="npm version"></a>
  <a href="https://pi.dev/packages/pi-context-view"><img src="https://img.shields.io/badge/Pi-Package-6366F1?style=flat-square" alt="Pi Package"></a>
  <a href="https://www.npmjs.com/package/pi-context-view"><img src="https://img.shields.io/npm/dm/pi-context-view?style=flat-square" alt="npm downloads"></a>
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
- `/context injections` - show the hidden parts of the context captured at
  session start or resume.

## Demo


### `/context`

See what fills your context, for example, what survives compaction:

![Context usage view showing estimated context composition](https://media.githubusercontent.com/media/dimk90/pi-context-view/100b63fb4c91b380bfe9fc72e33eb385850ca881/doc/images/context-usage.gif)


### `/context injections`

Inspect hidden parts of the context, such as tool definitions:

![Context injections view and item preview](https://media.githubusercontent.com/media/dimk90/pi-context-view/100b63fb4c91b380bfe9fc72e33eb385850ca881/doc/images/context-injections.gif)

### Zoom

Zoom in for a more detailed breakdown of large context windows, such as
1M-token windows:

![Zoom feature](https://media.githubusercontent.com/media/dimk90/pi-context-view/d24c88eb8a9f89fb9acc9bd4cbdfec283a1de8b7/doc/images/zoom.gif)

## Install

```bash
pi install npm:pi-context-view
```

## Context Footprint

`pi-context-view` does not add any instructions or messages to the model context.

## Related Projects

📌 [S-VHS](https://github.com/dimk90/s-vhs) - terminal recorder used to create
  the demo GIFs.

## License

MIT
