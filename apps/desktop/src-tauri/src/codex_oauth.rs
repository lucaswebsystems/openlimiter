use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::cache_write::CacheWriter;
use crate::codex_app_server::{read_rate_limits_for_home, AppServerFailure};
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
}

fn app_server_failure(error: AppServerFailure) -> CodexFailure {
    match error {
        AppServerFailure::Timeout => CodexFailure::Timeout,
        AppServerFailure::Unavailable => CodexFailure::Connect,
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
        read_rate_limits_for_home(&executable, &codex_home, &expected_account_id)
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
            detection.mark_stale(DetectedProviderId::Codex, &account_id);
            return credential_failure(&account_id, DetectedCredentialError::NotFound);
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
        CodexOutcome::Fallback { .. } => {
            detection.mark_fallback(DetectedProviderId::Codex, &account_id)
        }
        CodexOutcome::Cached { .. } | CodexOutcome::Failed { .. } => {}
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
    let abort_provider = complete_outcome(policy, &account_id, now_ms, &outcome);
    (outcome, abort_provider)
}

fn complete_outcome(
    policy: &RequestPolicy,
    account_id: &str,
    now_ms: u64,
    outcome: &CodexOutcome,
) -> bool {
    match outcome {
        CodexOutcome::Cached { .. } => false,
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
    fn app_server_transport_failures_keep_the_existing_failure_vocabulary() {
        assert_eq!(app_server_failure(AppServerFailure::Timeout), CodexFailure::Timeout);
        assert_eq!(
            app_server_failure(AppServerFailure::Unavailable),
            CodexFailure::Connect
        );
        assert_eq!(
            app_server_failure(AppServerFailure::Protocol),
            CodexFailure::Protocol
        );
        assert_eq!(
            app_server_failure(AppServerFailure::NeedsSignIn),
            CodexFailure::ProviderBlocked
        );
        assert_eq!(
            app_server_failure(AppServerFailure::IdentityMismatch),
            CodexFailure::ProviderBlocked
        );
    }
}
