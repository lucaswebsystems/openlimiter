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
use crate::provider_detection::DetectedProviderId;
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
    switches: &crate::provider_switches::ProviderSwitches,
    policy: &RequestPolicy,
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    transport: &T,
    writer: Arc<CacheWriter>,
    connection_id: String,
    mode: CollectionMode,
) -> Result<CollectionOutcome, CommandFailure> {
    connections.apply_plan(crate::pro::multi_account_enabled(secrets), &[])?;
    let record = connections.get(&connection_id)?;
    if !record.is_active() || !switches.enabled(detected_provider(record.provider_id)) {
        return Err(CommandFailure::Paused);
    }
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
    known_providers: HashSet<DetectedProviderId>,
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
    let mut known_providers = HashSet::new();

    for record in records {
        known_providers.insert(detected_provider(record.provider_id));
        let identity = resolve_connection(&record, secrets);
        covered.insert(identity.clone());
        if !record.is_active() {
            continue;
        }
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
        known_providers,
    }
}

fn automatic_account_limit(
    multi_account: bool,
    known_providers: &HashSet<DetectedProviderId>,
    provider: DetectedProviderId,
) -> usize {
    if multi_account {
        usize::MAX
    } else if known_providers.contains(&provider) {
        0
    } else {
        1
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

#[derive(Debug, Serialize)]
pub struct HomeRefreshOutcome {
    pub succeeded: bool,
    pub failed_providers: Vec<DetectedProviderId>,
}

fn requested_provider(
    selected: Option<&[DetectedProviderId]>,
    provider: DetectedProviderId,
) -> bool {
    selected.is_none_or(|providers| providers.contains(&provider))
}

pub async fn run_pass(
    app: &AppHandle,
    selected: Option<&[DetectedProviderId]>,
) -> HomeRefreshOutcome {
    let detection = app.state::<crate::provider_detection::DetectionStore>();
    let allowed =
        |provider| detection.switches.enabled(provider) && requested_provider(selected, provider);
    let connections = app.state::<ConnectionsStore>();
    let secrets = app.state::<KeyringStore>();
    let multi_account = crate::pro::multi_account_enabled(&*secrets);
    let _ = connections.apply_plan(multi_account, &[]);
    let records = connections.list().map(|mut records| {
        records.retain(|record| allowed(detected_provider(record.provider_id)));
        if selected.is_some() {
            for record in &mut records {
                record.next_refresh_at = None;
            }
        }
        collection_plan(records, &*secrets, now_epoch_ms())
    });
    let mut failed_providers = Vec::new();
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
                    &detection.switches,
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
                            failed_providers.push(provider);
                        }
                    }
                    Err(_) => {
                        last_failure = Some(CollectorFailure::Internal);
                        failed_providers.push(provider);
                    }
                }
            }

            let coverage = connections.list().map(|mut records| {
                records.retain(|record| {
                    detection
                        .switches
                        .enabled(detected_provider(record.provider_id))
                });
                collection_plan(records, &*secrets, now_epoch_ms())
            });
            match coverage {
                Ok(coverage) => {
                    if allowed(DetectedProviderId::Codex)
                        && !crate::codex_oauth::run_pass(
                            app,
                            &coverage.covered,
                            automatic_account_limit(
                                multi_account,
                                &coverage.known_providers,
                                DetectedProviderId::Codex,
                            ),
                        )
                        .await
                    {
                        failed_providers.push(DetectedProviderId::Codex);
                    }
                    if allowed(DetectedProviderId::Antigravity)
                        && !crate::antigravity_oauth::run_pass(
                            app,
                            &coverage.covered,
                            automatic_account_limit(
                                multi_account,
                                &coverage.known_providers,
                                DetectedProviderId::Antigravity,
                            ),
                        )
                        .await
                    {
                        failed_providers.push(DetectedProviderId::Antigravity);
                    }
                    if allowed(DetectedProviderId::Grok)
                        && !crate::grok_oauth::run_pass(
                            app,
                            &coverage.covered,
                            automatic_account_limit(
                                multi_account,
                                &coverage.known_providers,
                                DetectedProviderId::Grok,
                            ),
                        )
                        .await
                    {
                        failed_providers.push(DetectedProviderId::Grok);
                    }
                    if allowed(DetectedProviderId::Kimi)
                        && !crate::kimi_oauth::run_pass(
                            app,
                            &coverage.covered,
                            automatic_account_limit(
                                multi_account,
                                &coverage.known_providers,
                                DetectedProviderId::Kimi,
                            ),
                        )
                        .await
                    {
                        failed_providers.push(DetectedProviderId::Kimi);
                    }
                    if allowed(DetectedProviderId::Claude)
                        && !crate::claude_oauth::run_pass(
                            app,
                            automatic_account_limit(
                                multi_account,
                                &coverage.known_providers,
                                DetectedProviderId::Claude,
                            ),
                        )
                        .await
                    {
                        failed_providers.push(DetectedProviderId::Claude);
                    }
                    if allowed(DetectedProviderId::GeminiCli)
                        && !crate::gemini_cli_oauth::run_pass(
                            app,
                            automatic_account_limit(
                                multi_account,
                                &coverage.known_providers,
                                DetectedProviderId::GeminiCli,
                            ),
                        )
                        .await
                    {
                        failed_providers.push(DetectedProviderId::GeminiCli);
                    }
                }
                Err(_) => last_failure = Some(CollectorFailure::Internal),
            }
        }
        Err(_) => last_failure = Some(CollectorFailure::Internal),
    }
    let runtime = app.state::<CollectorRuntime>();
    runtime.record_pass(last_failure, attempted);
    let _ = app.emit(COLLECTOR_UPDATED_EVENT, runtime.status());
    HomeRefreshOutcome {
        succeeded: last_failure.is_none() && failed_providers.is_empty(),
        failed_providers,
    }
}

