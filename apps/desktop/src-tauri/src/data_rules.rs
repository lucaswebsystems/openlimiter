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

/// What one reading's number is: the meter contract. TypeScript twin:
/// `meterReading` in packages/core/src/data-rules.ts, held to the same answers
/// by packages/core/src/contracts/meter-vectors.json.
///
/// A PERCENT value is the used share, whatever quota kind it names; only
/// money_balance without a used and limit pair contradicts it. Direction on
/// any other unit comes from `kind` alone: money_balance is what remains,
/// spend and token_count are what was used, and no kind means no stated
/// direction. Only a percent has a used share to draw. Credits with a used and
/// limit pair and no kind are the shape written before the contract, and keep
/// reading as the used share they are.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Measure {
    /// percent, balance, spend, count or amount.
    pub kind: &'static str,
    /// used, remaining, or None when the reader never said.
    pub direction: Option<&'static str>,
    pub used_percent: Option<f64>,
    pub currency: Option<String>,
}

pub(crate) fn measure(row: &Snapshot) -> Option<Measure> {
    measure_fields(&MeterFields {
        value: row.value,
        unit: &row.unit,
        kind: row.kind.as_deref(),
        availability: row.availability.is_some(),
        pair: row.used_amount.is_some() && row.limit_amount.is_some() && row.currency.is_some(),
        currency: row.currency.as_deref(),
    })
}

/// The fields the meter contract reads, for a boundary that holds a row as
/// raw JSON rather than a `Snapshot` (the sync upload).
pub(crate) struct MeterFields<'a> {
    pub value: f64,
    pub unit: &'a str,
    pub kind: Option<&'a str>,
    pub availability: bool,
    /// A used amount, a limit amount and a currency, all three.
    pub pair: bool,
    pub currency: Option<&'a str>,
}

