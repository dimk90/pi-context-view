#!/usr/bin/env bash
#
# agg + tmux demo recording of the usage view.
#
# Produces doc/vhs/context-usage.cast and doc/images/context-usage.gif.
#

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$SCRIPT_DIR/../.."

SESSION="ctx-usage-demo-$$"
CAST=doc/vhs/context-usage.cast
GIF=doc/images/context-usage.gif

COLS=80
ROWS=30
PADDING=10

FONT_SIZE=28
FONT_FAMILY="Iosevka Term"

source "$SCRIPT_DIR/vhs.sh"

start_session

## Start pi off-screen so the GIF opens on an idle TUI
run_off_record "pi -e . --session 019f7c38-d958-7d36-8d86-e22832c0d227 --model openai-codex/gpt-5.6-sol --no-extensions"
wait_for "Session compacted 2 times" 30

# Start recording
record

## Open the Usage view
sleep 1

type_text "/context"
sleep 1

key Enter
wait_for "Context Usage"
sleep 3

# Walk a few legend categories.
key Down 0.2
key Down 0.2
key Down 0.2
sleep 1

# Preview the selected category, then return and close
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
key Down 0.1
key Down 0.1
key Down 0.1
key Down 0.1
key Down 0.1
sleep 2

key Escape
sleep 4

# Stop recording and render result
render "$PADDING"
