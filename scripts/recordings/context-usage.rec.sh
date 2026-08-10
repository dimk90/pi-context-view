#!/usr/bin/env bash
#
# s-vhs recording of the usage view: open /context, walk the legend,
# and preview one category.
#
# Produces doc/images/context-usage.gif
#

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)

# pi is started as `pi -e .`, so the recorded shell has to sit in the repo root
cd "$REPO_ROOT" || exit 1

# shellcheck disable=SC1090
source <(curl -fsSL https://dimk90.github.io/s-vhs/v0.2.0) && wait "$!" || exit 1


## Constants


# The demo replays one recorded session, so its id and model are pinned
PI_COMMAND='pi -e . --session 019f7c38-d958-7d36-8d86-e22832c0d227'
PI_COMMAND+=' --model openai-codex/gpt-5.6-sol --no-extensions'
PI_COMMAND+=' --thinking xhigh'


## Configuration


SetOutput "$REPO_ROOT/doc/images/context-usage.gif"

SetCols 80
SetRows 34
SetFontSize 30
SetFontFamily 'Iosevka Term'
SetTheme 'asciinema'
SetTypingSpeed 0.1

Start


## Recording


# Bring pi up off camera, so the GIF opens on an idle TUI
Run "$PI_COMMAND"
Wait 'Session compacted 2 times'

Show

Sleep 1

# Open the usage view
Type '/context'
Sleep 1
Enter
Wait 'Context Usage'
Sleep 3

# Walk a few legend categories
Down 3 0.2
Sleep 1
Enter
Wait 'Skills'
Sleep 2

# Preview the selected category, scroll through it, then close
Down 12 0.1
Sleep 2

Escape
Sleep 4

Render
