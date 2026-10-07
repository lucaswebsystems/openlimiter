use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::cache_write::CacheWriter;
use crate::codex_app_server::{read_rate_limits_for_home, AppServerFailure, RateLimitsPayload};
use crate::native_readers::parse_body;
use crate::native_snapshot::{iso_from_epoch_ms, write_report, CacheReport};
use crate::net::{ReqwestTransport, Transport};
use crate::poll_identity::PollIdentity;
use crate::provider_detection::{DetectedCredentialError, DetectedProviderId, DetectionStore};
use crate::reader_registry::{ProviderId, ReaderId};
use crate::request_policy::{GateRejection, RequestPolicy};

pub const REFRESH_SECONDS: u64 = 300;
const BLOCKED_BACKOFF_SECONDS: u64 = 86_400;
const MAX_THROTTLE_ENTRIES: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexFailure {
    Timeout,
    Connect,
    Tls,
    TooLarge,
    Protocol,
    ProviderResponse,
    RateLimited,
    ProviderBlocked,
    Drift,
    Cache,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CodexOutcome {
    CacheCommitted {
        account_id: String,
    },
    Cached {
        account_id: String,
        retry_at: String,
    },
    MissingExecutable {
        account_id: String,
    },
    MissingCredential {
        account_id: String,
    },
    ReopenCli {
        account_id: String,
        message: String,
    },
    Fallback {
        account_id: String,
        reason: CodexFailure,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_after_seconds: Option<u64>,
    },
    Failed {
        account_id: String,
        reason: CodexFailure,
    },
}

impl CodexOutcome {
    fn reopen(account_id: &str) -> Self {
        Self::ReopenCli {
            account_id: account_id.to_string(),
            message: "Reopen Codex to refresh this login.".to_string(),
        }
    }

    fn fallback(account_id: &str, reason: CodexFailure) -> Self {
        Self::Fallback {
            account_id: account_id.to_string(),
            reason,
            retry_after_seconds: None,
        }
    }

    fn rate_limited(account_id: &str, retry_after_seconds: Option<u64>) -> Self {
        Self::Fallback {
            account_id: account_id.to_string(),
            reason: CodexFailure::RateLimited,
            retry_after_seconds,
        }
    }
}

#[derive(Default)]
pub struct CodexOauthRuntime {
    next_allowed: Mutex<BTreeMap<String, u64>>,
}

trait AppServerReader: Send + Sync {
    fn read(
        &self,
        executable: &std::path::Path,
        codex_home: &std::path::Path,
        expected_account_id: &str,
    ) -> Result<RateLimitsPayload, AppServerFailure>;
}

struct NativeAppServerReader;

impl AppServerReader for NativeAppServerReader {
    fn read(
        &self,
        executable: &std::path::Path,
        codex_home: &std::path::Path,
        expected_account_id: &str,
    ) -> Result<RateLimitsPayload, AppServerFailure> {
        read_rate_limits_for_home(executable, codex_home, expected_account_id)
    }
}

impl CodexOauthRuntime {
    fn begin(&self, account_id: &str, now_ms: u64) -> Result<(), u64> {
        let mut entries = self.next_allowed.lock().map_err(|_| now_ms)?;
        if let Some(next) = entries.get(account_id).copied() {
            if now_ms < next {
                return Err(next);
            }
        }
        if entries.len() >= MAX_THROTTLE_ENTRIES {
            entries.retain(|_, next| *next > now_ms);
        }
        if entries.len() >= MAX_THROTTLE_ENTRIES {
            if let Some(first) = entries.keys().next().cloned() {
                entries.remove(&first);
            }
        }
        entries.insert(
            account_id.to_string(),
            now_ms.saturating_add(REFRESH_SECONDS.saturating_mul(1_000)),
        );
        Ok(())
    }

    fn postpone(&self, account_id: &str, now_ms: u64, seconds: u64) {
        if let Ok(mut entries) = self.next_allowed.lock() {
            entries.insert(
                account_id.to_string(),
                now_ms.saturating_add(seconds.saturating_mul(1_000)),
            );
        }
    }

    fn cancel(&self, account_id: &str) {
        if let Ok(mut entries) = self.next_allowed.lock() {
            entries.remove(account_id);
        }
    }
}

fn app_server_failure(error: AppServerFailure) -> CodexFailure {
    match error {
        AppServerFailure::Timeout => CodexFailure::Timeout,
        AppServerFailure::Unavailable => CodexFailure::Connect,
        AppServerFailure::MissingExecutable => CodexFailure::Connect,
        AppServerFailure::RateLimited(_) => CodexFailure::RateLimited,
        AppServerFailure::Protocol => CodexFailure::Protocol,
        AppServerFailure::NeedsSignIn | AppServerFailure::IdentityMismatch => {
            CodexFailure::ProviderBlocked
        }
    }
}

async fn commit_report(writer: Arc<CacheWriter>, account_id: String, report: CacheReport) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        write_report(&writer, "CODEX", Some(&account_id), report)
    })
    .await
    .is_ok_and(|result| result.is_ok())
}

