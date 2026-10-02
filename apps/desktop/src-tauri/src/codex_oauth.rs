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
use crate::provider_detection::{DetectedProviderId, DetectionStore};
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
    Unavailable {
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
        AppServerFailure::Protocol | AppServerFailure::NeedsSignIn => CodexFailure::Protocol,
    }
}

async fn commit_report(
    writer: Arc<CacheWriter>,
    account_id: Option<String>,
    report: CacheReport,
) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        write_report(&writer, "CODEX", account_id.as_deref(), report)
    })
    .await
    .is_ok_and(|result| result.is_ok())
}

async fn fallback_report(
    writer: Arc<CacheWriter>,
    account_id: &str,
    availability: &'static str,
    now_ms: u64,
) {
    let account_id = account_id.to_string();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        writer.record_availability("CODEX", Some(&account_id), availability, None, now_ms)
    })
    .await;
}

async fn collect_with_app_server(
    runtime: &CodexOauthRuntime,
    writer: Arc<CacheWriter>,
    account_id: Option<&str>,
    executable: std::path::PathBuf,
    codex_home: Option<std::path::PathBuf>,
    now_ms: u64,
) -> CodexOutcome {
    let poll_key = account_id.map(str::to_string).unwrap_or_else(|| {
        format!(
            "codex-home:{}",
            codex_home
                .as_ref()
                .map_or_else(String::new, |home| home.to_string_lossy().into_owned())
        )
    });
    if let Err(retry_ms) = runtime.begin(&poll_key, now_ms) {
        let Some(account_id) = account_id else {
            return CodexOutcome::Unavailable {
                reason: CodexFailure::Protocol,
            };
        };
        return CodexOutcome::Cached {
            account_id: account_id.to_string(),
            retry_at: iso_from_epoch_ms(retry_ms)
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
        };
    }
    let response = match tauri::async_runtime::spawn_blocking(move || {
        read_rate_limits_for_home(&executable, codex_home.as_deref())
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(AppServerFailure::NeedsSignIn)) => {
            runtime.postpone(&poll_key, now_ms, BLOCKED_BACKOFF_SECONDS);
            if let Some(account_id) = account_id {
                fallback_report(writer, account_id, "missing_credentials", now_ms).await;
                return CodexOutcome::reopen(account_id);
            }
            return CodexOutcome::Unavailable {
                reason: CodexFailure::Protocol,
            };
        }
        Ok(Err(error)) => {
            let reason = app_server_failure(error);
            if let Some(account_id) = account_id {
                let availability = match reason {
                    CodexFailure::Timeout | CodexFailure::Connect => "network_failure",
                    _ => "schema_drift",
                };
                fallback_report(Arc::clone(&writer), account_id, availability, now_ms).await;
                return CodexOutcome::Failed {
                    account_id: account_id.to_string(),
                    reason,
                };
            }
            return CodexOutcome::Unavailable { reason };
        }
        Err(_) => {
            if let Some(account_id) = account_id {
                fallback_report(Arc::clone(&writer), account_id, "schema_drift", now_ms).await;
                return CodexOutcome::Failed {
                    account_id: account_id.to_string(),
                    reason: CodexFailure::Protocol,
                };
            }
            return CodexOutcome::Unavailable {
                reason: CodexFailure::Protocol,
            };
        }
    };
    let observed_account_id = response
        .provider_account_id
        .as_deref()
        .map(|provider_id| {
            crate::provider_detection::opaque_account_id(DetectedProviderId::Codex, provider_id)
        });
    if let (Some(previous), Some(observed)) = (account_id, observed_account_id.as_deref()) {
        if previous != observed {
            fallback_report(
                Arc::clone(&writer),
                previous,
                "missing_credentials",
                now_ms,
            )
            .await;
        }
    }
    let effective_account_id = observed_account_id.or_else(|| account_id.map(str::to_string));
    let Some(effective_account_id) = effective_account_id else {
        return CodexOutcome::Unavailable {
            reason: CodexFailure::Protocol,
        };
    };
    let snapshots = parse_body(
        ReaderId::CodexUsage,
        &response.body,
        now_ms,
        &effective_account_id,
    );
    let Some(snapshots) = snapshots else {
        fallback_report(writer, &effective_account_id, "schema_drift", now_ms).await;
        return CodexOutcome::fallback(&effective_account_id, CodexFailure::Drift);
    };
    if commit_report(
        writer,
        Some(effective_account_id.clone()),
        CacheReport::Success(snapshots),
    )
    .await
    {
        CodexOutcome::CacheCommitted {
            account_id: effective_account_id,
        }
    } else {
        CodexOutcome::Failed {
            account_id: effective_account_id,
            reason: CodexFailure::Cache,
        }
    }
}

