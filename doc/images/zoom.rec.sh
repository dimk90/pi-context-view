#!/usr/bin/env bash
#
# s-vhs recording of the usage view zoom feature.
#
# Produces zoom.gif next to this script.
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
PI_COMMAND+=' --model anthropic/claude-opus-5-5 --no-extensions'
PI_COMMAND+=' --thinking xhigh'
PI_COMMAND+=' --tui-mode regular'
PI_COMMAND+=' --offline'


## Configuration


Require 'pi'

# The recording lives next to the GIF it produces
SetOutput "$SCRIPT_DIR/zoom.gif"

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
Wait '• Release v0\.2\.0' # wait for session name to appear

# Open the usage view
Run '/context'

Show

Wait 'Context Usage'
Sleep 2

# Turn On & Off Zoom
Key 'z'
Sleep 3

Render
