# Launch posts

## Hacker News or Reddit

### Title

Show HN: OpenLimiter, a local quota meter for several AI subscriptions

### Post

I use several AI coding subscriptions. Once they are paid for, the useful constraint is quota: which account still has room, which window is close to its limit, and when does it reset?

OpenLimiter is a free local desktop application and command line tool for that. It looks for existing Claude Code, Codex, Antigravity, Gemini CLI, Grok, and Kimi sessions, keeps each account separate, and refreshes every returned quota window while it runs. OpenRouter uses an API key. OpenCode uses an explicit experimental browser session. A manual meter covers everything else.

The verification status matters. None of the automatic readers is marked live verified in 1.0. Codex and Antigravity use contracts observed against real accounts. Claude and Gemini CLI are implemented with fixture coverage but no current live account verification. Grok and Kimi are fixture tested against contracts in official CLI source. The application labels every reader `UNVERIFIED`.

It can also render bounded quota context and a `PREFER` recommendation into coding agent context. That recommendation is advice. It never executes or redirects a request.

OpenUsage, ClaudeBar, UsageMaster, CodexBar, ccusage, and Overclock Redline already cover useful parts of this category. The narrow differences here are more automatic collectors than Redline, live updating rows instead of its static detail snapshot, and routing advice that the agent itself can read. OpenUsage and CodexBar cover more providers. ccusage is stronger for retrospective token and cost reports.

Several readers call private, undocumented provider interfaces. A provider can change or block them at any time, and this category has been blocked before. OpenLimiter fails to unknown on contract drift, but that does not make the interfaces stable.

The local core is free and open source under Apache 2.0. Pro is coming soon and is not available today.

The builds are unsigned: Windows shows a SmartScreen warning, and macOS is not available because Gatekeeper hard blocks an unsigned app. Windows and Linux are available.

Source: https://github.com/lucaswebsystems/openlimiter

## X

OpenLimiter 1.0 is a free local quota meter for several AI subscriptions. Six automatic readers ship, all labelled `UNVERIFIED`; only Codex and Antigravity use contracts observed against real accounts, while the rest are fixture tested. Private interfaces can break or be blocked. Unsigned Windows and Linux builds ship, SmartScreen warns on Windows, macOS is not available, and Pro is coming soon.

https://github.com/lucaswebsystems/openlimiter