async fn fallback_report(writer: Arc<CacheWriter>, account_id: &str, drift: bool, now_ms: u64) {
    let report = if drift {
        CacheReport::Drift {
            observed_at: iso_from_epoch_ms(now_ms)
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
        }
    } else {
        CacheReport::Unavailable
    };
    let _ = commit_report(writer, account_id.to_string(), report).await;
}

async fn collect_with_app_server(
    runtime: &CodexOauthRuntime,
    app_server: Arc<dyn AppServerReader>,
    writer: Arc<CacheWriter>,
    account_id: &str,
    executable: &std::path::Path,
    codex_home: &std::path::Path,
    now_ms: u64,
) -> CodexOutcome {
    if let Err(retry_ms) = runtime.begin(account_id, now_ms) {
        return CodexOutcome::Cached {
            account_id: account_id.to_string(),
            retry_at: iso_from_epoch_ms(retry_ms)
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
        };
    }
    let executable = executable.to_path_buf();
    let codex_home = codex_home.to_path_buf();
    let expected_account_id = account_id.to_string();
    let response = tauri::async_runtime::spawn_blocking(move || {
        app_server.read(&executable, &codex_home, &expected_account_id)
    })
    .await;
    let payload = match response {
        Ok(Ok(payload)) => payload,
        Ok(Err(AppServerFailure::NeedsSignIn)) => {
            runtime.postpone(account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, account_id, false, now_ms).await;
            return CodexOutcome::reopen(account_id);
        }
        Ok(Err(AppServerFailure::IdentityMismatch)) => {
            runtime.postpone(account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, account_id, false, now_ms).await;
            return CodexOutcome::fallback(account_id, CodexFailure::ProviderBlocked);
        }
        Ok(Err(AppServerFailure::MissingExecutable)) => {
            runtime.cancel(account_id);
            return CodexOutcome::MissingExecutable {
                account_id: account_id.to_string(),
            };
        }
        Ok(Err(AppServerFailure::RateLimited(retry_after_seconds))) => {
            runtime.postpone(account_id, now_ms, 0);
            fallback_report(writer, account_id, false, now_ms).await;
            return CodexOutcome::rate_limited(account_id, retry_after_seconds);
        }
        Ok(Err(error)) => {
            return CodexOutcome::Failed {
                account_id: account_id.to_string(),
                reason: app_server_failure(error),
            }
        }
        Err(_) => {
            return CodexOutcome::Failed {
                account_id: account_id.to_string(),
                reason: CodexFailure::Connect,
            }
        }
    };
    let Some(snapshots) = parse_body(ReaderId::CodexUsage, &payload.body, now_ms, account_id)
    else {
        fallback_report(writer, account_id, true, now_ms).await;
        return CodexOutcome::fallback(account_id, CodexFailure::Drift);
    };
    if commit_report(
        writer,
        account_id.to_string(),
        CacheReport::Success(snapshots),
    )
    .await
    {
        CodexOutcome::CacheCommitted {
            account_id: account_id.to_string(),
        }
    } else {
        CodexOutcome::Failed {
            account_id: account_id.to_string(),
            reason: CodexFailure::Cache,
        }
    }
}

fn credential_failure(account_id: &str, error: DetectedCredentialError) -> CodexOutcome {
    match error {
        DetectedCredentialError::Stale
        | DetectedCredentialError::NotFound
        | DetectedCredentialError::Unreadable => CodexOutcome::reopen(account_id),
    }
}

