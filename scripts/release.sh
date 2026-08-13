#!/bin/bash
#
# Release pi-context-view from develop to master, npm, and GitHub.
#
# Prepare the version bump, dated changelog, completed-plan removal, README,
# images, and dependency pins before running this script. The prepared tree may
# be uncommitted or already committed and pushed to develop. The script performs
# all mechanical checks before asking for one approval, then stops on the first
# failed release step without attempting rollback.
#

set -uo pipefail

readonly _RELEASE_PACKAGE_NAME='pi-context-view'
readonly _RELEASE_GITHUB_REPOSITORY='dimk90/pi-context-view'
readonly _RELEASE_NPM_REGISTRY='https://registry.npmjs.org/'
readonly _RELEASE_DEVELOP_BRANCH='develop'
readonly _RELEASE_MASTER_BRANCH='master'
readonly _RELEASE_ALLOWED_PATHS=(
    CHANGELOG.md
    doc/PLAN.md
    README.md
    package.json
    pnpm-lock.yaml
)

# Reads RELEASE_VERSIONS_FILE and RELEASE_TARGET_VERSION, prints the newest
# published stable version, and fails with a reason when the target does not
# exceed it.
#
# Literal JS: template placeholders belong to node and must not expand
# shellcheck disable=SC2016
readonly _RELEASE_NPM_VERSION_CHECK_SCRIPT='
    const fs = require("node:fs");

    const target = process.env.RELEASE_TARGET_VERSION.split(".").map(Number);
    const rawVersions = JSON.parse(fs.readFileSync(process.env.RELEASE_VERSIONS_FILE, "utf8"));
    const versions = (Array.isArray(rawVersions) ? rawVersions : [rawVersions])
        .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
        .map((version) => version.split(".").map(Number));
    const compare = (left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    const latest = versions.sort(compare).at(-1);

    if (!latest) {
        console.error("npm has no published stable version");
        process.exit(1);
    }
    if (compare(target, latest) <= 0) {
        console.error(`target is not newer than ${latest.join(".")}`);
        process.exit(1);
    }
    console.log(latest.join("."));
'

# Reads NPM_ACCOUNT and MAINTAINERS_FILE and fails with a reason when the
# authenticated account does not own the package.
#
# Literal JS: template placeholders belong to node and must not expand
# shellcheck disable=SC2016
readonly _RELEASE_NPM_OWNER_CHECK_SCRIPT='
    const fs = require("node:fs");

    const maintainers = JSON.parse(fs.readFileSync(process.env.MAINTAINERS_FILE, "utf8"));
    const entries = Array.isArray(maintainers) ? maintainers : [maintainers];
    if (!entries.some((maintainer) => maintainer?.name === process.env.NPM_ACCOUNT)) {
        console.error(`${process.env.NPM_ACCOUNT} is not a package owner`);
        process.exit(1);
    }
'

_RELEASE_BLOCKERS=()
_RELEASE_CANDIDATE_PATHS=()
_RELEASE_CANDIDATE_MODE='invalid'
_RELEASE_TMP_DIR=''
_RELEASE_LOG_FILE=''
_RELEASE_TARGET_VERSION=''
_RELEASE_TARGET_TAG=''
_RELEASE_NPM_ACCOUNT=''
_RELEASE_LATEST_NPM_VERSION=''
_RELEASE_APPROVED_HEAD=''
_RELEASE_APPROVED_STATUS=''
_RELEASE_RELEASE_COMMIT=''
_RELEASE_MERGE_COMMIT=''
_RELEASE_STEP_NUMBER=0
_RELEASE_DEVELOP_PUSHED='not pushed'
_RELEASE_TAG_PUSHED='not pushed'
_RELEASE_NPM_STATE='not attempted'


## Main

main() {
    #
    # Validate and apply the prepared release.
    #
    # Parameters:
    #   $@ - command-line arguments; none are accepted.
    #
    # Example:
    #   main
    #
    _release_require_environment "$@"
    _release_prepare_workspace

    _release_run_sanity_checks
    _release_confirm_release_plan

    _release_validate_release_tree
    _release_commit_release
    _release_push_develop
    _release_merge_into_master
    _release_tag_master
    _release_push_master_and_tag
    _release_publish_to_npm
    _release_return_to_develop
    _release_report_success
}


## Internal

# Bash cannot hide these functions; the _release_ prefix marks the private
# boundary and avoids collisions if the script is ever sourced accidentally.


### Startup

_release_require_environment() {
    #
    # Exit unless the script was invoked without arguments, every required
    # command exists, and the terminal is interactive.
    #
    # Parameters:
    #   $@ - command-line arguments; none are accepted.
    #
    # Example:
    #   _release_require_environment "$@"
    #
    local argument_count=$#
    local missing_tools=()
    local tool

    if ((argument_count > 0)); then
        printf 'Usage: %s\n' "$0" >&2
        printf 'Releases the version already prepared in package.json and CHANGELOG.md.\n' >&2
        exit 2
    fi

    for tool in gum git node pnpm pi; do
        command -v "$tool" >/dev/null 2>&1 || missing_tools+=("$tool")
    done
    if ((${#missing_tools[@]} > 0)); then
        printf 'Missing required command(s): %s\n' "${missing_tools[*]}" >&2
        exit 1
    fi

    if [[ ! -t 0 || ! -t 1 ]]; then
        printf 'The release script needs an interactive terminal.\n' >&2
        exit 1
    fi
}


_release_prepare_workspace() {
    #
    # Enter the repository root and create the temporary command log removed by
    # the exit trap.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_prepare_workspace
    #
    local repository_root

    repository_root="$(git rev-parse --show-toplevel 2>/dev/null)"
    if [[ -z $repository_root ]]; then
        printf 'Run this script inside the %s repository.\n' "$_RELEASE_PACKAGE_NAME" >&2
        exit 1
    fi
    cd "$repository_root" || exit 1

    _RELEASE_TMP_DIR="$(mktemp -d -t pi-context-release-XXXXXX)" || exit 1
    readonly _RELEASE_TMP_DIR
    _RELEASE_LOG_FILE="${_RELEASE_TMP_DIR}/command.log"
    readonly _RELEASE_LOG_FILE
    trap 'rm -rf "$_RELEASE_TMP_DIR"' EXIT
}


### Sanity checks

_release_run_sanity_checks() {
    #
    # Run every sanity check, then exit when any of them recorded a blocker.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_run_sanity_checks
    #
    _release_heading "Sanity checks for ${_RELEASE_PACKAGE_NAME}"

    _release_check_required_files
    _release_check_origin_remote
    _release_check_repository_state
    _release_check_candidate_paths
    if _release_read_target_version; then
        _release_check_package_metadata
        _release_check_changelog
        _release_check_plan
        _release_check_npm_version
    fi
    _release_check_origin_state
    _release_check_npm_registry
    _release_check_npm_account
    _release_report_blockers
}


_release_check_required_files() {
    #
    # Block when a file the release depends on is missing.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_required_files
    #
    local required_file

    for required_file in CHANGELOG.md doc/PLAN.md doc/RELEASE.md README.md package.json pnpm-lock.yaml; do
        if [[ -f $required_file ]]; then
            _release_pass "found ${required_file}"
        else
            _release_block "required release file is missing: ${required_file}"
        fi
    done
}


_release_check_origin_remote() {
    #
    # Block when origin does not identify the expected GitHub repository.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_origin_remote
    #
    local origin_url origin_pattern

    origin_url="$(git remote get-url origin 2>/dev/null)"
    origin_pattern='^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)dimk90/pi-context-view(\.git)?$'
    if [[ $origin_url =~ $origin_pattern ]]; then
        _release_pass "origin identifies ${_RELEASE_GITHUB_REPOSITORY}"
    else
        _release_block 'origin does not identify the expected GitHub repository' \
                       "${origin_url:-origin is missing}"
    fi
}


_release_check_repository_state() {
    #
    # Block unless the release starts on develop with no Git operation running.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_repository_state
    #
    local operations=()
    local current_branch git_dir marker

    current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null)"
    if [[ $current_branch == "$_RELEASE_DEVELOP_BRANCH" ]]; then
        _release_pass "current branch is ${_RELEASE_DEVELOP_BRANCH}"
    else
        _release_block "release must start on ${_RELEASE_DEVELOP_BRANCH}" \
                       "current branch: ${current_branch:-detached HEAD}"
    fi

    git_dir="$(git rev-parse --absolute-git-dir)"
    for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG rebase-apply rebase-merge; do
        [[ -e ${git_dir}/${marker} ]] && operations+=("$marker")
    done
    if ((${#operations[@]} == 0)); then
        _release_pass 'no merge, rebase, cherry-pick, revert, or bisect is in progress'
    else
        _release_block 'a Git operation is in progress' "$(printf '%s\n' "${operations[@]}")"
    fi
}


_release_check_candidate_paths() {
    #
    # Classify the candidate as a worktree or committed change set and block
    # when the worktree holds anything outside the release paths.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_candidate_paths
    #
    local unexpected_paths=()
    local path

    while IFS= read -r -d '' path; do
        _RELEASE_CANDIDATE_PATHS+=("$path")
        _release_is_allowed_path "$path" || unexpected_paths+=("$path")
    done < <(git diff HEAD --name-only -z
             git ls-files --others --exclude-standard -z)

    if ((${#_RELEASE_CANDIDATE_PATHS[@]} == 0)); then
        _RELEASE_CANDIDATE_MODE='committed'
        _release_pass 'the worktree is clean; checking the committed develop tree'
    elif ((${#unexpected_paths[@]} > 0)); then
        _release_block 'the worktree holds changes outside the release paths' \
                       "$(printf '%s\n' "${unexpected_paths[@]}")"
    else
        _RELEASE_CANDIDATE_MODE='worktree'
        _release_pass "the worktree holds ${#_RELEASE_CANDIDATE_PATHS[@]} release path(s) and nothing else"
        _release_check_required_candidates 'the prepared release' '' \
                                           "${_RELEASE_CANDIDATE_PATHS[@]}"
    fi
}


_release_check_required_candidates() {
    #
    # Block when a candidate change set leaves CHANGELOG.md or package.json
    # untouched.
    #
    # Parameters:
    #   $1 - subject - candidate description used in the blocker message.
    #   $2 - scope - (optional) - comparison named in the blocker message,
    #        such as 'from origin/master'.
    #   $3... - paths - candidate paths to search.
    #
    # Example:
    #   _release_check_required_candidates 'the prepared release' '' 'CHANGELOG.md'
    #
    local subject="$1"
    local scope="$2"
    shift 2
    local paths=("$@")
    local required_candidate path candidate_found

    for required_candidate in CHANGELOG.md package.json; do
        candidate_found=false
        for path in "${paths[@]}"; do
            if [[ $path == "$required_candidate" ]]; then
                candidate_found=true
                break
            fi
        done
        if [[ $candidate_found != true ]]; then
            _release_block "${subject} does not change ${required_candidate}${scope:+ ${scope}}"
        fi
    done
}


_release_read_target_version() {
    #
    # Read the prepared version from package.json and derive the release tag.
    #
    # Returns nonzero when package.json cannot supply a stable version, so the
    # caller can skip every check that depends on it.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_read_target_version && _release_check_changelog
    #
    if ! _RELEASE_TARGET_VERSION="$(_release_package_value 'version' 2>"$_RELEASE_LOG_FILE")"; then
        _release_block 'package.json is not valid JSON' "$(cat "$_RELEASE_LOG_FILE")"
        return 1
    fi
    if [[ ! $_RELEASE_TARGET_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        _release_block 'package.json version must use stable X.Y.Z form' \
                       "found: ${_RELEASE_TARGET_VERSION:-missing}"
        return 1
    fi

    _RELEASE_TARGET_TAG="v${_RELEASE_TARGET_VERSION}"
    _release_pass "package version is ${_RELEASE_TARGET_VERSION}"
    return 0
}


_release_check_package_metadata() {
    #
    # Block when the package identity, Pi peer dependencies, or development
    # pins do not match the release requirements.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_package_metadata
    #
    local package_name agent_peer tui_peer pi_version agent_pin tui_pin

    package_name="$(_release_package_value 'name')"
    agent_peer="$(_release_package_value 'peerDependencies.@earendil-works/pi-coding-agent')"
    tui_peer="$(_release_package_value 'peerDependencies.@earendil-works/pi-tui')"
    if [[ $package_name == "$_RELEASE_PACKAGE_NAME" ]]; then
        _release_pass "package identity is ${_RELEASE_PACKAGE_NAME}"
    else
        _release_block 'package.json has an unexpected package name' \
                       "found: ${package_name:-missing}"
    fi
    if [[ $agent_peer == '*' && $tui_peer == '*' ]]; then
        _release_pass 'Pi peer dependencies remain *'
    else
        _release_block 'Pi peer dependencies must remain *' \
                       "$(printf 'pi-coding-agent: %s\npi-tui: %s' \
                                 "${agent_peer:-missing}" "${tui_peer:-missing}")"
    fi

    pi_version="$(pi --version 2>/dev/null | tr -d '\r\n')"
    pi_version="${pi_version#v}"
    agent_pin="$(_release_package_value 'devDependencies.@earendil-works/pi-coding-agent')"
    tui_pin="$(_release_package_value 'devDependencies.@earendil-works/pi-tui')"
    if [[ $pi_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] &&
       [[ $agent_pin == "$pi_version" && $tui_pin == "$pi_version" ]]; then
        _release_pass "development pins match the local Pi ${pi_version}"
    else
        _release_block 'development pins do not match the local Pi' \
                       "$(printf 'pi: %s\npi-coding-agent: %s\npi-tui: %s' \
                                 "${pi_version:-unknown}" "${agent_pin:-missing}" "${tui_pin:-missing}")"
    fi
}


_release_check_changelog() {
    #
    # Block unless the newest CHANGELOG.md heading dates the target version.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_changelog
    #
    local changelog_pattern changelog_heading changelog_version release_date

    # Literal regex: $ anchors the heading and must not expand
    # shellcheck disable=SC2016
    changelog_pattern='^## `\[v([0-9]+\.[0-9]+\.[0-9]+)\]` - (.+)$'
    changelog_heading="$(grep -m 1 -E '^## `\[v[0-9]' CHANGELOG.md)"
    if [[ ! $changelog_heading =~ $changelog_pattern ]]; then
        _release_block 'unable to parse the latest CHANGELOG.md version heading' \
                       "${changelog_heading:-no version heading found}"
        return 0
    fi

    changelog_version="${BASH_REMATCH[1]}"
    release_date="${BASH_REMATCH[2]}"
    if [[ $changelog_version == "$_RELEASE_TARGET_VERSION" ]]; then
        _release_pass 'package.json matches the latest CHANGELOG.md version'
    else
        _release_block 'package.json and CHANGELOG.md versions differ' \
                       "package.json: ${_RELEASE_TARGET_VERSION}; CHANGELOG.md: ${changelog_version}"
    fi
    if [[ $release_date =~ ^[0-9]{2}\.[0-9]{2}\.[0-9]{4}$ ]]; then
        _release_pass "CHANGELOG.md dates v${changelog_version} as ${release_date}"
    else
        _release_block "CHANGELOG.md has no DD.MM.YYYY date for v${changelog_version}" \
                       "found: ${release_date}"
    fi
}


_release_check_plan() {
    #
    # Block while doc/PLAN.md still plans the version being released.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_plan
    #
    local plan_pattern

    plan_pattern="^## v${_RELEASE_TARGET_VERSION//./\\.}[[:space:]]*$"
    if grep -qE "$plan_pattern" doc/PLAN.md; then
        _release_block "doc/PLAN.md still contains v${_RELEASE_TARGET_VERSION}"
    else
        _release_pass "doc/PLAN.md does not contain v${_RELEASE_TARGET_VERSION}"
    fi
}


_release_check_npm_version() {
    #
    # Block unless the target version is unpublished and newer than every
    # stable version on npm.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_npm_version
    #
    if ! _release_capture 'reading published npm versions' \
                          pnpm view "$_RELEASE_PACKAGE_NAME" versions --json \
                               --registry="$_RELEASE_NPM_REGISTRY"; then
        _release_block 'unable to read published npm versions' \
                       "$(tail -n 10 "$_RELEASE_LOG_FILE")"
        return 0
    fi

    if RELEASE_VERSIONS_FILE="$_RELEASE_LOG_FILE" \
       RELEASE_TARGET_VERSION="$_RELEASE_TARGET_VERSION" \
       node -e "$_RELEASE_NPM_VERSION_CHECK_SCRIPT" \
            >"${_RELEASE_TMP_DIR}/latest-version" \
            2>"${_RELEASE_TMP_DIR}/version-error"
    then
        _RELEASE_LATEST_NPM_VERSION="$(<"${_RELEASE_TMP_DIR}/latest-version")"
        _release_pass "target is unpublished and newer than npm ${_RELEASE_LATEST_NPM_VERSION}"
    else
        _release_block 'package version is not a valid next npm version' \
                       "$(cat "${_RELEASE_TMP_DIR}/version-error")"
    fi
}


_release_check_origin_state() {
    #
    # Fetch origin and block on any branch, tree, or tag state the release
    # cannot start from.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_origin_state
    #
    if ! git fetch --quiet --prune --tags origin; then
        _release_block 'unable to fetch origin'
        return 0
    fi

    _release_pass 'fetched origin branches and tags'
    _release_check_branch_synchronization
    if [[ $_RELEASE_CANDIDATE_MODE == 'committed' ]]; then
        _release_check_committed_candidate
    fi
    _release_check_master_ancestry
    _release_check_target_tag
}


_release_check_branch_synchronization() {
    #
    # Block unless develop and master exactly match their origin branches.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_branch_synchronization
    #
    local branch counts ahead behind

    for branch in "$_RELEASE_DEVELOP_BRANCH" "$_RELEASE_MASTER_BRANCH"; do
        if ! git rev-parse --verify --quiet "refs/heads/${branch}" >/dev/null ||
           ! git rev-parse --verify --quiet "refs/remotes/origin/${branch}" >/dev/null; then
            _release_block "local or origin branch is missing: ${branch}"
            continue
        fi

        if ! counts="$(git rev-list --left-right --count \
                            "refs/heads/${branch}...refs/remotes/origin/${branch}")"; then
            _release_block "unable to compare ${branch} with origin/${branch}"
            continue
        fi
        read -r ahead behind <<< "$counts"
        if ((behind > 0)); then
            _release_block "${branch} is behind origin/${branch}" \
                           "ahead ${ahead}, behind ${behind}"
        elif ((ahead > 0)); then
            _release_block "${branch} is ahead of origin/${branch}" \
                           'both branches must match origin before the release starts'
        else
            _release_pass "${branch} exactly matches origin/${branch}"
        fi
    done
}


_release_check_committed_candidate() {
    #
    # Block unless the committed develop tree carries a release change set
    # against origin/master.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_committed_candidate
    #
    local committed_candidate_paths=()
    local path

    while IFS= read -r -d '' path; do
        committed_candidate_paths+=("$path")
    done < <(git diff --name-only -z \
                      "refs/remotes/origin/${_RELEASE_MASTER_BRANCH}" \
                      "refs/heads/${_RELEASE_DEVELOP_BRANCH}")

    if ((${#committed_candidate_paths[@]} == 0)); then
        _release_block 'the committed develop tree has no changes from origin/master'
    else
        _release_pass \
            "the committed develop tree differs from origin/master in ${#committed_candidate_paths[@]} path(s)"
    fi
    _release_check_required_candidates 'the committed release' 'from origin/master' \
                                       "${committed_candidate_paths[@]}"
}


_release_check_master_ancestry() {
    #
    # Block when origin/master carries tree changes that develop does not have.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_master_ancestry
    #
    local merge_base

    merge_base="$(git merge-base "refs/remotes/origin/${_RELEASE_MASTER_BRANCH}" \
                                  "refs/heads/${_RELEASE_DEVELOP_BRANCH}" 2>/dev/null)"
    if [[ -n $merge_base ]] &&
       git diff --quiet "$merge_base" "refs/remotes/origin/${_RELEASE_MASTER_BRANCH}"; then
        _release_pass 'origin/master has no tree changes absent from develop'
    else
        _release_block 'origin/master contains tree changes absent from develop'
    fi
}


_release_check_target_tag() {
    #
    # Block when the target tag already exists locally or on origin.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_target_tag
    #
    local remote_tag

    [[ -n $_RELEASE_TARGET_TAG ]] || return 0

    if git show-ref --verify --quiet "refs/tags/${_RELEASE_TARGET_TAG}"; then
        _release_block "local tag already exists: ${_RELEASE_TARGET_TAG}"
    else
        _release_pass "local tag is absent: ${_RELEASE_TARGET_TAG}"
    fi

    if remote_tag="$(git ls-remote --tags origin "refs/tags/${_RELEASE_TARGET_TAG}")"; then
        if [[ -n $remote_tag ]]; then
            _release_block "origin tag already exists: ${_RELEASE_TARGET_TAG}" "$remote_tag"
        else
            _release_pass "origin tag is absent: ${_RELEASE_TARGET_TAG}"
        fi
    else
        _release_block "unable to check origin tag ${_RELEASE_TARGET_TAG}"
    fi
}


_release_check_npm_registry() {
    #
    # Block unless pnpm is configured for the public npm registry.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_npm_registry
    #
    local configured_registry

    if ! _release_capture 'checking the pnpm registry' pnpm config get registry; then
        _release_block 'unable to read the pnpm registry configuration'
        return 0
    fi

    configured_registry="$(tr -d '\r\n' <"$_RELEASE_LOG_FILE")"
    if [[ $configured_registry == "$_RELEASE_NPM_REGISTRY" ]]; then
        _release_pass "pnpm uses ${_RELEASE_NPM_REGISTRY}"
    else
        _release_block 'pnpm is not configured for the public npm registry' \
                       "found: ${configured_registry:-missing}"
    fi
}


_release_check_npm_account() {
    #
    # Block unless npm reports an authenticated account for the release.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_npm_account
    #
    if ! _release_capture 'checking npm authentication' \
                          pnpm whoami --registry="$_RELEASE_NPM_REGISTRY"; then
        _release_block 'npm authentication failed' 'refresh the token with: npm login'
        return 0
    fi

    _RELEASE_NPM_ACCOUNT="$(tr -d '\r\n' <"$_RELEASE_LOG_FILE")"
    if [[ -z $_RELEASE_NPM_ACCOUNT ]]; then
        _release_block 'npm reported no authenticated account'
        return 0
    fi

    _release_pass "npm token is valid for account ${_RELEASE_NPM_ACCOUNT}"
    _release_check_package_owner
}


_release_check_package_owner() {
    #
    # Block unless the authenticated npm account owns the package.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_check_package_owner
    #
    if ! _release_capture 'checking npm package ownership' \
                          pnpm view "$_RELEASE_PACKAGE_NAME" maintainers --json \
                               --registry="$_RELEASE_NPM_REGISTRY"; then
        _release_block 'unable to verify npm package ownership' \
                       "$(tail -n 10 "$_RELEASE_LOG_FILE")"
        return 0
    fi

    if NPM_ACCOUNT="$_RELEASE_NPM_ACCOUNT" \
       MAINTAINERS_FILE="$_RELEASE_LOG_FILE" \
       node -e "$_RELEASE_NPM_OWNER_CHECK_SCRIPT" \
            >"${_RELEASE_TMP_DIR}/owner-check" 2>&1
    then
        _release_pass "npm account ${_RELEASE_NPM_ACCOUNT} owns ${_RELEASE_PACKAGE_NAME}"
    else
        _release_block 'authenticated npm account cannot publish this package' \
                       "$(cat "${_RELEASE_TMP_DIR}/owner-check")"
    fi
}


_release_report_blockers() {
    #
    # Print every recorded blocker and exit before the release starts.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_report_blockers
    #
    local blocker

    ((${#_RELEASE_BLOCKERS[@]} > 0)) || return 0

    _release_heading "${#_RELEASE_BLOCKERS[@]} blocker(s): release did not start"
    for blocker in "${_RELEASE_BLOCKERS[@]}"; do
        printf '  %s\n' "$blocker"
    done
    printf '\n'
    _release_info 'nothing was staged, committed, tagged, pushed, or published'
    exit 1
}


### Approval

_release_confirm_release_plan() {
    #
    # Freeze the approved candidate, present the plan, and require one explicit
    # approval of an unchanged candidate.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_confirm_release_plan
    #
    local current_head current_status

    _RELEASE_APPROVED_HEAD="$(git rev-parse HEAD)"
    _RELEASE_APPROVED_STATUS="$(git status --porcelain=v1 --untracked-files=all)"
    readonly _RELEASE_APPROVED_HEAD _RELEASE_APPROVED_STATUS

    _release_print_release_plan

    if ! gum confirm "Release ${_RELEASE_PACKAGE_NAME} ${_RELEASE_TARGET_TAG}?" \
                     --affirmative='Release' --negative='Cancel'; then
        _release_info 'release cancelled; nothing was changed'
        exit 1
    fi

    current_head="$(git rev-parse HEAD)"
    current_status="$(git status --porcelain=v1 --untracked-files=all)"
    if [[ $current_head != "$_RELEASE_APPROVED_HEAD" ||
          $current_status != "$_RELEASE_APPROVED_STATUS" ]]; then
        _release_stop 'the candidate changed after approval; run the preflight again'
    fi
}


_release_print_release_plan() {
    #
    # Print the release summary, the numbered plan, and the approval scope.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_print_release_plan
    #
    local summary_lines=()
    local plan_lines=()
    local candidate_summary candidate_plan

    if [[ $_RELEASE_CANDIDATE_MODE == 'committed' ]]; then
        candidate_summary="$(git rev-parse --short HEAD) (already committed on develop)"
        candidate_plan=' 2. Use the reviewed release tree already committed on develop'
    else
        candidate_summary="uncommitted: ${_RELEASE_CANDIDATE_PATHS[*]}"
        candidate_plan=" 2. Commit reviewed release paths as [doc] Release ${_RELEASE_TARGET_TAG}"
    fi

    _release_heading "Release plan for ${_RELEASE_TARGET_TAG}"
    summary_lines=(
        "package    ${_RELEASE_PACKAGE_NAME}"
        "version    ${_RELEASE_TARGET_VERSION} (npm: ${_RELEASE_LATEST_NPM_VERSION})"
        "tag        ${_RELEASE_TARGET_TAG}"
        "branches   ${_RELEASE_DEVELOP_BRANCH} → ${_RELEASE_MASTER_BRANCH}"
        "npm        ${_RELEASE_NPM_ACCOUNT} at ${_RELEASE_NPM_REGISTRY}"
        "candidate  ${candidate_summary}"
    )
    gum style --border rounded --border-foreground 212 --padding '0 2' --margin '1 0 0 0' -- \
              "${summary_lines[@]}"

    plan_lines=(
        ' 1. Validate: frozen install, diff check, pnpm check, package dry run'
        "$candidate_plan"
        ' 3. Push develop to origin and verify the remote commit'
        ' 4. Update master, merge develop with --no-ff, and revalidate the exact tree'
        " 5. Verify version and clean state, then tag ${_RELEASE_TARGET_TAG}"
        ' 6. Atomically push master and only the target tag (starts GitHub release workflow)'
        ' 7. Publish the tagged tree to public npm and verify the version'
        ' 8. Return to develop and verify a clean worktree'
    )
    gum style --border rounded --border-foreground 244 --padding '0 2' --margin '1 0 0 0' -- \
              "${plan_lines[@]}"

    gum style --faint --margin '1 0 1 2' -- \
              'Approval also confirms the changelog text, README/package metadata,' \
              'screenshots, and immutable image revisions were reviewed as required by doc/RELEASE.md.'
}


### Release steps

_release_validate_release_tree() {
    #
    # Install, inspect, check, and pack the approved candidate before anything
    # leaves the machine.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_validate_release_tree
    #
    _release_begin_step 'Validate the release tree'
    _release_apply_command 'installing with the frozen lockfile' \
                           pnpm install --frozen-lockfile --ignore-scripts
    if [[ $_RELEASE_CANDIDATE_MODE == 'committed' ]]; then
        _release_apply_command 'checking the committed candidate diff' \
                               git diff --check \
                                   "refs/remotes/origin/${_RELEASE_MASTER_BRANCH}" \
                                   "refs/heads/${_RELEASE_DEVELOP_BRANCH}"
    else
        _release_apply_command 'checking the candidate diff' git diff --check
    fi
    _release_apply_command 'running pnpm check' pnpm check
    if _release_capture 'packing a dry run' pnpm pack --dry-run; then
        _release_pass 'pnpm pack --dry-run succeeded'
        _release_detail "$(cat "$_RELEASE_LOG_FILE")"
    else
        _release_stop 'pnpm pack --dry-run failed' "$(tail -n 20 "$_RELEASE_LOG_FILE")"
    fi
}


_release_commit_release() {
    #
    # Establish the release commit on develop from the approved candidate.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_commit_release
    #
    if [[ $_RELEASE_CANDIDATE_MODE == 'committed' ]]; then
        _release_use_committed_release
    else
        _release_create_release_commit
    fi
}


_release_use_committed_release() {
    #
    # Adopt the reviewed commit already on develop as the release commit.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_use_committed_release
    #
    _release_begin_step 'Use the committed release on develop'
    if [[ $(git rev-parse HEAD) != "$_RELEASE_APPROVED_HEAD" ]]; then
        _release_stop 'develop moved while validating the committed release'
    fi
    if [[ -n $(git status --porcelain) ]]; then
        _release_stop 'the committed release worktree is no longer clean' \
                      "$(git status --short)"
    fi
    _RELEASE_RELEASE_COMMIT="$_RELEASE_APPROVED_HEAD"
    _release_pass "release commit: $(git log -1 --format='%h %s')"
}


_release_create_release_commit() {
    #
    # Stage exactly the approved paths and commit them on develop.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_create_release_commit
    #
    local expected_paths staged_paths commit_message

    _release_begin_step 'Commit the release on develop'
    if ! git add -- "${_RELEASE_CANDIDATE_PATHS[@]}"; then
        _release_stop 'unable to stage the reviewed release paths'
    fi
    if ! git diff --quiet || [[ -n $(git ls-files --others --exclude-standard) ]]; then
        _release_stop 'unstaged or untracked changes appeared after staging' \
                      "$(git status --short)"
    fi
    expected_paths="$(printf '%s\n' "${_RELEASE_CANDIDATE_PATHS[@]}" | sort)"
    staged_paths="$(git diff --cached --name-only | sort)"
    if [[ $staged_paths != "$expected_paths" ]]; then
        _release_stop 'the staged paths differ from the approved release paths' \
                      "$(git status --short)"
    fi
    commit_message="[doc] Release ${_RELEASE_TARGET_TAG}"
    if ! git commit -m "$commit_message"; then
        _release_stop 'release commit failed'
    fi
    if [[ -n $(git status --porcelain) ]]; then
        _release_stop 'the worktree is not clean after the release commit' \
                      "$(git status --short)"
    fi
    _RELEASE_RELEASE_COMMIT="$(git rev-parse HEAD)"
    _release_pass "release commit: $(git log -1 --format='%h %s')"
}


_release_push_develop() {
    #
    # Push the release commit to origin/develop and verify the remote ref.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_push_develop
    #
    local develop_push_status remote_develop

    _release_begin_step 'Push develop to origin'
    develop_push_status=0
    git push origin "$_RELEASE_DEVELOP_BRANCH" || develop_push_status=$?
    remote_develop="$(git ls-remote origin "refs/heads/${_RELEASE_DEVELOP_BRANCH}" | awk '{ print $1 }')"
    if [[ $remote_develop == "$_RELEASE_RELEASE_COMMIT" ]]; then
        _RELEASE_DEVELOP_PUSHED="verified at ${_RELEASE_RELEASE_COMMIT:0:12}"
    else
        _RELEASE_DEVELOP_PUSHED='not verified'
    fi
    if ((develop_push_status != 0)); then
        _release_stop "git push origin develop exited ${develop_push_status}" \
                      "origin: ${remote_develop:-unknown}; expected: ${_RELEASE_RELEASE_COMMIT}"
    fi
    if [[ $remote_develop != "$_RELEASE_RELEASE_COMMIT" ]]; then
        _release_stop 'origin/develop does not identify the release commit' \
                      "origin: ${remote_develop:-unknown}; expected: ${_RELEASE_RELEASE_COMMIT}"
    fi
    _release_pass "origin/develop identifies ${_RELEASE_RELEASE_COMMIT:0:12}"
}


_release_merge_into_master() {
    #
    # Merge develop into master with --no-ff and revalidate the merged tree.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_merge_into_master
    #
    local master_parent first_parent second_parent

    _release_begin_step 'Merge develop into master and revalidate'
    if ! git switch "$_RELEASE_MASTER_BRANCH"; then
        _release_stop 'unable to switch to master'
    fi
    if ! git pull --ff-only origin "$_RELEASE_MASTER_BRANCH"; then
        _release_stop 'master cannot fast-forward to origin/master'
    fi
    master_parent="$(git rev-parse HEAD)"
    if ! git merge --no-ff --no-edit "$_RELEASE_DEVELOP_BRANCH"; then
        _release_stop 'develop could not be merged into master'
    fi
    _RELEASE_MERGE_COMMIT="$(git rev-parse HEAD)"
    first_parent="$(git rev-parse --verify --quiet 'HEAD^1')"
    second_parent="$(git rev-parse --verify --quiet 'HEAD^2')"
    if [[ $first_parent != "$master_parent" || $second_parent != "$_RELEASE_RELEASE_COMMIT" ]]; then
        _release_stop 'the merge parents do not identify master and the release commit'
    fi
    if ! git diff --quiet "$_RELEASE_RELEASE_COMMIT" HEAD; then
        _release_stop 'the master merge tree differs from the reviewed release tree' \
                      "$(git diff --name-only "$_RELEASE_RELEASE_COMMIT" HEAD)"
    fi
    if [[ -n $(git status --porcelain) ]]; then
        _release_stop 'the master worktree is not clean after the merge' "$(git status --short)"
    fi
    _release_apply_command 'rechecking the frozen lockfile on master' \
                           pnpm install --frozen-lockfile --ignore-scripts
    _release_apply_command 'rerunning pnpm check on master' pnpm check
    _release_apply_command 'repacking the master tree' pnpm pack --dry-run
    _release_pass "tested master merge: ${_RELEASE_MERGE_COMMIT:0:12}"
}


_release_tag_master() {
    #
    # Tag the tested master merge after reverifying its version and state.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_tag_master
    #
    local master_version tagged_commit

    _release_begin_step 'Tag the tested master commit'
    if ! _release_capture 'reading the package version on master' pnpm pkg get version; then
        _release_stop 'unable to read the package version on master' \
                      "$(tail -n 10 "$_RELEASE_LOG_FILE")"
    fi
    master_version="$(tr -d '"\r\n' <"$_RELEASE_LOG_FILE")"
    if [[ $master_version != "$_RELEASE_TARGET_VERSION" ]]; then
        _release_stop 'master package version changed unexpectedly' \
                      "found: ${master_version}; expected: ${_RELEASE_TARGET_VERSION}"
    fi
    if [[ -n $(git status --porcelain) || $(git rev-parse HEAD) != "$_RELEASE_MERGE_COMMIT" ]]; then
        _release_stop 'master moved or became dirty before tagging'
    fi
    if ! git tag "$_RELEASE_TARGET_TAG"; then
        _release_stop "unable to create tag ${_RELEASE_TARGET_TAG}"
    fi
    tagged_commit="$(git rev-parse "refs/tags/${_RELEASE_TARGET_TAG}^{commit}")"
    if [[ $tagged_commit != "$_RELEASE_MERGE_COMMIT" ]]; then
        _release_stop "${_RELEASE_TARGET_TAG} does not identify the tested merge commit"
    fi
    _release_pass "${_RELEASE_TARGET_TAG} identifies ${_RELEASE_MERGE_COMMIT:0:12}"
}


_release_push_master_and_tag() {
    #
    # Push master and only the target tag in one atomic update, then verify
    # both remote refs.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_push_master_and_tag
    #
    local release_push_status remote_refs matching_refs

    _release_begin_step 'Push master and the tag atomically'
    release_push_status=0
    git push --atomic origin "$_RELEASE_MASTER_BRANCH" \
             "refs/tags/${_RELEASE_TARGET_TAG}" || release_push_status=$?
    remote_refs="$(git ls-remote origin \
                        "refs/heads/${_RELEASE_MASTER_BRANCH}" \
                        "refs/tags/${_RELEASE_TARGET_TAG}")"
    matching_refs="$(grep -c "^${_RELEASE_MERGE_COMMIT}" <<< "$remote_refs")"
    if ((matching_refs == 2)); then
        _RELEASE_TAG_PUSHED="verified at ${_RELEASE_MERGE_COMMIT:0:12}"
    else
        _RELEASE_TAG_PUSHED='not verified'
    fi
    if ((release_push_status != 0)); then
        _release_stop "atomic master and tag push exited ${release_push_status}; npm was not published" \
                      "$remote_refs"
    fi
    if ((matching_refs != 2)); then
        _release_stop 'origin master or tag does not identify the tested merge commit' "$remote_refs"
    fi
    _release_pass "origin master and ${_RELEASE_TARGET_TAG} identify ${_RELEASE_MERGE_COMMIT:0:12}"
    _release_info 'the tag push started the Publish GitHub release workflow'
}


_release_publish_to_npm() {
    #
    # Publish the tagged tree and confirm the registry serves the version.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_publish_to_npm
    #
    local publish_status published attempt

    _release_begin_step 'Publish the tagged tree to npm'
    publish_status=0
    pnpm publish --no-git-checks --access public \
                 --registry="$_RELEASE_NPM_REGISTRY" || publish_status=$?
    published=false
    for attempt in 1 2 3; do
        if _release_capture "verifying npm publication (attempt ${attempt})" \
                            pnpm view "${_RELEASE_PACKAGE_NAME}@${_RELEASE_TARGET_VERSION}" version \
                                 --registry="$_RELEASE_NPM_REGISTRY" &&
           [[ $(tr -d '"\r\n' <"$_RELEASE_LOG_FILE") == "$_RELEASE_TARGET_VERSION" ]]; then
            published=true
            break
        fi
        ((attempt < 3)) && sleep 5 # allow for registry propagation
    done

    if ((publish_status != 0)); then
        if [[ $published == true ]]; then
            _RELEASE_NPM_STATE="published ${_RELEASE_TARGET_VERSION}, but pnpm publish exited ${publish_status}"
        else
            _RELEASE_NPM_STATE="unknown after pnpm publish exited ${publish_status}"
        fi
        _release_stop 'npm publish failed after the tag was pushed; this is a partial release'
    fi
    if [[ $published != true ]]; then
        _RELEASE_NPM_STATE='publish command succeeded, registry verification pending'
        _release_stop 'npm did not report the published version; this is a partial release' \
                      "$(tail -n 10 "$_RELEASE_LOG_FILE")"
    fi
    _RELEASE_NPM_STATE="published ${_RELEASE_TARGET_VERSION}"
    _release_pass "npm publishes ${_RELEASE_PACKAGE_NAME}@${_RELEASE_TARGET_VERSION}"
}


_release_return_to_develop() {
    #
    # Switch back to develop and verify it is clean at the release commit.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_return_to_develop
    #
    _release_begin_step 'Return to develop'
    if ! git switch "$_RELEASE_DEVELOP_BRANCH"; then
        _release_stop 'unable to return to develop'
    fi
    if [[ -n $(git status --porcelain) ]]; then
        _release_stop 'develop is not clean after the release' "$(git status --short)"
    fi
    if [[ $(git rev-parse HEAD) != "$_RELEASE_RELEASE_COMMIT" ]]; then
        _release_stop 'develop no longer identifies the release commit'
    fi
    _release_pass "develop is clean at ${_RELEASE_RELEASE_COMMIT:0:12}"
}


_release_report_success() {
    #
    # Print the completed release with its npm and GitHub locations.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _release_report_success
    #
    gum style --border double --border-foreground 42 --foreground 42 \
              --padding '0 2' --margin '1 0' -- \
              "Released ${_RELEASE_PACKAGE_NAME} ${_RELEASE_TARGET_TAG}" \
              "npm:    https://www.npmjs.com/package/${_RELEASE_PACKAGE_NAME}/v/${_RELEASE_TARGET_VERSION}" \
              "GitHub: https://github.com/${_RELEASE_GITHUB_REPOSITORY}/releases/tag/${_RELEASE_TARGET_TAG}"
}


### Output and shared helpers

_release_pass() {
    #
    # Print a satisfied check or completed action.
    #
    # Parameters:
    #   $1 - message - description of what succeeded.
    #
    # Example:
    #   _release_pass 'npm credentials are valid'
    #
    local message="$1"

    printf '%s%s\n' "$(gum style --foreground 42 '✅ ')" "$message"
}


_release_info() {
    #
    # Print a neutral status line.
    #
    # Parameters:
    #   $1 - message - status to report.
    #
    # Example:
    #   _release_info 'nothing was published'
    #
    local message="$1"

    printf '%s %s\n' "$(gum style --foreground 244 '•')" "$message"
}


_release_detail() {
    #
    # Print captured command output as indented, dimmed lines.
    #
    # Parameters:
    #   $1 - detail - multi-line output to print.
    #
    # Example:
    #   _release_detail "$(tail -n 20 "$_RELEASE_LOG_FILE")"
    #
    local detail="$1"
    local lines=()
    local line_index

    [[ -n $detail ]] || return 0
    mapfile -t lines <<< "$detail"
    for line_index in "${!lines[@]}"; do
        lines[line_index]="-> ${lines[line_index]}"
    done
    gum style --faint --margin '0 0 0 2' -- "${lines[@]}"
}


_release_fail() {
    #
    # Print a failed check or release action.
    #
    # Parameters:
    #   $1 - message - description of the failure.
    #   $2 - detail - (optional) - supporting output.
    #
    # Example:
    #   _release_fail 'pnpm check failed' "$(tail -n 20 "$_RELEASE_LOG_FILE")"
    #
    local message="$1"
    local detail="${2-}"

    printf '%s %s\n' "$(gum style --foreground 196 '✘')" "$message"
    _release_detail "$detail"
}


_release_heading() {
    #
    # Print a framed phase heading.
    #
    # Parameters:
    #   $1 - title - phase name.
    #
    # Example:
    #   _release_heading 'Sanity checks'
    #
    local title="$1"

    gum style --border rounded --border-foreground 212 --foreground 212 \
              --padding '0 2' --margin '1 0 0 0' -- "$title"
}


_release_block() {
    #
    # Record and print a sanity-check blocker without skipping later checks.
    #
    # Parameters:
    #   $1 - message - concise blocker description.
    #   $2 - detail - (optional) - evidence for the blocker.
    #
    # Example:
    #   _release_block 'develop is behind origin/develop'
    #
    local message="$1"
    local detail="${2-}"

    _RELEASE_BLOCKERS+=("$message")
    _release_fail "$message" "$detail"
}


_release_capture() {
    #
    # Run a non-interactive command behind a spinner and capture its output.
    #
    # Parameters:
    #   $1 - title - spinner title.
    #   $2... - command and arguments to run.
    #
    # Example:
    #   _release_capture 'reading npm' pnpm view package version
    #
    local title="$1"
    shift

    # The inner script receives the log path as $0 and must stay unexpanded
    # shellcheck disable=SC2016
    gum spin --spinner minidot --title "$title" -- \
             bash -c 'exec "$@" >"$0" 2>&1' "$_RELEASE_LOG_FILE" "$@"
}


_release_apply_command() {
    #
    # Run one non-interactive release command and stop on failure.
    #
    # Parameters:
    #   $1 - title - command description.
    #   $2... - command and arguments to run.
    #
    # Example:
    #   _release_apply_command 'running checks' pnpm check
    #
    local title="$1"
    shift

    if _release_capture "$title" "$@"; then
        _release_pass "$title"
        return 0
    fi

    _release_stop "$title failed" "$(tail -n 20 "$_RELEASE_LOG_FILE")"
}


_release_package_value() {
    #
    # Read a dot-separated field path from package.json.
    #
    # Keys must not contain dots, which holds for every field read here.
    #
    # Parameters:
    #   $1 - field_path - field path such as 'version'.
    #
    # Example:
    #   version="$(_release_package_value 'version')"
    #
    local field_path="$1"

    node -e '
        const fs = require("node:fs");
        const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
        const value = process.argv[1]
            .split(".")
            .reduce((current, key) => current?.[key], packageJson);
        process.stdout.write(value === undefined ? "" : String(value));
    ' "$field_path"
}


_release_is_allowed_path() {
    #
    # Determine whether a changed path may belong to the release commit.
    #
    # Parameters:
    #   $1 - path - repository-relative path.
    #
    # Example:
    #   _release_is_allowed_path 'CHANGELOG.md'
    #
    local path="$1"
    local allowed_path

    for allowed_path in "${_RELEASE_ALLOWED_PATHS[@]}"; do
        [[ $path == "$allowed_path" ]] && return 0
    done

    # reviewed image captures are optional release files
    [[ $path == doc/images/* ]] && return 0
    return 1
}


_release_begin_step() {
    #
    # Print the next numbered release-step heading.
    #
    # Parameters:
    #   $1 - title - action about to run.
    #
    # Example:
    #   _release_begin_step 'Validate the release tree'
    #
    local title="$1"

    _RELEASE_STEP_NUMBER=$((_RELEASE_STEP_NUMBER + 1))
    printf '\n%s %s\n' \
           "$(gum style --bold --foreground 212 "[${_RELEASE_STEP_NUMBER}/8]")" "$title"
}


_release_stop() {
    #
    # Report a failed release checkpoint and exit without destructive cleanup.
    #
    # Parameters:
    #   $1 - message - failed checkpoint description.
    #   $2 - detail - (optional) - supporting output.
    #
    # Example:
    #   _release_stop 'atomic push failed'
    #
    local message="$1"
    local detail="${2-}"
    local branch head tag_target

    _release_fail "$message" "$detail"
    branch="$(git branch --show-current 2>/dev/null)"
    head="$(git rev-parse --short HEAD 2>/dev/null)"
    tag_target="$(git rev-parse --short "refs/tags/${_RELEASE_TARGET_TAG}" 2>/dev/null)"

    _release_heading 'Release stopped'
    _release_info "branch: ${branch:-detached}, head: ${head:-unknown}"
    _release_info "develop push: ${_RELEASE_DEVELOP_PUSHED}"
    _release_info "master and ${_RELEASE_TARGET_TAG} push: ${_RELEASE_TAG_PUSHED}"
    _release_info "npm: ${_RELEASE_NPM_STATE}"
    _release_info "local ${_RELEASE_TARGET_TAG}: ${tag_target:-absent}"
    _release_info 'no later step ran; inspect this state before retrying'
    exit 1
}


main "$@"
