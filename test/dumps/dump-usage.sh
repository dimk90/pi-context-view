#!/bin/bash
#
# Render `/context usage` with the working-copy extension (`pi -e .`) for every
# stored session whose display name contains a pattern, and save each rendered
# view to a log file, so usage numbers can be compared across versions.
#
# Usage:
#   test/dump-usage.sh [command-index] [name-pattern|session-file]
#
# `pi -e .` registers a second copy of an already installed pi-context-view, so
# pi disambiguates them by index: 1 is the working copy, 2 the installed
# package. Pass the index to compare the working copy against the release:
#
#   test/dump-usage.sh          # working copy, sessions named *[Test]*
#   test/dump-usage.sh 2        # installed package, same sessions
#   test/dump-usage.sh 2 Research
#   test/dump-usage.sh 1 path/to/session.jsonl
#
# Logs are named after the session and the index, so both variants coexist.
#
# Each session is copied to a temp dir before pi opens it: opening a session
# lets pi and the extension append entries (e.g. probe identities), which
# would mutate the original recording.
#

set -euo pipefail


## Constants


# Any of the constants below may be overridden in the environment.

: "${SESSION:=context-usage-dump}"
: "${COLS:=120}"
: "${ROWS:=45}"
: "${OUT_DIR:=test/dumps}"
: "${SESSIONS_DIR:=$HOME/.pi/agent/sessions}"
: "${NAME_PATTERN:=[Test]}"

# Which of pi's duplicate /context commands to run: 1 = working copy loaded
# with `pi -e .`, 2 = the installed pi-context-view package.
: "${COMMAND_INDEX:=1}"

# Seconds to wait for pi to start and for the view to render.
: "${STARTUP_TIMEOUT:=60}"
: "${VIEW_TIMEOUT:=90}"

# How long to wait for pi to react to a typed command, and how many times to
# retype it. Loading a large session can drop keystrokes for a while, so the
# product of the two is the real budget.
: "${INPUT_TIMEOUT:=6}"
: "${INPUT_ATTEMPTS:=10}"

# The `usage` row of pi's slash-command completion popup: the proof that pi,
# not the shell, received the typed command.
: "${COMPLETION_PATTERN:=Show estimated context usage}"

# Temp copy of the session, set by main and removed by the EXIT trap. Global
# because the trap runs after main's locals are gone.
WORK_DIR=


## Session


start_pi() {
    #
    # Start a detached tmux session running pi on the given session file with
    # only the working-copy extension path added.
    #
    # Parameters:
    #   $1 - session_file - path to the .jsonl session to open.
    #
    # Example:
    #   start_pi /tmp/dump/session.jsonl
    #
    local session_file="$1"

    tmux kill-session -t "$SESSION" 2> /dev/null || true # leftover from an aborted run
    tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" -c "$PWD"
    tmux send-keys -t "$SESSION" "pi -e . --session $session_file" Enter
    wait_for_pi "$STARTUP_TIMEOUT"
}


wait_for_pi() {
    #
    # Poll until pi is the foreground process of the pane. Return 1 on timeout.
    #
    # Pane text cannot gate startup: the shell prompt is already drawn before
    # pi runs, so a text pattern can match the prompt and return immediately.
    # Readiness for input is established separately, by open_usage_view waiting
    # for pi's completion popup.
    #
    # Parameters:
    #   $1 - timeout - (optional) - seconds before giving up (default: 30).
    #
    # Example:
    #   wait_for_pi 60
    #
    local timeout="${1:-30}"

    local deadline=$((SECONDS + timeout))

    until [[ $(tmux display-message -p -t "$SESSION" '#{pane_current_command}') == 'pi' ]]; do
        if ((SECONDS >= deadline)); then
            printf 'timeout waiting for pi to start\n' >&2
            return 1
        fi
        sleep 0.5
    done
}


