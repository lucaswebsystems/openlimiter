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

pub const REFRESH_SECONDS: u64 = 300;
const RATE_LIMIT_BACKOFF_SECONDS: u64 = 3_600;
const BLOCKED_BACKOFF_SECONDS: u64 = 86_400;
const MAX_THROTTLE_ENTRIES: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KimiFailure {
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
pub enum KimiOutcome {
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
        reason: KimiFailure,
    },
    Failed {
        account_id: String,
        reason: KimiFailure,
    },
}

impl KimiOutcome {
    fn reopen(account_id: &str) -> Self {
        Self::ReopenCli {
            account_id: account_id.to_string(),
            message: "Reopen Kimi to refresh this login.".to_string(),
        }
    }

    fn fallback(account_id: &str, reason: KimiFailure) -> Self {
        Self::Fallback {
            account_id: account_id.to_string(),
            reason,
        }
    }
}

#[derive(Default)]
pub struct KimiOauthRuntime {
    next_allowed: Mutex<BTreeMap<String, u64>>,
}

impl KimiOauthRuntime {
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

fn net_failure(error: NetError) -> KimiFailure {
    match error {
        NetError::Timeout => KimiFailure::Timeout,
        NetError::Connect => KimiFailure::Connect,
        NetError::Tls => KimiFailure::Tls,
        NetError::TooLarge => KimiFailure::TooLarge,
        NetError::Protocol => KimiFailure::Protocol,
    }
}

async fn commit_report(writer: Arc<CacheWriter>, account_id: String, report: CacheReport) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        write_report(&writer, "KIMI", Some(&account_id), report)
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
    runtime: &KimiOauthRuntime,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: &str,
    secret: &DetectedSecret,
    now_ms: u64,
) -> KimiOutcome {
    if let Err(retry_ms) = runtime.begin(account_id, now_ms) {
        return KimiOutcome::Cached {
            account_id: account_id.to_string(),
            retry_at: iso_from_epoch_ms(retry_ms)
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
        };
    }
    let response = match fetch_endpoint(
        transport,
        ProviderEndpoint::KimiUsage,
        AuthApplication::KimiSessionBearer,
        &secret.access_token,
        None,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            return KimiOutcome::Failed {
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
                .and_then(|body| parse_body(ReaderId::KimiUsage, body, now_ms, account_id));
            let Some(snapshots) = snapshots else {
                fallback_report(writer, account_id, true, now_ms).await;
                return KimiOutcome::fallback(account_id, KimiFailure::Drift);
            };
            if commit_report(
                writer,
                account_id.to_string(),
                CacheReport::Success(snapshots),
            )
            .await
            {
                KimiOutcome::CacheCommitted {
                    account_id: account_id.to_string(),
                }
            } else {
                KimiOutcome::Failed {
                    account_id: account_id.to_string(),
                    reason: KimiFailure::Cache,
                }
            }
        }
        401 => {
            runtime.postpone(account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, account_id, false, now_ms).await;
            KimiOutcome::reopen(account_id)
        }
        403 | 404 | 410 => {
            runtime.postpone(account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, account_id, false, now_ms).await;
            KimiOutcome::fallback(account_id, KimiFailure::ProviderBlocked)
        }
        429 => {
            let seconds = response
                .retry_after_seconds
                .unwrap_or(0)
                .max(RATE_LIMIT_BACKOFF_SECONDS)
                .min(BLOCKED_BACKOFF_SECONDS);
            runtime.postpone(account_id, now_ms, seconds);
            fallback_report(writer, account_id, false, now_ms).await;
            KimiOutcome::fallback(account_id, KimiFailure::RateLimited)
        }
        _ => KimiOutcome::Failed {
            account_id: account_id.to_string(),
            reason: KimiFailure::ProviderResponse,
        },
    }
}

fn credential_failure(account_id: &str, _error: DetectedCredentialError) -> KimiOutcome {
    KimiOutcome::reopen(account_id)
}

pub async fn collect_account<T: Transport>(
    detection: &DetectionStore,
    runtime: &KimiOauthRuntime,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: String,
    now_ms: u64,
) -> KimiOutcome {
    let secret = match detection.read_credential(DetectedProviderId::Kimi, &account_id) {
        Ok(secret) => secret,
        Err(error) => {
            detection.mark_stale(DetectedProviderId::Kimi, &account_id);
            return credential_failure(&account_id, error);
        }
    };
    let outcome =
        collect_with_secret(runtime, transport, writer, &account_id, &secret, now_ms).await;
    match &outcome {
        KimiOutcome::CacheCommitted { .. } => {
            detection.mark_ready(DetectedProviderId::Kimi, &account_id)
        }
        KimiOutcome::ReopenCli { .. } => {
            detection.mark_stale(DetectedProviderId::Kimi, &account_id)
        }
        KimiOutcome::Fallback { .. } => {
            detection.mark_fallback(DetectedProviderId::Kimi, &account_id)
        }
        KimiOutcome::Cached { .. } | KimiOutcome::Failed { .. } => {}
    }
    outcome
}

fn uncovered_account_ids(
    detected_account_ids: Vec<String>,
    covered: &HashSet<PollIdentity>,
) -> Vec<String> {
    detected_account_ids
        .into_iter()
        .filter(|account_id| {
            !covered.contains(&PollIdentity::detected(
                ProviderId::Kimi,
                account_id.clone(),
            ))
        })
        .collect()
}

