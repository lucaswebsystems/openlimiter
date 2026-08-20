# OpenLimiter 1.0 release notes

OpenLimiter 1.0 turns the quota from several AI subscriptions into one live meter. Install it on Windows or Linux and the supported command line subscriptions already on the computer appear without another sign in.

## What you get

1. Automatic discovery for Claude Code, Codex, Antigravity, Grok, and Kimi.

2. A separate row for every detected account.

3. Every quota window returned for that account, including its current percentage and reset time when available.

4. A tray beside the clock for a quick reading, plus a full desktop view and a command line view.

5. Provider data that refreshes while OpenLimiter runs. Freshness and the age of any last valid reading remain visible, so the result is not a report frozen at launch.

6. Agent Auto Routing, which can render bounded quota context and a `PREFER` recommendation into coding agent context.

## Other connections

OpenRouter connects with an API key that you add.

OpenCode connects through an explicit experimental browser session.

The Manual meter covers any subscription without a reader.

## Privacy

The local product has no telemetry. Credentials stay on the computer and go only to the provider they belong to. OpenLimiter never sends prompts, spends quota, acts on your behalf, or writes to command line authentication files.

## Free core and Pro

The complete local product is free and open source under Apache 2.0.

The optional paid hosted tier adds email alerts, ninety day history with forecasts, and live hosted budget context for agent routing. It does not unlock any local feature.

## Availability

Version 1.0 ships unsigned builds for Windows and Linux. Windows can show a reputation warning during installation. macOS is coming soon and has no launch download.

## Known limits

Several automatic readers use provider interfaces that are unsupported for third party applications. Those interfaces can change without notice. A broken contract produces a visible unknown state instead of an estimate.

Every connector remains marked `UNVERIFIED` until its evidence is explicitly verified.
