# Security policy

## Reporting

Report a suspected vulnerability with [GitHub private vulnerability reporting](https://github.com/lucaswebsystems/openlimiter/security/advisories/new). Open the repository Security tab, then select Report a vulnerability.

Include a concise description, affected version, reproduction steps using synthetic data, and the expected impact. Do not include real credentials or provider account data.

Do not open a public issue for a suspected vulnerability.

## Scope

Security issues include secret disclosure, provider artifact mutation, unsafe cache behaviour, symbolic link bypass, parser bounds bypass, agent context injection, and unexpected network egress.

Connector drift without a security impact is a compatibility issue. Please use the connector request template for that case.

## Telemetry

Local mode has no telemetry. No local command sends usage, diagnostics, identifiers, prompts, or quota state to the project authors.

Nothing goes to OpenLimiter's own servers until the user signs in. Three kinds of request happen without an account. Each provider's usage request uses the login or key that provider's own tool stored on this computer and goes to that provider, nowhere else. On new desktop installs, after a disclosure that is shown and recorded, a direct Claude usage request goes to Anthropic's `api/oauth/usage` with the user's own Claude Code login; Show Fable limit in Connect Tools turns it off on the desktop, and `openlimiter config set providers.claude.poll false` turns it off in the terminal. The desktop also checks GitHub for updates and asks before installing one.

OpenLimiter sync is explicit, free, and separate from telemetry. Signing in turns sync on, because moving percentages between devices is what the account exists for, and sync can be turned off at any time. The desktop then sends provider code, opaque account label, window name, bounded usage percentage, reset time, observation time, and opaque device identifier. Subscription logins, prompts, source code, provider response bodies, local configuration, and diagnostics never enter sync or Pro. An API spend key reaches the server when the user opts in to Pro cloud metering, which stores it encrypted. Signing out never changes local data.

Row level security limits each authenticated user to their own current snapshots. Direct client writes are revoked. A closed Edge Function authenticates the user and calls the storage procedure with the server resolved user identifier. Hosted traffic uses HTTPS and Supabase supplies storage encryption. Current snapshots expire after seven days without refresh. Pro history expires after ninety days.

The Pro session and local trust anchor stay in the operating system credential store. Signed device entitlements are checked offline against public keys embedded in the desktop build. Hosted routing context is treated as untrusted data and rebuilt from a closed shape before it reaches the coding agent hook.

## Supported versions

Security fixes go to the latest released version during the initial development period.
