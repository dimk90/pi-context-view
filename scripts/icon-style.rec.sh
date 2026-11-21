#!/usr/bin/env bash
#
# s-vhs recording of one Context Usage panel, drawn with one pre-defined icon style.
#
# Usage: ./scripts/icon-style.rec.sh <Square|Circle|CC|Nerd>
#
# Produces doc/images/icon-styles/<style>.gif.
#
# icon-styles-panel.sh runs this once per style and composites into
# doc/images/icon-styles.png.
#

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

# pi is started as `pi -e .`, so the recorded shell has to sit in the repo root
cd "$REPO_ROOT" || exit 1

# Usage message on run without arguments
ICON_STYLE="${1-}"
if [[ ! $ICON_STYLE =~ ^(Square|Circle|CC|Nerd)$ ]]; then
    printf 'usage: %s <Square|Circle|CC|Nerd>\n' "$(basename "$0")" >&2
    exit 1
fi

# shellcheck disable=SC1090
source <(curl -fsSL https://dimk90.github.io/s-vhs/v0.7.1) && wait "$!" || exit 1


## Constants


# The demo replays one recorded session, so its id and model are pinned
PI_COMMAND='pi -e . --session 01a07844-4448-77ed-805f-b2d4af9cd00a'
PI_COMMAND+=' --model openai-codex/gpt-5.6-sol --no-extensions'
PI_COMMAND+=' --thinking xhigh'
PI_COMMAND+=' --tui-mode regular'
PI_COMMAND+=' --offline'

PANEL_DIR="$REPO_ROOT/doc/images/icon-styles"
REAL_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"


## Routines


mirror_agent_dir() {
    #
    # Mirror the user's agent directory into a throwaway one made of symlinks,
    # substituting only pi-context-view.json with one that selects the icon
    # style. The recording never touches the user's own extension config.
    #
    # AGENT_DIR is set before anything is built, and not returned on stdout: a
    # command substitution would keep a half-built mirror in the subshell, where
    # no exit handler can reach it.
    #
    # Parameters:
    #   $1 - icon_style - pre-defined icon style name.
    #
    # Example:
    #   mirror_agent_dir 'Circle' || exit 1
    #
    local icon_style="$1"

    AGENT_DIR=$(mktemp -d) || return 1
    find "$REAL_AGENT_DIR" -mindepth 1 -maxdepth 1 ! -name 'extensions' \
        -exec ln -s {} "$AGENT_DIR/" \; || return 1
    mkdir "$AGENT_DIR/extensions" || return 1

    # every other extension keeps its own config; only this one is substituted
    if [[ -d $REAL_AGENT_DIR/extensions ]]; then
        find "$REAL_AGENT_DIR/extensions" -mindepth 1 -maxdepth 1 ! -name 'pi-context-view.json' \
            -exec ln -s {} "$AGENT_DIR/extensions/" \; || return 1
    fi

    printf '{"iconStyle":"%s"}\n' "$icon_style" > "$AGENT_DIR/extensions/pi-context-view.json"
}


## Configuration


Require 'pi'

SetOutput "$PANEL_DIR/$ICON_STYLE.gif"

# Framing is the palette recording's, so the panels match the palette composite
SetCols 78
SetRows 25
SetFontSize 32
SetFontFamily 'Iosevka Term'
SetTheme 'asciinema'

# Only the last frame is kept, so the GIF is an intermediate
SetOptimize 'off'
SetLoop 'off'

# Expand the mirror path at exit, including when construction fails
# shellcheck disable=SC2016
Finally '[[ -z ${AGENT_DIR-} ]] || rm -rf "$AGENT_DIR"'

# Change Pi config directory to temporary dir
mirror_agent_dir "$ICON_STYLE" || exit 1
mkdir -p "$PANEL_DIR" || exit 1

Env 'PI_CODING_AGENT_DIR' "$AGENT_DIR"

Start


## Recording


# Bring pi up off camera, so the panel is an idle TUI
Run "$PI_COMMAND"
Wait '• Release v0\.2\.0' # wait for session name to appear

# Open the usage view and hold it: the still is the last frame
Run '/context'
Wait 'Context Usage'
Key 'z'                         # turn zoom mode on
Wait 'Context Usage · Zoom '    # wait for zoom to apply

# Render one static frame
Show
Sleep 1
Render
