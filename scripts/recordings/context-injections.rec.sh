#!/usr/bin/env bash
#
# s-vhs recording of the injections view: open /context injections,
# walk the items, and preview one of them.
#
# Produces doc/images/context-injections.gif
#

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)

# pi is started as `pi -e .`, so the recorded shell has to sit in the repo root
cd "$REPO_ROOT" || exit 1

# shellcheck disable=SC1090
source <(curl -fsSL https://dimk90.github.io/s-vhs/v0.4.2) && wait "$!" || exit 1


## Constants


# The demo replays one recorded session, so its id and model are pinned
PI_COMMAND='pi -e . --session 01a03fb7-bf9e-727f-8832-83508056b76f'
PI_COMMAND+=' --model openai-codex/gpt-5.6-sol --no-extensions'
PI_COMMAND+=' -e ~/.pi/agent/npm/node_modules/pi-web-providers'
PI_COMMAND+=' --thinking xhigh'
PI_COMMAND+=' --tui-mode regular'


## Configuration


Require 'pi'

SetOutput "$REPO_ROOT/doc/images/context-injections.gif"

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
Wait 'Session compacted 2 times'

Show
Sleep 1

# Open the injections view:
# - the first Enter takes the completion;
# - the second one submits the command;
Type '/context'
Sleep 0.5
Type ' '
Sleep 0.5
Type 'injections'
Sleep 1
Enter 2

Wait 'Context Injections'
Sleep 2

# Walk the items
Down 21 0.07
Sleep 1

# Preview the selected item, then close
Enter
Wait 'web_contents'
Sleep 3

Escape
Sleep 3

Render
