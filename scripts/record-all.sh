#!/bin/bash
#
# Re-record every committed demo asset: the s-vhs recordings under doc/images
# and the palette and map-size panel composites.
#
# Each target pins its own session, size and palette, so this script only runs
# them in a fixed order, keeps going after a failure, and reports what broke.
#
# Produces doc/images/*.gif, doc/images/palettes.png, and doc/images/map-sizes.png
#

set -uo pipefail

_RECORD_REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
readonly _RECORD_REPO_ROOT

# Single-panel recorders (scripts/palette.rec.sh and scripts/map-size.rec.sh)
# are left out: their respective composite scripts already drive every variant
readonly _RECORD_TARGETS=(
    'doc/images/context-usage.rec.sh'
    'doc/images/context-injections.rec.sh'
    'doc/images/zoom.rec.sh'
    'doc/images/palettes.rec.sh'
    'doc/images/map-sizes.rec.sh'
    'scripts/palettes-panel.sh'
    'scripts/map-sizes-panel.sh'
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
    # Run one target from the repository root, with its own output in view.
    #
    # A missing or non-executable target fails like any other one, so a broken
    # path does not stop the remaining recordings.
    #
    # Parameters:
    #   $1 - target - target path relative to the repository root.
    #
    # Example:
    #   _record_run_target 'doc/images/zoom.rec.sh' || return 1
    #
    local target="$1"
    local path="$_RECORD_REPO_ROOT/$target"

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
    #   _record_report 'doc/images/zoom.rec.sh'
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
