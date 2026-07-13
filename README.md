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

## Install

```bash
pi install npm:pi-context-view
```

### Usage Examples

- Inspect context composition after compaction:

  ![Context usage view and category preview](https://media.githubusercontent.com/media/dimk90/pi-context-view/cbf53257118d811188a48591905fb9438fd54536/doc/images/context-usage.png)

- Inspect hidden parts of the context, such as tool definitions:

  ![Context injections view and item preview](https://media.githubusercontent.com/media/dimk90/pi-context-view/cbf53257118d811188a48591905fb9438fd54536/doc/images/context-injections.png)

## Context

`pi-context-view` does not add any instructions or messages to the model
context.

## License

MIT
