# OpenLimiter 1.0 release notes

OpenLimiter 1.0 turns quota across several AI subscriptions into one local meter. It keeps accounts separate, shows every returned window, refreshes while it runs, and stays beside the clock.

## What you get

1. Automatic local readers for Claude Code, Codex, Antigravity, Gemini CLI, Grok, and Kimi.

2. One row for every detected account and every quota window returned for it.

3. Tray, desktop, and command line views with percentages, reset times, and freshness when available.

4. Agent Auto Routing that can render bounded quota context and a `PREFER` recommendation into coding agent context. It advises only.

5. OpenRouter through an API key, an experimental OpenCode browser session, and a manual meter for everything else.

## Verification

No automatic reader is marked live verified in this release. Codex and Antigravity use contracts observed against real accounts. Claude and Gemini CLI are implemented with fixture coverage but no current live account verification. Grok and Kimi are fixture tested against contracts in official CLI source. The product labels every reader `UNVERIFIED`.

## Privacy

The local product has no telemetry. Credentials stay on the computer and go only to their provider. OpenLimiter never sends prompts, spends quota, acts on your behalf, or writes to command line authentication files.

## Availability and limits

The builds are unsigned: Windows shows a SmartScreen warning, and macOS is not available because Gatekeeper hard blocks an unsigned app. Windows and Linux ship now.

Several readers use private, undocumented provider interfaces that can change or be blocked at any time. A broken contract becomes a visible unknown reading.

The complete local product is free and open source under Apache 2.0. Pro is coming soon and is not available in 1.0.
