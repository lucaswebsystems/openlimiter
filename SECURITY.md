# Security policy

## Reporting

Report a suspected vulnerability with [GitHub private vulnerability reporting](https://github.com/lucaswebsystems/openlimiter/security/advisories/new). Open the repository Security tab, then select Report a vulnerability.

Include a concise description, affected version, reproduction steps using synthetic data, and the expected impact. Do not include real credentials or provider account data.

Do not open a public issue for a suspected vulnerability.

## Scope

Security issues include secret disclosure, provider artifact mutation, unsafe cache behavior, symbolic link bypass, parser bounds bypass, agent context injection, and unexpected network egress.

Connector drift without a security impact is a compatibility issue. Please use the connector request template for that case.

## Telemetry

Local mode has no telemetry. No local command sends usage, diagnostics, identifiers, prompts, or quota state to the project authors.

OpenLimiter Pro is an explicit opt in hosted service. After sign in, the desktop may send selected provider code, meter code, bounded usage percentage, and reset time for alerts, history, forecasts, and coding agent routing context. Provider credentials, prompts, source code, provider response bodies, and diagnostics never enter Pro.

The Pro session and local trust anchor stay in the operating system credential store. Signed device entitlements are checked offline against public keys embedded in the desktop build. Hosted routing context is treated as untrusted data and rebuilt from a closed shape before it reaches the coding agent hook.

## Supported versions

Only the latest released version receives security fixes during the initial development period.
