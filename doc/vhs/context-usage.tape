#!/usr/bin/env bash
#
# agg + tmux demo recording of the Usage view.
#
# Requires: tmux, asciinema, agg, fish, and pi on PATH.
# Produces doc/demo-rec/context-usage.cast and doc/images/context-usage.gif.
#

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$SCRIPT_DIR/../.."

SESSION="ctx-usage-demo-$$"
CAST=doc/demo-rec/context-usage.cast
GIF=doc/images/context-usage.gif

source "$SCRIPT_DIR/vhs.sh"

start_session

## Start pi off-screen so the GIF opens on an idle TUI.
run_off_record "pi --session 019f576a-b4ef-7972-bbf6-77dddfb8476e --model openai-codex/gpt-5.6-sol"
wait_for "Session compacted 2 times" 30

# Start recording
record

## Open the Usage view (silent probe captures the Initial snapshot).
sleep 1

type_slow "/context"
sleep 1

key Enter
wait_for "Context Usage"
sleep 2

# Walk a few legend categories.
key Down 0.2
key Down 0.2
key Down 0.2
key Down 0.2
sleep 1

# Preview the selected category, then return and close.
key Enter
wait_for "Skills"
sleep 2
key Down 0.1
key Down 0.1
key Down 0.1
key Down 0.1
key Down 0.1
key Down 0.1
key Down 0.1
sleep 2

key Escape
sleep 2

# Stop recording and render result
render