pub async fn collect_account<T: Transport>(
    detection: &DetectionStore,
    runtime: &CodexOauthRuntime,
    _transport: &T,
    writer: Arc<CacheWriter>,
    account_id: String,
    now_ms: u64,
) -> CodexOutcome {
    let executable = match detection.client_executable(DetectedProviderId::Codex) {
        Some(executable) => executable,
        None => {
            detection.mark_stale(DetectedProviderId::Codex, &account_id);
            fallback_report(writer, &account_id, "network_failure", now_ms).await;
            return CodexOutcome::Failed {
                account_id,
                reason: CodexFailure::Connect,
            };
        }
    };
    let codex_home = detection.managed_codex_home(&account_id);
    let outcome = collect_with_app_server(
        runtime,
        writer,
        Some(&account_id),
        executable,
        codex_home.clone(),
        now_ms,
    )
    .await;
    match &outcome {
        CodexOutcome::CacheCommitted {
            account_id: observed,
        } => {
            if observed != &account_id {
                detection.mark_stale(DetectedProviderId::Codex, &account_id);
                if let Some(home) = codex_home.as_deref() {
                    detection.remember_stored_codex_identity(home, observed);
                }
            }
            detection.mark_ready(DetectedProviderId::Codex, observed)
        }
        CodexOutcome::ReopenCli { .. } => {
            detection.mark_stale(DetectedProviderId::Codex, &account_id)
        }
        CodexOutcome::Fallback { .. } => {
            detection.mark_fallback(DetectedProviderId::Codex, &account_id)
        }
        CodexOutcome::Cached { .. }
        | CodexOutcome::Failed { .. }
        | CodexOutcome::Unavailable { .. } => {}
    }
    outcome
}

pub(crate) async fn collect_home<T: Transport>(
    detection: &DetectionStore,
    runtime: &CodexOauthRuntime,
    _transport: &T,
    writer: Arc<CacheWriter>,
    codex_home: std::path::PathBuf,
    account_id: Option<String>,
    now_ms: u64,
) -> CodexOutcome {
    let Some(executable) = detection.client_executable(DetectedProviderId::Codex) else {
        if let Some(account_id) = account_id {
            fallback_report(writer, &account_id, "network_failure", now_ms).await;
            return CodexOutcome::Failed {
                account_id,
                reason: CodexFailure::Connect,
            };
        }
        return CodexOutcome::Unavailable {
            reason: CodexFailure::Connect,
        };
    };
    let outcome = collect_with_app_server(
        runtime,
        writer,
        account_id.as_deref(),
        executable,
        Some(codex_home.clone()),
        now_ms,
    )
    .await;
    if let CodexOutcome::CacheCommitted { account_id } = &outcome {
        detection.remember_stored_codex_identity(&codex_home, account_id);
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
    // Only file metadata participates. The app server owns the credential and
    // OpenLimiter never loads its bearer token.
    let revision = detection
        .managed_codex_home(&account_id)
        .or_else(|| detection.default_codex_home())
        .map(|home| detection.codex_login_revision(&home))
        .unwrap_or_else(|| "codex-app-server-unavailable".to_string());
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
        CodexOutcome::Unavailable { .. } => false,
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
    let detection = app.state::<DetectionStore>();
    let mut targets = detection.codex_targets();
    targets.retain(|(_, account_id)| {
        account_id.as_ref().is_none_or(|account_id| {
            !covered.contains(&PollIdentity::detected(
                ProviderId::Codex,
                account_id.clone(),
            ))
        })
    });
    targets.truncate(automatic_account_limit);
    let mut succeeded = true;
    for (home, account_id) in targets {
        let detection = app.state::<DetectionStore>();
        let runtime = app.state::<CodexOauthRuntime>();
        let policy = app.state::<RequestPolicy>();
        let transport = app.state::<ReqwestTransport>();
        let writer = app.state::<Arc<CacheWriter>>();
        let (outcome, abort_provider) = if let Some(account_id) = account_id {
            collect_account_guarded(
                &detection,
                &runtime,
                &policy,
                &*transport,
                Arc::clone(&writer),
                account_id,
                crate::connections::now_epoch_ms(),
            )
            .await
        } else {
            (
                collect_home(
                    &detection,
                    &runtime,
                    &*transport,
                    Arc::clone(&writer),
                    home,
                    None,
                    crate::connections::now_epoch_ms(),
                )
                .await,
                false,
            )
        };
        succeeded &= pass_read_succeeded(&outcome);
        if abort_provider {
            break;
        }
    }
    succeeded
}
