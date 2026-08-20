# Release checklist

This checklist prepares a public release. Every registry write, GitHub release, site deployment and remote push still waits for Lucas to approve that exact action.

## Version preparation

1. Run the complete local test suite.
2. Apply the prepared stable release changeset.

```bash
corepack pnpm version
```

3. Confirm that `openlimiter`, `@openlimiter/core`, `@openlimiter/connectors` and `@openlimiter/adapters` have the same version.
4. Confirm that the desktop version carriers and the public site describe the intended release.
5. Review and commit the version changes before creating the release tag.

## npm trusted publishing

1. Configure the GitHub repository `lucaswebsystems/openlimiter` as a trusted publisher for all four public npm packages.
2. Select `.github/workflows/npm-release.yml` as the workflow file.
3. Select `npm` as the GitHub environment and allow publishing.
4. Configure that GitHub environment to require Lucas as reviewer.
5. Dispatch the npm release workflow from `main`, enter the committed package version, then enter `PUBLISH` only after reviewing the commit.
6. Confirm the provenance record and install the released CLI in a clean directory.

The workflow uses a hosted runner and short lived OIDC credentials. It does not need a permanent npm token. It checks the complete suite, inspects the archive, rejects an existing version and publishes the dependency packages before the CLI.

## Desktop artifacts

1. Run the desktop release workflow for the intended tag.
2. Inspect the draft release, including both unsigned Windows installers, AppImage, deb and rpm.
3. Confirm that no macOS artifact is attached. macOS remains coming soon until signing and notarisation are available.
4. Confirm that Windows reports the installers as unsigned and that the documented SmartScreen path says `More info`, then `Run anyway`.
5. Publish the draft only after Lucas approves it.

Version 1.0 does not enable automatic updates. Updater metadata and signatures begin with a later release that has a dedicated update signing key. Operating system signing is separate: Windows 1.0 is intentionally unsigned, while no unsigned macOS build is distributed.

## Public site

1. Review the production environment values for the hosted checkout entry point.
2. Build the site locally.
3. Deploy only after Lucas explicitly approves the production write.
4. Verify canonical URLs, the sitemap, robots rules, pricing, downloads, documentation and the transactional portal after deployment.

No command in this checklist was run against a production service while preparing the release.
