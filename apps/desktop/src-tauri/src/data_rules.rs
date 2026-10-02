//! Display policy is independent of cache storage. TypeScript twin: data-rules.ts.
use crate::native_snapshot::Snapshot;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use tauri::Manager;

pub const RETENTION_MS: u64 = 7 * 86_400_000;

pub(crate) fn retained(row: &Snapshot, now: u64) -> bool {
    crate::native_time::epoch_ms_from_rfc3339(&row.observed_at)
        .is_some_and(|at| at >= now.saturating_sub(RETENTION_MS))
}

pub(crate) fn freshness_policy(source: &str, observed: i64, now: i64) -> (u64, i64, &'static str) {
    freshness_for("", "", source, observed, now)
}

pub(crate) fn freshness_for(
    provider: &str,
    writer: &str,
    source: &str,
    observed: i64,
    now: i64,
) -> (u64, i64, &'static str) {
    let interval = if source == "native_payload" {
        60
    } else if writer == "desktop" {
        use crate::provider_detection::DetectedProviderId;
        DetectedProviderId::ALL
            .into_iter()
            .find(|id| id.slug().to_uppercase().replace('-', "_") == provider)
            .map(crate::request_policy::provider_interval_seconds)
            .unwrap_or(900) as i64
    } else {
        900
    };
    let ttl = interval * 120 / 100 + 60;
    let expires = observed.saturating_add(ttl * 1000);
    (
        ttl as u64,
        expires,
        if now < observed {
            "unavailable"
        } else if now < expires {
            "fresh"
        } else {
            "stale"
        },
    )
}

fn row_freshness(row: &Snapshot, observed: i64, now: i64) -> (u64, i64, &'static str) {
    freshness_for(
        &row.provider,
        row.writer.as_deref().unwrap_or(""),
        &row.source,
        observed,
        now,
    )
}

pub(crate) fn reason(row: &Snapshot, now: i64) -> Option<&str> {
    if let Some(reason) = row.availability.as_deref() {
        return Some(reason);
    }
    // Spend past its cap is still a real reading, so only the bounds are checked.
    let bounded_spend = row.used_amount.is_some_and(|used| used.is_finite() && used >= 0.0)
        && row.limit_amount.is_some_and(|limit| limit.is_finite() && limit > 0.0)
        && row.currency.as_deref() == Some("USD");
    if row.window.kind == "unknown" && !bounded_spend
        || row.kind.as_deref() == Some("runtime_info")
        || row.meter == "ACQUISITION"
    {
        return Some("placeholder");
    }
    if !row.value.is_finite() || row.value < 0.0 || (row.unit == "PERCENT" && row.value > 100.0) {
        return Some("quota_unavailable");
    }
    let Some(observed) = crate::native_time::epoch_ms_from_rfc3339(&row.observed_at) else {
        return Some("stale");
    };
    (row_freshness(row, observed as i64, now).2 != "fresh").then_some("stale")
}

/// A reading Claude Code handed its status line. TypeScript twin: `claudeStatusline`.
fn claude_statusline(row: &Snapshot) -> bool {
    let provenance = |key: &str| {
        row.provenance
            .as_ref()
            .and_then(|value| value.get(key))
            .and_then(serde_json::Value::as_str)
    };
    row.provider == "CLAUDE"
        && provenance("sourceKind") == Some("statusline_payload")
        && provenance("observedVia") == Some("claude_code_statusline")
}

/// Freshness is not visibility, for Claude status line rows only.
///
/// Claude Code writes them only while it runs, so an idle session would lose
/// its card after two minutes. A stale row stays displayable (its age shows)
/// until its window resets; after that the honest answer is waiting for Claude
/// Code, never a number nobody measured. TypeScript twin: `heldReason`.
fn held_reason<'a>(row: &Snapshot, reason: Option<&'a str>, now: i64) -> Option<&'a str> {
    let observed = crate::native_time::epoch_ms_from_rfc3339(&row.observed_at);
    if reason != Some("stale")
        || !claude_statusline(row)
        || !observed.is_some_and(|at| at as i64 <= now)
    {
        return reason;
    }
    let reset = row
        .reset_at
        .as_deref()
        .and_then(crate::native_time::epoch_ms_from_rfc3339);
    if reset.is_some_and(|at| now < at as i64) {
        None
    } else {
        Some("awaiting_statusline")
    }
}

