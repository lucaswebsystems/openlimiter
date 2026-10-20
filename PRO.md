# OpenLimiter Pro

OpenLimiter is open source under Apache 2.0. OpenLimiter Pro is an optional set of hosted services. Its server code is private; the client that talks to it is public in this repository.

## Price, trial and refund

Pro costs USD 5 a month or USD 50 a year. Each account can try it free for 30 days with no card. A full refund is available on request within 14 days of any charge, and you can cancel at any time in the Stripe customer portal. Pro is sold by Lucas Costa, and Stripe processes the payments.

Start the trial from [openlimiter.com/pricing](https://openlimiter.com/pricing) or from Settings in the desktop app.

## What Pro adds

1. History: ninety days of synced readings, with a forecast.
2. Email and phone push alerts. Desktop alerts stay free.
3. More than one account per provider. Free keeps one active account per provider.
4. Cloud metering for the API spend keys you opt in, so spend is read while your computer is off. OpenAI and Anthropic spend needs an organisation admin key.

Pro also unlocks two cosmetic desktop extras: theme presets beyond the default, and the tagged caption preset. Dark and light stay free.

## What stays free

Every connector, meter and desktop alert is free and stays free, and so are the edge tab, the tray, agent activity, the terminal status line, the command line tool, local advice, manual entry and local ingestion, with one account per provider. A free account adds sync of current readings between your devices, the phone included.

An entitlement check protects hosted Pro work, more than one account per provider, and two cosmetic touches, theme presets and tagged status line captions. When a trial or subscription ends, the hosted services stop, extra accounts are no longer read (nothing is deleted), and the cosmetics return to the default look. Free sync and the local application keep every connector, meter and alert for one account per provider, with no reinstall.

## The public and private line

This public repository contains the entire local product, every connector, the engine, the command line tool, both dashboards, the local agent context block, and the Pro client contract. The Pro client includes sign in, checkout, offline entitlement verification, silent refresh, hosted calls, and the bounded context file read by the coding agent hook.

The separate private repository contains payment event handling, entitlement issuance, cloud metering, database migrations, and hosted service logic. No private key or server secret belongs in this repository.

Publishing the client is deliberate. You can inspect every network value the application sends and every rule used to accept a signed entitlement on your machine. The private service remains the operated product.

## Subscription states

Checkout redirects never grant access. A signed Stripe event must prove settled payment or an `active` or `trialing` subscription before the server activates paid Pro. A `past_due` subscription keeps hosted access for three days from the signed event that made it past due, and repeated events cannot extend that deadline. `unpaid`, `canceled`, and `incomplete_expired` subscriptions lose paid access at the next refresh. A trial that is still running stays available after cancellation, and each account gets one trial. An expired trial cannot refresh.

## Entitlement behaviour

The desktop verifies an Ed25519 signed device entitlement offline against public keys embedded at build time. A token asks for a silent refresh after twelve hours, expires after a day, and is honoured offline for up to three days from issue. The server clips each of those deadlines at the end of paid or trial access.

Each token is bound to one device identifier and carries a monotonic sequence plus a one time identifier. The client keeps its trust anchor and session in the operating system credential store. Older sequences are rejected. A pending request identifier makes retry idempotent, and a cache write can be recovered if the process stops before the trust write completes.

The credential store preserves the highest server timestamp ever observed. A local clock earlier than that timestamp beyond the accepted five minute tolerance fails closed and requires a server refresh. The client also persists consecutive failed entitlement refreshes. After 360 failures, offline entitlement expires even if the local clock is frozen. A successful refresh resets the counter.

Multiple embedded public keys may coexist, so a new signing key can overlap the old key during rotation. If the service is unavailable, a verified token continues through its bounded grace period and the failed refresh ceiling. Revocation stops refresh, so hosted access ends when that bounded allowance ends.

## What sync and Pro receive

After sign in, the desktop may send provider code, opaque account label, window name, bounded usage percentage, reset time, observation time, the amount and currency of balance meters, and opaque device identifier. Each API spend key adds a row with a random key identifier, the name you gave the key, its provider, the month, the amount spent in US dollars, your budget if you set one, the period that amount covers and whether that period is complete. A free account sends these API spend rows with every sync; a device with a Pro or trial entitlement sends them only when that entitlement includes the API spend feature. Sync is on by default after sign in and can be turned off. Free accounts keep current snapshots. Pro accounts also keep ninety days of samples for alerts, history, forecasts, and routing context.

Subscription logins, provider response bodies, prompts, source code, local configuration, and diagnostics never enter sync or Pro. The database has no column for them. Extra JSON fields are discarded before storage. A breach of the sync tables exposes quota readings and, where they sync, API spend key names, amounts and budgets, and cannot reach a provider account. The returned routing context is treated as untrusted data and rebuilt from a closed shape before the coding agent hook reads it.

Cloud metering is the one exception, and you choose it: an API spend key you opt in travels once to the server, is stored encrypted, and is never sent back. Without it, API spend keys stay in this device's keyring.

## Public build configuration

The web portal needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Both are public Supabase client values. The desktop build needs `OPENLIMITER_PRO_URL` and `OPENLIMITER_PRO_PUBLIC_KEYS` at compile time. The key list uses comma separated `identifier:value` entries so two verification keys can overlap during rotation.

None of these values grants server write authority. Service role values, Stripe secrets, webhook secrets, and Ed25519 private keys must never enter a public build.
