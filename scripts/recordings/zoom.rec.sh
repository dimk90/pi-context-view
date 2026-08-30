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
source <(curl -fsSL https://dimk90.github.io/s-vhs/v0.4.2) && wait "$!" || exit 1


## Constants


# The demo replays one recorded session, so its id and model are pinned
PI_COMMAND='pi -e . --session 01a0529a-687b-74a7-9076-11919f491954'
PI_COMMAND+=' --model anthropic/claude-opus-5 --no-extensions'
PI_COMMAND+=' --thinking xhigh'
PI_COMMAND+=' --tui-mode regular'


## Configuration


Require 'pi'

SetOutput "$REPO_ROOT/doc/images/zoom.gif"

SetCols 80
SetRows 27
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

# Open the usage view
Run '/context'

Show

Wait 'Context Usage'
Sleep 2

# Turn On & Off Zoom
Key 'z'
Sleep 3

Render