open_usage_view() {
    #
    # Type the command, pick it from the completion popup, and wait until the
    # Usage view is rendered.
    #
    # Example:
    #   open_usage_view
    #
    local command_line="/context:$COMMAND_INDEX usage"

    # Keystrokes are dropped while pi loads the session, and a large session
    # takes longer than any fixed grace period. Retype until pi reacts; C-u
    # first so a partially accepted earlier attempt does not leave the line
    # garbled.
    #
    # The gate is the completion popup, not the typed text: keys sent before pi
    # takes over the terminal are echoed by the shell, so the command appears
    # on screen while pi has never seen it. Only pi can draw the popup.
    local attempt
    for ((attempt = 0; attempt < INPUT_ATTEMPTS; attempt++)); do
        tmux send-keys -t "$SESSION" C-u
        tmux send-keys -t "$SESSION" "$command_line"
        wait_for "$COMPLETION_PATTERN" "$INPUT_TIMEOUT" 2> /dev/null && break
    done

    # Without this the Enters below are sent into an unknown state, and the
    # failure only surfaces as a confusing 'Context Usage' timeout.
    if ! tmux capture-pane -p -t "$SESSION" | grep -q "$COMPLETION_PATTERN"; then
        printf 'editor did not accept %s after %s attempts\n' "$command_line" "$INPUT_ATTEMPTS" >&2
        return 1
    fi

    tmux send-keys -t "$SESSION" Enter # accept the command completion
    sleep 1
    tmux send-keys -t "$SESSION" Enter # run it
    # Without the explicit return the trailing sleep would become the function's
    # exit code, and a timed-out view would still be captured as a success.
    wait_for 'Context Usage' "$VIEW_TIMEOUT" || return 1
    sleep 1 # let the first frame settle before capturing
}


wait_for() {
    #
    # Poll the visible pane until a pattern appears. Return 1 on timeout.
    #
    # Parameters:
    #   $1 - pattern - grep pattern to wait for.
    #   $2 - timeout - (optional) - seconds before giving up (default: 30).
    #
    # Example:
    #   wait_for 'Context Usage' 60
    #
    local pattern="$1"
    local timeout="${2:-30}"

    local deadline=$((SECONDS + timeout))

    until tmux capture-pane -p -t "$SESSION" | grep -q "$pattern"; do
        if ((SECONDS >= deadline)); then
            printf 'timeout waiting for: %s\n' "$pattern" >&2
            return 1
        fi
        sleep 0.5
    done
}


## Session metadata


read_session_name() {
    #
    # Echo the session display name, or an empty string when the session has
    # no session_info entry.
    #
    # Parameters:
    #   $1 - session_file - path to the .jsonl session.
    #
    # Example:
    #   name=$(read_session_name "$session_file")
    #
    local session_file="$1"

    # Names can be changed during a session; the last entry wins. `|| true`
    # keeps unnamed sessions (no match, grep exits 1) from failing pipefail.
    grep '"type":"session_info"' "$session_file" \
        | tail -1                                 \
        | sed -n 's/.*"name":"\(.*\)"}$/\1/p'    \
        || true
}


read_session_id() {
    #
    # Echo the session id from the session header entry.
    #
    # Parameters:
    #   $1 - session_file - path to the .jsonl session.
    #
    # Example:
    #   id=$(read_session_id "$session_file")
    #
    local session_file="$1"

    head -1 "$session_file" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'
}


find_sessions() {
    #
    # Echo, one per line, the session files under SESSIONS_DIR whose display
    # name contains the given literal substring. Sessions without a name are
    # skipped.
    #
    # Parameters:
    #   $1 - pattern - literal substring to look for in the session name.
    #
    # Example:
    #   mapfile -t sessions < <(find_sessions '[Test]')
    #
    local pattern="$1"

    local session_file name

    while IFS= read -r session_file; do
        name="$(read_session_name "$session_file")"
        # A plain `[[ ]] && printf` guard would abort the script on the first
        # non-matching session under `set -e`.
        if [[ -n $name && $name == *"$pattern"* ]]; then
            printf '%s\n' "$session_file"
        fi
    done < <(find "$SESSIONS_DIR" -name '*.jsonl' | sort)
}


