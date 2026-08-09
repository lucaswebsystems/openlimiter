[![CI](https://github.com/lucaswebsystems/openlimiter/actions/workflows/ci.yml/badge.svg)](https://github.com/lucaswebsystems/openlimiter/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE) [![npm](https://img.shields.io/badge/npm-coming%20soon-lightgrey.svg)](https://www.npmjs.com/package/openlimiter)

# OpenLimiter

OpenLimiter is an open source, cross platform, multi provider AI subscription quota meter that gives coding agents bounded budget state and routing advice.

## Demo data

All examples, fixtures, screenshots, and tests use synthetic values. No example contains a real credential or account.

Demo GIF placeholder: Add the approved demo GIF here.

## Quick start

OpenLimiter requires Node 24 and pnpm 9. Run these in order on a clean clone.

    pnpm install
    pnpm build
    pnpm typecheck
    pnpm test
    pnpm openlimiter demo

The build has to run before the type check, because each package resolves its
neighbours through the declaration files that the build produces.

`pnpm openlimiter` is a thin wrapper around the built entry point. The package
is not published yet, so there is no globally installed `openlimiter` command.
Anywhere this document writes `openlimiter <command>`, you can run either of
these from the repository root:

    pnpm openlimiter <command>
    node packages/cli/dist/bin.js <command>

## Feeding it real quota

OpenLimiter never contacts a provider. It parses data that something else
already put in front of it, which is why every path below is local. Until one of
these paths runs, every command honestly reports unknown.

### 1. The Claude Code statusline (the path that needs no extra work)

Claude Code runs your statusline command on every render and writes a JSON
object describing the current session to that command's standard input. When
that object carries a `rate_limits` block, `openlimiter statusline` validates
it, writes it to the cache, and renders the fresh numbers in the same call.

    node packages/cli/dist/bin.js statusline < session.json
    OpenLimiter NEAR_CAP CLAUDE 87.5% UNKNOWN OPENROUTER,CODEX,ANTIGRAVITY,OPENCODE,MANUAL

The block it reads looks like this. Anything else in the session object is
ignored.

    {
      "rate_limits": {
        "five_hour": { "utilization": 87.5, "resets_at": "2026-08-09T13:11:01.351Z" },
        "seven_day": { "utilization": 41.25, "resets_at": "2026-08-15T12:11:01.351Z" }
      }
    }

If standard input is absent, empty, malformed, or carries no recognisable rate
limit field, the statusline falls back to the cache and reports unknown. It
never blocks and never fails.

Not every Claude Code version sends rate limit fields. If yours does not, this
path stays quiet and the manual paths below still work.

### 2. A manual document on disk

Write `manual.json` inside the state directory and every command picks it up.
The state directory is `%LOCALAPPDATA%\openlimiter` on Windows,
`~/Library/Application Support/openlimiter` on macOS, and
`${XDG_STATE_HOME:-~/.local/state}/openlimiter` on Linux.

    {
      "version": 1,
      "meters": [
        { "name": "MONTHLY", "used_percent": 61.5, "reset_at": "2026-08-29T12:11:29.714Z" }
      ]
    }

`name` is one uppercase identifier of up to 32 characters, `used_percent` is a
number from 0 to 100, and `reset_at` is an ISO instant in the future. Up to ten
meters are read. A row that breaks any of those rules is dropped and the
remaining rows still count. Run `openlimiter snapshot --refresh` to fold the
file into the cache.

### 3. The generic ingest command

Any script or agent can hand OpenLimiter a document without a provider
integration.

    echo '{"meters":[{"name":"AGENT_BUDGET","used_percent":12.5,"reset_at":"2026-08-09T13:11:30.141Z"}]}' | openlimiter ingest
    openlimiter ingest --payload '{"meters":[{"name":"AGENT_BUDGET","used_percent":12.5,"reset_at":"2026-08-09T13:11:30.141Z"}]}'

Without a provider flag the document is a manual document, so the resulting
snapshot is labelled as manual precision. With `--provider <id>` the document is
handed to that connector's own parser and keeps that connector's labels.

    openlimiter ingest --provider codex --payload '{"rate_limits":{"primary_window":{"used_percent":33,"reset_at":"2026-08-09T14:11:30.264Z"}}}'

Valid provider ids are `claude`, `openrouter`, `codex`, `antigravity`,
`opencode`, and `manual`. Ingested rows merge into the cache under the same lock
every other writer uses, so nothing already cached is lost.

## Wiring Claude Code

Add this to your Claude Code `settings.json`, using the absolute path to your
clone. Forward slashes work on every platform.

    {
      "statusLine": {
        "type": "command",
        "command": "node /absolute/path/to/openlimiter/packages/cli/dist/bin.js statusline"
      },
      "hooks": {
        "UserPromptSubmit": [
          {
            "hooks": [
              {
                "type": "command",
                "command": "node /absolute/path/to/openlimiter/packages/cli/dist/bin.js hook"
              }
            ]
          }
        ]
      }
    }

The statusline is the only path that writes. The hook reads the cache, performs
no network access, and exits 0 whatever happens, so it cannot break a session.

## Commands

    openlimiter init                                   write local configuration
    openlimiter snapshot [--refresh]                   show cached quota, optionally refresh first
    openlimiter statusline                             render one line, ingesting standard input
    openlimiter hook [--dry-run]                       emit the agent context block
    openlimiter ingest [--provider <id>] [--payload <json>]   accept quota from a script
    openlimiter doctor                                 report connector detection and cache health
    openlimiter demo                                   render synthetic fixtures
    openlimiter export                                 print the cache as canonical JSON

Exit codes: 0 success, 1 failure, 2 usage error, 3 no bounded quota data.
`hook` and `statusline` always exit 0 because another tool invokes them. Every
other command reports a genuine failure on standard error with no provider text
and no secrets in the message.

## How it works

Connectors parse provider supplied shapes into one strict snapshot schema. They
do not contact providers in this release. The core validates bounds, merges into
one atomic cache under one lock, derives freshness, forecasts burn, and creates
bounded advice. Adapters read that cache and expose only enum codes, bounded
numbers, and timestamps to an agent.

Claude Code receives a compact statusline and an optional UserPromptSubmit
context block. The hook path reads the cache only and injects nothing when all
provider state is unknown.

Usage percentages are truncated for display and never rounded upward, so a meter
at 99.99 percent reads as 99.9 percent and a cap is only ever claimed once it is
actually reached.

## Honest limitations

Most consumer subscription providers do not offer an official quota API. Several
connectors therefore describe unofficial interfaces that can change or disappear.

Every connector ships marked UNVERIFIED. Missing, expired, malformed, and
unknown input becomes unknown state. It never becomes zero or exhausted.

OpenLimiter provides routing advice. It does not route requests automatically,
bypass limits, or mutate provider authentication artifacts.

OpenRouter uses a documented credits response shape. Its key belongs in the
operating system credential store. The actual credential library adapter is
intentionally stubbed in this release, so `openlimiter init` cannot store a key
until you supply a driver.

The OpenCode connector describes an authenticated scrape shape and carries high
automation risk. Keep that limitation visible when evaluating the project.

The Codex, Antigravity, and OpenCode connectors have no local reader yet. They
accept data through `openlimiter ingest --provider <id>` and nothing else.

## License

OpenLimiter is licensed under Apache License 2.0.

## Author

Created by [Lucas Costa](https://lucaswebsystems.com).

Find Lucas on [LinkedIn](https://www.linkedin.com/in/lucas-costa-t/) and [GitHub](https://github.com/lucaswebsystems).

Visit [openlimiter.com](https://openlimiter.com).
