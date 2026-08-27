#!/usr/bin/env bash
#
# s-vhs recording of one Context Usage panel, painted with one category palette.
#
# Usage: ./palette-panel.rec.sh <default|terrain|rainbow>
#
# Produces doc/images/palettes/<palette>.gif.
#
# palettes.sh runs this once per palette and composites into doc/images/color-palettes.png.
#

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)

# pi is started as `pi -e .`, so the recorded shell has to sit in the repo root
cd "$REPO_ROOT" || exit 1

PALETTE="${1-}"
if [[ ! $PALETTE =~ ^(default|terrain|rainbow)$ ]]; then
    printf 'usage: %s <default|terrain|rainbow>\n' "$(basename "$0")" >&2
    exit 1
fi

# shellcheck disable=SC1090
source <(curl -fsSL https://dimk90.github.io/s-vhs/v0.4.2) && wait "$!" || exit 1


## Constants


# The demo replays one recorded session, so its id and model are pinned
PI_COMMAND='pi -e . --session 01a03fb7-bf9e-727f-8832-83508056b76f'
PI_COMMAND+=' --model openai-codex/gpt-5.6-sol --no-extensions'
PI_COMMAND+=' --thinking xhigh'
PI_COMMAND+=' --tui-mode regular'

PANEL_DIR="doc/images/palettes"
REAL_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"


## Routines


mirror_agent_dir() {
    #
    # Mirror the user's agent directory into a throwaway one made of symlinks,
    # substituting only pi-context-view.json. The recording then reads the
    # palette without ever touching the user's own extension config.
    #
    # Parameters:
    #   $1 - palette - palette name, or 'default' for the built-in colors.
    #
    # Example:
    #   agent_dir=$(mirror_agent_dir 'terrain') || exit 1
    #
    local palette="$1"
    local agent_dir
    agent_dir=$(mktemp -d) || return 1

    find "$REAL_AGENT_DIR" -mindepth 1 -maxdepth 1 -exec ln -s {} "$agent_dir/" \; || return 1
    rm "$agent_dir/extensions" || return 1
    mkdir "$agent_dir/extensions" || return 1

    # every other extension keeps its own config; only this one is substituted
    find "$REAL_AGENT_DIR/extensions" -mindepth 1 -maxdepth 1 ! -name 'pi-context-view.json' \
        -exec ln -s {} "$agent_dir/extensions/" \; || return 1
    if [[ $palette != 'default' ]]; then
        cp "$REPO_ROOT/doc/palettes/$palette.json" "$agent_dir/extensions/pi-context-view.json" || return 1
    fi

    printf '%s\n' "$agent_dir"
}


## Configuration


Require 'pi'

SetOutput "$PANEL_DIR/$PALETTE.gif"

# Framing is the usage recording's, so the panels match the /context demo
SetCols 80
SetRows 25
SetFontSize 24
SetFontFamily 'Iosevka Term'
SetTheme 'asciinema'

# Only the last frame is kept, so the GIF is an intermediate
SetOptimize 'off'
SetLoop 'off'

# Change Pi config directory
AGENT_DIR=$(mirror_agent_dir "$PALETTE") || exit 1
mkdir -p "$PANEL_DIR" || exit 1

Env 'PI_CODING_AGENT_DIR' "$AGENT_DIR"

Start


## Recording


# Bring pi up off camera, so the panel is an idle TUI
Run "$PI_COMMAND"
Wait 'Session compacted 2 times'

# Open the usage view and hold it: the still is the last frame
Run '/context'
Wait 'Context Usage'

# Render one static frame
Show
Render

rm -rf "$AGENT_DIR"
