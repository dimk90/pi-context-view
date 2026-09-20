#!/usr/bin/env bash
#
# s-vhs recording of one zoomed Context Usage panel with three map sizes:
# default (16 x 18), long-vertical (8 x 36), and big (32 x 36).
#
# Produces map-sizes.gif next to this script.
#

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)

# pi is started as `pi -e .`, so the recorded shell needs the repo root
cd "$REPO_ROOT" || exit 1

# shellcheck disable=SC1090
source <(curl -fsSL https://dimk90.github.io/s-vhs/v0.6.0) && wait "$!" || exit 1


## Constants


# Replay the same session and model as palettes.rec.sh without sending a prompt
PI_COMMAND='pi -e . --session 01a07844-4448-77ed-805f-b2d4af9cd00a'
PI_COMMAND+=' --model openai-codex/gpt-5.6-sol --no-extensions'
PI_COMMAND+=' --thinking xhigh'
PI_COMMAND+=' --tui-mode regular'
PI_COMMAND+=' --offline'

MAP_SIZES=('default' 'long-vertical' 'big')
HOLD_SECONDS=2
REAL_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"


## Routines


mirror_agent_dir() {
    #
    # Mirror the user's agent directory with symlinks, substituting only this
    # extension's config. Keep the temporary path available to the exit handler
    # even if building the mirror fails.
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
    # Replace the recording-owned geometry override before reopening the view.
    # The default scene uses no config file, so it exercises built-in defaults.
    #
    # Parameters:
    #   $1 - size - default, long-vertical, or big.
    #
    # Example:
    #   apply_map_size 'long-vertical' || exit 1
    #
    local size="$1"
    local config_file="$AGENT_DIR/extensions/pi-context-view.json"

    case "$size" in
        default)       rm -f "$config_file" ;;
        long-vertical) printf '%s\n' '{"mapCols":8,"mapRows":22}' > "$config_file" ;;
        big)           printf '%s\n' '{"mapCols":22,"mapRows":22}' > "$config_file" ;;
        *)             return 1 ;;
    esac
}


## Configuration


Require 'pi'

# The recording lives next to the GIF it produces
SetOutput "$SCRIPT_DIR/map-sizes.gif"

# Keep all three geometries unclamped, with room for the legend and frame
SetCols 90
SetRows 34
SetFontSize 24
SetFontFamily 'Iosevka Term'
SetTheme 'asciinema'
SetLastFrameDuration "$HOLD_SECONDS"
SetOptimize 'on'

# Expand the mirror path at exit, including when mirror construction fails
# shellcheck disable=SC2016
Finally '[[ -z ${AGENT_DIR-} ]] || rm -rf "$AGENT_DIR"'
mirror_agent_dir || exit 1
Env 'PI_CODING_AGENT_DIR' "$AGENT_DIR"

Start


## Recording


Run "$PI_COMMAND"
Wait '• Release v0\.2\.0'

for size in "${MAP_SIZES[@]}"; do
    apply_map_size "$size" || exit 1

    Run '/context'
    Wait '^Context Usage'
    Key 'z'
    Wait '^Context Usage · Zoom '

    Show
    Sleep "$HOLD_SECONDS"

    # Leave the final panel visible through Render, not the underlying session
    if [[ $size != 'big' ]]; then
        Hide
        Escape
        Wait '• Release v0\.2\.0'
    fi
done

Render
