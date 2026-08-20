# OpenLimiter

When you hold several AI subscriptions, the scarce resource stops being money and becomes quota. Each provider exposes different limits and reset windows, so choosing where to start a long task becomes guesswork.

OpenLimiter puts those limits in one live local meter. Install it on Windows or Linux and it finds supported subscriptions already connected through local AI command line tools. Each account gets its own row, every available window stays visible, and a tray icon beside the clock keeps the current state close.

[Download for Windows or Linux](https://openlimiter.com/download)

## What you get

1. Automatic discovery of supported AI command line sessions already present on the computer.

2. A separate row for every account, with every quota window the provider returns.

3. A tray beside the clock, plus a full desktop view and a command line view.

4. Current provider data that refreshes while the application runs, with reset times, freshness, and the age of any last valid reading.

5. Bounded quota context that can help a coding agent prefer an account with room.

## Connections

### Automatic

Claude Code, Codex, Antigravity, Gemini CLI, Grok, and Kimi. OpenLimiter reads the OAuth credentials their own command line tools already stored. It does not create or refresh those credentials.

### Key based

OpenRouter. You add an API key explicitly.

### Manual

OpenCode uses an experimental browser session that you supply. The Manual meter accepts a percentage and reset time for any other subscription.

## What it reads

The automatic readers open known local authentication locations, identify the account, and use the existing access token only with that provider usage interface. Parsing, account merging, and routing advice happen on your computer.

Several provider usage interfaces are unsupported for use by third party applications. They can change or disappear without notice. When a response no longer matches its contract, OpenLimiter shows an unknown state instead of inventing a plausible number.

## What it never does

1. The local product has no telemetry and needs no OpenLimiter account.

2. It never sends prompts, source code, or provider credentials to OpenLimiter.

3. It never sends a prompt, spends quota, changes a plan, or acts on your behalf.

4. It never writes to, refreshes, replaces, or deletes a command line authentication file.

5. It never guesses a missing percentage or reset time.

Optional Pro is an intentional hosted service, not telemetry. After you sign in, it can receive selected bounded quota snapshots for alerts, history, forecasts, and agent context. Provider credentials and provider response bodies never enter that service.

## Agent Auto Routing

OpenLimiter can render a bounded `PREFER` recommendation into coding agent context. This is advice. It does not intercept, execute, authenticate, or redirect a request, and the agent can ignore it.

## Free core and hosted tier

The complete local product is free and open source under Apache 2.0. It includes the desktop application, command line tool, local connectors, local meter, and local agent context.

OpenLimiter Pro is optional. It costs 5 dollars per month or 50 dollars per year after the first 30 days. It adds email alerts, ninety day history with forecasts, and live hosted budget context for agent routing. No local feature moves behind payment.

## Availability

OpenLimiter 1.0 ships for Windows and Linux. The builds are unsigned, so Windows can show a reputation warning during installation. macOS is coming soon and is not a launch download.

## Project

[Source](https://github.com/lucaswebsystems/openlimiter)

[Release notes](docs/RELEASE_NOTES_1.0.md)

[Honest comparison](docs/COMPARISON.md)

[Security](SECURITY.md)

[License](LICENSE)
