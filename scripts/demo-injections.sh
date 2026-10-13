#!/bin/bash
#
# Start pi with this working copy of pi-context-view and explicitly selected
# request-only injection demo extensions, for demo recordings.
#
# Usage:
#   ./scripts/demo-injections.sh [demo flags...] [pi arguments...]
#
#   --context       load one conversation addition, modification, and deletion
#   --system        load one section addition, modification, deletion, and an attributed tool
#   --payload       load one message payload edit and manual tool-declaration removal
#   --message       load a saved before_agent_start review message
#   --mock          use a local mock provider, without real LLM calls or saved sessions
#   --forced        load forced-prompt.ts, replacing the whole system prompt
#   --codemode-only load Pi's built-in codemode in only mode, through temporary settings
#   --after         load pi-context-view before the selected demo extensions
#   --local         also load locally installed extensions (omit --no-extensions)
#
# Fixtures live in scripts/demo-injections/, independently of regular test fixtures.
# See scripts/demo-injections.md for each group's fixtures and behavior.
#
# No demo fixtures load by default. Selected groups load in flag order;
# --codemode-only combines with any explicitly selected fixtures.
# Place demo flags before Pi arguments. Other arguments go to pi unchanged.
# Discovered extensions stay disabled unless --local is set. With --local,
# an installed pi-context-view may load alongside this working copy.
# --mock --local loads global extensions only; project resources stay disabled.
#
# Send an ordinary prompt for payload demos: silent probes have no provider
# payload. Injections shows the latest request when reopened.
#

set -euo pipefail

_DEMO_REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
readonly _DEMO_REPO_ROOT
readonly _DEMO_MONITOR="$_DEMO_REPO_ROOT/src/index.ts"

# Reads DEMO_SETTINGS_FILE, which may be missing, and prints those settings as
# JSON with codemode in `only` mode and enabled next to the inherited tools.
# Fails when the file is not valid JSON.
readonly _DEMO_CODEMODE_SETTINGS_SCRIPT='
    const fs = require("node:fs");

    const file = process.env.DEMO_SETTINGS_FILE;
    const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const defaultTools = Array.isArray(settings.defaultTools) ? settings.defaultTools : [];

    settings.codemode = { ...settings.codemode, mode: "only" };
    settings.defaultTools = [...defaultTools, "+codemode"];
    process.stdout.write(JSON.stringify(settings, null, 2) + "\n");
'

# Temporary agent directory used by --codemode-only; removed on exit
_DEMO_AGENT_OVERLAY=''


main() {
    #
    # Load only the selected demo extensions, then run pi.
    #
    # Parameters:
    #   $1.. - demo flags - (optional) - select fixtures and their load order.
    #   $@ - pi arguments - (optional) - passed to pi after the extensions.
    #
    # Example:
    #   ./scripts/demo-injections.sh --codemode-only --forced --no-session
    #
    local monitor_first=false
    local mock=false
    local local_extensions=false
    local codemode_only=false
    local discovery_args=(--no-extensions)
    local fixtures=()
    while (($# > 0)); do
        case "$1" in
            --local) local_extensions=true; discovery_args=() ;;
            --after) monitor_first=true ;;
            --mock) mock=true ;;
            --forced) fixtures+=(forced-prompt) ;;
            --codemode-only) codemode_only=true ;;
            --context)
                fixtures+=(context-modify context-delete context-add) ;;
            --system)
                fixtures+=(review-checklist section-patch section-modify section-delete) ;;
            --payload)
                fixtures+=(payload-changes payload-remove-tool) ;;
            --message)
                fixtures+=(agent-start-message) ;;
            *) break ;;
        esac
        shift
    done

    local extension_args=()
    local fixture
    for fixture in "${fixtures[@]}"; do
        extension_args+=(-e "$_DEMO_REPO_ROOT/scripts/demo-injections/$fixture.ts")
    done
    if [[ "$monitor_first" == true ]]; then
        extension_args=(-e "$_DEMO_MONITOR" "${extension_args[@]}")
    else
        extension_args+=(-e "$_DEMO_MONITOR")
    fi
    if [[ "$codemode_only" == true ]]; then
        # --no-extensions drops built-ins; Pi loads explicit builtin: entries after other -e paths
        extension_args+=(-e 'builtin:codemode')
    fi

    if [[ "$mock" == true ]]; then
        # The runner owns cleanup; replace the shell so signals reach it directly
        exec node "$_DEMO_REPO_ROOT/scripts/demo-injections/demo-mock.ts" "$codemode_only" "$local_extensions" \
            "${discovery_args[@]}" "${extension_args[@]}" "$@"
    else
        if [[ "$codemode_only" == true ]]; then
            _demo_use_codemode_settings
        fi
        # No exec: the EXIT trap must remove the temporary agent directory after pi exits
        pi "${discovery_args[@]}" "${extension_args[@]}" "$@"
    fi
}


## Internal
# Bash cannot hide these from a sourcing shell; the _demo_ prefix marks them private.


_demo_use_codemode_settings() {
    #
    # Point pi at a temporary agent directory that mirrors the real one, except
    # for settings that enable codemode in `only` mode. The real settings file
    # stays unchanged; the directory is removed when the script exits.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _demo_use_codemode_settings
    #
    local agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
    agent_dir="${agent_dir/#\~/$HOME}"

    _DEMO_AGENT_OVERLAY=$(mktemp -d)
    trap 'rm -rf -- "$_DEMO_AGENT_OVERLAY"' EXIT
    # Links share auth, models, sessions, and themes with the real directory
    find "$agent_dir" -mindepth 1 -maxdepth 1 ! -name 'settings.json' \
         -exec ln -s -- {} "$_DEMO_AGENT_OVERLAY/" \;
    DEMO_SETTINGS_FILE="$agent_dir/settings.json" \
        node -e "$_DEMO_CODEMODE_SETTINGS_SCRIPT" >"$_DEMO_AGENT_OVERLAY/settings.json"
    export PI_CODING_AGENT_DIR="$_DEMO_AGENT_OVERLAY"
}


main "$@"
