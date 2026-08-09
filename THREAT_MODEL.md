# Threat model

## Protected assets

Protected assets include provider credentials, browser sessions, quota state, local configuration, and agent context integrity.

## Agent context injection boundary

Provider text is untrusted data. Connector parsers select known numeric fields and known timestamps. They discard labels, messages, account text, markup, and unknown fields.

The advice engine emits only provider enum codes, reason enum codes, bounded percentages, freshness enum codes, and timestamps. The Claude Code adapter validates these values again and wraps them in an explicit untrusted data boundary.

If every provider is unknown, the adapter injects nothing.

## Secret handling

Provider authentication artifacts are read only. OpenLimiter never rewrites, backs up, repairs, or migrates them.

OpenRouter credentials belong only in the operating system credential store. Repository files, cache files, exports, diagnostics, fixtures, and logs must never contain the key.

The credential library call is behind an interface. Tests use only a memory implementation with a synthetic key.

## Connector drift

Unofficial interfaces may change without notice. Every connector is marked UNVERIFIED. Parsing fails closed to unknown on missing fields, new shapes, unsafe numbers, expired windows, or invalid timestamps.

Doctor output reports drift as UNVERIFIED until an explicit verifier exists. It remains redacted.

## Egress allowlist

This release performs no provider egress.

A future connector that performs egress must declare one exact provider host, use secure transport, reject redirects outside that host, set a short timeout, bound the response size, and document the interface status.

No connector may send cache content, other provider state, prompts, source code, or diagnostics.

## Telemetry

OpenLimiter has no telemetry. It does not send usage, diagnostics, identifiers, prompts, or quota state to the project authors.
