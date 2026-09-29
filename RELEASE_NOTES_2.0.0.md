# OpenLimiter 2.0.0

Draft for the GitHub release body. This release has not been tagged, published or deployed. Confirm the release gates and remove this draft notice before publication.

OpenLimiter reads usage limits and agent activity from supported AI tools on your computer and shows them in your desktop Rail, tray, terminal, browser and phone.

## Desktop

The left edge Rail keeps your readings in view on Windows 10 and 11. See when supported agents are busy, waiting for you, or done, with free local alerts for activity and usage. Locate an agent from the Rail, Agents list or tray. Toast clicks are not promised.

The local monthly spend cap is removed. Local meters and alerts remain free, with one active account per provider. The macOS and Linux Rail remains a preview; the tray remains the fallback.

## CLI

Status lines use the same band colours as the meters. Use `openlimiter terminal show` and `openlimiter terminal hide` to choose which providers appear.

The desktop and CLI share one acquisition and retry policy. Manual refresh respects provider retry deadlines. A failed refresh keeps the last valid reading and its original time instead of inventing a new number.

```sh
npm install -g openlimiter
```

## Web and phone

Browser and phone sessions handle renewal, pairing and reconnects more reliably, with cleanup on logout. Signed in devices show the latest synchronized reading and clearly identify older readings when a computer stops syncing.

This is current reading sync, not a promise that a phone can collect every local provider while the computer is offline. Physical device checks and the required session soak remain publication gates.

## Providers

Cursor is Experimental pending live account verification. Support and verification are specific to the provider, account shape, operating system and acquisition surface. Missing quota stays unavailable; it never becomes zero.

## Free and Pro

Local meters, agent activity, local alerts and current reading sync to the browser and phone remain free after a trial ends. Free keeps one active account per provider.

Pro adds history, remote alerts, multiple active accounts per provider and opt in cloud metering for API spend keys. Local subscription credentials stay on your device.

## Downloads

These stable installer names are uploaded alongside the versioned release assets. The links become available after the first release carrying these aliases is published as latest, and keep the same names for future releases.

| Platform | Installer |
| --- | --- |
| Windows x64 | [Setup](https://github.com/lucaswebsystems/openlimiter/releases/latest/download/OpenLimiter-windows-x64-setup.exe), [MSI](https://github.com/lucaswebsystems/openlimiter/releases/latest/download/OpenLimiter-windows-x64.msi) |
| macOS, Apple silicon and Intel | [Universal disk image](https://github.com/lucaswebsystems/openlimiter/releases/latest/download/OpenLimiter-macos-universal.dmg) |
| Linux x64 | [AppImage](https://github.com/lucaswebsystems/openlimiter/releases/latest/download/OpenLimiter-linux-x86_64.AppImage), [DEB](https://github.com/lucaswebsystems/openlimiter/releases/latest/download/OpenLimiter-linux-amd64.deb), [RPM](https://github.com/lucaswebsystems/openlimiter/releases/latest/download/OpenLimiter-linux-x86_64.rpm) |

Builds remain unsigned. On Windows, SmartScreen: choose More info, then Run anyway. On macOS, open the app once, then System Settings, Privacy and Security, Open Anyway. Unsigned macOS builds are excluded from automatic updates.

## Publication checks still required

1. Verify the desktop What's New dialog on a real update from 1.3.x. Automated checks cover the current version entry, packaging, startup and persistence.
2. Verify all six stable installer aliases on the draft release. The workflow keeps versioned assets and updater artifacts intact; publication remains a separate action.
3. Reconcile the generated `llms.txt` product claims with the 2.0 free local alerts, phone access and removed spend cap rules.
4. Pass the acceptance commands on the final integrated commit, then prove the supported platform installers and updates, provider claims, real phone journeys and session soak.
5. Obtain Lucas's explicit go for each tag, publication and deployment action.

<!--
Codex L8 checkpoint, 2026-09-28, base af0fbd963937de1259e31b86ea3a746410dc7289.
Release preparation only. No remote actions or commits.
Passed: root build and typecheck, web lint, desktop UI assembly, cargo build,
178 desktop UI tests with Node process isolation disabled, four release guards,
and llms generator parity. Cargo emitted 22 warnings.
Incomplete: root tests were interrupted after five minutes without a test result.
Web tests and the requested desktop test command failed with spawn EPERM.
Web build failed to fetch Inter from Google Fonts (ECONNREFUSED 127.0.0.1:9).
The installed Node is 24.13.0; web requests 24.15.0.
Round 2 completed the missing desktop surface through the existing onboarding
completion state. The catalog becomes a local script module during UI assembly,
compatible with the desktop CSP, with no JSON module requirement. The dialog
records openlimiter-whats-new-seen only after it opens successfully. Both the
test and the assembler reject a current version without release content.
Six stable installer copies are uploaded by the existing gh CLI, with no new
action. README, release notes and the site's download constants use the aliases.
Round 2 passed root build and typecheck, desktop UI assembly, 184 desktop UI
tests including 10 release guards with Node process isolation disabled, YAML
parsing and nine synthetic workflow cases across the three runner platforms.
The assembled runtime module loads all seven items and skips a seen version.
An isolated missing catalog fixture fails assembly with Missing What's New
for 2.0.0. Final git diff --check passes; all round 1 edits remain uncommitted.
The normal What's New test command was blocked by Error: spawn EPERM.
The alias harness mocked gh and checked identical bytes, unchanged original
and updater fixtures, and failure before upload for missing or ambiguous files.
Real release uploads, native installer execution and GUI checks were not run.
L7 owns stale product copy in the llms generator and translations of title,
versionLabel, dismiss and releases["2.0.0"]
keys heading, rail, activity, statusline, cursor, retry, sessions and spend.
Internal workspace:* ranges publish the matching 2.0.0 package versions.
Only the desktop crate's own Cargo.lock version changed.
Vault logging was not saved because this unit permits writes only in its worktree.
Remove this internal checkpoint and resolve the publication checks before release.
-->
