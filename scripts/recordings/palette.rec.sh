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

# Usage message on run without arguments
PALETTE="${1-}"
if [[ ! $PALETTE =~ ^(default|terrain|rainbow)$ ]]; then
    printf 'usage: %s <default|terrain|rainbow>\n' "$(basename "$0")" >&2
    exit 1
fi

# shellcheck disable=SC1090
source <(curl -fsSL https://dimk90.github.io/s-vhs/v0.5.0) && wait "$!" || exit 1


## Constants


# The demo replays one recorded session, so its id and model are pinned
PI_COMMAND='pi -e . --session 01a0529a-687b-74a7-9076-11919f491954'
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
    # AGENT_DIR is set before anything is built, and not returned on stdout: a
    # command substitution would keep a half-built mirror in the subshell, where
    # no exit handler can reach it.
    #
    # Parameters:
    #   $1 - palette - palette name, or 'default' for the built-in colors.
    #
    # Example:
    #   mirror_agent_dir 'terrain' || exit 1
    #
    local palette="$1"

    AGENT_DIR=$(mktemp -d) || return 1

    find "$REAL_AGENT_DIR" -mindepth 1 -maxdepth 1 -exec ln -s {} "$AGENT_DIR/" \; || return 1
    rm "$AGENT_DIR/extensions" || return 1
    mkdir "$AGENT_DIR/extensions" || return 1

    # every other extension keeps its own config; only this one is substituted
    find "$REAL_AGENT_DIR/extensions" -mindepth 1 -maxdepth 1 ! -name 'pi-context-view.json' \
        -exec ln -s {} "$AGENT_DIR/extensions/" \; || return 1
    [[ $palette == 'default' ]] && return 0

    cp "$REPO_ROOT/doc/palettes/$palette.json" "$AGENT_DIR/extensions/pi-context-view.json"
}


remove_agent_mirror() {
    #
    # Remove the throwaway agent directory. Safe before it exists and safe to
    # repeat; rm never follows the symlinks the mirror is made of, so the
    # user's own files stay untouched.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   remove_agent_mirror
    #
    [[ -n ${AGENT_DIR-} ]] && rm -rf "$AGENT_DIR"
    return 0
}


## Configuration


Require 'pi'

SetOutput "$PANEL_DIR/$PALETTE.gif"

# Framing is the usage recording's, so the panels match the /context demo
SetCols 78
SetRows 25
SetFontSize 24
SetFontFamily 'Iosevka Term'
SetTheme 'asciinema'

# Only the last frame is kept, so the GIF is an intermediate
SetOptimize 'off'
SetLoop 'off'

# Keep s-vhs teardown intact and remove the mirror even if recording fails
Finally 'remove_agent_mirror'

# Change Pi config directory to temporary dir
mirror_agent_dir "$PALETTE" || exit 1
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
