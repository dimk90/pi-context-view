#!/bin/bash

set -uo pipefail

readonly EXPECTED_PACKAGE_NAME='pi-context-view'
readonly EXPECTED_GITHUB_REPOSITORY='dimk90/pi-context-view'
readonly EXPECTED_REGISTRY='https://registry.npmjs.org/'

PASSES=()
BLOCKERS=()
TMP_DIR=''


## Reporting

record_pass() {
    #
    # Record and print a successful preflight check.
    #
    # Parameters:
    #   $1 - message - description of the successful check.
    #
    # Example:
    #   record_pass 'develop matches origin/develop'
    #
    local message="$1"

    PASSES+=("$message")
    printf 'PASS     %s\n' "$message"
}


record_blocker() {
    #
    # Record and print a release blocker without terminating later checks.
    #
    # Parameters:
    #   $1 - message - concise blocker description.
    #   $2 - detail - (optional) - relevant command output.
    #
    # Example:
    #   record_blocker 'npm authentication failed' "$command_output"
    #
    local message="$1"
    local detail="${2-}"

    BLOCKERS+=("$message")
    printf 'BLOCKER  %s\n' "$message"
    if [[ -n $detail ]]; then
        while IFS= read -r detail_line; do
            printf '         %s\n' "$detail_line"
        done <<< "$detail"
    fi
}


print_usage() {
    #
    # Print the supported invocation.
    #
    # Example:
    #   print_usage
    #
    printf 'Usage: %s X.Y.Z\n' "$0"
    printf 'Runs release-readiness checks only; it performs no release writes.\n'
}


## Check helpers

require_command() {
    #
    # Verify that a required executable is available.
    #
    # Parameters:
    #   $1 - command_name - executable to locate on PATH.
    #
    # Example:
    #   require_command 'git' || have_git=false
    #
    local command_name="$1"

    if command -v "$command_name" >/dev/null 2>&1; then
        record_pass "command is available: ${command_name}"
        return 0
    fi

    record_blocker "required command is unavailable: ${command_name}"
    return 1
}


run_quiet_check() {
    #
    # Run a command, recording its exit status and bounded failure output.
    #
    # Parameters:
    #   $1 - label - successful check description.
    #   $2... - command and arguments to execute.
    #
    # Example:
    #   run_quiet_check 'TypeScript and tests pass' pnpm check
    #
    local label="$1"
    shift
    local output_file="${TMP_DIR}/command-output"
    local detail

    if "$@" >"$output_file" 2>&1; then
        record_pass "$label"
        return 0
    fi

    detail="$(tail -n 30 "$output_file")"
    record_blocker "$label" "$detail"
    return 1
}


