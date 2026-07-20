#!/bin/bash
#
# Shared helpers for agg + asciinema + tmux demo recordings.
# Meant to be sourced by a recording script, not executed.
#
# Usage in a recording script:
#   SESSION=my-demo
#   CAST=doc/demo-rec/my-demo.cast
#   GIF=doc/images/my-demo.gif
#   source "$(dirname "$0")/vhs.sh"
#

set -euo pipefail


## Constants


# Any of the constants below may be overridden before sourcing.

: "${SESSION:=demo}"
: "${CAST:?set CAST to the .cast output path before sourcing vhs.sh}"
: "${GIF:?set GIF to the .gif output path before sourcing vhs.sh}"

# Terminal geometry is in cells, not pixels; pixel size ~= cells x glyph size
# at FONT_SIZE.
: "${COLS:=100}"
: "${ROWS:=40}"

# Leave FONT_FAMILY empty to use agg's built-in default fonts.
: "${FONT_FAMILY:=}"
: "${FONT_SIZE:=28}"
: "${LINE_HEIGHT:=1.2}"

# Set PAD_COLOR to override automatic detection from the GIF's top-left pixel.
# PAD_FALLBACK_COLOR is used when only ffmpeg is available.
: "${PAD_COLOR:=}"
: "${PAD_FALLBACK_COLOR:=#121314}"

# Shell to run inside the tmux session.
: "${DEMO_SHELL:=fish}"

# Default delay between simulated keystrokes (VHS TypingSpeed).
: "${TYPE_DELAY:=0.1}"
# Default pause after a key press.
: "${KEY_DELAY:=0.0}"

# Recorder state: PID of the backgrounded asciinema process, and a flag set
# once the first segment is captured so later record calls append.
REC_PID=
RECORDED=


## Session


start_session() {
    #
    # Start a fresh detached tmux session sized COLSxROWS running DEMO_SHELL,
    # isolated from personal tmux config (no status bar).
    #
    # Example:
    #   start_session
    #
    tmux -f /dev/null new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" "$DEMO_SHELL"
    tmux set -g extended-keys on
    tmux set -g extended-keys-format csi-u
    tmux set-option -t "$SESSION" status off
}


## Input


run_off_record() {
    #
    # Run a command in the session while no recorder is attached.
    #
    # Parameters:
    #   $1 - command_line - command line to type and execute.
    #   $2 - settle - (optional) - seconds to wait afterwards (default: 2).
    #
    # Example:
    #   run_off_record 'pi --no-extensions' 5
    #
    local command_line="$1"
    local settle="${2:-2}"

    _send -l "$command_line"
    _send Enter
    sleep "$settle"
}


key() {
    #
    # Press one named key, then pause.
    #
    # Parameters:
    #   $1 - key_name - tmux key name (e.g., 'Enter', 'Down').
    #   $2 - pause - (optional) - seconds to sleep after (default: KEY_DELAY).
    #
    # Example:
    #   key Down 0.2
    #
    local key_name="$1"
    local pause="${2:-$KEY_DELAY}"

    _send "$key_name"
    sleep "$pause"
}


