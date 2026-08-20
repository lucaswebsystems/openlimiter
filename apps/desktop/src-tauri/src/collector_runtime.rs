use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::cache_write::CacheWriter;
use crate::collector::{collect_core, CollectionMode, CollectionOutcome, CollectorFailure};
use crate::collector_schedule::{schedule_after, scheduled};
use crate::commands::CommandFailure;
use crate::connections::{now_epoch_ms, ConnectionRecord, ConnectionsStore};
use crate::credentials::{KeyringStore, SecretStore};
use crate::net::{ReqwestTransport, Transport};
use crate::poll_identity::detected_provider;
use crate::poll_identity::{resolve_connection, PollIdentity};
use crate::request_policy::{provider_interval_seconds, RequestPolicy, BLOCKED_PROVIDER_SECONDS};

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
    policy: &RequestPolicy,
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    transport: &T,
    writer: Arc<CacheWriter>,
    connection_id: String,
    mode: CollectionMode,
) -> Result<CollectionOutcome, CommandFailure> {
    let record = connections.get(&connection_id)?;
    let identity = resolve_connection(&record, secrets);
    let provider = detected_provider(record.provider_id);
    let now_ms = now_epoch_ms();
    let _lease = match policy.begin(provider, identity.account_id(), now_ms) {
        Ok(lease) => lease,
        Err(_) => {
            return Ok(CollectionOutcome::Failed {
                connection_id,
                reason: CollectorFailure::Busy,
                status: None,
                retry_after_seconds: None,
            })
        }
    };
    if !runtime.begin(&identity) {
        return Ok(CollectionOutcome::Failed {
            connection_id,
            reason: CollectorFailure::Busy,
            status: None,
            retry_after_seconds: None,
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
    let status = outcome.as_ref().ok().and_then(CollectionOutcome::status);
    let retry_after_seconds = outcome
        .as_ref()
        .ok()
        .and_then(CollectionOutcome::retry_after_seconds);
    match status {
        Some(403 | 404 | 410) => policy.block_provider(provider, now_ms, BLOCKED_PROVIDER_SECONDS),
        Some(429) | Some(503) if retry_after_seconds.is_some() => {
            policy.rate_limit_account(provider, identity.account_id(), now_ms, retry_after_seconds)
        }
        Some(429) => policy.rate_limit_account(provider, identity.account_id(), now_ms, None),
        Some(401) => policy.complete_after(
            provider,
            identity.account_id(),
            now_ms,
            BLOCKED_PROVIDER_SECONDS,
        ),
        _ => policy.complete_after(
            provider,
            identity.account_id(),
            now_ms,
            provider_interval_seconds(provider),
        ),
    }
    synchronize_schedule(connections, secrets, &identity, &connection_id);
    runtime.finish(&identity);
    outcome
}

struct CollectionPlan {
    records: Vec<ConnectionRecord>,
    covered: HashSet<PollIdentity>,
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
    now_ms: u64,
) -> CollectionPlan {
    let mut groups = HashMap::<PollIdentity, Vec<ConnectionRecord>>::new();
    let mut covered = HashSet::new();

    for record in records {
        let identity = resolve_connection(&record, secrets);
        covered.insert(identity.clone());
        groups.entry(identity).or_default().push(record);
    }

    let mut planned = Vec::new();
    for records in groups.into_values() {
        let scheduled_records: Vec<_> = records
            .iter()
            .filter(|record| scheduled(record))
            .cloned()
            .collect();
        let account_next = scheduled_records
            .iter()
            .filter_map(|record| record.next_refresh_at)
            .max();
        let eligible_records = if account_next.is_some_and(|next| now_ms < next) {
            Vec::new()
        } else {
            scheduled_records
        };
        if let Some(record) = canonical_record(&eligible_records) {
            planned.push(record);
        }
    }
    planned.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    CollectionPlan {
        records: planned,
        covered,
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
        if record.id == selected_id || &resolve_connection(&record, secrets) != identity {
            continue;
        }
        let _ = connections.update(&record.id, |sibling| {
            sibling.next_refresh_at = selected.next_refresh_at;
        });
    }
}

async fn run_pass(app: &AppHandle) {
    let connections = app.state::<ConnectionsStore>();
    let secrets = app.state::<KeyringStore>();
    let records = connections
        .list()
        .map(|records| collection_plan(records, &*secrets, now_epoch_ms()));
    let mut last_failure = None;
    let mut attempted = false;
    let mut stopped_providers = HashSet::new();
    match records {
        Ok(plan) => {
            for record in plan.records {
                let provider = detected_provider(record.provider_id);
                if stopped_providers.contains(&provider) {
                    continue;
                }
                attempted = true;
                let runtime = app.state::<CollectorRuntime>();
                let policy = app.state::<RequestPolicy>();
                let transport = app.state::<ReqwestTransport>();
                let writer = app.state::<Arc<CacheWriter>>();
                match run_guarded(
                    &runtime,
                    &policy,
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
                        if matches!(outcome.status(), Some(403 | 404 | 410 | 429)) {
                            stopped_providers.insert(provider);
                        }
                        if outcome.failure().is_some() {
                            last_failure = outcome.failure();
                        }
                    }
                    Err(_) => last_failure = Some(CollectorFailure::Internal),
                }
            }

            let coverage = connections
                .list()
                .map(|records| collection_plan(records, &*secrets, now_epoch_ms()));
            match coverage {
                Ok(coverage) => {
                    crate::codex_oauth::run_pass(app, &coverage.covered).await;
                    crate::antigravity_oauth::run_pass(app, &coverage.covered).await;
                    crate::grok_oauth::run_pass(app, &coverage.covered).await;
                    crate::kimi_oauth::run_pass(app, &coverage.covered).await;
                }
                Err(_) => last_failure = Some(CollectorFailure::Internal),
            }
        }
        Err(_) => last_failure = Some(CollectorFailure::Internal),
    }
    crate::claude_oauth::run_pass(app).await;
    crate::gemini_cli_oauth::run_pass(app).await;
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
            run_pass(&app).await;
        }
    });
}

pub fn refresh_all(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run_pass(&app).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{SecretStore, MASK_DOTS};
    use crate::reader_registry::{CredentialKind, ProviderId, ReaderId};
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

        let early = collection_plan(records.clone(), &secrets, NOW);
        assert!(early.records.is_empty());
        let due = collection_plan(records, &secrets, NOW + 600_000);
        assert_eq!(due.records.len(), 1);
    }

    #[test]
    fn credential_only_antigravity_paths_fail_closed_to_one_poll_target() {
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
            NOW,
        );

        assert_eq!(plan.records.len(), 1);
        assert_eq!(plan.records[0].id, "first-account");
        assert_eq!(plan.covered.len(), 1);
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
        let plan = collection_plan(records, &secrets, NOW);

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
            NOW,
        );

        assert_eq!(plan.records.len(), 1);
    }
}