pub async fn collect_account<T: Transport>(
    detection: &DetectionStore,
    runtime: &CodexOauthRuntime,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: String,
    now_ms: u64,
) -> CodexOutcome {
    let secret = match detection.read_credential(DetectedProviderId::Codex, &account_id) {
        Ok(secret) => secret,
        Err(error) => {
            detection.mark_stale(DetectedProviderId::Codex, &account_id);
            return credential_failure(&account_id, error);
        }
    };
    let executable = match detection.client_executable(DetectedProviderId::Codex) {
        Some(executable) => executable,
        None => {
            detection.mark_cli_missing(DetectedProviderId::Codex, &account_id);
            return CodexOutcome::MissingExecutable { account_id: account_id.clone() };
        }
    };
    let codex_home = match detection.codex_home(&account_id) {
        Some(home) => home,
        None => {
            detection.mark_stale(DetectedProviderId::Codex, &account_id);
            return credential_failure(&account_id, DetectedCredentialError::NotFound);
        }
    };
    let _ = transport;
    let _ = secret;
    let outcome = collect_with_app_server(
        runtime,
        Arc::new(NativeAppServerReader),
        writer,
        &account_id,
        &executable,
        &codex_home,
        now_ms,
    )
    .await;
    match &outcome {
        CodexOutcome::CacheCommitted { .. } => {
            detection.mark_ready(DetectedProviderId::Codex, &account_id)
        }
        CodexOutcome::ReopenCli { .. } => {
            detection.mark_stale(DetectedProviderId::Codex, &account_id)
        }
        CodexOutcome::MissingCredential { .. } => {
            detection.mark_stale(DetectedProviderId::Codex, &account_id)
        }
        CodexOutcome::Fallback { .. } => {
            detection.mark_fallback(DetectedProviderId::Codex, &account_id)
        }
        CodexOutcome::Cached { .. } | CodexOutcome::Failed { .. } => {}
        CodexOutcome::MissingExecutable { .. } => {
            detection.mark_cli_missing(DetectedProviderId::Codex, &account_id)
        }
    }
    outcome
}

pub(crate) async fn collect_account_guarded<T: Transport>(
    detection: &DetectionStore,
    runtime: &CodexOauthRuntime,
    policy: &RequestPolicy,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: String,
    now_ms: u64,
) -> (CodexOutcome, bool) {
    let revision = detection
        .read_credential(DetectedProviderId::Codex, &account_id)
        .map(|secret| secret.credential_revision)
        .unwrap_or_else(|_| "unavailable".to_string());
    let _lease = match policy.begin_with_revision(
        DetectedProviderId::Codex,
        &account_id,
        now_ms,
        Some(&revision),
    ) {
        Ok(lease) => lease,
        Err(GateRejection::Deferred { retry_at }) => {
            return (
                CodexOutcome::Cached {
                    account_id,
                    retry_at: iso_from_epoch_ms(retry_at)
                        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
                },
                false,
            )
        }
        Err(GateRejection::Busy | GateRejection::Unavailable) => {
            return (
                CodexOutcome::Failed {
                    account_id,
                    reason: CodexFailure::Protocol,
                },
                false,
            )
        }
    };
    // The durable gate owns retry timing, including after a process restart.
    runtime.postpone(&account_id, now_ms, 0);
    let outcome = collect_account(
        detection,
        runtime,
        transport,
        writer,
        account_id.clone(),
        now_ms,
    )
    .await;
    let abort_provider = complete_outcome(policy, detection, runtime, &account_id, now_ms, &outcome);
    (outcome, abort_provider)
}

fn complete_outcome(
    policy: &RequestPolicy,
    detection: &DetectionStore,
    runtime: &CodexOauthRuntime,
    account_id: &str,
    now_ms: u64,
    outcome: &CodexOutcome,
) -> bool {
    match outcome {
        CodexOutcome::Cached { .. } => false,
        CodexOutcome::MissingExecutable { .. } => {
            runtime.cancel(account_id);
            policy.cancel_unstarted(DetectedProviderId::Codex, account_id);
            detection.mark_cli_missing(DetectedProviderId::Codex, account_id);
            false
        }
        CodexOutcome::MissingCredential { .. } => {
            runtime.cancel(account_id);
            policy.cancel_unstarted(DetectedProviderId::Codex, account_id);
            false
        }
        CodexOutcome::Failed { .. } => {
            policy.retry_account(DetectedProviderId::Codex, &account_id, now_ms, None, false);
            false
        }
        CodexOutcome::Fallback {
            reason: CodexFailure::ProviderBlocked,
            ..
        } => {
            policy.refuse_account(DetectedProviderId::Codex, &account_id, now_ms, true);
            true
        }
        CodexOutcome::Fallback {
            reason: CodexFailure::RateLimited,
            retry_after_seconds,
            ..
        } => {
            policy.rate_limit_account(
                DetectedProviderId::Codex,
                &account_id,
                now_ms,
                *retry_after_seconds,
            );
            true
        }
        CodexOutcome::ReopenCli { .. } => {
            policy.refuse_account(DetectedProviderId::Codex, &account_id, now_ms, false);
            false
        }
        _ => {
            policy.complete_after(
                DetectedProviderId::Codex,
                &account_id,
                now_ms,
                REFRESH_SECONDS,
            );
            false
        }
    }
}

