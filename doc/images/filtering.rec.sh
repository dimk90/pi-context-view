#!/usr/bin/env bash
#
# s-vhs recording of the injections view: open /context injections,
# walk the items, and preview one of them.
#
# Produces context-injections.gif next to this script.
#

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)

# pi is started as `pi -e .`, so the recorded shell has to sit in the repo root
cd "$REPO_ROOT" || exit 1

# shellcheck disable=SC1090
source <(curl -fsSL https://dimk90.github.io/s-vhs/v0.7.1) && wait "$!" || exit 1


## Constants


# The demo replays the committed session file, so the session and model are pinned
PI_COMMAND='pi -e . --session scripts/data/demo-session.jsonl'
# Load the session's extension tools: --no-extensions skips the global ones
PI_COMMAND+=' -e npm:webfox@4.12.0 -e npm:@eko24ive/pi-ask@1.2.0'
PI_COMMAND+=' --model openai/gpt-6.2-sol --no-extensions'
PI_COMMAND+=' --thinking xhigh'
PI_COMMAND+=' --tui-mode regular'
PI_COMMAND+=' --offline'


## Configuration


Require 'pi'

# The recording lives next to the GIF it produces
SetOutput "$SCRIPT_DIR/filtering.gif"

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
Wait '• Release v0\.2\.0' # wait for session name to appear

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
Type '/'
Sleep 2

Type 'pyth' 0.2
Sleep 3

Highlight 'Tab Mode' 2

Tab
Sleep 2

Tab
Sleep 2

Escape
Sleep 2

Render
