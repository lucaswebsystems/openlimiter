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

pub const REFRESH_SECONDS: u64 = 600;
const RATE_LIMIT_BACKOFF_SECONDS: u64 = 3_600;
const BLOCKED_BACKOFF_SECONDS: u64 = 86_400;
const MAX_THROTTLE_ENTRIES: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AntigravityFailure {
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
pub enum AntigravityOutcome {
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
        reason: AntigravityFailure,
    },
    Failed {
        account_id: String,
        reason: AntigravityFailure,
    },
}

impl AntigravityOutcome {
    fn reopen(account_id: &str) -> Self {
        Self::ReopenCli {
            account_id: account_id.to_string(),
            message: "Reopen Antigravity to refresh this login.".to_string(),
        }
    }

    fn fallback(account_id: &str, reason: AntigravityFailure) -> Self {
        Self::Fallback {
            account_id: account_id.to_string(),
            reason,
        }
    }
}

#[derive(Default)]
pub struct AntigravityOauthRuntime {
    next_allowed: Mutex<BTreeMap<String, u64>>,
}

impl AntigravityOauthRuntime {
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

fn net_failure(error: NetError) -> AntigravityFailure {
    match error {
        NetError::Timeout => AntigravityFailure::Timeout,
        NetError::Connect => AntigravityFailure::Connect,
        NetError::Tls => AntigravityFailure::Tls,
        NetError::TooLarge => AntigravityFailure::TooLarge,
        NetError::Protocol => AntigravityFailure::Protocol,
    }
}

async fn commit_report(writer: Arc<CacheWriter>, account_id: String, report: CacheReport) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        write_report(&writer, "ANTIGRAVITY", Some(&account_id), report)
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
    runtime: &AntigravityOauthRuntime,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: &str,
    secret: &DetectedSecret,
    now_ms: u64,
) -> AntigravityOutcome {
    if let Err(retry_ms) = runtime.begin(account_id, now_ms) {
        return AntigravityOutcome::Cached {
            account_id: account_id.to_string(),
            retry_at: iso_from_epoch_ms(retry_ms)
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
        };
    }
    let response = match fetch_endpoint(
        transport,
        ProviderEndpoint::AntigravityQuota,
        AuthApplication::AntigravitySessionBearer,
        &secret.access_token,
        None,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            return AntigravityOutcome::Failed {
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
                .and_then(|body| parse_body(ReaderId::AntigravityQuota, body, now_ms, account_id));
            let Some(snapshots) = snapshots else {
                fallback_report(writer, account_id, true, now_ms).await;
                return AntigravityOutcome::fallback(account_id, AntigravityFailure::Drift);
            };
            if commit_report(
                writer,
                account_id.to_string(),
                CacheReport::Success(snapshots),
            )
            .await
            {
                AntigravityOutcome::CacheCommitted {
                    account_id: account_id.to_string(),
                }
            } else {
                AntigravityOutcome::Failed {
                    account_id: account_id.to_string(),
                    reason: AntigravityFailure::Cache,
                }
            }
        }
        401 => {
            runtime.postpone(account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, account_id, false, now_ms).await;
            AntigravityOutcome::reopen(account_id)
        }
        403 | 404 | 410 => {
            runtime.postpone(account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, account_id, false, now_ms).await;
            AntigravityOutcome::fallback(account_id, AntigravityFailure::ProviderBlocked)
        }
        429 => {
            let seconds = response
                .retry_after_seconds
                .unwrap_or(0)
                .max(RATE_LIMIT_BACKOFF_SECONDS)
                .min(BLOCKED_BACKOFF_SECONDS);
            runtime.postpone(account_id, now_ms, seconds);
            fallback_report(writer, account_id, false, now_ms).await;
            AntigravityOutcome::fallback(account_id, AntigravityFailure::RateLimited)
        }
        _ => AntigravityOutcome::Failed {
            account_id: account_id.to_string(),
            reason: AntigravityFailure::ProviderResponse,
        },
    }
}