is_release_path() {
    #
    # Determine whether a path may belong to the reviewed release commit.
    #
    # Parameters:
    #   $1 - path - repository-relative path to classify.
    #
    # Example:
    #   is_release_path 'CHANGELOG.md'
    #
    local path="$1"

    case "$path" in
        CHANGELOG.md | doc/PLAN.md | package.json | pnpm-lock.yaml | README.md | doc/images/*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}


## Main

if [[ ${1-} == '--help' || ${1-} == '-h' ]]; then
    print_usage
    exit 0
fi

if (($# != 1)); then
    print_usage >&2
    exit 2
fi

readonly TARGET_VERSION="$1"
readonly TARGET_TAG="v${TARGET_VERSION}"

if [[ ! $TARGET_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'Target version must use stable X.Y.Z form: %s\n' "$TARGET_VERSION" >&2
    exit 2
fi

TMP_DIR="$(mktemp -d)" || {
    printf 'Unable to create a temporary directory.\n' >&2
    exit 1
}
readonly TMP_DIR
trap 'rm -rf "$TMP_DIR"' EXIT

printf 'Release preflight for %s (%s)\n\n' "$EXPECTED_PACKAGE_NAME" "$TARGET_TAG"

have_git=true
have_node=true
have_pnpm=true
have_npm=true
have_pi=true
have_curl=true
have_gh=true

require_command 'git'  || have_git=false
require_command 'node' || have_node=false
require_command 'pnpm' || have_pnpm=false
require_command 'npm'  || have_npm=false
require_command 'pi'   || have_pi=false
require_command 'curl' || have_curl=false
require_command 'gh'   || have_gh=false

if [[ $have_git != true ]]; then
    printf '\nFAILED: %d blocker(s), %d passed check(s).\n' "${#BLOCKERS[@]}" "${#PASSES[@]}"
    exit 1
fi

repository_root="$(git rev-parse --show-toplevel 2>"${TMP_DIR}/git-root-error")"
if [[ -z $repository_root ]]; then
    record_blocker 'current directory is not inside a Git repository' "$(<"${TMP_DIR}/git-root-error")"
    printf '\nFAILED: %d blocker(s), %d passed check(s).\n' "${#BLOCKERS[@]}" "${#PASSES[@]}"
    exit 1
fi
cd "$repository_root" || {
    record_blocker "cannot enter repository root: ${repository_root}"
    printf '\nFAILED: %d blocker(s), %d passed check(s).\n' "${#BLOCKERS[@]}" "${#PASSES[@]}"
    exit 1
}
record_pass "repository root resolved: ${repository_root}"

for required_file in AGENTS.md CHANGELOG.md doc/PLAN.md doc/RELEASE.md README.md package.json pnpm-lock.yaml; do
    if [[ -f $required_file ]]; then
        record_pass "required release file exists: ${required_file}"
    else
        record_blocker "required release file is missing: ${required_file}"
    fi
done

origin_url="$(git remote get-url origin 2>"${TMP_DIR}/origin-error")"
if [[ $origin_url =~ github\.com[:/]dimk90/pi-context-view(\.git)?$ ]]; then
    record_pass "origin identifies ${EXPECTED_GITHUB_REPOSITORY}"
else
    record_blocker 'origin does not identify the expected GitHub repository' "${origin_url:-$(<"${TMP_DIR}/origin-error")}"
fi

run_quiet_check 'origin branches and tags fetched successfully' \
    git fetch --quiet --prune --tags origin

current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ $current_branch == 'develop' ]]; then
    record_pass 'current branch is develop'
else
    record_blocker 'release must start on develop' "current branch: ${current_branch:-detached HEAD}"
fi

absolute_git_dir="$(git rev-parse --absolute-git-dir)"
operation_in_progress=false
for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
    if [[ -e ${absolute_git_dir}/${marker} ]]; then
        record_blocker "Git operation is in progress: ${marker}"
        operation_in_progress=true
    fi
done
for marker in rebase-apply rebase-merge; do
    if [[ -d ${absolute_git_dir}/${marker} ]]; then
        record_blocker "Git operation is in progress: ${marker}"
        operation_in_progress=true
    fi
done
if [[ $operation_in_progress == false ]]; then
    record_pass 'no merge, rebase, cherry-pick, revert, or bisect is in progress'
fi

if git diff --cached --quiet; then
    record_pass 'index contains no pre-existing staged changes'
else
    record_blocker 'index contains pre-existing staged changes'
fi

candidate_paths=()
unexpected_paths=()
if git diff --name-only -z >"${TMP_DIR}/tracked-paths"; then
    while IFS= read -r -d '' path; do
        candidate_paths+=("$path")
        is_release_path "$path" || unexpected_paths+=("$path")
    done <"${TMP_DIR}/tracked-paths"
else
    record_blocker 'unable to enumerate modified tracked files'
fi
if git ls-files --others --exclude-standard -z >"${TMP_DIR}/untracked-paths"; then
    while IFS= read -r -d '' path; do
        candidate_paths+=("$path")
        is_release_path "$path" || unexpected_paths+=("$path")
    done <"${TMP_DIR}/untracked-paths"
else
    record_blocker 'unable to enumerate untracked files'
fi

if ((${#candidate_paths[@]} == 0)); then
    record_blocker 'release candidate has no uncommitted release files'
else
    record_pass "release candidate contains ${#candidate_paths[@]} changed path(s)"
fi
if ((${#unexpected_paths[@]} == 0)); then
    record_pass 'all changed paths are allowed release paths'
else
    record_blocker 'worktree contains paths outside the release allowlist' "$(printf '%s\n' "${unexpected_paths[@]}")"
fi

if git diff --quiet -- CHANGELOG.md; then
    record_blocker 'CHANGELOG.md is not part of the uncommitted release candidate'
else
    record_pass 'CHANGELOG.md is part of the release candidate'
fi
if git diff --quiet -- package.json; then
    record_blocker 'package.json is not part of the uncommitted release candidate'
else
    record_pass 'package.json is part of the release candidate'
fi

if git rev-parse --verify refs/remotes/origin/develop >/dev/null 2>&1 &&
   [[ $(git rev-parse HEAD) == "$(git rev-parse refs/remotes/origin/develop)" ]]; then
    record_pass 'develop HEAD exactly matches origin/develop before the release commit'
else
    record_blocker 'develop HEAD does not exactly match origin/develop'
fi

master_merge_base="$(git merge-base refs/remotes/origin/master HEAD 2>/dev/null || true)"
if [[ -n $master_merge_base ]] &&
   git diff --quiet "$master_merge_base" refs/remotes/origin/master; then
    record_pass 'origin/master has no tree changes absent from develop'
else
    record_blocker 'origin/master contains tree changes absent from develop'
fi

if git rev-parse --verify refs/heads/master >/dev/null 2>&1 &&
   git merge-base --is-ancestor refs/heads/master refs/remotes/origin/master; then
    record_pass 'local master can fast-forward to origin/master'
else
    record_blocker 'local master is missing, ahead of, or diverged from origin/master'
fi

if git show-ref --verify --quiet "refs/tags/${TARGET_TAG}"; then
    record_blocker "local tag already exists: ${TARGET_TAG}"
else
    record_pass "local tag is absent: ${TARGET_TAG}"
fi

git ls-remote --exit-code --tags origin "refs/tags/${TARGET_TAG}" >"${TMP_DIR}/remote-tag" 2>&1
remote_tag_status=$?
case "$remote_tag_status" in
    0) record_blocker "remote tag already exists: ${TARGET_TAG}" "$(<"${TMP_DIR}/remote-tag")" ;;
    2) record_pass "remote tag is absent: ${TARGET_TAG}" ;;
    *) record_blocker "unable to verify remote tag absence: ${TARGET_TAG}" "$(<"${TMP_DIR}/remote-tag")" ;;
esac

baseline_package_version=''
: >"${TMP_DIR}/head-package-error"
: >"${TMP_DIR}/master-package-error"
if [[ $have_node == true ]] &&
   git show HEAD:package.json >"${TMP_DIR}/head-package.json" 2>"${TMP_DIR}/head-package-error" &&
   git show refs/remotes/origin/master:package.json >"${TMP_DIR}/master-package.json" 2>"${TMP_DIR}/master-package-error"; then
    baseline_package_version="$(node -p "JSON.parse(require('fs').readFileSync('${TMP_DIR}/head-package.json', 'utf8')).version")"
    master_package_version="$(node -p "JSON.parse(require('fs').readFileSync('${TMP_DIR}/master-package.json', 'utf8')).version")"
    if [[ $baseline_package_version == "$master_package_version" ]]; then
        record_pass "develop baseline and origin/master package version agree: ${baseline_package_version}"
    else
        record_blocker 'develop baseline and origin/master package versions differ' \
            "develop baseline: ${baseline_package_version}; origin/master: ${master_package_version}"
    fi

    previous_tag="v${baseline_package_version}"
    if git rev-parse --verify "refs/tags/${previous_tag}^{commit}" >/dev/null 2>&1 &&
       [[ $(git rev-parse "refs/tags/${previous_tag}^{commit}") == "$(git rev-parse refs/remotes/origin/master)" ]]; then
        record_pass "previous release tag identifies origin/master: ${previous_tag}"
    else
        record_blocker "previous release tag does not identify origin/master: ${previous_tag}"
    fi
else
    record_blocker 'unable to compare develop and master package baselines' \
        "$(<"${TMP_DIR}/head-package-error")$(<"${TMP_DIR}/master-package-error")"
fi

pi_version=''
if [[ $have_pi == true ]]; then
    pi_version="$(pi --version 2>"${TMP_DIR}/pi-version-error" | tr -d '\r\n')"
    pi_version="${pi_version#v}"
    if [[ $pi_version =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
        record_pass "local Pi version resolved: ${pi_version}"
    else
        record_blocker 'unable to resolve a valid local Pi version' "${pi_version:-$(<"${TMP_DIR}/pi-version-error")}"
        pi_version='INVALID'
    fi
fi

if [[ $have_node == true && -f package.json && -f CHANGELOG.md && -f doc/PLAN.md && -f README.md ]]; then
    if node - "$TARGET_VERSION" "$pi_version" >"${TMP_DIR}/metadata-check" 2>&1 <<'NODE'
const fs = require('node:fs');

const version = process.argv[2];
const piVersion = process.argv[3];
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const plan = fs.readFileSync('doc/PLAN.md', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');
const errors = [];

const expectedHeading = `## \`[v${version}]\` - Unreleased`;
const headingCount = changelog.split(expectedHeading).length - 1;
const unreleasedHeadings = changelog.match(/^## .* - Unreleased\s*$/gm) ?? [];
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const planHeading = new RegExp(`^## v${escapedVersion}\\s*$`, 'm');
const heroImage = readme.match(/<img\b[^>]*\bsrc="([^"]+)"/i)?.[1];

if (packageJson.name !== 'pi-context-view') errors.push(`package name is ${packageJson.name}`);
if (packageJson.version !== version) errors.push(`package version is ${packageJson.version}, expected ${version}`);
if (headingCount !== 1) errors.push(`expected one target Unreleased heading, found ${headingCount}`);
if (unreleasedHeadings.length !== 1) errors.push(`expected one total Unreleased heading, found ${unreleasedHeadings.length}`);
if (planHeading.test(plan)) errors.push(`doc/PLAN.md still contains a v${version} section`);
if (packageJson.peerDependencies?.['@earendil-works/pi-coding-agent'] !== '*') errors.push('pi-coding-agent peer dependency is not *');
if (packageJson.peerDependencies?.['@earendil-works/pi-tui'] !== '*') errors.push('pi-tui peer dependency is not *');
if (packageJson.devDependencies?.['@earendil-works/pi-coding-agent'] !== piVersion) errors.push('pi-coding-agent development pin does not match local Pi');
if (packageJson.devDependencies?.['@earendil-works/pi-tui'] !== piVersion) errors.push('pi-tui development pin does not match local Pi');
if (!Array.isArray(packageJson.pi?.extensions) || !packageJson.pi.extensions.includes('./src/index.ts')) errors.push('pi.extensions does not include ./src/index.ts');
if (!packageJson.pi?.image?.startsWith('https://')) errors.push('pi.image is not an absolute HTTPS URL');
if (heroImage !== packageJson.pi?.image) errors.push('README hero image and package pi.image differ');
if (packageJson.repository?.url !== 'git+https://github.com/dimk90/pi-context-view.git') errors.push('package repository URL is unexpected');

if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
}
NODE
    then
        record_pass 'package, changelog, plan, image, and Pi-pin invariants hold'
    else
        record_blocker 'release metadata invariants failed' "$(<"${TMP_DIR}/metadata-check")"
    fi
fi

if [[ $have_pnpm == true ]]; then
    configured_registry="$(pnpm config get registry 2>"${TMP_DIR}/registry-error")"
    if [[ $configured_registry == "$EXPECTED_REGISTRY" ]]; then
        record_pass "pnpm registry is ${EXPECTED_REGISTRY}"
    else
        record_blocker 'pnpm registry is not the expected public registry' "${configured_registry:-$(<"${TMP_DIR}/registry-error")}"
    fi

    npm_user="$(pnpm whoami --registry="$EXPECTED_REGISTRY" 2>"${TMP_DIR}/npm-whoami-error")"
    npm_whoami_status=$?
    if ((npm_whoami_status == 0)) && [[ -n $npm_user ]]; then
        record_pass "npm authentication is valid for account: ${npm_user}"
    else
        record_blocker 'npm authentication failed' "$(<"${TMP_DIR}/npm-whoami-error")"
        npm_user=''
    fi

    if pnpm view "$EXPECTED_PACKAGE_NAME" name --json --registry="$EXPECTED_REGISTRY" >"${TMP_DIR}/npm-package" 2>&1; then
        record_pass "npm package is readable: ${EXPECTED_PACKAGE_NAME}"
    else
        record_blocker "npm package is not readable: ${EXPECTED_PACKAGE_NAME}" "$(<"${TMP_DIR}/npm-package")"
    fi

    if pnpm view "${EXPECTED_PACKAGE_NAME}@${TARGET_VERSION}" version --json --registry="$EXPECTED_REGISTRY" >"${TMP_DIR}/npm-target" 2>&1; then
        record_blocker "npm version already exists: ${EXPECTED_PACKAGE_NAME}@${TARGET_VERSION}" "$(<"${TMP_DIR}/npm-target")"
    elif grep -Eq 'ERR_PNPM_PACKAGE_NOT_FOUND|No matching version|E404' "${TMP_DIR}/npm-target"; then
        record_pass "npm version is available: ${EXPECTED_PACKAGE_NAME}@${TARGET_VERSION}"
    else
        record_blocker "unable to prove npm version absence: ${EXPECTED_PACKAGE_NAME}@${TARGET_VERSION}" "$(<"${TMP_DIR}/npm-target")"
    fi

    if pnpm view "$EXPECTED_PACKAGE_NAME" versions --json --registry="$EXPECTED_REGISTRY" >"${TMP_DIR}/npm-versions" 2>&1; then
        if RELEASE_TARGET_VERSION="$TARGET_VERSION" \
           RELEASE_VERSIONS_FILE="${TMP_DIR}/npm-versions" \
           node >"${TMP_DIR}/version-order" 2>&1 <<'NODE'
const fs = require('node:fs');

const target = process.env.RELEASE_TARGET_VERSION.split('.').map(Number);
const rawVersions = JSON.parse(fs.readFileSync(process.env.RELEASE_VERSIONS_FILE, 'utf8'));
const versions = (Array.isArray(rawVersions) ? rawVersions : [rawVersions])
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
    .map((version) => version.split('.').map(Number));

/** Compare two stable semantic-version tuples numerically. */
const compare = (left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
const maximum = versions.sort(compare).at(-1);

if (!maximum) {
    console.error('package has no published stable version');
    process.exit(1);
}
if (compare(target, maximum) <= 0) {
    console.error(`target is not newer than latest stable ${maximum.join('.')}`);
    process.exit(1);
}
console.log(maximum.join('.'));
NODE
        then
            latest_stable_version="$(<"${TMP_DIR}/version-order")"
            record_pass "target is newer than latest published stable: ${latest_stable_version}"
            if [[ -n $baseline_package_version && $baseline_package_version == "$latest_stable_version" ]]; then
                record_pass 'develop/master baseline matches the latest published stable version'
            else
                record_blocker 'repository baseline does not match the latest published stable version' \
                    "repository: ${baseline_package_version:-unknown}; npm: ${latest_stable_version}"
            fi
        else
            record_blocker 'target version ordering is invalid' "$(<"${TMP_DIR}/version-order")"
        fi
    else
        record_blocker 'unable to list published npm versions' "$(<"${TMP_DIR}/npm-versions")"
    fi
fi

if [[ $have_npm == true && -n ${npm_user-} ]]; then
    if npm owner ls "$EXPECTED_PACKAGE_NAME" --registry="$EXPECTED_REGISTRY" >"${TMP_DIR}/npm-owners" 2>&1; then
        if awk '{print $1}' "${TMP_DIR}/npm-owners" | grep -Fxq "$npm_user"; then
            record_pass "npm account is a package owner: ${npm_user}"
        else
            record_blocker "npm account is not listed as a package owner: ${npm_user}" "$(<"${TMP_DIR}/npm-owners")"
        fi
    else
        record_blocker 'unable to verify npm package ownership' "$(<"${TMP_DIR}/npm-owners")"
    fi
fi

if [[ $have_gh == true ]]; then
    run_quiet_check 'GitHub CLI authentication is valid' gh auth status --hostname github.com

    if gh repo view "$EXPECTED_GITHUB_REPOSITORY" --json nameWithOwner,viewerPermission >"${TMP_DIR}/github-repository" 2>&1; then
        if REPOSITORY_JSON="$(<"${TMP_DIR}/github-repository")" node >"${TMP_DIR}/github-permission" 2>&1 <<'NODE'
const repository = JSON.parse(process.env.REPOSITORY_JSON);
const writePermissions = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

if (repository.nameWithOwner !== 'dimk90/pi-context-view') {
    console.error(`unexpected repository: ${repository.nameWithOwner}`);
    process.exit(1);
}
if (!writePermissions.has(repository.viewerPermission)) {
    console.error(`insufficient permission: ${repository.viewerPermission}`);
    process.exit(1);
}
NODE
        then
            record_pass "GitHub account has write access to ${EXPECTED_GITHUB_REPOSITORY}"
        else
            record_blocker 'GitHub repository permission is insufficient' "$(<"${TMP_DIR}/github-permission")"
        fi
    else
        record_blocker 'unable to inspect the GitHub repository' "$(<"${TMP_DIR}/github-repository")"
    fi
fi

if [[ $have_node == true && -f README.md && -f package.json ]]; then
    if node >"${TMP_DIR}/image-urls" 2>"${TMP_DIR}/image-extraction-error" <<'NODE'
const fs = require('node:fs');

const readme = fs.readFileSync('README.md', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const urls = new Set(readme.match(/https:\/\/media\.githubusercontent\.com\/media\/[^)"'\s>]+/g) ?? []);
if (packageJson.pi?.image) urls.add(packageJson.pi.image);
for (const url of urls) console.log(url);
NODE
    then
        image_count=0
        while IFS= read -r image_url; do
            [[ -n $image_url ]] || continue
            ((image_count += 1))
            if [[ $image_url =~ ^https://media\.githubusercontent\.com/media/([^/]+)/([^/]+)/([0-9a-f]{40})/(.+)$ ]]; then
                image_owner="${BASH_REMATCH[1]}"
                image_repository="${BASH_REMATCH[2]}"
                image_revision="${BASH_REMATCH[3]}"
                image_path="${BASH_REMATCH[4]}"
                if [[ ${image_owner}/${image_repository} != "$EXPECTED_GITHUB_REPOSITORY" ]]; then
                    record_blocker 'image URL references an unexpected repository' "$image_url"
                    continue
                fi
                if git cat-file -e "${image_revision}^{commit}" 2>/dev/null &&
                   git cat-file -e "${image_revision}:${image_path}" 2>/dev/null; then
                    record_pass "immutable image revision and path exist: ${image_path}"
                else
                    record_blocker 'image revision or path is absent from Git history' "$image_url"
                fi
                if [[ $have_curl == true ]]; then
                    if curl --fail --location --silent --show-error --head --max-time 30 "$image_url" >/dev/null 2>"${TMP_DIR}/image-curl-error" ||
                       curl --fail --location --silent --show-error --range 0-0 --max-time 30 --output /dev/null "$image_url" 2>"${TMP_DIR}/image-curl-error"; then
                        record_pass "image URL resolves: ${image_path}"
                    else
                        record_blocker 'image URL does not resolve' "${image_url}\n$(<"${TMP_DIR}/image-curl-error")"
                    fi
                fi
            else
                record_blocker 'image URL is not pinned to a 40-character immutable revision' "$image_url"
            fi
        done <"${TMP_DIR}/image-urls"
        if ((image_count > 0)); then
            record_pass "found ${image_count} unique immutable image URL(s)"
        else
            record_blocker 'no GitHub media image URLs were found'
        fi
    else
        record_blocker 'unable to extract image URLs' "$(<"${TMP_DIR}/image-extraction-error")"
    fi
fi

run_quiet_check 'candidate diff has no whitespace errors' git diff --check
if [[ $have_pnpm == true ]]; then
    run_quiet_check 'frozen lockfile installation succeeds' \
        pnpm install --frozen-lockfile --ignore-scripts
    run_quiet_check 'TypeScript checks and tests pass' pnpm check

    if pnpm pack --dry-run >"${TMP_DIR}/pack-dry-run" 2>&1; then
        record_pass 'package dry run succeeds'
        printf '\nPackage dry-run manifest (review required):\n'
        while IFS= read -r manifest_line; do
            printf '  %s\n' "$manifest_line"
        done <"${TMP_DIR}/pack-dry-run"
    else
        record_blocker 'package dry run failed' "$(tail -n 30 "${TMP_DIR}/pack-dry-run")"
    fi
fi

printf '\nCandidate paths (review required):\n'
if ((${#candidate_paths[@]} > 0)); then
    printf '  %s\n' "${candidate_paths[@]}"
else
    printf '  (none)\n'
fi

printf '\nSummary: %d passed check(s), %d blocker(s).\n' "${#PASSES[@]}" "${#BLOCKERS[@]}"
if ((${#BLOCKERS[@]} > 0)); then
    printf 'FAILED: stop before approval; no release write was performed.\n'
    exit 1
fi

printf 'READY: mechanical preflight passed. Complete semantic review before approval.\n'
