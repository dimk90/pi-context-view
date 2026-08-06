---
name: release-pi-extension
description: Safely release pi-context-view from develop to npm and GitHub. Use whenever the user asks to release, publish, tag, cut, or resume a version of this Pi extension. Enforces a blocker-first preflight, explicit approval of exact actions, exact-tree validation, push-before-publish ordering, and partial-failure reporting without force or destructive recovery.
compatibility: Requires Bash, git, Node.js, pnpm, Pi, curl, and authenticated npm and GitHub CLI (gh) access. Assumes the pi-context-view repository, develop/master branches, GitHub origin, and the public npm registry.
allowed-tools: Read Edit Write Bash(bash .agents/skills/release-pi-extension/scripts/preflight.sh:*) Bash(date:*) Bash(git status:*) Bash(git fetch:*) Bash(git diff:*) Bash(git log:*) Bash(git rev-parse:*) Bash(git merge-base:*) Bash(git ls-remote:*) Bash(git switch:*) Bash(git pull:*) Bash(git merge:*) Bash(git tag:*) Bash(git add:*) Bash(git commit:*) Bash(git push:*) Bash(pi --version:*) Bash(pnpm whoami:*) Bash(pnpm view:*) Bash(pnpm install:*) Bash(pnpm check:*) Bash(pnpm pack:*) Bash(pnpm pkg get:*) Bash(pnpm publish:*) Bash(gh auth status:*) Bash(gh repo view:*) Bash(gh run:*) Bash(gh release view:*)
---

# Release Pi Extension

Treat a release as a checkpointed state machine. External publication is not
transactional: prevent avoidable failures, but never claim that network services
make a release literally failure-proof.

## Safety rules

- Read the repository `AGENTS.md` and
  [doc/RELEASE.md](../../../doc/RELEASE.md) completely before every release.
  The release document remains the source of truth; this skill adds gates.
- Require a stable target version in `X.Y.Z` form. Use an explicitly requested
  version. If omitted, derive it only when `package.json` and the sole
  `Unreleased` changelog heading agree; otherwise ask, never choose a bump.
- Before approval, perform checks only. `git fetch` and dependency installation
  may update remote refs or ignored `node_modules`, but do not edit tracked
  files, stage, commit, tag, push, publish, or create a release.
- Never display or inspect npm/GitHub token values, `.npmrc`, or credential
  payloads. Authentication commands may report account names only.
- Never use force, amend, reset, rebase, tag replacement, `git add .`,
  `git add -A`, `--no-verify`, npm unpublish, or destructive recovery.
  `pnpm publish --no-git-checks` is allowed only at its documented gate.
- Any failed command, unexpected output, state drift, or ambiguous partial
  release is a hard stop. Do not improvise, retry a write, or continue to a
  later checkpoint.
- After the tag push, GitHub Actions is an independent external writer. On a
  failure or timeout, inspect the workflow and release again before reporting;
  never assume that an in-flight release creation stopped with the local task.
- Approval applies only to the displayed version, date, candidate files,
  commit message, branches, tag, package, release notes, and action sequence.
  Any change invalidates it and requires a fresh preflight and approval.

## 1. Establish the candidate

From the repository root:

1. Resolve the target version and tag (`X.Y.Z` and `vX.Y.Z`).
2. Read `CHANGELOG.md`, `doc/PLAN.md`, `README.md`, and `package.json`.
3. Run the deterministic mechanical preflight:

   ```bash
   bash .agents/skills/release-pi-extension/scripts/preflight.sh X.Y.Z
   ```

4. Independently review the semantic checks that a script cannot decide:
   - compare commits since the latest release tag with the target changelog;
   - confirm release notes are complete, user-visible, and contain no roadmap
     promises or internal-only details;
   - confirm the completed target section is absent from `doc/PLAN.md` and only
     future work remains;
   - verify README commands, screenshots, descriptions, links, and package
     metadata describe the candidate exactly;
   - verify every README/package image points to the intended immutable commit,
     not merely to an existing URL;
   - inspect the full candidate diff and `pnpm pack --dry-run` manifest; reject
     unexpected, secret, generated, test, demo, or unrelated files;
   - inspect repository history for the exact release commit convention.

The candidate must already contain the reviewed release edits: target version,
`Unreleased` changelog section, completed-plan removal, current metadata, and
matching Pi development pins/lockfile. The only edit performed after approval
is replacing that exact `Unreleased` marker with the displayed release date.

### Blocker handling

If any check fails, stop before asking for approval. Report:

- target version and tag;
- every blocker with the failing command or evidence;
- checks that passed when useful;
- current branch, HEAD, and concise worktree status;
- confirmation that nothing was staged, committed, tagged, pushed, published,
  or released by this workflow.

Do not fix blockers as part of a release attempt. Wait for the user to fix them
or explicitly request a separate fix, then rerun the entire preflight.

If the target tag, npm version, or GitHub release already exists, classify the
state as an existing or partial release and stop. Resume only after the user
explicitly requests it and all existing artifacts are proven to identify the
same version and commit; execute only missing steps.