## Internal


_cleanup() {
    #
    # Close the view, kill the tmux session, and drop the session copy; safe
    # when they are already gone.
    #
    tmux send-keys -t "$SESSION" Escape 2> /dev/null || true
    tmux kill-session -t "$SESSION" 2> /dev/null || true
    [[ -n $WORK_DIR ]] && rm -rf -- "$WORK_DIR"
    WORK_DIR=
    return 0
}


trap _cleanup EXIT


dump_session() {
    #
    # Copy one session, render the Usage view, and write the capture.
    #
    # Parameters:
    #   $1 - session_file - path to the .jsonl session to open.
    #
    # Example:
    #   dump_session ~/.pi/agent/sessions/proj/2026-07-25T10-06-13-169Z_019f.jsonl
    #
    local session_file="$1"

    local out_file
    out_file="$OUT_DIR/$(basename "$session_file" .jsonl)-context$COMMAND_INDEX.log"

    WORK_DIR="$(mktemp -d)"
    cp -- "$session_file" "$WORK_DIR/"

    # No capture is written when the view never renders, so a stale log from an
    # earlier run can never be mistaken for this one.
    if ! start_pi "$WORK_DIR/$(basename "$session_file")" || ! open_usage_view; then
        _cleanup
        printf 'FAILED %s\n' "$session_file" >&2
        return 1
    fi

    mkdir -p "$OUT_DIR"
    {
        printf 'session name: %s\n' "$(read_session_name "$session_file")"
        printf 'session id:   %s\n' "$(read_session_id "$session_file")"
        printf 'session file: %s\n' "$session_file"
        printf 'command:      /context:%s usage (%s)\n' "$COMMAND_INDEX" "$(describe_command_index)"
        printf 'captured:     %s\n\n' "$(date -Iseconds)"
        tmux capture-pane -p -t "$SESSION"
    } > "$out_file"

    _cleanup
    printf 'Wrote %s\n' "$out_file"
}


describe_command_index() {
    #
    # Echo which extension copy the current COMMAND_INDEX refers to.
    #
    # Example:
    #   printf '%s\n' "$(describe_command_index)"
    #
    case "$COMMAND_INDEX" in
        1) printf 'working copy'       ;;
        2) printf 'installed package'  ;;
        *) printf 'unknown copy'       ;;
    esac
}


main() {
    #
    # Dump every session matching the name pattern, or the single session file
    # given as the argument.
    #
    # Parameters:
    #   $1 - command_index - (optional) - digits only; which duplicate
    #        /context command to run (default: COMMAND_INDEX).
    #   $2 - target - (optional) - session file path, or a name pattern
    #        (default: NAME_PATTERN).
    #
    # A bare number can only be the index: session paths end in .jsonl and
    # session names are never digits alone.
    if [[ ${1-} =~ ^[1-9][0-9]*$ ]]; then
        COMMAND_INDEX="$1"
        shift
    fi

    local target="${1:-$NAME_PATTERN}"

    local sessions=()

    if [[ -f $target ]]; then
        sessions=("$target")
    else
        mapfile -t sessions < <(find_sessions "$target")
        if ((${#sessions[@]} == 0)); then
            printf 'no sessions with %s in the name under %s\n' "$target" "$SESSIONS_DIR" >&2
            return 1
        fi
        printf 'Matched %s session(s) for %s\n' "${#sessions[@]}" "$target"
    fi

    printf 'Using /context:%s (%s)\n' "$COMMAND_INDEX" "$(describe_command_index)"

    # One unrenderable session must not hide the remaining ones; the exit code
    # still reports that something failed.
    local session_file
    local failed=0
    for session_file in "${sessions[@]}"; do
        dump_session "$session_file" || failed=$((failed + 1))
    done

    if ((failed > 0)); then
        printf '%s of %s session(s) failed\n' "$failed" "${#sessions[@]}" >&2
        return 1
    fi
}


main "$@"
