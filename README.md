# pi-context-view

<h1 align="center">
    <img src="https://media.githubusercontent.com/media/dimk90/pi-context-view/cbf53257118d811188a48591905fb9438fd54536/doc/images/pi-context-view.png" width="400">
</h1>

<br>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/pi-context-view?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/pi-context-view)
[![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://pi.dev/packages/pi-context-view)


Pi extension that visualizes what fills the model's context and lets
you inspect the parts you normally can't see: the base prompt, tool
definitions, and instructions injected by other extensions.

## Features

- **Context usage map** - visualize used and free context space, grouped by
  category (tools, skills, messages, and more).

- **Context injections** - explore the hidden pieces of the context: the
  initial prompt, tool definitions, and extension injections.

## Commands

- `/context` - shorthand for `/context usage`.
- `/context usage` - open the context usage visualization.
- `/context injections` - show the hidden content of the context at session
  start or resume.

## Usage Examples


### `/context`

See what fills your context.
For example, check what remains after compaction:

<img width="700" alt="Context usage view showing estimated context composition" src="https://media.githubusercontent.com/media/dimk90/pi-context-view/4001d9d38c47959b9564a2f224d99fe66028a3e9/doc/images/context-usage.gif">


### `/context injections`

Inspect hidden parts of the context, such as tool definitions:

<img width="700" alt="Context injections view and item preview" src="https://media.githubusercontent.com/media/dimk90/pi-context-view/fe6da5953ec64c760a29d4838a12bd5122c67dfc/doc/images/context-injections.gif">


## Install

```bash
pi install npm:pi-context-view
```

## Context

`pi-context-view` does not add any instructions or messages to the model context.

## License

MIT
