#!/bin/bash
#
# Start pi with the request-only injection demo extensions from test/fixtures/
# and this working copy of pi-context-view, for demo recordings.
#
# Usage:
#   ./scripts/demo-injections.sh [--after] [--force] [--codemode-only] [pi arguments...]
#
#   --after         load pi-context-view before the demo extensions, so their
#                   handlers run after the monitor's; by default they run before it
#   --force         also load forced-prompt.ts, which replaces the whole system
#                   prompt of every run
#   --codemode-only activate Pi's codemode in only mode without changing settings;
#                   load no other demo fixtures, even with --force
#
# Other arguments go to pi unchanged, for example `--model` or `--no-session`.
# Discovered extensions stay disabled, so an installed copy of pi-context-view
# does not add a second `/context` command.
#
# Open /context injections in a fresh session for three section additions,
# three modifications, and three deletions without any marker prompts.
# Send an ordinary prompt before opening the view for three automatic late
# edits: one Added, one Modified, and one Deleted. Silent probes have no payload.
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
# payload-late-edits.ts seeds request-only notes, then adds, modifies, and
# deletes one payload message each. With --after these payload edits are unseen.
# payload-remove-tool.ts removes `write` unless --codemode-only uses codemode.
# forced-prompt.ts loads only with --force: its prompt replaces Pi's structured
# one, so the system-prompt demos no longer reach the request.
#

set -euo pipefail

_DEMO_REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
readonly _DEMO_REPO_ROOT
readonly _DEMO_MONITOR="$_DEMO_REPO_ROOT/src/index.ts"

# See each fixture's header. Context additions follow edits of the user's
# latest prompt; payload-late-edits prepends its originals to keep them separate
readonly _DEMO_FIXTURES=(
    context-modify context-in-place context-delete context-reorder context-add context-add-user
    system-append section-patch section-modify section-delete in-place-mutation
    payload-late-edits payload-delete
)


main() {
    #
    # Build the extension arguments in the requested order and replace this
    # shell with pi.
    #
    # Parameters:
    #   $1.. - --after, --force, --codemode-only - (optional) - load the monitor
    #          first, force the prompt, or hide tools via codemode. Any order.
    #   $@ - pi arguments - (optional) - passed to pi after the extensions.
    #
    # Example:
    #   ./scripts/demo-injections.sh --after --force --model anthropic/claude-haiku-4-5
    #
    local monitor_first=false
    local forced=false
    local hidden_tools=false
    while (($# > 0)); do
        case "$1" in
            --after) monitor_first=true ;;
            --force) forced=true ;;
            --codemode-only) hidden_tools=true ;;
            *) break ;;
        esac
        shift
    done

    local fixtures=()
    if [[ "$hidden_tools" == true ]]; then
        fixtures=(hidden-tools)
    else
        fixtures=("${_DEMO_FIXTURES[@]}" payload-remove-tool)
        if [[ "$forced" == true ]]; then
            fixtures+=(forced-prompt)
        fi
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
