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

## Desktop updater

1. Generate a dedicated Tauri update signing key pair and keep the private key outside the repository.
2. Store the public key as `TAURI_UPDATER_PUBLIC_KEY`.
3. Store the private key as `TAURI_SIGNING_PRIVATE_KEY` and its optional password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Run the desktop release workflow for the intended tag.
5. Inspect the draft release, including `latest.json`, every update signature, both macOS architectures, both Windows installers, AppImage, deb and rpm.
6. Publish the draft only after Lucas approves it.

The update signature is mandatory and separate from operating system code signing. Until Windows and macOS certificates are configured, SmartScreen warns and Gatekeeper blocks the first launch exactly as the downloads page explains.

## Public site

1. Review the production environment values for the hosted checkout entry point.
2. Build the site locally.
3. Deploy only after Lucas explicitly approves the production write.
4. Verify canonical URLs, the sitemap, robots rules, pricing, downloads, documentation and the transactional portal after deployment.

No command in this checklist was run against a production service while preparing the release.
