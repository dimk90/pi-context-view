# pi-context-view

![Context usage map](doc/images/pi-context-view.png)

A pi extension that visualizes what fills the model's context and lets
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

  ![Context usage view and category preview](doc/images/context-usage.png)

- Inspect hidden parts of the context, such as tool definitions:

  ![Context injections view and item preview](doc/images/context-injections.png)

## Context

`pi-context-view` does not add any instructions or messages to the model
context.

## License

MIT
