#!/bin/bash
#
# Start pi with this working copy of pi-context-view and explicitly selected
# request-only injection demo extensions, for demo recordings.
#
# Usage:
#   ./scripts/demo-injections.sh [demo flags...] [pi arguments...]
#
#   --context       load conversation additions, modifications, deletions, reordering
#   --system        load system prompt and section edits
#   --payload       load late message edits and manual tool-declaration removal
#   --forced        load forced-prompt.ts, replacing the whole system prompt
#   --codemode-only load hidden-tools.ts, enabling codemode's only mode locally
#   --after         load pi-context-view before the selected demo extensions
#
# See scripts/demo-injections.md for each group's fixtures and behavior.
#
# No demo fixtures load by default. Selected groups load in flag order;
# --codemode-only combines with any explicitly selected fixtures.
# Place demo flags before Pi arguments. Other arguments go to pi unchanged.
# Discovered extensions stay disabled to avoid a second installed copy.
#
# Send an ordinary prompt before first opening /context injections for payload
# demos: silent probes have no provider payload, and Initial stays frozen.
#

set -euo pipefail

_DEMO_REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
readonly _DEMO_REPO_ROOT
readonly _DEMO_MONITOR="$_DEMO_REPO_ROOT/src/index.ts"


main() {
    #
    # Load only the selected demo extensions, then replace this shell with pi.
    #
    # Parameters:
    #   $1.. - demo flags - (optional) - select fixtures and their load order.
    #   $@ - pi arguments - (optional) - passed to pi after the extensions.
    #
    # Example:
    #   ./scripts/demo-injections.sh --codemode-only --forced --no-session
    #
    local monitor_first=false
    local fixtures=()
    while (($# > 0)); do
        case "$1" in
            --after) monitor_first=true ;;
            --forced) fixtures+=(forced-prompt) ;;
            --codemode-only) fixtures+=(hidden-tools) ;;
            --context)
                fixtures+=(context-modify context-in-place context-delete context-reorder context-add context-add-user) ;;
            --system)
                fixtures+=(system-append section-patch section-modify section-delete in-place-mutation) ;;
            --payload)
                fixtures+=(payload-late-edits payload-delete payload-remove-tool) ;;
            *) break ;;
        esac
        shift
    done

    local extension_args=()
    local fixture
    for fixture in "${fixtures[@]}"; do
        extension_args+=(-e "$_DEMO_REPO_ROOT/test/fixtures/$fixture.ts")
    done
    if [[ "$monitor_first" == true ]]; then
        extension_args=(-e "$_DEMO_MONITOR" "${extension_args[@]}")
    else
        extension_args+=(-e "$_DEMO_MONITOR")
    fi

    exec pi --no-extensions "${extension_args[@]}" "$@"
}


main "$@"
