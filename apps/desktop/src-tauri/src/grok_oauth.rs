use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::cache_write::CacheWriter;
use crate::native_readers::parse_body;
use crate::native_snapshot::{iso_from_epoch_ms, write_report, CacheReport};
use crate::net::{fetch_endpoint, NetError, ProviderEndpoint, ReqwestTransport, Transport};
use crate::poll_identity::PollIdentity;
use crate::provider_detection::{
    DetectedCredentialError, DetectedProviderId, DetectedSecret, DetectionStore,
};
use crate::reader_registry::{AuthApplication, ProviderId, ReaderId};
use crate::request_policy::{GateRejection, RequestPolicy};

pub const REFRESH_SECONDS: u64 = 300;
const RATE_LIMIT_BACKOFF_SECONDS: u64 = 3_600;
const BLOCKED_BACKOFF_SECONDS: u64 = 86_400;
const MAX_THROTTLE_ENTRIES: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GrokFailure {
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
pub enum GrokOutcome {
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
        reason: GrokFailure,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_after_seconds: Option<u64>,
    },
    Failed {
        account_id: String,
        reason: GrokFailure,
    },
}

impl GrokOutcome {
    fn reopen(account_id: &str) -> Self {
        Self::ReopenCli {
            account_id: account_id.to_string(),
            message: "Reopen Grok to refresh this login.".to_string(),
        }
    }

    fn fallback(account_id: &str, reason: GrokFailure) -> Self {
        Self::Fallback {
            account_id: account_id.to_string(),
            reason,
            retry_after_seconds: None,
        }
    }

    fn rate_limited(account_id: &str, retry_after_seconds: Option<u64>) -> Self {
        Self::Fallback {
            account_id: account_id.to_string(),
            reason: GrokFailure::RateLimited,
            retry_after_seconds,
        }
    }
}

#[derive(Default)]
pub struct GrokOauthRuntime {
    next_allowed: Mutex<BTreeMap<String, u64>>,
}

impl GrokOauthRuntime {
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

fn net_failure(error: NetError) -> GrokFailure {
    match error {
        NetError::Timeout => GrokFailure::Timeout,
        NetError::Connect => GrokFailure::Connect,
        NetError::Tls => GrokFailure::Tls,
        NetError::TooLarge => GrokFailure::TooLarge,
        NetError::Protocol => GrokFailure::Protocol,
    }
}

async fn commit_report(writer: Arc<CacheWriter>, account_id: String, report: CacheReport) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        write_report(&writer, "GROK", Some(&account_id), report)
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

async fn collect_with_secret<T: Transport>(
    runtime: &GrokOauthRuntime,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: &str,
    secret: &DetectedSecret,
    now_ms: u64,
) -> GrokOutcome {
    if let Err(retry_ms) = runtime.begin(account_id, now_ms) {
        return GrokOutcome::Cached {
            account_id: account_id.to_string(),
            retry_at: iso_from_epoch_ms(retry_ms)
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
        };
    }
    let response = match fetch_endpoint(
        transport,
        ProviderEndpoint::GrokUsage,
        AuthApplication::GrokSessionBearer,
        &secret.access_token,
        secret.provider_account_id.as_deref(),
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            return GrokOutcome::Failed {
                account_id: account_id.to_string(),
                reason: net_failure(error),
            }
        }
    };
    match response.status {
        200..=299 => {
            let snapshots = response
                .body
                .as_deref()
                .and_then(|body| parse_body(ReaderId::GrokUsage, body, now_ms, account_id));
            let Some(snapshots) = snapshots else {
                fallback_report(writer, account_id, true, now_ms).await;
                return GrokOutcome::fallback(account_id, GrokFailure::Drift);
            };
            if commit_report(
                writer,
                account_id.to_string(),
                CacheReport::Success(snapshots),
            )
            .await
            {
                GrokOutcome::CacheCommitted {
                    account_id: account_id.to_string(),
                }
            } else {
                GrokOutcome::Failed {
                    account_id: account_id.to_string(),
                    reason: GrokFailure::Cache,
                }
            }
        }
        401 => {
            runtime.postpone(account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, account_id, false, now_ms).await;
            GrokOutcome::reopen(account_id)
        }
        403 | 404 | 410 => {
            runtime.postpone(account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, account_id, false, now_ms).await;
            GrokOutcome::fallback(account_id, GrokFailure::ProviderBlocked)
        }
        429 | 503 if response.status == 429 || response.retry_after_seconds.is_some() => {
            let retry_after_seconds = response.retry_after_seconds;
            let seconds = response
                .retry_after_seconds
                .unwrap_or(0)
                .max(RATE_LIMIT_BACKOFF_SECONDS)
                .min(BLOCKED_BACKOFF_SECONDS);
            runtime.postpone(account_id, now_ms, seconds);
            fallback_report(writer, account_id, false, now_ms).await;
            GrokOutcome::rate_limited(account_id, retry_after_seconds)
        }
        _ => GrokOutcome::Failed {
            account_id: account_id.to_string(),
            reason: GrokFailure::ProviderResponse,
        },
    }
}

