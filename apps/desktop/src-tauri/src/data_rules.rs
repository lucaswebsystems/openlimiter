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
    if row.window.kind == "unknown"
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

pub(crate) fn fix_kind(reason: &str) -> &'static str {
    match reason {
        "disabled" => "switch_on",
        "missing_credentials" => "sign_in",
        "expired_credentials" | "stale" | "rate_limited" | "network_failure" | "not_measured" => {
            "open_app"
        }
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
        let rejected = if disabled.contains(&row.provider) {
            Some("disabled")
        } else if row.availability.is_some() {
            row.availability.as_deref()
        } else if active.get(&row.provider).is_some_and(|accounts| {
            row.account_id
                .as_ref()
                .is_none_or(|id| !accounts.contains(id))
        }) {
            Some("account_not_connected")
        } else {
            reason(&row, now)
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

pub fn for_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    rows: Vec<Snapshot>,
    now: i64,
) -> Projection {
    use crate::provider_detection::DetectedProviderId;
    let mut active = ActiveAccounts::new();
    let mut disabled = BTreeSet::new();
    if let Some(store) = app.try_state::<crate::provider_detection::DetectionStore>() {
        for provider in DetectedProviderId::ALL {
            let code = provider.slug().to_uppercase().replace('-', "_");
            active.insert(
                code.clone(),
                store.display_account_ids(provider).into_iter().collect(),
            );
            if !store.switches.enabled(provider) {
                disabled.insert(code);
            }
        }
    }
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
