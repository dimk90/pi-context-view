#!/usr/bin/env bash
#
# s-vhs recording of one Context Usage panel repainted by each example category
# palette in turn: default, terrain, rainbow, two seconds each.
#
# Produces doc/images/palettes.gif
#

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)

# pi is started as `pi -e .`, so the recorded shell has to sit in the repo root
cd "$REPO_ROOT" || exit 1

# shellcheck disable=SC1090
source <(curl -fsSL https://dimk90.github.io/s-vhs/v0.5.0) && wait "$!" || exit 1


## Constants


# The demo replays one recorded session, so its id and model are pinned
PI_COMMAND='pi -e . --session 01a0529a-687b-74a7-9076-11919f491954'
PI_COMMAND+=' --model openai-codex/gpt-5.6-sol --no-extensions'
PI_COMMAND+=' --thinking xhigh'
PI_COMMAND+=' --tui-mode regular'

# Palette names from doc/palettes to record in addition to default palette
PALETTES=('terrain' 'rainbow')
# Demonstration time for each palette
HOLD_SECONDS=2

REAL_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"


## Routines


mirror_agent_dir() {
    #
    # Mirror the user's agent directory into a throwaway one made of symlinks,
    # leaving out pi-context-view.json. The recording then owns that one file
    # without ever touching the user's own extension config.
    #
    # AGENT_DIR is set before anything is built, and not returned on stdout: a
    # command substitution would keep a half-built mirror in the subshell, where
    # no exit handler can reach it.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   mirror_agent_dir || exit 1
    #
    AGENT_DIR=$(mktemp -d) || return 1

    find "$REAL_AGENT_DIR" -mindepth 1 -maxdepth 1 -exec ln -s {} "$AGENT_DIR/" \; || return 1
    rm "$AGENT_DIR/extensions" || return 1
    mkdir "$AGENT_DIR/extensions" || return 1

    # every other extension keeps its own config; only this one is substituted
    find "$REAL_AGENT_DIR/extensions" -mindepth 1 -maxdepth 1 ! -name 'pi-context-view.json' \
        -exec ln -s {} "$AGENT_DIR/extensions/" \;
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


apply_palette() {
    #
    # Put one palette in place for the next view open. The built-in colors are
    # the absence of an override file, not a palette of their own.
    #
    # Parameters:
    #   $1 - palette - palette name
    #
    # Example:
    #   apply_palette 'terrain' || exit 1
    #
    local palette="$1"
    local config_file="$AGENT_DIR/extensions/pi-context-view.json"
    cp "$REPO_ROOT/doc/palettes/$palette.json" "$config_file"
}


## Configuration


Require 'pi'

SetOutput "$REPO_ROOT/doc/images/palettes.gif"

# Sized for pi.dev: 1546 x 967 px with this font, matching the 1.6 aspect ratio suitable for pi.dev.
# Rows stay at the palette panels' 25, which holds the whole usage view.
SetCols 89
SetRows 25
SetFontSize 36
SetFontFamily 'Iosevka Term'
SetTheme 'asciinema'

# Every palette gets the same time on screen, including the one the loop ends on
SetLastFrameDuration "$HOLD_SECONDS"

# The GIF is committed to the repository, so shrink it losslessly
SetOptimize 'on'

# Keep s-vhs teardown intact and remove the mirror even if recording fails
Finally 'remove_agent_mirror'

# Create temporary dir with custom config for pi-context-view
mirror_agent_dir || exit 1

Env 'PI_CODING_AGENT_DIR' "$AGENT_DIR"

Start


## Recording

# Bring pi and the first palette up off camera, so the GIF opens on the panel
Run "$PI_COMMAND"
Wait 'Session compacted 2 times'

# Record default palette first
Run '/context'
Wait 'Context Usage'

Show
Sleep "$HOLD_SECONDS"
Hide
Escape

# Record custom palettes from doc/palettes
for palette in "${PALETTES[@]}"; do
    apply_palette "$palette" || return 1

    Run '/context'
    Wait 'Context Usage'

    Show
    Sleep "$HOLD_SECONDS"
    Hide
    Escape
done

Render