fn credential_failure(account_id: &str, error: DetectedCredentialError) -> AntigravityOutcome {
    match error {
        DetectedCredentialError::Stale
        | DetectedCredentialError::NotFound
        | DetectedCredentialError::Unreadable => AntigravityOutcome::reopen(account_id),
    }
}

pub async fn collect_account<T: Transport>(
    detection: &DetectionStore,
    runtime: &AntigravityOauthRuntime,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: String,
    now_ms: u64,
) -> AntigravityOutcome {
    let secret = match detection.read_credential(DetectedProviderId::Antigravity, &account_id) {
        Ok(secret) => secret,
        Err(error) => {
            detection.mark_stale(DetectedProviderId::Antigravity, &account_id);
            return credential_failure(&account_id, error);
        }
    };
    let outcome =
        collect_with_secret(runtime, transport, writer, &account_id, &secret, now_ms).await;
    match &outcome {
        AntigravityOutcome::CacheCommitted { .. } => {
            detection.mark_ready(DetectedProviderId::Antigravity, &account_id)
        }
        AntigravityOutcome::ReopenCli { .. } => {
            detection.mark_stale(DetectedProviderId::Antigravity, &account_id)
        }
        AntigravityOutcome::Fallback { .. } => {
            detection.mark_fallback(DetectedProviderId::Antigravity, &account_id)
        }
        AntigravityOutcome::Cached { .. } | AntigravityOutcome::Failed { .. } => {}
    }
    outcome
}

fn uncovered_account_ids(
    detected_account_ids: Vec<String>,
    covered: &HashSet<PollIdentity>,
) -> Vec<String> {
    /* The vendor vault exposes one current Antigravity login, with no stable
    provider account id beside the rotating access token. If any saved
    Antigravity connection exists, fail closed to that one path instead of
    risking a second request from the automatic path after token rotation. */
    if covered
        .iter()
        .any(|identity| identity.provider_id() == ProviderId::Antigravity)
    {
        return Vec::new();
    }
    detected_account_ids
        .into_iter()
        .filter(|account_id| {
            !covered.contains(&PollIdentity::detected(
                ProviderId::Antigravity,
                account_id.clone(),
            ))
        })
        .collect()
}

