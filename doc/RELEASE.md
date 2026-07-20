# Release Instructions

Release from `develop`, merge the reviewed release commit into `master`, and tag
the resulting `master` merge commit.

1. Confirm npm access and make sure the version has not already been published:

   ```bash
   pnpm whoami
   ```
   ```bash
   pnpm view pi-context-view dist-tags --json
   ```

1. Confirm that the exact pi development pins in `package.json` match the local
   pi version:

   ```bash
   pi --version
   ```

1. Finalize the release documentation:
   - replace `Unreleased` for the version in `CHANGELOG.md` with the release
     date in `DD.MM.YYYY` format;
   - make the changelog entries match the user-visible release notes;
   - remove the completed version section from `PLAN.md`, leaving future work
     in the roadmap;
   - verify that README commands, screenshots, and package metadata are current.

1. Check that README image links and the absolute `pi.image` URL resolve to the
   intended immutable image revisions.

1. Bump version number in `package.json`.

1. Review and validate the release tree:

   ```bash
   pnpm check
   ```
   ```bash
   pnpm pack --dry-run
   ```

1. Commit only the reviewed release files, following the repository's release
   commit convention. Add doc/images files only if their reviewed captures changed.

   ```bash
   git add CHANGELOG.md PLAN.md package.json pnpm-lock.yaml README.md doc/RELEASE.md
   ```
   ```bash
   git commit -m "[doc] Release v0.?.?"
   ```
   ```bash
   git push origin develop
   ```

1. Update `master`, merge `develop`, and validate the exact release tree again:

   ```bash
   git switch master
   ```

   ```bash
   git pull --ff-only origin master
   ```

   ```bash
   git merge --no-ff develop
   ```

1. Tag the tested `master`:
      ```bash
      git tag v0.?.?
      ```

1. Verify the version, tag target, and clean worktree:
      ```bash
      pnpm pkg get version
      ```

1. Push both branches and the tag together. Do not publish anything if this
    push fails:
      ```bash
      git push origin master
      ```

      ```bash
      git push --tags origin
      ```

13. Publish only from the clean commit identified by the pushed tag:

      ```bash
      pnpm publish --no-git-checks --access public
      ```

14. Return back to develop branch:

      ```bash
      git switch develop
      ```

15. Publish the GitHub release.
