# Contributing

Thank you for helping make quota advice safer and more honest.

## Local validation

Use Node 24 and pnpm 9.

    pnpm install
    pnpm typecheck
    pnpm test
    pnpm build

Tests must use synthetic values. Never add real credentials, account identifiers, emails, cookies, session data, or machine paths.

## Developer Certificate of Origin

Every commit must include a DCO sign off line.

    Signed-off-by: Demo Contributor <demo@example.test>

The line certifies that you have the right to submit the contribution under the project license.

## Adding a connector

Implement ConnectorContract from @openlimiter/core.

Add an explicit UNVERIFIED label block, a pure detect function, a read only input descriptor, a strict parser, and synthetic fixtures.

Test normal, missing, expired, malformed, hostile, huge numeric, and Unicode cases. Unknown input must return unknown. It must never become zero or exhausted.

Document any future egress host in THREAT_MODEL.md before adding network behavior.

## Prose rule

Project prose does not use dash characters. Reword prose with commas, periods, parentheses, or colons. Technical identifiers, package names, paths, flags, and URLs keep their required spelling.

Legal text is permanently exempt from this prose rule and must remain verbatim.