pub async fn run_pass(app: &AppHandle, covered: &HashSet<PollIdentity>) {
    let detected_account_ids = app
        .state::<DetectionStore>()
        .account_ids(DetectedProviderId::Antigravity);
    let account_ids = uncovered_account_ids(detected_account_ids, covered);
    for account_id in account_ids {
        let detection = app.state::<DetectionStore>();
        let runtime = app.state::<AntigravityOauthRuntime>();
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
    use crate::net::{
        HttpMethod, ANTIGRAVITY_BOOTSTRAP_BODY, ANTIGRAVITY_BOOTSTRAP_URL, ANTIGRAVITY_QUOTA_URL,
    };
    use crate::test_support::{RecordingTransport, TempDir};
    use zeroize::Zeroizing;

    const NOW: u64 = 1_787_136_000_000;
    const TOKEN: &str = "antigravity-access-token-for-tests-only";
    const ACCOUNT: &str = "antigravity-test-account";

    #[test]
    fn a_connected_account_has_only_one_collection_path_per_cadence() {
        let covered = HashSet::from([PollIdentity::detected(
            ProviderId::Antigravity,
            ACCOUNT.to_string(),
        )]);
        let automatic = uncovered_account_ids(vec![ACCOUNT.to_string()], &covered);

        assert!(automatic.is_empty());
    }

    #[test]
    fn a_rotated_vault_token_still_cannot_create_a_second_path() {
        let covered = HashSet::from([PollIdentity::detected(
            ProviderId::Antigravity,
            "credential-bound-old-token".to_string(),
        )]);
        let automatic = uncovered_account_ids(vec![ACCOUNT.to_string()], &covered);

        assert!(automatic.is_empty());
    }

    fn valid_body() -> Vec<u8> {
        br#"{
            "groups":[{
                "buckets":[
                    {"bucketId":"gemini-primary","remainingFraction":0.72,"window":"5h","resetTime":"2026-08-19T15:00:00Z"},
                    {"bucketId":"gemini-weekly","remainingFraction":0.44,"window":"weekly","resetTime":"2026-08-24T12:00:00Z"}
                ]
            }]
        }"#
        .to_vec()
    }

    fn secret(revision: &str) -> DetectedSecret {
        DetectedSecret {
            access_token: Zeroizing::new(TOKEN.to_string()),
            provider_account_id: None,
            credential_revision: revision.to_string(),
        }
    }

    fn writer(dir: &TempDir) -> Arc<CacheWriter> {
        Arc::new(CacheWriter::at(Some(dir.path().to_path_buf())))
    }

    fn quota_transport(body: Vec<u8>) -> RecordingTransport {
        RecordingTransport::scripted(vec![
            (
                200,
                br#"{"cloudaicompanionProject":"fixture-project-123"}"#.to_vec(),
                None,
            ),
            (200, body, None),
        ])
    }

    #[tokio::test]
    async fn automatic_read_uses_the_observed_endpoint_method_and_body() {
        let dir = TempDir::new();
        let runtime = AntigravityOauthRuntime::default();
        let transport = quota_transport(valid_body());
        let outcome = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &secret("one"),
            NOW,
        )
        .await;
        assert!(matches!(outcome, AntigravityOutcome::CacheCommitted { .. }));
        assert_eq!(
            transport.recorded_urls(),
            vec![ANTIGRAVITY_BOOTSTRAP_URL, ANTIGRAVITY_QUOTA_URL]
        );
        assert_eq!(
            transport.recorded_methods(),
            vec![HttpMethod::Post, HttpMethod::Post]
        );
        assert_eq!(
            transport.recorded_auths(),
            vec![
                AuthApplication::AntigravitySessionBearer,
                AuthApplication::AntigravitySessionBearer
            ]
        );
        assert_eq!(
            transport.recorded_bodies(),
            vec![
                Some(ANTIGRAVITY_BOOTSTRAP_BODY.to_string()),
                Some(r#"{"project":"fixture-project-123"}"#.to_string())
            ]
        );
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("ANTIGRAVITY"));
        assert!(!cache.contains(TOKEN));
    }

    #[tokio::test]
    async fn a_token_rotation_does_not_reset_the_account_cadence() {
        let dir = TempDir::new();
        let runtime = AntigravityOauthRuntime::default();
        let transport = quota_transport(valid_body());
        let _ = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &secret("revision-one"),
            NOW,
        )
        .await;
        let rotated = DetectedSecret {
            access_token: Zeroizing::new("rotated-antigravity-token-for-tests-only".to_string()),
            provider_account_id: None,
            credential_revision: "revision-two".to_string(),
        };
        let second = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &rotated,
            NOW + 1_000,
        )
        .await;

        assert!(matches!(second, AntigravityOutcome::Cached { .. }));
        assert_eq!(transport.recorded_urls().len(), 2);
    }

    #[tokio::test]
    async fn response_drift_writes_a_suppression_and_never_zero() {
        let dir = TempDir::new();
        let runtime = AntigravityOauthRuntime::default();
        let transport = quota_transport(br#"{"groups":[]}"#.to_vec());
        let outcome = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &secret("drift"),
            NOW,
        )
        .await;
        assert!(matches!(
            outcome,
            AntigravityOutcome::Fallback {
                reason: AntigravityFailure::Drift,
                ..
            }
        ));
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("suppressions"));
        assert!(cache.contains("drift"));
        assert!(!cache.contains("\"value\":0"));
    }

    #[tokio::test]
    async fn expired_session_names_the_only_recovery_without_leaking_the_token() {
        let dir = TempDir::new();
        let runtime = AntigravityOauthRuntime::default();
        let transport = RecordingTransport::replying(401, Vec::new(), None);
        let outcome = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &secret("stale"),
            NOW,
        )
        .await;
        let wire = serde_json::to_string(&outcome).expect("wire");
        assert!(wire.contains("reopen_cli"));
        assert!(wire.contains("Reopen Antigravity to refresh this login."));
        assert!(!wire.contains(TOKEN));
    }
}
