#!/bin/bash
#
# Start pi with the request-only injection demo extensions from test/fixtures/
# and this working copy of pi-context-view, for demo recordings.
#
# Usage:
#   ./scripts/demo-injections.sh [--after] [--force] [pi arguments...]
#
#   --after   load pi-context-view before the demo extensions, so their
#             handlers run after the monitor's; by default they run before it
#   --force   also load forced-prompt.ts, which replaces the whole system
#             prompt of every run
#
# Other arguments go to pi unchanged, for example `--model` or `--no-session`.
# Discovered extensions stay disabled, so an installed copy of pi-context-view
# does not add a second `/context` command.
#
# Open /context injections in a fresh session for three section additions,
# three modifications, and three deletions without any marker prompts.
# section-modify.ts and section-delete.ts seed synthetic baseline sections;
# only their request copies are changed. --after hides these structured edits
# because they run after capture; --force replaces the sectioned prompt.
#
# Optional conversation demos act on prompts with a marker; use one per prompt:
#   XYZZY_CONTEXT_REORDER   swapped with the latest prompt; send another prompt after it
#   XYZZY_CONTEXT_DELETE    removed from the request
#   XYZZY_PAYLOAD_DELETE    removed from the provider payload
#
# context-modify.ts and context-in-place.ts both edit the latest prompt.
# payload-remove-tool.ts removes the `write` declaration from every request.
# forced-prompt.ts loads only with --force: its prompt replaces Pi's structured
# one, so the system-prompt demos no longer reach the request.
#

set -euo pipefail

_DEMO_REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
readonly _DEMO_REPO_ROOT
readonly _DEMO_MONITOR="$_DEMO_REPO_ROOT/src/index.ts"

# One kind of request-only change each; see the header of each file. Additions
# come last, so edits of the latest user message reach the user's prompt
readonly _DEMO_FIXTURES=(
    context-modify context-in-place context-delete context-reorder context-add context-add-user
    system-append section-patch section-modify section-delete in-place-mutation
    payload-modify payload-delete payload-remove-tool payload-rewrite
)


main() {
    #
    # Build the extension arguments in the requested order and replace this
    # shell with pi.
    #
    # Parameters:
    #   $1.. - --after, --force - (optional) - load pi-context-view first;
    #          add the forced-prompt demo. Either order.
    #   $@ - pi arguments - (optional) - passed to pi after the extensions.
    #
    # Example:
    #   ./scripts/demo-injections.sh --after --force --model anthropic/claude-haiku-4-5
    #
    local monitor_first=false
    local forced=false
    while (($# > 0)); do
        case "$1" in
            --after) monitor_first=true ;;
            --force) forced=true ;;
            *) break ;;
        esac
        shift
    done

    local fixtures=("${_DEMO_FIXTURES[@]}")
    if [[ "$forced" == true ]]; then
        fixtures+=(forced-prompt)
    fi

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
