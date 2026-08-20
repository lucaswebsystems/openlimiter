# OpenLimiter Pro

OpenLimiter is open source under Apache 2.0. OpenLimiter Pro is an optional set of hosted services whose server implementation is private.

## The public and private line

This public repository contains the entire local product, every connector, the engine, the command line tool, both dashboards, the local agent context block, and the Pro client contract. The Pro client includes sign in, checkout, offline entitlement verification, silent refresh, hosted calls, and the bounded context file read by the coding agent hook.

The separate private repository contains payment event handling, entitlement issuance, database migrations, and hosted service logic. No private key or server secret belongs in this repository.

Publishing the client is deliberate. You can inspect every network value the application sends and every rule used to accept a signed entitlement on your machine. The private service remains the operated product.

## Nothing local is ever paywalled

Every feature that runs on your machine is free and stays free. This promise covers every connector, every meter, every local notification, every dashboard, every command line feature, every statusline option, local advice, manual entry, and local ingestion.

An entitlement check protects only a hosted service call. If Pro access ends, the hosted services stop. The local application does not lose a feature, change a meter, or require a reinstall.

## What Pro contains

Pro contains exactly three hosted services.

1. Email when a provider crosses a chosen threshold or resets.
2. Ninety day usage history with burn rate forecasts.
3. Live budget context for coding agent routing.

The routing context is advice. The coding agent chooses whether to follow it. OpenLimiter never intercepts, executes, redirects, or authenticates an agent request.

Phone features, quota synchronization between devices, device management, weekly digests, team dashboards, and priority requests are not part of Pro.

## Price and trial

Pro costs $5 per month or $50 per year. The first 30 days are free and require no card. The clock starts at first sign in, not at download, and it cannot be restarted by creating another checkout session for the same account.

When the trial or subscription ends, only hosted access ends. Local mode remains unchanged.

Checkout redirects never grant access. A signed Stripe event must prove settled payment or an `active` or `trialing` subscription before the server activates paid Pro. A `past_due` subscription keeps hosted access for three days from its first signed transition, and repeated events cannot extend that deadline. `unpaid`, `canceled`, and `incomplete_expired` subscriptions lose paid access at the next refresh. A still active, nonrepeatable account trial remains available after cancellation. An expired trial cannot refresh.

## Entitlement behavior

The desktop verifies an Ed25519 signed device entitlement offline against public keys embedded at build time. The token lasts five days, requests a silent refresh after three days, and permits ten additional days of offline grace after expiry.

Each token is bound to one device identifier and carries a monotonic sequence plus a one time identifier. The client keeps its trust anchor and session in the operating system credential store. Older sequences are rejected. A pending request identifier makes retry idempotent, and a cache write can be recovered if the process stops before the trust write completes.

The credential store preserves the highest server timestamp ever observed. A local clock earlier than that timestamp beyond the accepted five minute tolerance fails closed and requires a server refresh. The client also persists consecutive failed entitlement refreshes. After 360 failures, offline entitlement expires even if the local clock is frozen. A successful refresh resets the counter.

Multiple embedded public keys may coexist, so a new signing key can overlap the old key during rotation. If the service is unavailable, a verified token continues through its bounded grace period and the additional failed refresh ceiling. Revocation stops refresh, so hosted access ends when that bounded allowance ends.

## What Pro sends

After explicit sign in, the desktop may send selected provider code, meter code, bounded usage percentage, and reset time to the hosted service. That data supports alerts, history, forecasts, and routing context.

Provider credentials, provider response bodies, prompts, source code, local configuration, and diagnostics never enter Pro. The returned routing context is treated as untrusted data and rebuilt from a closed shape before the coding agent hook reads it.

Local mode sends no data to OpenLimiter and needs no account.

## Public build configuration

The web portal needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Both are public Supabase client values. The desktop build needs `OPENLIMITER_PRO_URL` and `OPENLIMITER_PRO_PUBLIC_KEYS` at compile time. The key list uses comma separated `identifier:value` entries so two verification keys can overlap during rotation.

None of these values grants server write authority. Service role values, Stripe secrets, webhook secrets, and Ed25519 private keys must never enter a public build.
