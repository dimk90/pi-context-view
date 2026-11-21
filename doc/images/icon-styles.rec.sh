#!/usr/bin/env bash
#
# s-vhs recording of one Context Usage panel redrawn by each pre-defined icon
# style in turn, switched live with `i`: Square, CC, Nerd, Circle, two seconds each.
#
# Produces icon-styles.gif next to this script.
#

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)

# pi is started as `pi -e .`, so the recorded shell has to sit in the repo root
cd "$REPO_ROOT" || exit 1

# shellcheck disable=SC1090
source <(curl -fsSL https://dimk90.github.io/s-vhs/v0.7.1) && wait "$!" || exit 1


## Constants


# The demo replays one recorded session, so its id and model are pinned
PI_COMMAND='pi -e . --session 01a07844-4448-77ed-805f-b2d4af9cd00a'
PI_COMMAND+=' --model openai-codex/gpt-5.6-sol --no-extensions'
PI_COMMAND+=' --thinking xhigh'
PI_COMMAND+=' --tui-mode regular'
PI_COMMAND+=' --offline'

# Styles `i` switches to after the default Square, in the built-in list order
ICON_STYLES=('CC' 'Nerd' 'Circle')
# Demonstration time for each style
HOLD_SECONDS=2

REAL_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"


## Routines


mirror_agent_dir() {
    #
    # Mirror the user's agent directory into a throwaway one made of symlinks,
    # leaving out pi-context-view.json. The view starts on the default style,
    # and the style `i` saves on close never reaches the user's own config.
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
    find "$REAL_AGENT_DIR" -mindepth 1 -maxdepth 1 ! -name 'extensions' \
        -exec ln -s {} "$AGENT_DIR/" \; || return 1
    mkdir "$AGENT_DIR/extensions" || return 1

    # every other extension keeps its own config; only this one is left out
    if [[ -d $REAL_AGENT_DIR/extensions ]]; then
        find "$REAL_AGENT_DIR/extensions" -mindepth 1 -maxdepth 1 ! -name 'pi-context-view.json' \
            -exec ln -s {} "$AGENT_DIR/extensions/" \; || return 1
    fi
}


## Configuration


Require 'pi'

# The recording lives next to the GIF it produces
SetOutput "$SCRIPT_DIR/icon-styles.gif"

# Framing is the palettes recording's, the 1.6 aspect ratio suitable for pi.dev
SetCols 89
SetRows 25
SetFontSize 36
SetFontFamily 'Iosevka Term'
SetTheme 'asciinema'

# Every style gets the same time on screen, including the one the loop ends on
SetLastFrameDuration "$HOLD_SECONDS"

# The GIF is committed to the repository, so shrink it losslessly
SetOptimize 'on'

# Expand the mirror path at exit, including when construction fails
# shellcheck disable=SC2016
Finally '[[ -z ${AGENT_DIR-} ]] || rm -rf "$AGENT_DIR"'
mirror_agent_dir || exit 1

Env 'PI_CODING_AGENT_DIR' "$AGENT_DIR"

Start


## Recording


# Bring pi and the usage view up off camera, so the GIF opens on the panel
Run "$PI_COMMAND"
Wait '• Release v0\.2\.0' # wait for session name to appear
Run '/context'
Wait 'Context Usage'
Key 'z'                     # turn zoom mode on
Wait ' · Zoom '             # wait for zoom to apply
Wait 'Icons: Square'        # the hint row names the active style

Show
Sleep "$HOLD_SECONDS"

# Switch styles live, each one held for the same time
for icon_style in "${ICON_STYLES[@]}"; do
    Key 'i'
    Wait "Icons: $icon_style"
    Sleep "$HOLD_SECONDS"
done

Render
