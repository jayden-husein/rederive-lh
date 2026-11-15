# Releasing

A release is a GitHub release whose asset is `rederive-lh-<version>.zip`: the
built `dist\` files, which users extract into `<plugins directory>\rederive-lh\dist\`.

1. **Version.** Pick it by semver: a new capability bumps the minor, fixes only
   bump the patch. Set it in both places (`tests\build.test.ts` fails when they
   differ):

   ```bash
   npm version 0.3.0 --no-git-tag-version --ignore-scripts
   ```

   and `"version"` in `src\manifest.json`. Then commit and push.
2. **CI green.** Wait for the CI run of that exact commit to pass on Windows,
   macOS and Linux:

   ```bash
   gh run watch --exit-status
   ```

   On a failure, `gh run view --log-failed` prints the failing step.
3. **Zip.** `npm run package` refuses a dirty working tree, builds, and writes
   `release\rederive-lh-<version>.zip`, printing the commit it came from. Build
   the zip after the last commit, never before.
4. **Release.** Tag the same commit, with notes on what changed for users and
   the install steps (copy them from the previous release), plus "updating"
   when users must do anything beyond replacing `dist\`:

   ```bash
   gh release create v0.3.0 release/rederive-lh-0.3.0.zip --target main --title v0.3.0 --notes-file <notes.md>
   ```

   Without `gh`, use the browser: `releases/new?tag=v0.3.0&target=main&title=v0.3.0`
   on the repo fills the form, and the user attaches the zip.
5. **Verify.** `releases/latest` resolves to the new tag, and the downloaded zip
   has the same SHA-256 as `release\`'s.