pub fn spawn_collector(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(COLLECTOR_INTERVAL_SECONDS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            run_pass(&app, None).await;
        }
    });
}

pub fn refresh_all(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run_pass(&app, None).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_refresh_selects_added_providers_and_leaves_removed_providers_out() {
        let selected = [DetectedProviderId::Codex, DetectedProviderId::Claude];
        assert!(requested_provider(
            Some(&selected),
            DetectedProviderId::Codex
        ));
        assert!(requested_provider(
            Some(&selected),
            DetectedProviderId::Claude
        ));
        assert!(!requested_provider(
            Some(&selected),
            DetectedProviderId::Antigravity
        ));
        assert!(!requested_provider(Some(&[]), DetectedProviderId::Codex));
        assert!(requested_provider(None, DetectedProviderId::Antigravity));
    }

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
            legacy_grandfathered: false,
            pause_reason: None,
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

    #[tokio::test]
    async fn a_disabled_stored_connection_cannot_test_or_refresh_the_provider() {
        use crate::test_support::{RecordingTransport, TempDir};
        let dir = TempDir::new();
        let switches = crate::provider_switches::ProviderSwitches::at(Some(dir.path().into()));
        switches
            .set(DetectedProviderId::Antigravity, false)
            .unwrap();
        let connections = ConnectionsStore::at(Some(dir.path().into()));
        connections.insert(antigravity("fixture", 1, None)).unwrap();
        let transport = RecordingTransport::replying(200, Vec::new(), None);
        for mode in [CollectionMode::Test, CollectionMode::Refresh] {
            let result = run_guarded(
                &CollectorRuntime::default(),
                &switches,
                &RequestPolicy::at(None),
                &connections,
                &InMemorySecrets::new(),
                &transport,
                Arc::new(CacheWriter::at(Some(dir.path().into()))),
                "fixture".to_string(),
                mode,
            )
            .await;
            assert!(matches!(result, Err(CommandFailure::Paused)));
        }
        assert!(transport.recorded_urls().is_empty());
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

    #[test]
    fn a_paused_connection_never_enters_the_background_poll_plan() {
        let secrets = InMemorySecrets::new();
        secrets
            .store_secret("paused-account", "paused-antigravity-token")
            .expect("secret");
        let mut paused = antigravity("paused-account", 1, None);
        paused.pause_reason = Some(crate::connections::PauseReason::PausedByPlan);

        let plan = collection_plan(vec![paused], &secrets, NOW);

        assert!(plan.records.is_empty());
        assert_eq!(plan.covered.len(), 1);
        assert!(plan
            .known_providers
            .contains(&DetectedProviderId::Antigravity));
    }

    #[test]
    fn free_limits_discovered_accounts_and_known_records_claim_the_provider() {
        let empty = HashSet::new();
        assert_eq!(
            automatic_account_limit(false, &empty, DetectedProviderId::Codex),
            1
        );
        assert_eq!(
            automatic_account_limit(true, &empty, DetectedProviderId::Codex),
            usize::MAX
        );
        let known = HashSet::from([DetectedProviderId::Codex]);
        assert_eq!(
            automatic_account_limit(false, &known, DetectedProviderId::Codex),
            0
        );
    }
}
