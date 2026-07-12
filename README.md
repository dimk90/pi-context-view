# pi-context-view

![Context usage map](doc/images/pi-context-view.png)

The extension provides visualization for content in the context and allows to inspect invisible pieces: base prompt, instructions injected by extensions, etc.

## Features

- **Context usage map**: Visualize occupied and free context space, grouped by categories tools, skills, messages.
- **Context injections**: Explore the invisible pieces of the context: initial prompt, tool definitions, extension's injections.

## Commands

- `/context` - short version of `/context usage`.
- `/context usage` — open the context usage visualization.
- `/context injections` — shows invisible content of the context at the session start/resume.

## Install

```bash
pi install npm:pi-context-view
```

### Usage Examples

- Inspect context composition after compaction:

  ![Context usage view and category preview](doc/images/context-usage.png)

- Inspect invisible things in the context, e.g. tools definitions:

  ![Context injections view and item preview](doc/images/context-injections.png)

## Context

`pi-context-view` does not add instructions or messages to the model context.

## License

MIT
