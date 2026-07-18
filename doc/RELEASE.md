# Release Instructions

Release from `develop`, merge the reviewed release commit into `master`, and tag
the resulting `master` merge commit. The examples below use `v0.2.1`.

1. Update both local release branches and confirm that the worktree is clean:
   ```bash
   git fetch --prune origin
   ```
   ```bash
   git switch develop
   ```
   ```bash
   git pull --ff-only origin develop
   ```

2. Confirm npm access and make sure the version has not already been published:

   ```bash
   pnpm whoami
   ```
   ```bash
   pnpm view pi-context-view dist-tags --json
   ```

3. Confirm that the exact pi development pins in `package.json` match the local
   pi version:

   ```bash
   pi --version
   ```

4. Finalize the release documentation:
   - replace `Unreleased` for the version in `CHANGELOG.md` with the release
     date in `DD.MM.YYYY` format;
   - make the changelog entries match the user-visible release notes;
   - remove the completed version section from `PLAN.md`, leaving future work
     in the roadmap;
   - verify that README commands, screenshots, and package metadata are current.

5. Check that README image links and the absolute `pi.image` URL resolve to the
   intended immutable image revisions.

6. Bump `package.json` (pnpm keeps `pnpm-lock.yaml` in sync) without letting
   pnpm create a commit or tag:

   ```bash
   pnpm version "v0.2.1"
   ```

7. Review and validate the release tree:

   ```bash
   pnpm check
   ```
   ```bash
   pnpm pack --dry-run
   ```

8. Commit only the reviewed release files, following the repository's release
   commit convention. Add doc/images files only if their reviewed captures changed.

   ```bash
   git add CHANGELOG.md PLAN.md package.json pnpm-lock.yaml README.md doc/RELEASE.md
   ```
   ```bash
   git commit -m "[doc] Release v0.2.1"
   ```
   ```bash
   git push origin develop
   ```

9. Update `master`, merge `develop`, and validate the exact release tree again:

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
      git tag v0.2.1
      ```

11. Verify the version, tag target, and clean worktree:
      ```bash
      pnpm pkg get version
      ```

12. Push both branches and the tag together. Do not publish anything if this
    push fails:
      ```bash
      git push origin master
      ```

      ```bash
      git push --tags origin
      ```

13. Publish only from the clean commit identified by the pushed tag:

      ```bash
      pnpm publish --access public
      ```

14. Return back to develop branch:

      ```bash
      git switch develop
      ```

15. Publish the GitHub release.
