# Security policy

## Reporting

Report a suspected vulnerability with [GitHub private vulnerability reporting](https://github.com/lucaswebsystems/openlimiter/security/advisories/new). Open the repository Security tab, then select Report a vulnerability.

Include a concise description, affected version, reproduction steps using synthetic data, and the expected impact. Do not include real credentials or provider account data.

Do not open a public issue for a suspected vulnerability.

## Scope

Security issues include secret disclosure, provider artifact mutation, unsafe cache behavior, symbolic link bypass, parser bounds bypass, agent context injection, and unexpected network egress.

Connector drift without a security impact is a compatibility issue. Please use the connector request template for that case.

## Telemetry

OpenLimiter has no telemetry. No command sends usage, diagnostics, identifiers, prompts, or quota state to the project authors.

## Supported versions

Only the latest released version receives security fixes during the initial development period.
