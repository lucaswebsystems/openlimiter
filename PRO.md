# OpenLimiter Pro

OpenLimiter is open source under Apache 2.0. OpenLimiter Pro is an optional set of hosted services whose server implementation is private.

## The public and private line

This public repository contains the entire local product, every connector, the engine, the command line tool, both dashboards, the local agent context block, and the Pro client contract. The Pro client includes sign in, checkout, offline entitlement verification, silent refresh, hosted calls, and the bounded context file read by the coding agent hook.

The separate private repository contains payment event handling, entitlement issuance, database migrations, and hosted service logic. No private key or server secret belongs in this repository.

Publishing the client is deliberate. You can inspect every network value the application sends and every rule used to accept a signed entitlement on your machine. The private service remains the operated product.

## Nothing local is ever paywalled

Every feature that runs on your machine is free and stays free. This promise covers every connector, every meter, every local notification, every dashboard, every command line feature, every statusline option, local advice, manual entry, and local ingestion.

An entitlement check protects only hosted Pro work. If Pro access ends, those services stop. Free sync and the local application continue. The local application does not lose a feature, change a meter, or require a reinstall.

Snapshot sync is free, enabled by default after sign in, and never entitlement gated. It sends only usage percentages and can be turned off at any time. Signing out never changes or deletes the local cache.

## What Pro contains

Pro is not available for purchase yet. Its planned deliverables are these six areas.

1. Email and phone push notifications with custom thresholds, quiet hours, and a daily digest.
2. Token based accent and background variants. Dark and light remain free.
3. More than one subscription per provider.
4. Features for heavy API usage.
5. Ninety day usage history with burn rate forecasts.
6. Live budget context for coding agent routing.

The routing context is advice. The coding agent chooses whether to follow it. OpenLimiter never intercepts, executes, redirects, or authenticates an agent request.

Current quota synchronization between devices and the phone PWA is free. Device management, team dashboards, and priority requests are not part of Pro.

## Price and trial

Pro is planned at $5 per month or $50 per year. Checkout is not available before every promised launch requirement is implemented, activated, and proven.

When the trial or subscription ends, only hosted access ends. Local mode remains unchanged.

Checkout redirects never grant access. A signed Stripe event must prove settled payment or an `active` or `trialing` subscription before the server activates paid Pro. A `past_due` subscription keeps hosted access for three days from its first signed transition, and repeated events cannot extend that deadline. `unpaid`, `canceled`, and `incomplete_expired` subscriptions lose paid access at the next refresh. A still active, nonrepeatable account trial remains available after cancellation. An expired trial cannot refresh.

## Entitlement behavior

The desktop verifies an Ed25519 signed device entitlement offline against public keys embedded at build time. The token lasts five days, requests a silent refresh after three days, and permits ten additional days of offline grace after expiry.

Each token is bound to one device identifier and carries a monotonic sequence plus a one time identifier. The client keeps its trust anchor and session in the operating system credential store. Older sequences are rejected. A pending request identifier makes retry idempotent, and a cache write can be recovered if the process stops before the trust write completes.

The credential store preserves the highest server timestamp ever observed. A local clock earlier than that timestamp beyond the accepted five minute tolerance fails closed and requires a server refresh. The client also persists consecutive failed entitlement refreshes. After 360 failures, offline entitlement expires even if the local clock is frozen. A successful refresh resets the counter.

Multiple embedded public keys may coexist, so a new signing key can overlap the old key during rotation. If the service is unavailable, a verified token continues through its bounded grace period and the additional failed refresh ceiling. Revocation stops refresh, so hosted access ends when that bounded allowance ends.

## What optional sync sends

After sign in, the desktop may send selected provider code, opaque account label, window name, bounded usage percentage, reset time, observation time, and opaque device identifier. Sync defaults on and can be turned off. Free accounts retain only current snapshots. Entitled accounts also retain ninety day samples for alerts, history, forecasts, and routing context.

Provider credentials, provider response bodies, prompts, source code, local configuration, and diagnostics never enter sync or Pro. The database has no column for them. Extra JSON fields are discarded before storage. A total sync database breach exposes quota display metadata and cannot reach a provider account. The returned routing context is treated as untrusted data and rebuilt from a closed shape before the coding agent hook reads it.

The local product and the OpenLimiter account are free. Local collection keeps running offline. Only usage percentages sync, never keys or credentials, and sync can be turned off.

## Public build configuration

The web portal needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Both are public Supabase client values. The desktop build needs `OPENLIMITER_PRO_URL` and `OPENLIMITER_PRO_PUBLIC_KEYS` at compile time. The key list uses comma separated `identifier:value` entries so two verification keys can overlap during rotation.

None of these values grants server write authority. Service role values, Stripe secrets, webhook secrets, and Ed25519 private keys must never enter a public build.
