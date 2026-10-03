#!/bin/bash
#
# Start pi with the request-only injection demo extensions from test/fixtures/
# and this working copy of pi-context-view, for demo recordings.
#
# Usage:
#   ./scripts/demo-injections.sh [--after] [pi arguments...]
#
#   --after   load pi-context-view before the demo extensions, so their
#             handlers run after the monitor's; by default they run before it
#
# Other arguments go to pi unchanged, for example `--model` or `--no-session`.
# Discovered extensions stay disabled, so an installed copy of pi-context-view
# does not add a second `/context` command.
#
# Some demo extensions act only on prompts with a marker; use one per prompt:
#   XYZZY_CONTEXT_REORDER   swapped with the latest prompt; send another prompt after it
#   XYZZY_CONTEXT_DELETE    removed from the request
#   XYZZY_PAYLOAD_DELETE    removed from the provider payload
#
# context-modify.ts and context-in-place.ts both edit the latest prompt.
# payload-remove-tool.ts removes the `write` declaration from every request.
# forced-prompt.ts is left out: it replaces the whole system prompt and would
# hide the system-prompt demos.
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
    #   $1 - --after - (optional) - load pi-context-view first.
    #   $@ - pi arguments - (optional) - passed to pi after the extensions.
    #
    # Example:
    #   ./scripts/demo-injections.sh --after --model anthropic/claude-haiku-4-5
    #
    local monitor_first=false
    if [[ "${1-}" == "--after" ]]; then
        monitor_first=true
        shift
    fi

    local extension_args=()
    local fixture
    for fixture in "${_DEMO_FIXTURES[@]}"; do
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