pub(crate) fn fix_kind(reason: &str) -> &'static str {
    match reason {
        "disabled" => "switch_on",
        "missing_credentials" | "account_unresolved" => "sign_in",
        "expired_credentials" | "stale" | "rate_limited" | "network_failure" | "not_measured"
        | "awaiting_statusline" => "open_app",
        "quota_unavailable" | "unlimited" | "placeholder" | "schema_drift" => "unsupported",
        _ => "reconnect",
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionFlag {
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub reason: String,
    pub fix_kind: &'static str,
}

#[derive(Serialize)]
pub struct Projection {
    pub snapshots: Vec<Snapshot>,
    pub flags: Vec<ConnectionFlag>,
}

pub type ActiveAccounts = BTreeMap<String, BTreeSet<String>>;

#[derive(Default)]
pub struct ConnectionIdentities(pub std::sync::Mutex<BTreeMap<String, (String, String)>>);

pub fn project(
    rows: Vec<Snapshot>,
    now: i64,
    active: &ActiveAccounts,
    disabled: &BTreeSet<String>,
) -> Projection {
    let mut snapshots = Vec::new();
    let mut flags = BTreeMap::new();
    for mut row in rows {
        if borrowed_from_inactive_gemini(&row, active) {
            continue;
        }
        let rejected = if disabled.contains(&row.provider) {
            Some("disabled")
        } else if row.availability.is_some() {
            row.availability.as_deref()
        } else if active.get(&row.provider).is_some_and(|accounts| {
            row.account_id
                .as_ref()
                .is_none_or(|id| !accounts.contains(id))
        }) {
            /* An anonymous status line row cannot be attributed, so it is never
            shown; its fix is a fresh Claude sign in that writes the account down. */
            if row.account_id.is_none() && claude_statusline(&row) {
                Some("account_unresolved")
            } else {
                Some("account_not_connected")
            }
        } else {
            held_reason(&row, reason(&row, now), now)
        };
        if let Some(reason) = rejected {
            let flag = ConnectionFlag {
                provider: row.provider.clone(),
                account_id: row.account_id.clone(),
                reason: reason.into(),
                fix_kind: fix_kind(reason),
            };
            flags.insert(
                (
                    flag.provider.clone(),
                    flag.account_id.clone(),
                    flag.reason.clone(),
                ),
                flag,
            );
        } else {
            if let Some(observed) = crate::native_time::epoch_ms_from_rfc3339(&row.observed_at) {
                row.expires_at = crate::cache_write::policy_iso(
                    row_freshness(&row, observed as i64, now).1 as u64,
                );
            }
            snapshots.push(row);
        }
    }
    Projection {
        snapshots,
        flags: flags.into_values().collect(),
    }
}

/// The active accounts detection vouches for, and the providers switched off.
pub(crate) fn detected_policy(
    store: &crate::provider_detection::DetectionStore,
) -> (ActiveAccounts, BTreeSet<String>) {
    let mut active = ActiveAccounts::new();
    let mut disabled = BTreeSet::new();
    for provider in crate::provider_detection::DetectedProviderId::ALL {
        let code = provider.slug().to_uppercase().replace('-', "_");
        active.insert(
            code.clone(),
            store.display_account_ids(provider).into_iter().collect(),
        );
        if !store.switches.enabled(provider) {
            disabled.insert(code);
        }
    }
    (active, disabled)
}

/// Identities a reading may legitimately carry without a detected login.
///
/// The Antigravity local probe needs no credential, and files its rows under
/// the provider singleton whenever no Antigravity login or connection is known
/// (`antigravity_oauth::run_pass`), so that identity is accepted exactly then.
/// The Gemini fallback files the shared Code Assist pool under the Gemini
/// login each reading was taken for, legitimate exactly while that login is.
pub(crate) fn register_local_identities(active: &mut ActiveAccounts, disabled: &BTreeSet<String>) {
    use crate::provider_detection::{provider_singleton_account_id, DetectedProviderId};
    if disabled.contains("ANTIGRAVITY") {
        return;
    }
    let gemini = if disabled.contains("GEMINI_CLI") {
        BTreeSet::new()
    } else {
        active.get("GEMINI_CLI").cloned().unwrap_or_default()
    };
    let accounts = active.entry("ANTIGRAVITY".into()).or_default();
    if accounts.is_empty() {
        accounts.insert(provider_singleton_account_id(DetectedProviderId::Antigravity));
    }
    accounts.extend(gemini);
}

/// An Antigravity row borrowed from a Gemini login (`gemini-cli-` is that
/// provider's account id prefix, and 2.0.2 and the terminal build use
/// `gemini-cli-shared`, which names no login). One whose login is not active
/// is dropped without a flag: the Gemini row already offers the fix for its
/// own login, and Antigravity's reconnect would be the wrong one.
fn borrowed_from_inactive_gemini(row: &Snapshot, active: &ActiveAccounts) -> bool {
    row.provider == "ANTIGRAVITY"
        && row.account_id.as_deref().is_some_and(|id| {
            id.starts_with("gemini-cli-")
                && active
                    .get("ANTIGRAVITY")
                    .is_some_and(|accounts| !accounts.contains(id))
        })
}

pub fn for_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    rows: Vec<Snapshot>,
    now: i64,
) -> Projection {
    let (mut active, disabled) = app
        .try_state::<crate::provider_detection::DetectionStore>()
        .map(|store| detected_policy(&store))
        .unwrap_or_default();
    if let Some(store) = app.try_state::<crate::connections::ConnectionsStore>() {
        for connection in store
            .list()
            .unwrap_or_default()
            .into_iter()
            .filter(|c| c.is_active())
        {
            let provider = crate::poll_identity::detected_provider(connection.provider_id);
            let known = app
                .try_state::<ConnectionIdentities>()
                .and_then(|state| state.0.lock().ok()?.get(&connection.id).cloned());
            if let Some((code, id)) = known {
                active.entry(code).or_default().insert(id);
            } else if let Some(id) = connection.codex_account_id.as_deref() {
                active
                    .entry(provider.slug().to_uppercase().replace('-', "_"))
                    .or_default()
                    .insert(crate::provider_detection::opaque_account_id(provider, id));
            }
        }
    }
    register_local_identities(&mut active, &disabled);
    let mut result = project(rows, now, &active, &disabled);
    if let Some(store) = app.try_state::<crate::provider_detection::DetectionStore>() {
        for provider in store.report().providers {
            let code = provider.provider_id.slug().to_uppercase().replace('-', "_");
            if provider.state == crate::provider_detection::ProviderPresence::InstalledLoggedOut
                && !result.snapshots.iter().any(|row| row.provider == code)
            {
                result.flags.push(ConnectionFlag {
                    provider: code.clone(),
                    account_id: None,
                    reason: "missing_credentials".into(),
                    fix_kind: "sign_in",
                });
            }
            for account in provider.accounts {
                if result.snapshots.iter().any(|row| {
                    row.provider == code && row.account_id.as_deref() == Some(&account.account_id)
                }) || result.flags.iter().any(|flag| {
                    flag.provider == code && flag.account_id.as_deref() == Some(&account.account_id)
                }) {
                    continue;
                }
                let reason =
                    if account.auth_state == crate::provider_detection::DetectedAuthState::Stale {
                        "expired_credentials"
                    } else if !account.automatic_collection {
                        "quota_unavailable"
                    } else {
                        "not_measured"
                    };
                result.flags.push(ConnectionFlag {
                    provider: code.clone(),
                    account_id: Some(account.account_id),
                    reason: reason.into(),
                    fix_kind: fix_kind(reason),
                });
            }
        }
    }
    for provider in disabled {
        if !result
            .flags
            .iter()
            .any(|flag| flag.provider == provider && flag.reason == "disabled")
        {
            result.flags.push(ConnectionFlag {
                provider,
                account_id: None,
                reason: "disabled".into(),
                fix_kind: "switch_on",
            });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn measured(account: Option<&str>) -> Snapshot {
        serde_json::from_value(serde_json::json!({
            "provider": "CLAUDE", "meter": "FIVE_HOUR", "accountId": account,
            "value": 0, "unit": "PERCENT", "kind": "quota_percent",
            "window": { "kind": "rolling", "durationSeconds": 18000 }, "resetAt": null,
            "source": "internal_payload", "precision": "exact",
            "observedAt": "2026-09-29T12:00:00.000Z", "expiresAt": "2026-09-29T12:20:00.000Z",
            "labels": { "credentialOrigin": "official-local-tool", "dataInterfaceStatus": "internal-endpoint", "automationRisk": "high", "verification": "UNVERIFIED" }
        })).unwrap()
    }

    #[test]
    fn extra_usage_past_its_cap_is_still_a_reading() {
        let now =
            crate::native_time::epoch_ms_from_rfc3339("2026-09-29T12:00:00.000Z").unwrap() as i64;
        let mut spend = measured(Some("fixture"));
        spend.meter = "EXTRA_USAGE".to_string();
        spend.window.kind = "unknown".to_string();
        spend.value = 100.0;
        spend.used_amount = Some(25.0);
        spend.limit_amount = Some(20.0);
        spend.currency = Some("USD".to_string());
        assert_eq!(reason(&spend, now), None);
    }

    #[test]
    fn active_identity_is_not_inferred_from_recency_and_flags_name_specific_fixes() {
        let now =
            crate::native_time::epoch_ms_from_rfc3339("2026-09-29T12:00:00.000Z").unwrap() as i64;
        let a = measured(Some("fixture-a"));
        let b = measured(Some("fixture-b"));
        let anonymous = measured(None);
        let active = BTreeMap::from([(
            "CLAUDE".into(),
            BTreeSet::from(["fixture-a".into(), "fixture-b".into()]),
        )]);
        let projection = project(
            vec![a.clone(), b.clone(), anonymous],
            now,
            &active,
            &BTreeSet::new(),
        );
        assert_eq!(projection.snapshots.len(), 2);
        assert_eq!(projection.flags[0].reason, "account_not_connected");
        let switched = BTreeMap::from([("CLAUDE".into(), BTreeSet::from(["fixture-b".into()]))]);
        let mut delayed = a;
        delayed.observed_at = "2026-09-29T12:00:01.000Z".into();
        assert_eq!(
            project(
                vec![delayed, b.clone()],
                now + 1000,
                &switched,
                &BTreeSet::new()
            )
            .snapshots
            .len(),
            1
        );
        let mut expired = b;
        expired.availability = Some("expired_credentials".into());
        let projection = project(vec![expired], now, &switched, &BTreeSet::new());
        assert!(projection.snapshots.is_empty());
        assert_eq!(projection.flags[0].fix_kind, "open_app");
        assert_eq!(fix_kind("disabled"), "switch_on");
        assert_eq!(fix_kind("missing_credentials"), "sign_in");
        assert_eq!(fix_kind("placeholder"), "unsupported");
    }
    /// The TypeScript twin of these cases is
    /// `packages/core/test/data-rules.test.ts`, "Claude status line rows".
    fn statusline(account: Option<&str>) -> Snapshot {
        serde_json::from_value(serde_json::json!({
            "provider": "CLAUDE", "meter": "FIVE_HOUR", "accountId": account,
            "value": 37, "unit": "PERCENT", "kind": "quota_percent",
            "window": { "kind": "rolling", "durationSeconds": 18000 },
            "resetAt": "2026-09-29T14:00:00.000Z",
            "source": "native_payload", "precision": "exact",
            "observedAt": "2026-09-29T12:00:00.000Z", "expiresAt": "2026-09-29T12:01:00.000Z",
            "provenance": { "sourceKind": "statusline_payload", "observedVia": "claude_code_statusline" },
            "labels": { "credentialOrigin": "official-local-tool", "dataInterfaceStatus": "native-statusline-payload", "automationRisk": "low", "verification": "UNVERIFIED" }
        }))
        .unwrap()
    }

    #[test]
    fn an_idle_claude_status_line_keeps_its_reading_until_reset_then_waits() {
        let observed =
            crate::native_time::epoch_ms_from_rfc3339("2026-09-29T12:00:00.000Z").unwrap() as i64;
        let minutes = |count: i64| observed + count * 60_000;
        let active = BTreeMap::from([("CLAUDE".into(), BTreeSet::from(["fixture-a".into()]))]);
        let held = project(
            vec![statusline(Some("fixture-a"))],
            minutes(45),
            &active,
            &BTreeSet::new(),
        );
        assert!(held.flags.is_empty());
        assert_eq!(held.snapshots.len(), 1);
        assert_eq!(held.snapshots[0].value, 37.0);
        assert_eq!(held.snapshots[0].expires_at, "2026-09-29T12:02:12.000Z");
        let waiting = project(
            vec![statusline(Some("fixture-a"))],
            minutes(121),
            &active,
            &BTreeSet::new(),
        );
        assert!(waiting.snapshots.is_empty());
        assert_eq!(waiting.flags[0].reason, "awaiting_statusline");
        assert_eq!(waiting.flags[0].fix_kind, "open_app");
        let mut unknown_reset = statusline(Some("fixture-a"));
        unknown_reset.reset_at = None;
        assert_eq!(
            project(vec![unknown_reset], minutes(5), &active, &BTreeSet::new()).flags[0].reason,
            "awaiting_statusline"
        );
        /* Every other source keeps its own expiry. */
        let mut codex = statusline(None);
        codex.provider = "CODEX".into();
        let mut polled = statusline(Some("fixture-a"));
        polled.provenance = Some(serde_json::json!({ "sourceKind": "remote_api", "observedVia": "local_event" }));
        polled.source = "internal_payload".into();
        let mut antigravity = statusline(None);
        antigravity.provider = "ANTIGRAVITY".into();
        antigravity.provenance = Some(serde_json::json!({ "sourceKind": "statusline_payload", "observedVia": "local_command" }));
        let others = project(vec![codex, polled, antigravity], minutes(45), &active, &BTreeSet::new());
        assert!(others.snapshots.is_empty());
        assert!(others.flags.iter().all(|flag| flag.reason == "stale"));
        assert_eq!(others.flags.len(), 3);
    }

    #[test]
    fn an_anonymous_claude_status_line_row_asks_to_sign_in_again() {
        let now =
            crate::native_time::epoch_ms_from_rfc3339("2026-09-29T12:00:00.000Z").unwrap() as i64;
        let free = BTreeMap::from([("CLAUDE".into(), BTreeSet::from(["fixture-a".into()]))]);
        let rows = vec![
            statusline(Some("fixture-a")),
            statusline(Some("fixture-b")),
            statusline(None),
        ];
        let projection = project(rows.clone(), now, &free, &BTreeSet::new());
        assert_eq!(projection.snapshots.len(), 1);
        let reasons: Vec<_> = projection
            .flags
            .iter()
            .map(|flag| (flag.reason.as_str(), flag.fix_kind))
            .collect();
        assert!(reasons.contains(&("account_unresolved", "sign_in")));
        assert!(reasons.contains(&("account_not_connected", "reconnect")));
        let pro = BTreeMap::from([(
            "CLAUDE".into(),
            BTreeSet::from(["fixture-a".into(), "fixture-b".into()]),
        )]);
        let projection = project(rows, now, &pro, &BTreeSet::new());
        assert_eq!(projection.snapshots.len(), 2);
        assert_eq!(projection.flags.len(), 1);
        assert_eq!(projection.flags[0].reason, "account_unresolved");
    }

    #[test]
    fn all_provider_cadences_match_typescript() {
        for provider in [
            "CLAUDE",
            "CODEX",
            "GEMINI_CLI",
            "ANTIGRAVITY",
            "GROK",
            "KIMI",
            "CURSOR",
            "OPENROUTER",
            "OPENCODE",
        ] {
            let ttl = match provider {
                "CLAUDE" | "GEMINI_CLI" => 1140,
                "ANTIGRAVITY" => 780,
                _ => 420,
            };
            assert_eq!(
                freshness_for(provider, "desktop", "internal_payload", 0, 0).0,
                ttl
            );
            assert_eq!(
                freshness_for(provider, "cli", "internal_payload", 0, 0).0,
                1140
            );
        }
    }
    #[test]
    fn jitter_latency_sleep_failure_and_recovery() {
        for (source, interval) in [
            ("native_payload", 60),
            ("internal_payload", 900),
            ("documented_api", 900),
        ] {
            let jittered = interval * 120 / 100 * 1000;
            assert_eq!(freshness_policy(source, 0, jittered + 59_999).2, "fresh");
            assert_eq!(freshness_policy(source, 0, jittered + 60_000).2, "stale");
            assert_eq!(freshness_policy(source, 0, 86_400_000).2, "stale");
            assert_eq!(freshness_policy(source, 86_400_000, 86_400_001).2, "fresh");
        }
    }
}
