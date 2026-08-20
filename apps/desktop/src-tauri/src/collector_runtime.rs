use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::cache_write::CacheWriter;
use crate::collector::{collect_core, CollectionMode, CollectionOutcome, CollectorFailure};
use crate::collector_schedule::{eligible, schedule_after, scheduled};
use crate::commands::CommandFailure;
use crate::connections::{now_epoch_ms, ConnectionRecord, ConnectionsStore};
use crate::credentials::{KeyringStore, SecretStore};
use crate::net::{ReqwestTransport, Transport};
use crate::poll_identity::{resolve_connection, PollIdentity};
use crate::reader_registry::ProviderId;

pub const COLLECTOR_UPDATED_EVENT: &str = "collector-updated";
const COLLECTOR_INTERVAL_SECONDS: u64 = 60;

#[derive(Clone, Debug, Serialize)]
pub struct CollectorStatus {
    pub ticks: u64,
    pub last_pass_at: Option<u64>,
    pub last_failure: Option<CollectorFailure>,
}

#[derive(Default)]
struct RuntimeInner {
    active: HashSet<PollIdentity>,
    ticks: u64,
    last_pass_at: Option<u64>,
    last_failure: Option<CollectorFailure>,
}

#[derive(Default)]
pub struct CollectorRuntime {
    inner: Mutex<RuntimeInner>,
}

impl CollectorRuntime {
    fn begin(&self, identity: &PollIdentity) -> bool {
        self.inner
            .lock()
            .map(|mut inner| inner.active.insert(identity.clone()))
            .unwrap_or(false)
    }

    fn finish(&self, identity: &PollIdentity) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.active.remove(identity);
        }
    }

    pub fn record_pass(&self, failure: Option<CollectorFailure>, attempted: bool) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.ticks = inner.ticks.wrapping_add(1);
            inner.last_pass_at = Some(now_epoch_ms());
            if failure.is_some() || attempted {
                inner.last_failure = failure;
            }
        }
    }

    pub fn status(&self) -> CollectorStatus {
        self.inner
            .lock()
            .map(|inner| CollectorStatus {
                ticks: inner.ticks,
                last_pass_at: inner.last_pass_at,
                last_failure: inner.last_failure,
            })
            .unwrap_or(CollectorStatus {
                ticks: 0,
                last_pass_at: None,
                last_failure: Some(CollectorFailure::Internal),
            })
    }
}

pub async fn run_guarded<T: Transport>(
    runtime: &CollectorRuntime,
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    transport: &T,
    writer: Arc<CacheWriter>,
    connection_id: String,
    mode: CollectionMode,
) -> Result<CollectionOutcome, CommandFailure> {
    let record = connections.get(&connection_id)?;
    let identity =
        resolve_connection(&record, secrets).unwrap_or_else(|| PollIdentity::unique(&record));
    if !runtime.begin(&identity) {
        return Ok(CollectionOutcome::Failed {
            connection_id,
            reason: CollectorFailure::Busy,
            status: None,
        });
    }
    let outcome = collect_core(
        connections,
        secrets,
        transport,
        writer,
        connection_id.clone(),
        mode,
    )
    .await;
    if outcome.is_err() {
        let _ = schedule_after(connections, &connection_id, false, true, None);
    }
    synchronize_schedule(connections, secrets, &identity, &connection_id);
    runtime.finish(&identity);
    outcome
}

struct CollectionPlan {
    records: Vec<ConnectionRecord>,
    covered: HashSet<PollIdentity>,
    unresolved_automatic: HashSet<ProviderId>,
}

fn canonical_record(records: &[ConnectionRecord]) -> Option<ConnectionRecord> {
    records
        .iter()
        .min_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        })
        .cloned()
}

