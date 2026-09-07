# `openlimiter`

A local terminal quota meter for AI coding subscriptions: bars in your terminal, an account free of charge, and an account that syncs the same bars to the hub and your phone.

## Install

```bash
npm install --global openlimiter
```

## First run

```bash
npx openlimiter
```

With nothing after it, or once installed, `openlimiter` on its own walks the same three steps every time: sign in (skippable), connect the agent CLIs already on this machine, then show bars in. It prints the bars once at the end.

## Terminal bars

Claude Code, Grok Build and the Antigravity CLI draw bars through their own status line. Codex draws its own built in items instead. Gemini CLI, OpenCode, Kimi and any other terminal read a shell prompt segment.

```bash
openlimiter terminal
openlimiter terminal install claude
openlimiter terminal status
openlimiter terminal uninstall claude
openlimiter terminal show codex
openlimiter terminal hide codex
```

## Account and sync

```bash
openlimiter login       # device code sign in, approved at openlimiter.com/app/cli
openlimiter whoami
openlimiter sync        # uploads one round of cached bars to the hub
openlimiter logout
```

Bars never require this. An account only syncs the current percentage on every window between your devices.

## Agent context hooks

Install or remove a user scoped hook explicitly:

```bash
openlimiter hooks install codex
openlimiter hooks uninstall codex
openlimiter hooks status codex
openlimiter hooks repair codex
```

Installation preserves unrelated agent configuration, writes a recoverable backup, performs no network request, and refuses a version below the tested minimum or an unsafe configuration path. Hook execution reads only the short lived local snapshot and the protected desktop trust bridge, then fails open with no context on any invalid or missing input.

Antigravity CLI injection is excluded because `agy 1.1.23` did not fire the IDE hook shapes in a real prompt fixture. Kimi Code CLI installation stays gated because `1.50.0` fired `UserPromptSubmit` but discarded successful hook stdout instead of adding it to model context.

Grok Build does not currently expose a documented dynamic context surface. Use the explicit command instead:

```bash
openlimiter status --agent-context
```

## How each provider connects

| Provider | Connects by | Reads |
|---|---|---|
| Claude | Nothing to do | The Claude Code status line automatically; an opt in poll of Anthropic's usage endpoint (`providers.claude.poll`) covers the gap when Claude Code is closed |
| Codex | Use the login already there, or sign in from inside OpenLimiter | The login the Codex CLI stored |
| Gemini CLI | Read only, from the login already there | The login the Gemini CLI stored |
| Antigravity | Read only, from the credential already there | The credential the Antigravity CLI stored |
| Grok | Use the login already there | The login the Grok CLI stored |
| Kimi | Use the login already there | The usage response the Kimi CLI defines |
| OpenRouter | Real OAuth from the hub, or your own key | OpenRouter's documented key and usage report |
| OpenCode | Import only | `openlimiter ingest --provider opencode` |
| Manual | You write the numbers | `manual.json` in the OpenLimiter state directory, or `openlimiter ingest --provider manual` |

`openlimiter refresh` is what reaches the network, at most once every fifteen minutes per provider: it reads the logins your provider tools already stored and asks each provider for its own usage. It stands down while the desktop app is running, and `statusline`, `snapshot` and `setup` all start it in the background on their own. OpenLimiter never asks for a vendor password, never impersonates a vendor tool, and never uploads a token.

Read the [documentation](https://openlimiter.com/docs) or browse the [repository](https://github.com/lucaswebsystems/openlimiter).
