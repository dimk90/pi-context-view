# Release Instructions

Release from `develop`, merge the reviewed release commit into `master`, and tag
the resulting `master` merge commit. The examples below use `v0.2.1`.

1. Update both local release branches and confirm that the worktree is clean:
   ```bash
   git fetch --prune origin
   git switch develop
   git pull --ff-only origin develop
   ```

1. Confirm npm access and make sure the version has not already been published:
   ```bash
   npm whoami
   npm view pi-context-view dist-tags --json
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

1. Bump both `package.json` and `package-lock.json` without letting npm create a
   commit or tag:

   ```bash
   npm version "v0.2.1" --no-git-tag-version
   ```

1. Review and validate the release tree:

   ```bash
   git diff --check
   git diff
   ```

   ```bash
   npm run check
   npm pack --dry-run
   ```

1. Commit only the reviewed release files, following the repository's release
   commit convention. Add doc/images files only if their reviewed captures changed.

   ```bash
   git add CHANGELOG.md PLAN.md package.json package-lock.json README.md doc/RELEASE.md
   git commit -m "[doc] Release v0.2.1"
   git push origin develop
   ```

1. Update `master`, merge `develop`, and validate the exact release tree again:

   ```bash
   git switch master
   git pull --ff-only origin master
   git merge --no-ff develop
   ```

1. Tag the tested `master`:

   ```bash
   git tag v0.2.1
   ```

1. Verify the version, tag target, and clean worktree:

   ```bash
   npm pkg get version
   ```

1. Push both branches and the tag together. Do not publish anything if this
   push fails:

   ```bash
   git push origin master
   ```

   ```bash
   git push --tags origin
   ```

1. Publish only from the clean commit identified by the pushed tag:

```bash
npm publish --access public
```

1. Publish the GitHub release


1. Return back to develop branch:

```bash
git switch develop
```