fn collection_plan(
    records: Vec<ConnectionRecord>,
    secrets: &impl SecretStore,
    explicit: bool,
    now_ms: u64,
) -> CollectionPlan {
    let mut groups = HashMap::<PollIdentity, Vec<ConnectionRecord>>::new();
    let mut unresolved = Vec::new();
    let mut covered = HashSet::new();
    let mut unresolved_automatic = HashSet::new();

    for record in records {
        if let Some(identity) = resolve_connection(&record, secrets) {
            covered.insert(identity.clone());
            groups.entry(identity).or_default().push(record);
        } else {
            if matches!(
                record.provider_id,
                ProviderId::Codex | ProviderId::Antigravity | ProviderId::Grok | ProviderId::Kimi
            ) {
                unresolved_automatic.insert(record.provider_id);
            }
            unresolved.push(record);
        }
    }

    let mut planned = Vec::new();
    for records in groups.into_values() {
        let eligible_records = if explicit {
            records.clone()
        } else {
            let scheduled_records: Vec<_> = records
                .iter()
                .filter(|record| scheduled(record))
                .cloned()
                .collect();
            let account_next = scheduled_records
                .iter()
                .filter_map(|record| record.next_refresh_at)
                .max();
            if account_next.is_some_and(|next| now_ms < next) {
                Vec::new()
            } else {
                scheduled_records
            }
        };
        if let Some(record) = canonical_record(&eligible_records) {
            planned.push(record);
        }
    }
    planned.extend(unresolved.into_iter().filter(|record| {
        if explicit {
            true
        } else {
            eligible(record, now_ms)
        }
    }));
    planned.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    CollectionPlan {
        records: planned,
        covered,
        unresolved_automatic,
    }
}

fn synchronize_schedule(
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    identity: &PollIdentity,
    selected_id: &str,
) {
    let Ok(selected) = connections.get(selected_id) else {
        return;
    };
    let Ok(records) = connections.list() else {
        return;
    };
    for record in records {
        if record.id == selected_id
            || resolve_connection(&record, secrets).as_ref() != Some(identity)
        {
            continue;
        }
        let _ = connections.update(&record.id, |sibling| {
            sibling.next_refresh_at = selected.next_refresh_at;
        });
    }
}

async fn run_pass(app: &AppHandle, explicit: bool) {
    let connections = app.state::<ConnectionsStore>();
    let secrets = app.state::<KeyringStore>();
    let records = connections
        .list()
        .map(|records| collection_plan(records, &*secrets, explicit, now_epoch_ms()));
    let mut last_failure = None;
    let mut attempted = false;
    match records {
        Ok(plan) => {
            for record in plan.records {
                attempted = true;
                let runtime = app.state::<CollectorRuntime>();
                let transport = app.state::<ReqwestTransport>();
                let writer = app.state::<Arc<CacheWriter>>();
                match run_guarded(
                    &runtime,
                    &connections,
                    &*secrets,
                    &*transport,
                    Arc::clone(&writer),
                    record.id,
                    CollectionMode::Refresh,
                )
                .await
                {
                    Ok(outcome) => {
                        if outcome.failure().is_some() {
                            last_failure = outcome.failure();
                        }
                    }
                    Err(_) => last_failure = Some(CollectorFailure::Internal),
                }
            }

            let coverage = connections
                .list()
                .map(|records| collection_plan(records, &*secrets, false, now_epoch_ms()));
            match coverage {
                Ok(coverage) => {
                    if !coverage.unresolved_automatic.contains(&ProviderId::Codex) {
                        crate::codex_oauth::run_pass(app, &coverage.covered).await;
                    }
                    if !coverage
                        .unresolved_automatic
                        .contains(&ProviderId::Antigravity)
                    {
                        crate::antigravity_oauth::run_pass(app, &coverage.covered).await;
                    }
                    if !coverage.unresolved_automatic.contains(&ProviderId::Grok) {
                        crate::grok_oauth::run_pass(app, &coverage.covered).await;
                    }
                    if !coverage.unresolved_automatic.contains(&ProviderId::Kimi) {
                        crate::kimi_oauth::run_pass(app, &coverage.covered).await;
                    }
                }
                Err(_) => last_failure = Some(CollectorFailure::Internal),
            }
        }
        Err(_) => last_failure = Some(CollectorFailure::Internal),
    }
    crate::claude_oauth::run_pass(app).await;
    let runtime = app.state::<CollectorRuntime>();
    runtime.record_pass(last_failure, attempted);
    let _ = app.emit(COLLECTOR_UPDATED_EVENT, runtime.status());
}

pub fn spawn_collector(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(COLLECTOR_INTERVAL_SECONDS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            run_pass(&app, false).await;
        }
    });
}