type_text() {
    #
    # Type text one character at a time, like VHS's TypingSpeed.
    #
    # Parameters:
    #   $1 - text - text to type.
    #   $2 - delay - (optional) - seconds between keystrokes (default: TYPE_DELAY).
    #
    # Example:
    #   type_text '/context'
    #
    local text="$1"
    local delay="${2:-$TYPE_DELAY}"
    local idx

    for ((idx = 0; idx < ${#text}; idx++)); do
        _send -l "${text:idx:1}"
        sleep "$delay"
    done
}


wait_for() {
    #
    # Poll the visible pane until a pattern appears, instead of guessing
    # sleeps. Return 1 on timeout.
    #
    # Parameters:
    #   $1 - pattern - grep pattern to wait for.
    #   $2 - timeout - (optional) - seconds before giving up (default: 15).
    #
    # Example:
    #   wait_for 'Context Usage' 30
    #
    local pattern="$1"
    local timeout="${2:-15}"

    local deadline=$((SECONDS + timeout))

    until tmux capture-pane -p -t "$SESSION" | grep -q "$pattern"; do
        if ((SECONDS >= deadline)); then
            printf 'timeout waiting for: %s\n' "$pattern" >&2
            return 1
        fi
        sleep 0.2
    done
}


## Recording


record() {
    #
    # Start (or resume) recording the session; the first call records fresh,
    # later calls append to the same cast (VHS Show).
    #
    # Example:
    #   record
    #
    # Expands to nothing on the first call; must stay unquoted so an empty
    # value adds no argument.
    # shellcheck disable=SC2086
    asciinema rec --overwrite ${RECORDED:+--append}      \
                  --window-size "${COLS}x${ROWS}"        \
                  -c "tmux attach -t $SESSION" "$CAST" &
    REC_PID=$!
    RECORDED=1
    sleep 1 # let the recorder attach
}


stop_recording() {
    #
    # Stop recording without disturbing the session (VHS Hide).
    #
    # Example:
    #   stop_recording
    #
    # Detaching appends terminal-reset noise to the cast; remember the clean
    # size first and truncate back to it.
    local clean_end
    clean_end=$(wc -c < "$CAST")

    tmux detach-client -s "$SESSION"
    wait "$REC_PID"
    truncate -s "$clean_end" -- "$CAST"
    REC_PID=
}


## Render


render() {
    #
    # End the recording (killing the session detaches the recorder) and
    # render the cast to GIF with agg.
    #
    # Parameters:
    #   $1 - padding - (optional) - uniform pixel padding to add to the GIF.
    #
    # Example:
    #   render "$PADDING"
    #
    local padding="${1-}"

    # As in stop_recording, drop the detach noise appended by the kill.
    local clean_end=
    [[ -n $REC_PID ]] && clean_end=$(wc -c < "$CAST")

    tmux kill-session -t "$SESSION"

    if [[ -n $REC_PID ]]; then
        wait "$REC_PID"
        truncate -s "$clean_end" -- "$CAST"
    fi
    REC_PID=

    local font_args=()
    [[ -n $FONT_FAMILY ]] && font_args+=(--font-family "$FONT_FAMILY")

    agg "${font_args[@]}"            \
        --font-size "$FONT_SIZE"     \
        --line-height "$LINE_HEIGHT" \
        "$CAST" "$GIF"

    if [[ -n $padding ]]; then
        _pad_gif "$padding"
    fi

    printf 'Wrote %s\n' "$GIF"
}


## Internal


_send() {
    #
    # Send keys to the demo session (thin wrapper over tmux send-keys).
    #
    # Parameters:
    #   $@ - arguments passed through to tmux send-keys.
    #
    # Example:
    #   _send -l 'ls'
    #   _send Enter
    #
    tmux send-keys -t "$SESSION" "$@"
}


_pad_gif() {
    #
    # Add uniform pixel padding around the rendered GIF (like VHS's
    # Set Padding). Prefers magick, falls back to ffmpeg, and warns when
    # neither is installed.
    #
    # Parameters:
    #   $1 - pad - padding in pixels.
    #
    # Example:
    #   _pad_gif 40
    #
    local pad="$1"

    local pad_color="${PAD_COLOR:-}"

    printf '::: adding %spx padding\n' "$pad"

    if command -v magick &> /dev/null; then
        if [[ -z $pad_color ]]; then
            pad_color="#$(magick "${GIF}[0]" -format '%[hex:p{0,0}]' info:)"
        fi
        # Coalesce first: border on frame-diffed GIFs misplaces frames.
        magick "$GIF" -coalesce -bordercolor "$pad_color" -border "$pad" \
            -layers optimize "$GIF"
    elif command -v ffmpeg &> /dev/null; then
        local tmp="${GIF%.gif}-pad.gif"
        pad_color="${pad_color:-$PAD_FALLBACK_COLOR}"
        # Regenerate the palette, otherwise ffmpeg falls back to a dithered
        # generic 256-color palette.
        ffmpeg -loglevel error -y -i "$GIF" -filter_complex \
            "pad=iw+2*${pad}:ih+2*${pad}:${pad}:${pad}:${pad_color/\#/0x},split[a][b];[a]palettegen[p];[b][p]paletteuse" \
            "$tmp"
        mv -- "$tmp" "$GIF"
    else
        printf 'warning: neither magick nor ffmpeg found; skipping %spx padding\n' "$pad" >&2
    fi
}


_cleanup() {
    #
    # Kill the demo session and recorder on exit; safe to call when neither
    # is alive.
    #
    tmux kill-session -t "$SESSION" 2> /dev/null || true
    if [[ -n $REC_PID ]] && kill -0 "$REC_PID" 2> /dev/null; then
        kill "$REC_PID" 2> /dev/null || true
    fi
}


# Installed in the sourcing script's shell, so any exit — including a
# set -e failure mid-recording — tears down the tmux session and recorder
# instead of leaving them running in the background.
trap _cleanup EXIT
