# OpenLimiter

When you hold several AI subscriptions, the scarce resource stops being money and becomes quota. Each provider has different limits and reset windows, so choosing where to start a long task becomes guesswork.

OpenLimiter puts those limits in one local meter. It keeps every returned window under its account, refreshes readings while it runs, and stays beside the clock on Windows and Linux.

[Download for Windows or Linux](https://openlimiter.com/download)

## What ships

1. Automatic local readers for Claude Code, Codex, Antigravity, Gemini CLI, Grok, and Kimi.

2. One row per account, with every quota window the provider returns.

3. A tray view, desktop view, command line view, and visible freshness.

4. Agent Auto Routing, which can place bounded quota context and a `PREFER` recommendation in coding agent context. It is advice and never executes or redirects a request.

## Verification status

None of the automatic readers is marked live verified in 1.0.

Codex and Antigravity use response contracts observed against real accounts. Claude and Gemini CLI are implemented and tested with fixtures, but have not completed current live account verification. Grok and Kimi are fixture tested against contracts in their official CLI source. Every reader remains labelled `UNVERIFIED` in the product.

OpenRouter is key based and fixture tested against its documented response. OpenCode uses an explicit experimental browser session. A manual meter covers anything else.

## What it reads

Automatic readers open known local authentication locations and use the OAuth token that the provider command line tool already stored. The token goes only to that provider usage interface. Parsing, account merging, and routing advice happen locally.

Several readers depend on private, undocumented provider interfaces. A provider can change or block them at any time, and this category has been blocked before. OpenLimiter shows unknown when a response breaks its expected contract, but it cannot make the interface stable.

## What it never does

1. The local product has zero telemetry and needs no OpenLimiter account. Sync is off by default. Nothing leaves the machine unless you sign in to OpenLimiter and turn sync on.

2. No prompts, source code, or provider credentials sent to OpenLimiter.

3. No prompt execution, quota spending, plan changes, or action on your behalf.

4. No writing to command line authentication files.

5. No invented percentage or reset time when data is missing.

Optional sync is an intentional user action, not telemetry. It is free. After you sign in and enable it, OpenLimiter sends only selected bounded quota snapshots so the same numbers can appear on the web dashboard and phone PWA. Provider credentials and provider response bodies never enter that service. Signing out stops remote access and never changes the local cache, local meter, tray, connectors, or local advice.

## Agent Auto Routing

OpenLimiter can render a bounded `PREFER` recommendation into coding agent context. This is advice. It does not intercept, execute, authenticate, or redirect a request, and the agent can ignore it.

## Free core and Pro

The complete local product is free and open source under Apache 2.0. It includes the desktop application, command line tool, local connectors, local meter, local agent context, and optional current snapshot sync.

OpenLimiter Pro is coming soon at 5 dollars per month or 48 dollars per year. It adds exactly three hosted features: threshold alerts, history and forecasting, and agent auto routing. Sync itself is free. No local feature moves behind payment.

## Availability

The builds are unsigned: Windows shows a SmartScreen warning, and macOS is not available because Gatekeeper hard blocks an unsigned app. Windows and Linux ship now.

## Project

[Source](https://github.com/lucaswebsystems/openlimiter)

[Release notes](docs/RELEASE_NOTES_1.0.md)

[Honest comparison](docs/COMPARISON.md)

[Security](SECURITY.md)

[License](LICENSE)