fn credential_failure(account_id: &str, _error: DetectedCredentialError) -> GrokOutcome {
    GrokOutcome::reopen(account_id)
}

pub async fn collect_account<T: Transport>(
    detection: &DetectionStore,
    runtime: &GrokOauthRuntime,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: String,
    now_ms: u64,
) -> GrokOutcome {
    let secret = match detection.read_credential(DetectedProviderId::Grok, &account_id) {
        Ok(secret) => secret,
        Err(error) => {
            detection.mark_stale(DetectedProviderId::Grok, &account_id);
            return credential_failure(&account_id, error);
        }
    };
    let outcome =
        collect_with_secret(runtime, transport, writer, &account_id, &secret, now_ms).await;
    match &outcome {
        GrokOutcome::CacheCommitted { .. } => {
            detection.mark_ready(DetectedProviderId::Grok, &account_id)
        }
        GrokOutcome::ReopenCli { .. } => {
            detection.mark_stale(DetectedProviderId::Grok, &account_id)
        }
        GrokOutcome::Fallback { .. } => {
            detection.mark_fallback(DetectedProviderId::Grok, &account_id)
        }
        GrokOutcome::Cached { .. } | GrokOutcome::Failed { .. } => {}
    }
    outcome
}

async fn collect_account_guarded<T: Transport>(
    detection: &DetectionStore,
    runtime: &GrokOauthRuntime,
    policy: &RequestPolicy,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: String,
    now_ms: u64,
) -> (GrokOutcome, bool) {
    let _lease = match policy.begin(DetectedProviderId::Grok, &account_id, now_ms) {
        Ok(lease) => lease,
        Err(GateRejection::Deferred { retry_at }) => {
            return (
                GrokOutcome::Cached {
                    account_id,
                    retry_at: iso_from_epoch_ms(retry_at)
                        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
                },
                false,
            )
        }
        Err(GateRejection::Busy | GateRejection::Unavailable) => {
            return (
                GrokOutcome::Failed {
                    account_id,
                    reason: GrokFailure::Protocol,
                },
                false,
            )
        }
    };
    let outcome = collect_account(
        detection,
        runtime,
        transport,
        writer,
        account_id.clone(),
        now_ms,
    )
    .await;
    let abort_provider = match &outcome {
        GrokOutcome::Fallback {
            reason: GrokFailure::ProviderBlocked,
            ..
        } => {
            policy.block_provider(DetectedProviderId::Grok, now_ms, BLOCKED_BACKOFF_SECONDS);
            true
        }
        GrokOutcome::Fallback {
            reason: GrokFailure::RateLimited,
            retry_after_seconds,
            ..
        } => {
            policy.rate_limit_account(
                DetectedProviderId::Grok,
                &account_id,
                now_ms,
                *retry_after_seconds,
            );
            true
        }
        GrokOutcome::ReopenCli { .. } => {
            policy.complete_after(
                DetectedProviderId::Grok,
                &account_id,
                now_ms,
                BLOCKED_BACKOFF_SECONDS,
            );
            false
        }
        _ => {
            policy.complete_after(
                DetectedProviderId::Grok,
                &account_id,
                now_ms,
                REFRESH_SECONDS,
            );
            false
        }
    };
    (outcome, abort_provider)
}

fn uncovered_account_ids(
    detected_account_ids: Vec<String>,
    covered: &HashSet<PollIdentity>,
) -> Vec<String> {
    detected_account_ids
        .into_iter()
        .filter(|account_id| {
            !covered.contains(&PollIdentity::detected(
                ProviderId::Grok,
                account_id.clone(),
            ))
        })
        .collect()
}

