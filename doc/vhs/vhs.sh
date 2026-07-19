# shellcheck shell=bash
#
# Shared helpers for agg + asciinema + tmux demo recordings.
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

: "${FONT_FAMILY:=Iosevka Term}"
: "${FONT_SIZE:=28}"

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

REC_PID=
RECORDED=


## Functions


# Fresh session, isolated from personal tmux config (no status bar).
start_session() {
	tmux -f /dev/null new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" "$DEMO_SHELL"
	tmux set -g extended-keys on
	tmux set -g extended-keys-format csi-u
	tmux set-option -t "$SESSION" status off
}

# Run a command in the session while no recorder is attached (VHS Hide).
# Usage: run_off_record <command> [settle-seconds].
run_off_record() {
	send -l "$1"
	send Enter
	sleep "${2:-2}"
}

send() {
	tmux send-keys -t "$SESSION" "$@";
}

# Press one named key, then pause. Usage: key <KeyName> [pause-seconds].
key() {
	send "$1"
	sleep "${2:-$KEY_DELAY}"
}

# Type text one character at a time, like VHS's TypingSpeed.
# Usage: type_text <text> [delay-seconds]; defaults to TYPE_DELAY.
type_text() {
	local s=$1
	local delay=${2:-$TYPE_DELAY}
	local i
	for ((i = 0; i < ${#s}; i++)); do
		send -l "${s:i:1}"
		sleep "$delay"
	done
}

# Poll the visible pane until a pattern appears, instead of guessing sleeps.
# Usage: wait_for <grep-pattern> [timeout-seconds].
wait_for() {
	local pattern=$1
	local deadline=$((SECONDS + ${2:-15}))
	until tmux capture-pane -p -t "$SESSION" | grep -q "$pattern"; do
		if ((SECONDS >= deadline)); then
			echo "timeout waiting for: $pattern" >&2
			return 1
		fi
		sleep 0.2
	done
}

# Start (or resume) recording the session; first call records fresh,
# later calls append to the same cast (VHS Show).
record() {
	asciinema rec --overwrite ${RECORDED:+--append} \
		--window-size "${COLS}x${ROWS}"             \
		-c "tmux attach -t $SESSION" "$CAST" &
	REC_PID=$!
	RECORDED=1
	sleep 1 # let the recorder attach
}

# Stop recording without disturbing the session (VHS Hide).
stop_recording() {
	local clean_end
	clean_end=$(wc -c < "$CAST")

	tmux detach-client -s "$SESSION"
	wait "$REC_PID"
	truncate -s "$clean_end" -- "$CAST"
	REC_PID=
}

# End the recording (killing the session detaches the recorder) and render.
# Usage: render [padding-pixels].
render() {
	local clean_end=
	[[ -n $REC_PID ]] && clean_end=$(wc -c < "$CAST")

	tmux kill-session -t "$SESSION"

	if [[ -n $REC_PID ]]; then
		wait "$REC_PID"
		truncate -s "$clean_end" -- "$CAST"
	fi
	REC_PID=

	agg --font-family "$FONT_FAMILY" \
		--font-size "$FONT_SIZE"     \
		"$CAST" "$GIF"

	if [[ -n ${1:-} ]]; then
		pad_gif "$1"
	fi

	echo "Wrote $GIF"
}

# Add uniform pixel padding around the rendered GIF (like VHS's Set Padding).
# Prefers magick, falls back to ffmpeg, and warns when neither is installed.
# Usage: pad_gif <pixels>.
pad_gif() {
	local pad=$1
	local pad_color=${PAD_COLOR:-}
	echo "::: adding ${pad}px padding"
	if command -v magick >/dev/null 2>&1; then
		if [[ -z $pad_color ]]; then
			pad_color="#$(magick "${GIF}[0]" -format '%[hex:p{0,0}]' info:)"
		fi
		# Coalesce first: border on frame-diffed GIFs misplaces frames.
		magick "$GIF" -coalesce -bordercolor "$pad_color" -border "$pad" \
			-layers optimize "$GIF"
	elif command -v ffmpeg >/dev/null 2>&1; then
		local tmp="${GIF%.gif}-pad.gif"
		pad_color=${pad_color:-$PAD_FALLBACK_COLOR}
		# Regenerate the palette, otherwise ffmpeg falls back to a dithered
		# generic 256-color palette.
		ffmpeg -loglevel error -y -i "$GIF" -filter_complex \
			"pad=iw+2*${pad}:ih+2*${pad}:${pad}:${pad}:${pad_color/\#/0x},split[a][b];[a]palettegen[p];[b][p]paletteuse" \
			"$tmp"
		mv -- "$tmp" "$GIF"
	else
		echo "warning: neither magick nor ffmpeg found; skipping ${pad}px padding" >&2
	fi
}

cleanup() {
	tmux kill-session -t "$SESSION" 2>/dev/null || true
	if [[ -n $REC_PID ]] && kill -0 "$REC_PID" 2>/dev/null; then
		kill "$REC_PID" 2>/dev/null || true
	fi
}
trap cleanup EXIT
