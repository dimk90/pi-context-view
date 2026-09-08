#!/bin/bash
#
# Re-record every committed demo asset: the s-vhs recordings under
# scripts/recordings and the palette panel composite.
#
# Each target pins its own session, size and palette, so this script only runs
# them in a fixed order, keeps going after a failure, and reports what broke.
#
# Produces doc/images/*.gif and doc/images/palettes.png
#

set -uo pipefail

_RECORD_SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly _RECORD_SCRIPT_DIR

# recordings/palette.rec.sh is left out on purpose: it records a single panel
# for one palette, and palettes-panel.sh already drives it once per palette
readonly _RECORD_TARGETS=(
    'recordings/context-usage.rec.sh'
    'recordings/context-injections.rec.sh'
    'recordings/zoom.rec.sh'
    'recordings/palettes.rec.sh'
    'palettes-panel.sh'
)


main() {
    #
    # Run every recording target, then report the failed ones.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   ./scripts/record-all.sh
    #
    local target
    local failed=()

    for target in "${_RECORD_TARGETS[@]}"; do
        _record_run_target "$target" || failed+=("$target")
    done

    _record_report ${failed[@]+"${failed[@]}"}
}


## Internal
#
# Bash cannot hide these from a sourcing shell; the _record_ prefix marks the
# private boundary.


_record_run_target() {
    #
    # Run one target from the scripts directory, with its own output in view.
    #
    # A missing or non-executable target fails like any other one, so a broken
    # path does not stop the remaining recordings.
    #
    # Parameters:
    #   $1 - target - target path relative to the scripts directory.
    #
    # Example:
    #   _record_run_target 'recordings/zoom.rec.sh' || return 1
    #
    local target="$1"
    local path="$_RECORD_SCRIPT_DIR/$target"

    printf '\n::: Recording %s\n' "$target"
    [[ -x $path ]] || {
        printf 'record-all: %s is not executable\n' "$path" >&2
        return 1
    }

    "$path"
}


_record_report() {
    #
    # Print the run summary and carry its exit status.
    #
    # Parameters:
    #   $@ - failed - target paths that exited nonzero, none on a clean run.
    #
    # Example:
    #   _record_report 'recordings/zoom.rec.sh'
    #
    local failed=("$@")
    local target

    if [[ ${#failed[@]} -eq 0 ]]; then
        printf '\n::: All %d targets recorded\n' "${#_RECORD_TARGETS[@]}"
        printf '::: Review doc/images before committing\n'
        return 0
    fi

    printf '\n::: %d of %d targets failed:\n' "${#failed[@]}" "${#_RECORD_TARGETS[@]}" >&2
    for target in "${failed[@]}"; do
        printf ':::   %s\n' "$target" >&2
    done
    return 1
}


main "$@"
