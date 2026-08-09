# Architecture

## Layered design

The core owns the snapshot contract, normalization, cache, freshness, forecast, and advice policy. It contains no provider parsing.

Connectors translate a known response shape into raw meters. They perform no network access and never write provider authentication artifacts.

Adapters translate bounded advice into an agent specific representation. The Claude Code hook reads the cache only.

The CLI coordinates detection, cache reads, caller supplied refresh payloads, diagnostics, demos, and exports.

## Snapshot schema

A snapshot contains provider, meter, value, unit, window, resetAt, source, precision, observedAt, expiresAt, and connector labels.

The labels are credentialOrigin, dataInterfaceStatus, automationRisk, and verification.

Provider codes, units, sources, precision values, and label values are closed enums. Meter names use a bounded uppercase identifier. Percentage values remain between zero and one hundred.

Freshness is derived from observedAt, expiresAt, and an injected current time. Pure policy code never reads the system clock.

## Connector contract

A connector exposes id, displayName, labels, detect, and read. Detection is pure and uses only the supplied environment map. Read accepts a caller supplied context and returns either meters or a closed failure reason.

Every connector is read only. Missing or unrecognized input returns unknown.

## One binary, one schema, one cache

One binary gives agent tools and people the same commands.

One schema prevents provider text from crossing into policy or agent context.

One cache avoids competing state files and keeps the hook path fast. The cache uses one state directory, one file name, one lock name, atomic replacement, strict validation, symbolic link rejection, and restrictive permissions where supported.