pub(crate) fn measure_fields(row: &MeterFields<'_>) -> Option<Measure> {
    if row.availability || row.kind == Some("runtime_info") {
        return None;
    }
    if !row.value.is_finite() || row.value < 0.0 {
        return None;
    }
    let percent = |value: f64| Measure {
        kind: "percent",
        direction: Some("used"),
        used_percent: Some(value),
        currency: row.pair.then(|| row.currency.map(str::to_string)).flatten(),
    };
    let other = |kind: &'static str, direction: Option<&'static str>| Measure {
        kind,
        direction,
        used_percent: None,
        currency: row.currency.map(str::to_string),
    };
    if row.unit == "PERCENT" {
        /* A percent may name the quota it measures, but not what is left,
        unless the money pair makes it the used share of that money. */
        let contradicted = row.kind == Some("money_balance") && !row.pair;
        return (!contradicted && row.value <= 100.0).then(|| percent(row.value));
    }
    match row.kind {
        None if row.pair => (row.value <= 100.0).then(|| percent(row.value)),
        None => Some(other("amount", None)),
        Some("money_balance") => Some(other("balance", Some("remaining"))),
        Some("spend") => Some(other("spend", Some("used"))),
        Some("token_count") => Some(other("count", Some("used"))),
        Some(_) => None,
    }
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
    // A unit and kind that contradict each other have no reading to draw.
    if measure(row).is_none() {
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

/// Availabilities that are an answer about the account connected now rather
/// than something to fix. TypeScript twin: `CONNECTION_NOTE_REASONS`.
pub(crate) const CONNECTION_NOTE_REASONS: &[&str] = &["unlimited"];

/// What the last collection pass knew about saved connections and the plan,
/// so projection makes the same account selection collection made.
#[derive(Clone, Default)]
pub struct IdentityPlan {
    /// Every saved record: connection id to (provider code, identity).
    pub saved: BTreeMap<String, (String, String)>,
    /// Whether the plan allows every account (Pro). Free until a pass says.
    pub multi_account: bool,
}

#[derive(Default)]
pub struct ConnectionIdentities(pub std::sync::Mutex<IdentityPlan>);

pub fn project(
    rows: Vec<Snapshot>,
    now: i64,
    active: &ActiveAccounts,
    disabled: &BTreeSet<String>,
) -> Projection {
    let mut snapshots = Vec::new();
    let mut flags = BTreeMap::new();
    for mut row in rows {
        let note = row
            .availability
            .as_deref()
            .is_some_and(|reason| CONNECTION_NOTE_REASONS.contains(&reason));
        let rejected = if disabled.contains(&row.provider) {
            Some("disabled")
        } else if row.availability.is_some() && !note {
            row.availability.as_deref()
        } else if active.get(&row.provider).is_some_and(|accounts| {
            row.account_id
                .as_ref()
                .is_none_or(|id| !accounts.contains(id))
        }) {
            Some("account_not_connected")
        } else if note {
            /* A note speaks for the account connected now, and only while it
            is fresh: an old answer is stale like any old reading. */
            let fresh = crate::native_time::epoch_ms_from_rfc3339(&row.observed_at)
                .is_some_and(|observed| row_freshness(&row, observed as i64, now).2 == "fresh");
            if fresh {
                row.availability.as_deref()
            } else {
                Some("stale")
            }
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

/// The accounts every surface treats as active, per provider code: each saved
/// connection's identity, and the detected accounts the automatic pass would
/// read, chosen by the same decision collection makes (saved keys first, then
/// the plan's cap, in a stable order). The status line reads this too.
pub(crate) fn active_accounts<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> ActiveAccounts {
    use crate::provider_detection::DetectedProviderId;
    let code = |provider: DetectedProviderId| provider.slug().to_uppercase().replace('-', "_");
    let plan = app
        .try_state::<ConnectionIdentities>()
        .and_then(|state| state.0.lock().ok().map(|plan| plan.clone()))
        .unwrap_or_default();
    let records = app
        .try_state::<crate::connections::ConnectionsStore>()
        .and_then(|store| store.list().ok())
        .unwrap_or_default();
    let mut saved = ActiveAccounts::new();
    let mut covered = std::collections::HashSet::new();
    let mut known = std::collections::HashSet::new();
    for record in &records {
        let provider = crate::poll_identity::detected_provider(record.provider_id);
        known.insert(provider);
        let identity = plan.saved.get(&record.id).map(|(_, id)| id.clone()).or_else(|| {
            record
                .codex_account_id
                .as_deref()
                .map(|id| crate::provider_detection::opaque_account_id(provider, id))
        });
        let Some(identity) = identity else {
            continue;
        };
        covered.insert(crate::poll_identity::PollIdentity::detected(
            record.provider_id,
            identity.clone(),
        ));
        if record.is_active() {
            saved.entry(code(provider)).or_default().insert(identity);
        }
    }
    let mut active = ActiveAccounts::new();
    if let Some(store) = app.try_state::<crate::provider_detection::DetectionStore>() {
        for provider in DetectedProviderId::ALL.into_iter().filter(|p| p.enabled()) {
            let limit = crate::account_identity::automatic_account_limit(
                plan.multi_account,
                &known,
                provider,
            );
            let selected = crate::account_identity::automatic_account_ids(
                provider,
                store.display_account_ids(provider),
                &covered,
                limit,
            );
            active.insert(code(provider), selected.into_iter().collect());
        }
    }
    for (provider, identities) in saved {
        active.entry(provider).or_default().extend(identities);
    }
    active
}

/// Where the terminal reads the active accounts. TypeScript reader:
/// `readActiveAccounts` in packages/core/src/acquire/coordination.ts.
pub(crate) const ACTIVE_ACCOUNTS_FILE_NAME: &str = "openlimiter-active-accounts.json";

/// Write the active accounts where the terminal reads them. The terminal
/// cannot see saved connections or the plan, so without this it would draw a
/// previous account's leftovers beside the one signed in now.
pub(crate) fn write_active_accounts(
    directory: Option<&std::path::Path>,
    active: &ActiveAccounts,
    now_ms: u64,
) -> Option<()> {
    let directory = directory?;
    let written_at = crate::native_snapshot::iso_from_epoch_ms(now_ms)?;
    let text = serde_json::json!({ "version": 1, "writtenAt": written_at, "providers": active })
        .to_string();
    crate::fsx::ensure_private_dir(directory).ok()?;
    crate::fsx::atomic_write(&directory.join(ACTIVE_ACCOUNTS_FILE_NAME), &text).ok()
}

pub fn for_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    rows: Vec<Snapshot>,
    now: i64,
) -> Projection {
    use crate::provider_detection::DetectedProviderId;
    let active = active_accounts(app);
    let mut disabled = BTreeSet::new();
    if let Some(store) = app.try_state::<crate::provider_detection::DetectionStore>() {
        /* A switched off provider has no accounts and no switch to flag. */
        for provider in DetectedProviderId::ALL.into_iter().filter(|p| p.enabled()) {
            if !store.switches.enabled(provider) {
                disabled.insert(provider.slug().to_uppercase().replace('-', "_"));
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
            /* Only the accounts the plan makes active are measured, so only
            they can be missing a measurement. */
            let selected = active.get(&code);
            for account in provider
                .accounts
                .into_iter()
                .filter(|account| selected.is_some_and(|ids| ids.contains(&account.account_id)))
            {
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
    fn an_unlimited_answer_survives_the_cache_rules_and_reaches_connections() {
        /* The real parsers' unlimited rows, through the one gate every cache
        write passes, then the projection: a note, never a meter. */
        let now = crate::native_time::epoch_ms_from_rfc3339("2026-08-07T12:00:00.000Z").unwrap();
        for (reader, body, provider) in [
            (
                crate::reader_registry::ReaderId::OpenrouterKey,
                r#"{"data":{"limit":null,"limit_remaining":null,"usage":12.47,"is_free_tier":false}}"#,
                "OPENROUTER",
            ),
            (
                crate::reader_registry::ReaderId::CodexUsage,
                r#"{"credits":{"has_credits":true,"unlimited":true,"balance":null}}"#,
                "CODEX",
            ),
        ] {
            let rows = crate::native_readers::parse_body(reader, body, now, "fixture-account")
                .expect("an unlimited answer");
            let unlimited: Vec<Snapshot> = rows
                .into_iter()
                .filter(|row| row.availability.as_deref() == Some("unlimited"))
                .filter_map(crate::native_snapshot::normalize_snapshot)
                .collect();
            assert_eq!(unlimited.len(), 1, "{provider}: the cache keeps the answer");
            let active = ActiveAccounts::from([(
                provider.to_string(),
                BTreeSet::from(["fixture-account".to_string()]),
            )]);
            let projection = project(unlimited, now as i64, &active, &BTreeSet::new());
            assert!(projection.snapshots.is_empty());
            assert_eq!(projection.flags.len(), 1);
            assert_eq!(projection.flags[0].reason, "unlimited", "{provider}");
        }
    }

    #[test]
    fn an_old_or_foreign_unlimited_answer_never_becomes_a_note() {
        /* A note says the account connected now is unlimited. An answer from
        an account nobody has connected, or one gone stale, says nothing of
        the sort. */
        let now =
            crate::native_time::epoch_ms_from_rfc3339("2026-09-29T12:00:00.000Z").unwrap() as i64;
        let mut unlimited = measured(Some("fixture-old"));
        unlimited.availability = Some("unlimited".into());
        let nobody = ActiveAccounts::from([("CLAUDE".to_string(), BTreeSet::new())]);
        let foreign = project(vec![unlimited.clone()], now, &nobody, &BTreeSet::new());
        assert!(foreign.flags.iter().all(|flag| flag.reason != "unlimited"));
        let current = ActiveAccounts::from([(
            "CLAUDE".to_string(),
            BTreeSet::from(["fixture-old".to_string()]),
        )]);
        let later = now + 24 * 3_600_000;
        let stale = project(vec![unlimited.clone()], later, &current, &BTreeSet::new());
        assert!(stale.flags.iter().all(|flag| flag.reason != "unlimited"));
        let fresh = project(vec![unlimited], now, &current, &BTreeSet::new());
        assert_eq!(fresh.flags[0].reason, "unlimited");
    }

    #[test]
    fn the_free_plan_shows_the_one_account_it_collects() {
        /* Two detected Codex logins on Free: collection reads one, so the
        other's leftovers are not shown beside it. */
        let home = crate::test_support::TempDir::new();
        let write = |path: std::path::PathBuf, account: &str| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(
                path,
                format!(r#"{{"tokens":{{"access_token":"fixture-{account}","account_id":"{account}"}}}}"#),
            )
            .unwrap();
        };
        write(home.path().join(".codex").join("auth.json"), "fixture-a");
        write(
            home.path().join("accounts").join("codex").join("second").join("auth.json"),
            "fixture-b",
        );
        let now =
            crate::native_time::epoch_ms_from_rfc3339("2026-09-29T12:00:00.000Z").unwrap() as i64;
        let detection = crate::provider_detection::DetectionStore::for_test_home(
            home.path(),
            now as u64,
        );
        let accounts = detection.account_ids(crate::provider_detection::DetectedProviderId::Codex);
        assert_eq!(accounts.len(), 2, "two logins detected");
        let app = tauri::test::mock_builder()
            .manage(detection)
            .build(tauri::generate_context!(test = true))
            .unwrap();
        let row = |account: &str| {
            let mut row = measured(Some(account));
            row.provider = "CODEX".into();
            row
        };
        let projection = for_app(
            app.handle(),
            accounts.iter().map(|account| row(account)).collect(),
            now,
        );
        assert_eq!(
            projection.snapshots.len(),
            1,
            "one account on Free: {:?}",
            projection.flags
        );
    }

    #[test]
    fn the_desktop_writes_the_active_accounts_the_terminal_reads() {
        /* The shape `readActiveAccounts` in packages/core accepts: version 1,
        when it was written, and each provider's ids, every one matching the
        terminal's account id pattern (a lowercase letter or digit, then up to
        63 more of those or hyphens). */
        let dir = crate::test_support::TempDir::new();
        let codex = crate::provider_detection::DetectedProviderId::Codex;
        let ids = [
            crate::provider_detection::opaque_account_id(codex, "fixture-a"),
            crate::account_identity::key_account_id(
                crate::provider_detection::DetectedProviderId::Synthetic,
                "fixture-key",
            ),
        ];
        let active = ActiveAccounts::from([
            ("CODEX".to_string(), BTreeSet::from([ids[0].clone()])),
            ("SYNTHETIC".to_string(), BTreeSet::from([ids[1].clone()])),
        ]);
        assert!(write_active_accounts(None, &active, 0).is_none());
        let now = crate::native_time::epoch_ms_from_rfc3339("2026-09-29T12:00:00.000Z").unwrap();
        write_active_accounts(Some(dir.path()), &active, now).expect("written");
        let text = std::fs::read_to_string(dir.path().join(ACTIVE_ACCOUNTS_FILE_NAME)).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap(),
            serde_json::json!({
                "version": 1,
                "writtenAt": "2026-09-29T12:00:00.000Z",
                "providers": { "CODEX": [ids[0]], "SYNTHETIC": [ids[1]] }
            })
        );
        for id in &ids {
            let bytes = id.as_bytes();
            assert!(bytes.len() <= 64, "{id}");
            assert!(bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit(), "{id}");
            assert!(
                bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-'),
                "{id}"
            );
        }
    }

    #[test]
    fn the_typescript_freshness_table_states_every_provider_cadence() {
        /* The TypeScript twin decides freshness for the same rows, so each
        provider's cadence must be the one this side polls at. */
        let source = include_str!("../../../../packages/core/src/data-rules.ts");
        let table = source
            .split("const desktopIntervals")
            .nth(1)
            .and_then(|rest| rest.split_once('{'))
            .and_then(|(_, rest)| rest.split_once('}'))
            .map(|(table, _)| table)
            .expect("the interval table");
        /* The shipped providers' entries; each 2.1 provider states its own in
        its descriptor, held to its module by a test in provider_detection.rs. */
        let stated: BTreeMap<&str, u64> = table
            .split(',')
            .filter_map(|entry| entry.split_once(':'))
            .filter_map(|(code, seconds)| Some((code.trim(), seconds.trim().parse().ok()?)))
            .collect();
        let providers: Vec<_> = crate::provider_detection::DetectedProviderId::ALL
            .into_iter()
            .filter(|provider| provider.footprint().is_none())
            .collect();
        assert_eq!(stated.len(), providers.len());
        for provider in providers {
            let code = provider.slug().to_uppercase().replace('-', "_");
            assert_eq!(
                stated.get(code.as_str()).copied(),
                Some(crate::request_policy::provider_interval_seconds(provider)),
                "{code}"
            );
        }
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
    fn the_meter_contract_matches_the_typescript_vectors() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/contracts/meter-vectors.json"
        ))
        .expect("vectors");
        for vector in vectors.as_array().expect("a list") {
            let name = vector["name"].as_str().expect("name");
            let row: Snapshot = serde_json::from_value(vector["row"].clone()).expect(name);
            let expected = &vector["expected"];
            match measure(&row) {
                None => assert!(expected.is_null(), "{name}"),
                Some(found) => {
                    assert_eq!(found.kind, expected["measure"], "{name}");
                    assert_eq!(
                        found.direction.map(serde_json::Value::from),
                        expected["direction"].as_str().map(serde_json::Value::from),
                        "{name}"
                    );
                    assert_eq!(found.used_percent, expected["usedPercent"].as_f64(), "{name}");
                    assert_eq!(found.currency.as_deref(), expected["currency"].as_str(), "{name}");
                }
            }
        }
    }

    #[test]
    fn a_contradiction_is_flagged_and_unlimited_stays_a_note() {
        let now =
            crate::native_time::epoch_ms_from_rfc3339("2026-09-29T12:00:00.000Z").unwrap() as i64;
        let mut balance_percent = measured(Some("fixture-a"));
        balance_percent.kind = Some("money_balance".into());
        assert_eq!(reason(&balance_percent, now), Some("quota_unavailable"));
        let mut balance = measured(Some("fixture-a"));
        balance.unit = "CREDITS".into();
        balance.value = 12.5;
        balance.kind = Some("money_balance".into());
        assert_eq!(reason(&balance, now), None);
        assert_eq!(measure(&balance).expect("a balance").direction, Some("remaining"));
        let mut unlimited = measured(Some("fixture-a"));
        unlimited.availability = Some("unlimited".into());
        assert_eq!(measure(&unlimited), None);
        let projection = project(vec![unlimited], now, &ActiveAccounts::new(), &BTreeSet::new());
        assert!(projection.snapshots.is_empty());
        assert_eq!(projection.flags[0].reason, "unlimited");
    }

    #[test]
    fn an_account_change_mid_poll_holds_the_old_reading_back() {
        /* The account identity contract's switching rule: the active identity
        comes from the credential now, so a read that began under the previous
        account and landed after the switch is written under that account and
        held back, never shown as the new one's. */
        let now =
            crate::native_time::epoch_ms_from_rfc3339("2026-09-29T12:00:00.000Z").unwrap() as i64;
        let old_key = crate::account_identity::key_account_id(
            crate::provider_detection::DetectedProviderId::Synthetic,
            "fixture-key-old",
        );
        let new_key = crate::account_identity::key_account_id(
            crate::provider_detection::DetectedProviderId::Synthetic,
            "fixture-key-new",
        );
        let mut late = measured(Some(&old_key));
        late.provider = "CLAUDE".into();
        late.observed_at = "2026-09-29T12:00:00.000Z".into();
        let active = BTreeMap::from([("CLAUDE".to_string(), BTreeSet::from([new_key]))]);
        let projection = project(vec![late], now, &active, &BTreeSet::new());
        assert!(projection.snapshots.is_empty());
        assert_eq!(projection.flags[0].reason, "account_not_connected");
        assert_eq!(projection.flags[0].account_id.as_deref(), Some(old_key.as_str()));
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