pub async fn run_pass(app: &AppHandle, covered: &HashSet<PollIdentity>) {
    let account_ids = uncovered_account_ids(
        app.state::<DetectionStore>()
            .account_ids(DetectedProviderId::Grok),
        covered,
    );
    for account_id in account_ids {
        let detection = app.state::<DetectionStore>();
        let runtime = app.state::<GrokOauthRuntime>();
        let policy = app.state::<RequestPolicy>();
        let transport = app.state::<ReqwestTransport>();
        let writer = app.state::<Arc<CacheWriter>>();
        let (_, abort_provider) = collect_account_guarded(
            &detection,
            &runtime,
            &policy,
            &*transport,
            Arc::clone(&writer),
            account_id,
            crate::connections::now_epoch_ms(),
        )
        .await;
        if abort_provider {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use crate::cache_write::CACHE_FILE_NAME;
    use crate::native_snapshot::epoch_ms_from_rfc3339;
    use crate::net::GROK_USAGE_URL;
    use crate::test_support::{RecordingTransport, TempDir};
    use zeroize::Zeroizing;

    const NOW_TEXT: &str = "2026-08-07T12:00:00.000Z";
    const TOKEN: &str = "grok-access-token-for-tests-only";
    const FIXTURE: &str =
        include_str!("../../../../packages/connectors/fixtures/grok.billing.json");

    fn now() -> u64 {
        epoch_ms_from_rfc3339(NOW_TEXT).expect("fixture clock")
    }

    fn secret(token: &str, provider_account_id: &str, revision: &str) -> DetectedSecret {
        DetectedSecret {
            access_token: Zeroizing::new(token.to_string()),
            provider_account_id: Some(provider_account_id.to_string()),
            credential_revision: revision.to_string(),
        }
    }

    fn writer(dir: &TempDir) -> Arc<CacheWriter> {
        Arc::new(CacheWriter::at(Some(dir.path().to_path_buf())))
    }

    #[tokio::test]
    async fn official_source_fixture_runs_through_request_parser_and_cache() {
        let dir = TempDir::new();
        let runtime = GrokOauthRuntime::default();
        let transport = RecordingTransport::replying(200, FIXTURE.as_bytes().to_vec(), None);
        let outcome = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            "grok-account-one",
            &secret(TOKEN, "provider-user-one", "one"),
            now(),
        )
        .await;
        assert!(matches!(outcome, GrokOutcome::CacheCommitted { .. }));
        assert_eq!(transport.recorded_urls(), vec![GROK_USAGE_URL]);
        assert_eq!(
            transport.recorded_auths(),
            vec![AuthApplication::GrokSessionBearer]
        );
        assert_eq!(
            transport.recorded_provider_account_ids(),
            vec![Some("provider-user-one".to_string())]
        );
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("WEEKLY"));
        assert!(cache.contains("ON_DEMAND_MONTHLY"));
        assert!(!cache.contains(TOKEN));
    }

    #[tokio::test]
    async fn cadence_is_bound_to_the_resolved_account_not_the_token() {
        let dir = TempDir::new();
        let runtime = GrokOauthRuntime::default();
        let transport = RecordingTransport::replying(200, FIXTURE.as_bytes().to_vec(), None);
        let _ = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            "grok-account-one",
            &secret(TOKEN, "provider-user-one", "one"),
            now(),
        )
        .await;
        let second = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            "grok-account-one",
            &secret(
                "rotated-grok-token-for-tests-only",
                "provider-user-one",
                "two",
            ),
            now() + 1_000,
        )
        .await;
        assert!(matches!(second, GrokOutcome::Cached { .. }));
        assert_eq!(transport.recorded_urls().len(), 1);
    }

    #[tokio::test]
    async fn drift_suppresses_previous_rows_without_inventing_zero() {
        let dir = TempDir::new();
        let runtime = GrokOauthRuntime::default();
        let transport = RecordingTransport::replying(200, br#"{"config":{}}"#.to_vec(), None);
        let outcome = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            "grok-account-one",
            &secret(TOKEN, "provider-user-one", "drift"),
            now(),
        )
        .await;
        assert!(matches!(
            outcome,
            GrokOutcome::Fallback {
                reason: GrokFailure::Drift,
                ..
            }
        ));
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("suppressions"));
        assert!(!cache.contains("\"value\":0"));
    }

    #[test]
    fn generic_and_detected_paths_dedupe_by_account_identity() {
        let account_id = "grok-account-one".to_string();
        let covered = HashSet::from([PollIdentity::detected(ProviderId::Grok, account_id.clone())]);
        assert!(uncovered_account_ids(vec![account_id], &covered).is_empty());
    }

    #[tokio::test]
    async fn service_retry_after_reaches_the_shared_policy_boundary() {
        let dir = TempDir::new();
        let outcome = collect_with_secret(
            &GrokOauthRuntime::default(),
            &RecordingTransport::replying(503, Vec::new(), Some(7_200)),
            writer(&dir),
            "grok-account-one",
            &secret(TOKEN, "provider-user-one", "service-backoff"),
            now(),
        )
        .await;
        assert!(matches!(
            outcome,
            GrokOutcome::Fallback {
                reason: GrokFailure::RateLimited,
                retry_after_seconds: Some(7_200),
                ..
            }
        ));
    }
}
