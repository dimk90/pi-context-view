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
source <(curl -fsSL https://dimk90.github.io/s-vhs/v0.5.0) && wait "$!" || exit 1


## Constants


# The demo replays one recorded session, so its id and model are pinned
PI_COMMAND='pi -e . --session 01a07844-4448-77ed-805f-b2d4af9cd00a'
PI_COMMAND+=' --model openai-codex/gpt-5.6-sol --no-extensions'
PI_COMMAND+=' --thinking xhigh'
PI_COMMAND+=' --tui-mode regular'


## Configuration


Require 'pi'

SetOutput "$REPO_ROOT/doc/images/context-usage.gif"

SetCols 80
SetRows 34
SetFontSize 36
SetFontFamily 'Iosevka Term'
SetTheme 'asciinema'
SetTypingSpeed 0.1

# The GIF is committed to the repository, so shrink it losslessly
SetOptimize 'on'

Start


## Recording


# Bring pi up off camera, so the GIF opens on an idle TUI
Run "$PI_COMMAND"
Wait '• Release v0.2.0' # wait for session name to appear

Show

Sleep 1

# Open the usage view
Type '/context'
Sleep 1
Enter
Wait 'Context Usage'
Sleep 2

# Walk a few legend categories
Down 7 0.2
Sleep 1
Enter
Wait 'Tool Calls'
Sleep 2

# Preview the selected category, scroll through it, then close
Down 3 0.5
Sleep 1
Up 1
Sleep 3

Escape
Sleep 3

Render
