#!/usr/bin/env bash
#
# agg + tmux demo recording of the injections view.
#
# Produces doc/vhs/context-injections.cast and doc/images/context-injections.gif.
#

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$SCRIPT_DIR/../.."

SESSION="ctx-injections-demo-$$"
CAST=doc/vhs/context-injections.cast
GIF=doc/images/context-injections.gif

COLS=80
ROWS=33

FONT_SIZE=21
FONT_FAMILY="Iosevka Term"

source "$SCRIPT_DIR/vhs.sh"

start_session

## Start pi off-screen so the GIF opens on an idle TUI.
run_off_record "pi -e . --session 019f7c38-d958-7d36-8d86-e22832c0d227 \
               --model openai-codex/gpt-5.6-sol \
               --no-extensions \
               -e ~/.pi/agent/npm/node_modules/pi-web-providers \
               -e ~/.pi/agent/npm/node_modules/@mrclrchtr/supi-ask-user"
wait_for "Session compacted 2 times" 30

# Start recording
record

## Open the injection view
sleep 1

type_text "/context injections"
sleep 1

key Enter
key Enter
wait_for "Context Injections"
sleep 3

# Walk items
for ((idx = 0; idx < 19; idx++)); do
    key Down 0.1
done
sleep 1

# Preview content
key Enter
wait_for "web_contents"
sleep 3

key Escape
sleep 3

# Stop recording and render result
render
