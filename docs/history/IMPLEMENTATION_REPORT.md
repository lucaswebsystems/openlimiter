# Implementation report

## Built

The implementation followed the requested vertical slice order.

1. Core came first. It defines the strict snapshot and connector contracts, normalization, canonical JSON, cross platform state resolution, atomic cache, symbolic link rejection, freshness, bounded advice, and forecast.
2. The core contract was frozen with deterministic tests before connector work began.
3. Six read only connectors followed. Every connector is marked UNVERIFIED and fails closed to unknown. All fixtures are synthetic.
4. The CLI, Claude Code adapter, repository automation, security material, project documentation, and placeholder web package followed.

The CLI implements init, snapshot, statusline, hook, doctor, demo, and export. The hook and statusline paths read the cache only. The agent context serializer accepts only bounded numbers, enum codes, and timestamps.

No connector performs provider egress. No connector reads or mutates a provider authentication artifact during build or test.

## Validation

All validation used the local offline package store.

1. pnpm install --offline --frozen-lockfile --ignore-scripts: passed.
2. pnpm typecheck: passed for core, connectors, adapters, and CLI.
3. pnpm test: 8 test files passed, 69 tests passed, 0 failed, 0 skipped. Vitest duration was 604 ms in the final run.
4. pnpm build: passed for core, connectors, adapters, and CLI.
5. The built demo command rendered all six synthetic providers.
6. Secret, machine path, provider egress, connector write, and prose character scans found no prohibited product content.

## Intentional stubs

1. The operating system credential store is behind a tested driver interface. A concrete credential library binding is not bundled yet.
2. Codex CLI and OpenCode agent adapters expose the P2 interface and intentionally render empty output.
3. apps/web contains only the separately owned marketing site placeholder.
4. The demo GIF and public security and conduct intake addresses remain the requested placeholders.

## Verdicts requested from Fable

1. Near cap begins at 80 percent. At cap begins at 100 percent.
2. Stale bounded observations remain visible as stale advice. Unknown observations are excluded. When all providers are unknown, the hook injects nothing.
3. All six connectors are enabled in configuration by default. Detection is recorded separately and does not disable a connector.
4. Refresh consumes caller supplied payloads only in this release. It performs no live provider call.
5. The offline Vitest harness vendors two small cached dependency archives and a test only Chai type compatibility package because the available local pnpm metadata was incomplete. Fable should verdict whether to retain that fully offline path or regenerate the lock with a complete package mirror.
