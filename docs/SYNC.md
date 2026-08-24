# Snapshot sync

The local product and the OpenLimiter account are free. The desktop requires sign in before its dashboard opens, while local collection keeps running even when the network is unavailable. A cached session keeps the application usable offline. Sync is free, enabled by default after sign in, and has no entitlement check. It can be turned off from the application menu. Signing out removes only OpenLimiter account material. It never changes `openlimiter-cache.json`, local connectors, the tray, or local advice.

## Stored shape

The desktop constructs one closed row per quota window with `provider`, `account_label`, `window_name`, `usage_percent`, and `reset_at`. The request adds `event_id`, `device_id`, and `observed_at`. Account and device identifiers are opaque. Email addresses are rejected as account labels.

The sync database contains no field for provider credentials, provider tokens, provider response bodies, prompts, source code, local configuration, or diagnostics. Both the desktop and Edge Function rebuild the request from the closed shape. Extra input fields are discarded. A total sync database breach exposes quota display metadata and cannot reach a provider account.

## Desktop commands

The Tauri backend exposes the account and sync commands used by the desktop interface.

1. `account_status` returns only configuration, sign in, email, sync preference and backend reachability. It never returns tokens.

2. `account_email` creates or signs in with email and password. When email confirmation is required, it returns a closed failure that tells the person to confirm and then sign in.

3. `account_oauth` supports Google and GitHub through PKCE and an exact loopback callback.

4. `account_set_sync` changes the clear sync switch. Disabling never changes local data.

5. `account_sync_configured_snapshot` uploads only configured providers and only when sync is enabled.

6. `account_logout` removes the OpenLimiter account session and preserves local quota data.

## Web hook for the visual lane

`apps/web/lib/synced-usage.ts` exports `createSyncClient`, `readSyncedUsage`, and `groupLatestSyncedUsage`. The reader requires a current Supabase session, relies on row level security, merges duplicate device rows by the latest observation, and returns provider groups with one window object per line. The visual surface should render only window name, bar, percentage, and reset time for each line.

The Next application is already the PWA. The same authenticated reader supplies desktop browser and phone layouts. No separate mobile backend exists.

## Configuration

The web host receives `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. These are public client values. The desktop receives `OPENLIMITER_SUPABASE_URL` and `OPENLIMITER_SUPABASE_ANON_KEY` at compile time. The key must use the public `sb_publishable_` format. The release workflow reads both values from GitHub Actions repository variables. They are never hardcoded. Pro calls separately receive `OPENLIMITER_PRO_URL`, ending in `/functions/v1`, at compile time. Release builds require HTTPS. Debug builds permit plain HTTP only for `127.0.0.1` and `localhost` so local Supabase can be exercised safely.
