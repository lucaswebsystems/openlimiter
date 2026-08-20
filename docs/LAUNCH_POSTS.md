# Launch posts

## Hacker News or Reddit

### Title

Show HN: OpenLimiter, a local quota meter for several AI subscriptions

### Post

I use several AI coding subscriptions. Once they are paid for, the useful constraint is quota rather than price: which account still has room, which window is close to its limit, and when does it reset?

OpenLimiter is a small local desktop application and command line tool for that. On first run it looks for existing Claude Code, Codex, Antigravity, Gemini CLI, Grok, and Kimi sessions, then shows every returned quota window in a separate row for each account. OpenRouter uses an API key. OpenCode uses an explicit experimental browser session. A manual meter covers everything else.

It lives beside the clock on Windows and Linux and refreshes provider data while it runs. It can also render bounded quota context and a `PREFER` recommendation into the coding agent context. That recommendation is advice. OpenLimiter never executes or redirects a request.

This is a crowded category. OpenUsage, ClaudeBar, UsageMaster, CodexBar, and ccusage already solve useful parts of it. OpenUsage and CodexBar cover more providers. ccusage is much stronger for retrospective token and cost reports. UsageMaster already recommends a tool to the human. The narrow difference here is a live per account quota view plus a recommendation that the agent itself can read.

The uncomfortable part is that several automatic readers call provider interfaces that are unsupported for third party applications. They can change without warning. OpenLimiter validates each response and shows unknown when the contract breaks, but that does not make the interfaces stable.

The local core is free and open source under Apache 2.0. The optional paid hosted tier adds alerts, ninety day history, forecasts, and live hosted budget context. It does not unlock local features and never receives provider credentials.

There is no Mac download at launch because the current build is unsigned. Windows and Linux are available.

Source: https://github.com/lucaswebsystems/openlimiter

## X

OpenLimiter 1.0 shows every quota window for every supported AI command line account beside the clock. It finds existing Claude, Codex, Antigravity, Gemini, Grok, and Kimi sessions, then gives bounded quota advice to the agent too. Free local core, optional hosted tier. Windows and Linux. Unsupported interfaces may break.

https://github.com/lucaswebsystems/openlimiter