## 2. Present the approval gate

When every mechanical and semantic check passes, show:

- package, target version/tag, release date (`DD.MM.YYYY`), npm account and
  registry, GitHub repository, current develop HEAD, and current master HEAD;
- exact candidate file list and a concise diff summary;
- exact release commit message (`[doc] Release vX.Y.Z`);
- exact changelog-derived GitHub release notes;
- ordered actions and external effects:
  1. finalize the changelog date and validate the exact tree;
  2. commit and push `develop`;
  3. fast-forward local `master`, merge `develop` with `--no-ff`, and revalidate;
  4. tag the tested merge commit and atomically push `master` plus that tag,
     triggering the GitHub release workflow;
  5. verify the workflow-created GitHub release from the pushed tag;
  6. publish that exact tagged tree to npm;
  7. return to `develop` and verify npm, GitHub, refs, branch, and clean
     worktree.

Ask a required, explicit **Approve exact release** / **Cancel** question. Do not
accept silence, a prior general request to release, or approval for another
candidate as authorization.

Immediately before the first edit, verify branch, HEAD, candidate file list,
and status still match the approved snapshot. On drift, stop and rerun.

## 3. Apply the approved release

Record the expected develop commit, master commit, merge commit, and tag target
as each becomes available. Run one checkpoint at a time.

### A. Finalize and commit develop

1. Replace only the target changelog heading's `Unreleased` value with the
   approved local date in `DD.MM.YYYY` format.
2. Run `pnpm install --frozen-lockfile`, then inspect the lockfile and complete
   diff. No dependency version may change unexpectedly.
3. Run `git diff --check`, `pnpm check`, and `pnpm pack --dry-run`; inspect the
   manifest again. Stop before staging on any failure or unexpected change.
4. Stage only the exact approved release files by path. Add image files only if
   their reviewed captures changed. Inspect `git diff --cached` and reject any
   unstaged or untracked release content.
5. Commit with the approved release message. Verify the commit contains exactly
   the approved files, the worktree is clean, and `package.json` reports the
   target version.
6. Push only `develop` to `origin`. Verify `origin/develop` resolves to the
   release commit. If push or verification fails, stop; do not touch `master`.

### B. Merge and validate master

1. Save the current `origin/master` commit, switch to `master`, and run:

   ```bash
   git pull --ff-only origin master
   git merge --no-ff develop
   ```

2. Verify the merge's first parent is the saved master commit, second parent is
   the pushed release commit, and its tree is identical to that release commit.
3. Verify a clean worktree and target package version. Run
   `pnpm install --frozen-lockfile`, `pnpm check`, and `pnpm pack --dry-run` on
   this exact merge commit; inspect the manifest.
4. Create the lightweight tag `vX.Y.Z` on this tested merge commit, as required
   by the repository release guide. Verify the tag target locally.

### C. Push and verify the GitHub release

Recheck that `HEAD`, `master`, package version, clean status, and tag target are
identical. Push `master` and only the target tag atomically:

```bash
git push --atomic origin master refs/tags/vX.Y.Z
```

Verify with `git ls-remote` that both remote refs equal the tested merge commit.
If the atomic push or verification fails, do not publish anything.

The tag push starts `.github/workflows/release.yml`. Allow brief read-only
polling while GitHub registers the run, then use `gh run` to verify that the run
for the exact tag and merge commit completes successfully. Do not manually
create, update, or retry the release. Verify with `gh release view vX.Y.Z` that
its tag and title are `vX.Y.Z`, its notes exactly equal the approved changelog
section, it is published and not a prerelease, and its URL is in the expected
repository. The already-verified remote tag must still identify the tested
merge commit.

If the workflow fails, times out, or creates an inconsistent release, stop and
do not publish npm. Re-query the workflow and release before reporting because
the workflow may still complete independently after the local check.

### D. Publish the tagged tree

Immediately recheck all C-gate identities, then run exactly:

```bash
pnpm publish --no-git-checks --access public
```

Do not retry a failed or interrupted publish blindly. First query npm for the
exact version: it may have succeeded despite a lost response. Continue only
when `pnpm view <package>@X.Y.Z version` returns the target version; allow brief
read-only retries for registry propagation.

### E. Return and verify

1. Switch back to `develop`; verify it and `origin/develop` still identify the
   release commit and the worktree is clean.
2. Verify npm reports the exact target version, the GitHub release still has
   the approved title and notes, remote refs still identify the recorded
   commits, and the final branch and worktree state are correct.

## 4. Report the result

On success, report the version, release/develop/merge SHAs, tag target, npm
package URL, GitHub release URL, final branch, and clean status.

On failure, stop immediately and report:

- the failed checkpoint and exact command;
- completed external effects, each with verified identifiers;
- steps definitely not performed;
- current branch, HEAD, tag/remote/npm/GitHub observations, and worktree state;
- the safest next action requiring user approval.

Never describe a partial release as rolled back or successful.