pub async fn run_pass(app: &AppHandle, covered: &HashSet<PollIdentity>) {
    let account_ids = uncovered_account_ids(
        app.state::<DetectionStore>()
            .account_ids(DetectedProviderId::Kimi),
        covered,
    );
    for account_id in account_ids {
        let detection = app.state::<DetectionStore>();
        let runtime = app.state::<KimiOauthRuntime>();
        let transport = app.state::<ReqwestTransport>();
        let writer = app.state::<Arc<CacheWriter>>();
        let _ = collect_account(
            &detection,
            &runtime,
            &*transport,
            Arc::clone(&writer),
            account_id,
            crate::connections::now_epoch_ms(),
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use crate::cache_write::CACHE_FILE_NAME;
    use crate::native_snapshot::epoch_ms_from_rfc3339;
    use crate::net::KIMI_USAGE_URL;
    use crate::test_support::{RecordingTransport, TempDir};
    use zeroize::Zeroizing;

    const NOW_TEXT: &str = "2026-08-07T12:00:00.000Z";
    const TOKEN: &str = "kimi-access-token-for-tests-only";
    const FIXTURE: &str = include_str!("../../../../packages/connectors/fixtures/kimi.usages.json");

    fn now() -> u64 {
        epoch_ms_from_rfc3339(NOW_TEXT).expect("fixture clock")
    }

    fn secret(token: &str, revision: &str) -> DetectedSecret {
        DetectedSecret {
            access_token: Zeroizing::new(token.to_string()),
            provider_account_id: None,
            credential_revision: revision.to_string(),
        }
    }

    fn writer(dir: &TempDir) -> Arc<CacheWriter> {
        Arc::new(CacheWriter::at(Some(dir.path().to_path_buf())))
    }

    #[tokio::test]
    async fn official_source_fixture_runs_through_request_parser_and_cache() {
        let dir = TempDir::new();
        let runtime = KimiOauthRuntime::default();
        let transport = RecordingTransport::replying(200, FIXTURE.as_bytes().to_vec(), None);
        let outcome = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            "kimi-account-one",
            &secret(TOKEN, "one"),
            now(),
        )
        .await;
        assert!(matches!(outcome, KimiOutcome::CacheCommitted { .. }));
        assert_eq!(transport.recorded_urls(), vec![KIMI_USAGE_URL]);
        assert_eq!(
            transport.recorded_auths(),
            vec![AuthApplication::KimiSessionBearer]
        );
        assert_eq!(transport.recorded_provider_account_ids(), vec![None]);
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("WEEKLY"));
        assert!(cache.contains("FIVE_HOUR"));
        assert!(!cache.contains(TOKEN));
    }

    #[tokio::test]
    async fn cadence_is_bound_to_the_resolved_account_not_the_token() {
        let dir = TempDir::new();
        let runtime = KimiOauthRuntime::default();
        let transport = RecordingTransport::replying(200, FIXTURE.as_bytes().to_vec(), None);
        let _ = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            "kimi-account-one",
            &secret(TOKEN, "one"),
            now(),
        )
        .await;
        let second = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            "kimi-account-one",
            &secret("rotated-kimi-token-for-tests-only", "two"),
            now() + 1_000,
        )
        .await;
        assert!(matches!(second, KimiOutcome::Cached { .. }));
        assert_eq!(transport.recorded_urls().len(), 1);
    }

    #[tokio::test]
    async fn two_accounts_keep_distinct_rows() {
        let dir = TempDir::new();
        let runtime = KimiOauthRuntime::default();
        let transport = RecordingTransport::replying(200, FIXTURE.as_bytes().to_vec(), None);
        for account in ["kimi-account-one", "kimi-account-two"] {
            let outcome = collect_with_secret(
                &runtime,
                &transport,
                writer(&dir),
                account,
                &secret(TOKEN, account),
                now(),
            )
            .await;
            assert!(matches!(outcome, KimiOutcome::CacheCommitted { .. }));
        }
        let cache: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache"),
        )
        .expect("json");
        assert_eq!(cache["snapshots"].as_array().expect("rows").len(), 4);
    }

    #[tokio::test]
    async fn drift_suppresses_previous_rows_without_inventing_zero() {
        let dir = TempDir::new();
        let runtime = KimiOauthRuntime::default();
        let transport = RecordingTransport::replying(200, br#"{"usage":{}}"#.to_vec(), None);
        let outcome = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            "kimi-account-one",
            &secret(TOKEN, "drift"),
            now(),
        )
        .await;
        assert!(matches!(
            outcome,
            KimiOutcome::Fallback {
                reason: KimiFailure::Drift,
                ..
            }
        ));
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("suppressions"));
        assert!(!cache.contains("\"value\":0"));
    }

    #[test]
    fn generic_and_detected_paths_dedupe_by_account_identity() {
        let account_id = "kimi-account-one".to_string();
        let covered = HashSet::from([PollIdentity::detected(ProviderId::Kimi, account_id.clone())]);
        assert!(uncovered_account_ids(vec![account_id], &covered).is_empty());
    }
}
