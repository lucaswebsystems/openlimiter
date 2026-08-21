# Optional snapshot sync

OpenLimiter remains complete without an account. Sync is free, off by default, and has no entitlement check. Nothing leaves the machine until the user signs in and enables it. Signing out disables sync and removes only OpenLimiter account material. It never changes `openlimiter-cache.json`, local connectors, the tray, or local advice.

## Stored shape

The desktop constructs one closed row per quota window with `provider`, `account_label`, `window_name`, `usage_percent`, and `reset_at`. The request adds `event_id`, `device_id`, and `observed_at`. Account and device identifiers are opaque. Email addresses are rejected as account labels.

The sync database contains no field for provider credentials, provider tokens, provider response bodies, prompts, source code, local configuration, or diagnostics. Both the desktop and Edge Function rebuild the request from the closed shape. Extra input fields are discarded. A total sync database breach exposes quota display metadata and cannot reach a provider account.

## Desktop hooks for the visual lane

The Tauri backend exposes three commands.

1. `sync_status` returns `{ enabled, signed_in }`.

2. `sync_set_enabled` receives `{ input: { enabled } }`. Enabling requires an OpenLimiter session and performs the first upload. Disabling never changes local data.

3. `sync_now` uploads only when sync is enabled.

The existing `pro_set_session` command stores the Supabase access token in the operating system credential store. It no longer requires a Pro entitlement. `pro_disconnect` signs out, disables sync, and preserves local quota data.

## Web hook for the visual lane

`apps/web/lib/synced-usage.ts` exports `createSyncClient`, `readSyncedUsage`, and `groupLatestSyncedUsage`. The reader requires a current Supabase session, relies on row level security, merges duplicate device rows by the latest observation, and returns provider groups with one window object per line. The visual surface should render only window name, bar, percentage, and reset time for each line.

The Next application is already the PWA. The same authenticated reader supplies desktop browser and phone layouts. No separate mobile backend exists.

## Configuration

The web host receives `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. These are public client values. The desktop receives `OPENLIMITER_PRO_URL`, ending in `/functions/v1`, at compile time. Release builds require HTTPS. Debug builds permit plain HTTP only for `127.0.0.1` and `localhost` so local Supabase can be exercised safely.