fn uncovered_account_ids(
    detected_account_ids: Vec<String>,
    covered: &HashSet<PollIdentity>,
) -> Vec<String> {
    detected_account_ids
        .into_iter()
        .filter(|account_id| {
            !covered.contains(&PollIdentity::detected(
                ProviderId::Codex,
                account_id.clone(),
            ))
        })
        .collect()
}

fn pass_read_succeeded(outcome: &CodexOutcome) -> bool {
    matches!(
        outcome,
        CodexOutcome::CacheCommitted { .. } | CodexOutcome::Cached { .. }
    )
}

pub async fn run_pass(
    app: &AppHandle,
    covered: &HashSet<PollIdentity>,
    automatic_account_limit: usize,
) -> bool {
    let detected_account_ids = app
        .state::<DetectionStore>()
        .account_ids(DetectedProviderId::Codex);
    let mut account_ids = uncovered_account_ids(detected_account_ids, covered);
    account_ids.truncate(automatic_account_limit);
    let mut succeeded = true;
    for account_id in account_ids {
        let detection = app.state::<DetectionStore>();
        let runtime = app.state::<CodexOauthRuntime>();
        let policy = app.state::<RequestPolicy>();
        let transport = app.state::<ReqwestTransport>();
        let writer = app.state::<Arc<CacheWriter>>();
        let (outcome, abort_provider) = collect_account_guarded(
            &detection,
            &runtime,
            &policy,
            &*transport,
            Arc::clone(&writer),
            account_id,
            crate::connections::now_epoch_ms(),
        )
        .await;
        succeeded &= pass_read_succeeded(&outcome);
        if abort_provider {
            break;
        }
    }
    succeeded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_refresh_reports_a_committed_read_and_a_login_failure() {
        assert!(pass_read_succeeded(&CodexOutcome::CacheCommitted {
            account_id: "fixture".into()
        }));
        assert!(pass_read_succeeded(&CodexOutcome::Cached {
            account_id: "fixture".into(),
            retry_at: "2026-09-08T12:00:00Z".into()
        }));
        assert!(!pass_read_succeeded(&CodexOutcome::ReopenCli {
            account_id: "fixture".into(),
            message: "Open the CLI once.".into()
        }));
    }

    use std::fs;

    use crate::cache_write::CACHE_FILE_NAME;
    use crate::provider_detection::opaque_account_id;
    use crate::test_support::TempDir;
    use std::collections::VecDeque;

    const NOW: u64 = 1_787_136_000_000;
    const TOKEN: &str = "codex-access-token-for-tests-only";

    struct StubAppServer {
        replies: Mutex<VecDeque<Result<RateLimitsPayload, AppServerFailure>>>,
        accounts: Mutex<Vec<String>>,
    }

    impl StubAppServer {
        fn new(replies: impl IntoIterator<Item = Result<String, AppServerFailure>>) -> Arc<Self> {
            Arc::new(Self {
                replies: Mutex::new(
                    replies
                        .into_iter()
                        .map(|reply| reply.map(|body| RateLimitsPayload { body }))
                        .collect(),
                ),
                accounts: Mutex::new(Vec::new()),
            })
        }

        fn accounts(&self) -> Vec<String> {
            self.accounts.lock().expect("accounts").clone()
        }
    }

    impl AppServerReader for StubAppServer {
        fn read(
            &self,
            _executable: &std::path::Path,
            _codex_home: &std::path::Path,
            expected_account_id: &str,
        ) -> Result<RateLimitsPayload, AppServerFailure> {
            self.accounts
                .lock()
                .expect("accounts")
                .push(expected_account_id.to_string());
            self.replies
                .lock()
                .expect("replies")
                .pop_front()
                .expect("stub response")
        }
    }

    #[test]
    fn a_connected_account_has_only_one_collection_path_per_cadence() {
        let provider_account_id = "provider-account-one";
        let detected_account_id = opaque_account_id(DetectedProviderId::Codex, provider_account_id);
        let covered = HashSet::from([PollIdentity::detected(
            ProviderId::Codex,
            detected_account_id.clone(),
        )]);
        let automatic = uncovered_account_ids(vec![detected_account_id], &covered);

        let generic_request_count = 1usize;
        assert!(automatic.is_empty());
        assert_eq!(generic_request_count + automatic.len(), 1);
    }

    #[test]
    fn a_distinct_detected_account_keeps_automatic_collection() {
        let detected_account_id =
            opaque_account_id(DetectedProviderId::Codex, "provider-account-two");
        let covered = HashSet::from([PollIdentity::detected(
            ProviderId::Codex,
            opaque_account_id(DetectedProviderId::Codex, "provider-account-one"),
        )]);
        let automatic = uncovered_account_ids(vec![detected_account_id.clone()], &covered);

        assert_eq!(automatic, vec![detected_account_id]);
    }

    fn valid_body() -> String {
        serde_json::json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": {
                    "usedPercent": 23.5,
                    "windowDurationMins": 300,
                    "resetsAt": (NOW + 3_600_000) / 1_000
                },
                "secondary": {
                    "usedPercent": 41.2,
                    "windowDurationMins": 10_080,
                    "resetsAt": (NOW + 86_400_000) / 1_000
                }
            }
        })
        .to_string()
    }

    fn writer(dir: &TempDir) -> Arc<CacheWriter> {
        Arc::new(CacheWriter::at(Some(dir.path().to_path_buf())))
    }

    #[tokio::test]
    async fn automatic_read_passes_the_account_identity_at_the_app_server_boundary() {
        let dir = TempDir::new();
        let runtime = CodexOauthRuntime::default();
        let app_server = StubAppServer::new([Ok(valid_body())]);
        let outcome = collect_with_app_server(
            &runtime,
            app_server.clone(),
            writer(&dir),
            "opaque-account-one",
            std::path::Path::new("synthetic-codex"),
            std::path::Path::new("synthetic-codex-home"),
            NOW,
        )
        .await;
        assert!(matches!(outcome, CodexOutcome::CacheCommitted { .. }));
        assert_eq!(app_server.accounts(), vec!["opaque-account-one"]);
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("FIVE_HOUR"));
        assert!(cache.contains("SEVEN_DAY"));
        assert!(!cache.contains(TOKEN));
    }

    #[tokio::test]
    async fn two_detected_accounts_keep_distinct_cache_rows() {
        let dir = TempDir::new();
        let runtime = CodexOauthRuntime::default();
        let app_server = StubAppServer::new([Ok(valid_body()), Ok(valid_body())]);
        for opaque in ["opaque-account-one", "opaque-account-two"] {
            let outcome = collect_with_app_server(
                &runtime,
                app_server.clone(),
                writer(&dir),
                opaque,
                std::path::Path::new("synthetic-codex"),
                std::path::Path::new("synthetic-codex-home"),
                NOW,
            )
            .await;
            assert!(matches!(outcome, CodexOutcome::CacheCommitted { .. }));
        }
        assert_eq!(
            app_server.accounts(),
            vec!["opaque-account-one", "opaque-account-two"]
        );
        let cache: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache"),
        )
        .expect("json");
        let rows = cache["snapshots"].as_array().expect("rows");
        assert_eq!(rows.len(), 4);
        assert_eq!(
            rows.iter()
                .filter(|row| row["accountId"] == "opaque-account-one")
                .count(),
            2
        );
        assert_eq!(
            rows.iter()
                .filter(|row| row["accountId"] == "opaque-account-two")
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn account_cadence_skips_a_second_app_server_read() {
        let dir = TempDir::new();
        let runtime = CodexOauthRuntime::default();
        let app_server = StubAppServer::new([Ok(valid_body())]);
        let _ = collect_with_app_server(
            &runtime,
            app_server.clone(),
            writer(&dir),
            "opaque-account-one",
            std::path::Path::new("synthetic-codex"),
            std::path::Path::new("synthetic-codex-home"),
            NOW,
        )
        .await;
        let second = collect_with_app_server(
            &runtime,
            app_server.clone(),
            writer(&dir),
            "opaque-account-one",
            std::path::Path::new("synthetic-codex"),
            std::path::Path::new("synthetic-codex-home"),
            NOW + 1_000,
        )
        .await;
        assert!(matches!(second, CodexOutcome::Cached { .. }));
        assert_eq!(app_server.accounts().len(), 1);
    }

    #[tokio::test]
    async fn response_drift_suppresses_old_rows_instead_of_writing_zero() {
        let dir = TempDir::new();
        let runtime = CodexOauthRuntime::default();
        let app_server = StubAppServer::new([Ok(r#"{"rateLimits":{}}"#.to_string())]);
        let outcome = collect_with_app_server(
            &runtime,
            app_server,
            writer(&dir),
            "opaque-account-one",
            std::path::Path::new("synthetic-codex"),
            std::path::Path::new("synthetic-codex-home"),
            NOW,
        )
        .await;
        assert!(matches!(
            outcome,
            CodexOutcome::Fallback {
                reason: CodexFailure::Drift,
                ..
            }
        ));
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("suppressions"));
        assert!(cache.contains("drift"));
        assert!(!cache.contains("\"value\":0"));
    }

    #[tokio::test]
    async fn authentication_failure_names_the_recovery_without_leaking_the_token() {
        let dir = TempDir::new();
        let runtime = CodexOauthRuntime::default();
        let app_server = StubAppServer::new([Err(AppServerFailure::NeedsSignIn)]);
        let outcome = collect_with_app_server(
            &runtime,
            app_server,
            writer(&dir),
            "opaque-account-one",
            std::path::Path::new("synthetic-codex"),
            std::path::Path::new("synthetic-codex-home"),
            NOW,
        )
        .await;
        let wire = serde_json::to_string(&outcome).expect("wire");
        assert!(wire.contains("reopen_cli"));
        assert!(wire.contains("Reopen Codex to refresh this login."));
        assert!(!wire.contains(TOKEN));
    }

    #[tokio::test]
    async fn guarded_acquisitions_follow_shared_exponential_retry() {
        let dir = TempDir::new();
        let detection = crate::provider_detection::DetectionStore::for_test_home(dir.path(), NOW);
        let account = "synthetic-account";
        let mut at = NOW;
        for seconds in [60, 120, 240, 480, 900, 900] {
            // Reopen the policy to prove attempts survive a process restart.
            let policy = RequestPolicy::at(Some(dir.path().to_path_buf()));
            let _lease = policy
                .begin_with_revision(DetectedProviderId::Codex, account, at, Some("revision"))
                .expect("due attempt");
            complete_outcome(
                &policy,
                &detection,
                &CodexOauthRuntime::default(),
                account,
                at,
                &CodexOutcome::Failed {
                    account_id: account.to_string(),
                    reason: CodexFailure::Connect,
                },
            );
            drop(_lease);
            let next = at + seconds * 1000;
            assert!(matches!(
                policy.begin_with_revision(
                    DetectedProviderId::Codex,
                    account,
                    next - 1,
                    Some("revision")
                ),
                Err(GateRejection::Deferred { retry_at }) if retry_at == next
            ));
            at = next;
        }
    }

    #[test]
    fn cached_outcome_preserves_shared_failures() {
        let dir = TempDir::new();
        let detection = DetectionStore::for_test_home(dir.path(), NOW);
        let policy = RequestPolicy::at(Some(dir.path().to_path_buf()));
        let account = "synthetic-account";
        let lease = policy
            .begin(DetectedProviderId::Codex, account, NOW)
            .unwrap();
        policy.rate_limit_account(DetectedProviderId::Codex, account, NOW, None);
        drop(lease);
        let at = NOW + 60_000;
        let _lease = policy
            .begin(DetectedProviderId::Codex, account, at)
            .unwrap();
        complete_outcome(
            &policy,
            &detection,
            &CodexOauthRuntime::default(),
            account,
            at,
            &CodexOutcome::Cached {
                account_id: account.into(),
                retry_at: iso_from_epoch_ms(at + 1).unwrap(),
            },
        );
        policy.rate_limit_account(DetectedProviderId::Codex, account, at, None);
        let document: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(
                dir.path()
                    .join(crate::request_policy::REQUEST_POLICY_FILE_NAME),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(document["providers"]["codex"]["attempts"][account], 2);
    }

    #[tokio::test]
    async fn a_restored_executable_can_run_immediately_after_it_was_missing() {
        let dir = TempDir::new();
        let runtime = CodexOauthRuntime::default();
        let policy = RequestPolicy::at(Some(dir.path().to_path_buf()));
        let account = "restored-executable-account";
        let lease = policy
            .begin_with_revision(DetectedProviderId::Codex, account, NOW, Some("revision"))
            .expect("first attempt");
        let missing = collect_with_app_server(
            &runtime,
            StubAppServer::new([Err(AppServerFailure::MissingExecutable)]),
            writer(&dir),
            account,
            std::path::Path::new("missing-codex"),
            std::path::Path::new("synthetic-codex-home"),
            NOW,
        )
        .await;
        let detection = DetectionStore::for_test_home(dir.path(), NOW);
        complete_outcome(&policy, &detection, &runtime, account, NOW, &missing);
        drop(lease);

        let restored_lease = policy
            .begin_with_revision(
                DetectedProviderId::Codex,
                account,
                NOW + 1,
                Some("revision"),
            )
            .expect("restored executable is immediately due");
        let restored = collect_with_app_server(
            &runtime,
            StubAppServer::new([Ok(valid_body())]),
            writer(&dir),
            account,
            std::path::Path::new("restored-codex"),
            std::path::Path::new("synthetic-codex-home"),
            NOW + 1,
        )
        .await;
        assert!(matches!(restored, CodexOutcome::CacheCommitted { .. }));
        drop(restored_lease);
    }

    #[tokio::test]
    async fn service_retry_after_reaches_the_shared_policy_boundary() {
        let dir = TempDir::new();
        let outcome = collect_with_app_server(
            &CodexOauthRuntime::default(),
            StubAppServer::new([Err(AppServerFailure::RateLimited(Some(7_200)))]),
            writer(&dir),
            "opaque-account-one",
            std::path::Path::new("synthetic-codex"),
            std::path::Path::new("synthetic-codex-home"),
            NOW,
        )
        .await;
        assert!(matches!(
            outcome,
            CodexOutcome::Fallback {
                reason: CodexFailure::RateLimited,
                retry_after_seconds: Some(7_200),
                ..
            }
        ));
    }

    #[tokio::test]
    async fn missing_executable_at_resolution_can_be_retried_immediately() {
        let dir = TempDir::new();
        let runtime = CodexOauthRuntime::default();
        let policy = RequestPolicy::at(Some(dir.path().to_path_buf()));
        let account = "unresolved-executable-account";
        let detection = DetectionStore::for_test_home(dir.path(), NOW);
        
        let auth_dir = dir.path().join(".codex");
        std::fs::create_dir_all(&auth_dir).unwrap();
        std::fs::write(
            auth_dir.join("auth.json"),
            r#"{"access_token":"fake-token"}"#,
        ).unwrap();

        // 1. First run, executable is missing.
        let (outcome, _) = collect_account_guarded(
            &detection,
            &runtime,
            &policy,
            &*StubAppServer::new([]),
            writer(&dir),
            account.to_string(),
            NOW,
        ).await;
        
        assert!(matches!(outcome, CodexOutcome::MissingExecutable { .. }));
        
        // 2. Install executable.
        let bin_dir = dir.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let codex_bin = bin_dir.join(if cfg!(windows) { "codex.cmd" } else { "codex" });
        std::fs::write(&codex_bin, "echo fake").unwrap();
        let path_var = std::env::var_os("PATH").unwrap_or_default();
        let mut new_path = std::ffi::OsString::new();
        new_path.push(bin_dir.as_os_str());
        if cfg!(windows) {
            new_path.push(";");
        } else {
            new_path.push(":");
        }
        new_path.push(path_var.clone());
        std::env::set_var("PATH", new_path);

        let detection_restored = DetectionStore::for_test_home(dir.path(), NOW + 1);
        
        // 3. Second run, should execute successfully immediately.
        let (outcome2, _) = collect_account_guarded(
            &detection_restored,
            &runtime,
            &policy,
            &*StubAppServer::new([Ok(valid_body())]),
            writer(&dir),
            account.to_string(),
            NOW + 1,
        ).await;
        
        std::env::set_var("PATH", path_var); // Restore PATH.
        
        assert!(matches!(outcome2, CodexOutcome::CacheCommitted { .. }));
    }
}