pub fn refresh_all(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run_pass(&app, true).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{SecretStore, MASK_DOTS};
    use crate::reader_registry::{CredentialKind, ReaderId};
    use crate::test_support::InMemorySecrets;

    const NOW: u64 = 1_787_136_000_000;

    fn record(
        id: &str,
        provider_id: ProviderId,
        reader_id: ReaderId,
        credential_kind: CredentialKind,
        codex_account_id: Option<&str>,
        created_at: u64,
        next_refresh_at: Option<u64>,
    ) -> ConnectionRecord {
        ConnectionRecord {
            id: id.to_string(),
            provider_id,
            reader_id,
            credential_kind,
            account_alias: id.to_string(),
            codex_account_id: codex_account_id.map(str::to_string),
            masked_label: MASK_DOTS.to_string(),
            created_at,
            base_seconds: reader_id.base_seconds(),
            next_refresh_at,
            last_attempt_at: None,
            last_success_at: None,
            attempt_generation: 0,
            body_delivered_generation: None,
            last_completion_at: None,
            ever_connected: true,
            consecutive_failures: 0,
            status: "CONNECTED".to_string(),
        }
    }

    fn antigravity(id: &str, created_at: u64, next_refresh_at: Option<u64>) -> ConnectionRecord {
        record(
            id,
            ProviderId::Antigravity,
            ReaderId::AntigravityQuota,
            CredentialKind::AntigravitySession,
            None,
            created_at,
            next_refresh_at,
        )
    }

    #[test]
    fn two_paths_with_the_same_antigravity_account_plan_one_poll() {
        let secrets = InMemorySecrets::new();
        secrets
            .store_secret("first-path", "same-antigravity-token")
            .expect("first secret");
        secrets
            .store_secret("second-path", "same-antigravity-token")
            .expect("second secret");
        let plan = collection_plan(
            vec![
                antigravity("first-path", 1, None),
                antigravity("second-path", 2, None),
            ],
            &secrets,
            false,
            NOW,
        );

        assert_eq!(plan.records.len(), 1);
        assert_eq!(plan.records[0].id, "first-path");
        assert_eq!(plan.covered.len(), 1);
    }

    #[test]
    fn a_future_duplicate_enforces_the_cadence_for_the_whole_account() {
        let secrets = InMemorySecrets::new();
        for id in ["due-path", "future-path"] {
            secrets
                .store_secret(id, "same-antigravity-token")
                .expect("secret");
        }
        let records = vec![
            antigravity("due-path", 1, None),
            antigravity("future-path", 2, Some(NOW + 600_000)),
        ];

        let early = collection_plan(records.clone(), &secrets, false, NOW);
        assert!(early.records.is_empty());
        let due = collection_plan(records, &secrets, false, NOW + 600_000);
        assert_eq!(due.records.len(), 1);
    }

    #[test]
    fn distinct_antigravity_accounts_keep_distinct_polls() {
        let secrets = InMemorySecrets::new();
        secrets
            .store_secret("first-account", "first-antigravity-token")
            .expect("first secret");
        secrets
            .store_secret("second-account", "second-antigravity-token")
            .expect("second secret");
        let plan = collection_plan(
            vec![
                antigravity("first-account", 1, None),
                antigravity("second-account", 2, None),
            ],
            &secrets,
            false,
            NOW,
        );

        assert_eq!(plan.records.len(), 2);
        assert_eq!(plan.covered.len(), 2);
    }

    #[test]
    fn codex_identity_uses_the_account_not_the_access_token() {
        let secrets = InMemorySecrets::new();
        secrets
            .store_secret("codex-old-path", "old-codex-access-token")
            .expect("old secret");
        secrets
            .store_secret("codex-new-path", "new-codex-access-token")
            .expect("new secret");
        let records = ["codex-old-path", "codex-new-path"]
            .into_iter()
            .enumerate()
            .map(|(index, id)| {
                record(
                    id,
                    ProviderId::Codex,
                    ReaderId::CodexUsage,
                    CredentialKind::CodexSession,
                    Some("same-provider-account"),
                    index as u64,
                    None,
                )
            })
            .collect();
        let plan = collection_plan(records, &secrets, false, NOW);

        assert_eq!(plan.records.len(), 1);
        assert_eq!(plan.covered.len(), 1);
    }

    #[test]
    fn one_openrouter_account_cannot_poll_twice_through_two_readers() {
        let secrets = InMemorySecrets::new();
        for id in ["key-reader", "credits-reader"] {
            secrets
                .store_secret(id, "same-openrouter-key")
                .expect("secret");
        }
        let plan = collection_plan(
            vec![
                record(
                    "key-reader",
                    ProviderId::Openrouter,
                    ReaderId::OpenrouterKey,
                    CredentialKind::OpenrouterInferenceKey,
                    None,
                    1,
                    None,
                ),
                record(
                    "credits-reader",
                    ProviderId::Openrouter,
                    ReaderId::OpenrouterCredits,
                    CredentialKind::OpenrouterManagementKey,
                    None,
                    2,
                    None,
                ),
            ],
            &secrets,
            false,
            NOW,
        );

        assert_eq!(plan.records.len(), 1);
    }
}
