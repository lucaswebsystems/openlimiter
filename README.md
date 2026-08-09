[![CI](https://github.com/lucaswebsystems/openlimiter/actions/workflows/ci.yml/badge.svg)](https://github.com/lucaswebsystems/openlimiter/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE) [![npm](https://img.shields.io/badge/npm-coming%20soon-lightgrey.svg)](https://www.npmjs.com/package/openlimiter)

# OpenLimiter

OpenLimiter is an open source, cross platform, multi provider AI subscription quota meter that gives coding agents bounded budget state and routing advice.

## Demo data

All examples, fixtures, screenshots, and tests use synthetic values. No example contains a real credential or account.

Demo GIF placeholder: Add the approved demo GIF here.

## Quick start

OpenLimiter requires Node 24 and pnpm 9.

    pnpm install
    pnpm typecheck
    pnpm test
    pnpm build
    pnpm --filter @openlimiter/cli exec openlimiter demo

Initialize local configuration, inspect cached quota state, and wire Claude Code.

    openlimiter init
    openlimiter snapshot
    openlimiter statusline
    openlimiter hook --dry-run
    openlimiter doctor

## HOW IT WORKS

Connectors parse provider supplied shapes into one strict snapshot schema. They do not contact providers in this release. The core validates bounds, writes one atomic cache, derives freshness, forecasts burn, and creates bounded advice. Adapters read that cache and expose only enum codes, bounded numbers, and timestamps to an agent.

Claude Code receives a compact statusline and an optional UserPromptSubmit context block. The hook path reads the cache only and injects nothing when all provider state is unknown.

## Honest limitations

Most consumer subscription providers do not offer an official quota API. Several connectors therefore describe unofficial interfaces that can change or disappear.

Every connector ships marked UNVERIFIED. Missing, expired, malformed, and unknown input becomes unknown state. It never becomes zero or exhausted.

OpenLimiter provides routing advice. It does not route requests automatically, bypass limits, or mutate provider authentication artifacts.

OpenRouter uses a documented credits response shape. Its key belongs in the operating system credential store. The actual credential library adapter is intentionally stubbed in this release.

The OpenCode connector describes an authenticated scrape shape and carries high automation risk. Keep that limitation visible when evaluating the project.

## License

OpenLimiter is licensed under Apache License 2.0.

## Author

Created by [Lucas Costa](https://lucaswebsystems.com).

Find Lucas on [LinkedIn](https://www.linkedin.com/in/lucas-costa-t/) and [GitHub](https://github.com/lucaswebsystems).

Visit [openlimiter.com](https://openlimiter.com).
