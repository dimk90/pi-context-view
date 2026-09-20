#!/usr/bin/env bash
#
# Record one zoomed Context Usage still for the map-size panel composite.
# Usage: ./scripts/map-size.rec.sh [<rows> <cols>]
# With no arguments, use a clean config and record default.gif.
# Otherwise, produce doc/images/map-sizes/<rows>x<cols>.gif.
#

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

cd "$REPO_ROOT" || exit 1

MAP_ROWS="${1-}"
MAP_COLS="${2-}"
MAP_SIZE='default'
if [[ $# -ne 0 ]]; then
    if [[ $# -ne 2 || ! $MAP_ROWS =~ ^[1-9][0-9]*$ || ! $MAP_COLS =~ ^[1-9][0-9]*$ ]]; then
        printf 'usage: %s [<rows> <cols>] (positive integers)\n' "$(basename "$0")" >&2
        exit 1
    fi
    MAP_SIZE="${MAP_ROWS}x${MAP_COLS}"
fi

# shellcheck disable=SC1090
source <(curl -fsSL https://dimk90.github.io/s-vhs/v0.6.0) && wait "$!" || exit 1


## Constants


# Match the session, model, and framing of map-sizes.rec.sh without a prompt
PI_COMMAND='pi -e . --session 01a07844-4448-77ed-805f-b2d4af9cd00a'
PI_COMMAND+=' --model openai-codex/gpt-5.6-sol --no-extensions'
PI_COMMAND+=' --thinking xhigh'
PI_COMMAND+=' --tui-mode regular'
PI_COMMAND+=' --offline'

PANEL_DIR="$REPO_ROOT/doc/images/map-sizes"
REAL_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"


## Routines


mirror_agent_dir() {
    #
    # Mirror the user's agent directory with symlinks, replacing only this
    # extension's config. Keep the temporary path available for exit cleanup
    # even if construction fails.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   mirror_agent_dir || exit 1
    #
    AGENT_DIR=$(mktemp -d) || return 1
    find "$REAL_AGENT_DIR" -mindepth 1 -maxdepth 1 ! -name 'extensions' \
        -exec ln -s {} "$AGENT_DIR/" \; || return 1
    mkdir "$AGENT_DIR/extensions" || return 1

    if [[ -d $REAL_AGENT_DIR/extensions ]]; then
        find "$REAL_AGENT_DIR/extensions" -mindepth 1 -maxdepth 1 ! -name 'pi-context-view.json' \
            -exec ln -s {} "$AGENT_DIR/extensions/" \; || return 1
    fi
}


apply_map_size() {
    #
    # Write only the requested geometry to the recording-owned config.
    #
    # Parameters:
    #   $1 - rows - validated map row count.
    #   $2 - cols - validated map column count.
    #
    # Example:
    #   apply_map_size 22 8 || exit 1
    #
    local rows="$1"
    local cols="$2"
    local config_file="$AGENT_DIR/extensions/pi-context-view.json"

    printf '{"mapRows":%s,"mapCols":%s}\n' "$rows" "$cols" > "$config_file"
}


## Configuration


Require 'pi'

SetOutput "$PANEL_DIR/$MAP_SIZE.gif"

# The composite's three geometries fit unclamped at this terminal and font size
SetCols 90
SetRows 34
SetFontSize 24
SetFontFamily 'Iosevka Term'
SetTheme 'asciinema'

# These stills are ignored intermediates, not committed animations
SetOptimize 'off'
SetLoop 'off'

# Expand the mirror path at exit, including when construction fails
# shellcheck disable=SC2016
Finally '[[ -z ${AGENT_DIR-} ]] || rm -rf "$AGENT_DIR"'
mirror_agent_dir || exit 1
if [[ $MAP_SIZE != 'default' ]]; then
    apply_map_size "$MAP_ROWS" "$MAP_COLS" || exit 1
fi
mkdir -p "$PANEL_DIR" || exit 1
Env 'PI_CODING_AGENT_DIR' "$AGENT_DIR"

Start


## Recording


Run "$PI_COMMAND"
Wait '• Release v0\.2\.0'

Run '/context'
Wait '^Context Usage'
Key 'z'
Wait '^Context Usage · Zoom '

Show
Sleep 1
Render
