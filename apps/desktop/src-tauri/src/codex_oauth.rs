use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::cache_write::CacheWriter;
use crate::native_readers::parse_body;
use crate::native_snapshot::{iso_from_epoch_ms, write_report, CacheReport};
use crate::net::{fetch_endpoint, NetError, ProviderEndpoint, ReqwestTransport, Transport};
use crate::provider_detection::{
    DetectedCredentialError, DetectedProviderId, DetectedSecret, DetectionStore,
};
use crate::reader_registry::{AuthApplication, ReaderId};

pub const REFRESH_SECONDS: u64 = 300;
const RATE_LIMIT_BACKOFF_SECONDS: u64 = 3_600;
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
        }
    }
}

#[derive(Default)]
pub struct CodexOauthRuntime {
    next_allowed: Mutex<BTreeMap<String, u64>>,
}

impl CodexOauthRuntime {
    fn key(account_id: &str, revision: &str) -> String {
        format!("{account_id}:{revision}")
    }

    fn begin(&self, account_id: &str, revision: &str, now_ms: u64) -> Result<(), u64> {
        let key = Self::key(account_id, revision);
        let mut entries = self.next_allowed.lock().map_err(|_| now_ms)?;
        if let Some(next) = entries.get(&key).copied() {
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
            key,
            now_ms.saturating_add(REFRESH_SECONDS.saturating_mul(1_000)),
        );
        Ok(())
    }

    fn postpone(&self, account_id: &str, revision: &str, now_ms: u64, seconds: u64) {
        if let Ok(mut entries) = self.next_allowed.lock() {
            entries.insert(
                Self::key(account_id, revision),
                now_ms.saturating_add(seconds.saturating_mul(1_000)),
            );
        }
    }
}

fn net_failure(error: NetError) -> CodexFailure {
    match error {
        NetError::Timeout => CodexFailure::Timeout,
        NetError::Connect => CodexFailure::Connect,
        NetError::Tls => CodexFailure::Tls,
        NetError::TooLarge => CodexFailure::TooLarge,
        NetError::Protocol => CodexFailure::Protocol,
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

async fn collect_with_secret<T: Transport>(
    runtime: &CodexOauthRuntime,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: &str,
    secret: &DetectedSecret,
    now_ms: u64,
) -> CodexOutcome {
    if let Err(retry_ms) = runtime.begin(account_id, &secret.credential_revision, now_ms) {
        return CodexOutcome::Cached {
            account_id: account_id.to_string(),
            retry_at: iso_from_epoch_ms(retry_ms)
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
        };
    }
    let response = match fetch_endpoint(
        transport,
        ProviderEndpoint::CodexUsage,
        AuthApplication::CodexSessionBearer,
        &secret.access_token,
        secret.provider_account_id.as_deref(),
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            return CodexOutcome::Failed {
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
                .and_then(|body| parse_body(ReaderId::CodexUsage, body, now_ms, account_id));
            let Some(snapshots) = snapshots else {
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
        401 => {
            runtime.postpone(
                account_id,
                &secret.credential_revision,
                now_ms,
                BLOCKED_BACKOFF_SECONDS,
            );
            fallback_report(writer, account_id, false, now_ms).await;
            CodexOutcome::reopen(account_id)
        }
        403 | 404 | 410 => {
            runtime.postpone(
                account_id,
                &secret.credential_revision,
                now_ms,
                BLOCKED_BACKOFF_SECONDS,
            );
            fallback_report(writer, account_id, false, now_ms).await;
            CodexOutcome::fallback(account_id, CodexFailure::ProviderBlocked)
        }
        429 => {
            let seconds = response
                .retry_after_seconds
                .unwrap_or(0)
                .max(RATE_LIMIT_BACKOFF_SECONDS)
                .min(BLOCKED_BACKOFF_SECONDS);
            runtime.postpone(account_id, &secret.credential_revision, now_ms, seconds);
            fallback_report(writer, account_id, false, now_ms).await;
            CodexOutcome::fallback(account_id, CodexFailure::RateLimited)
        }
        _ => CodexOutcome::Failed {
            account_id: account_id.to_string(),
            reason: CodexFailure::ProviderResponse,
        },
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
    let outcome =
        collect_with_secret(runtime, transport, writer, &account_id, &secret, now_ms).await;
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

pub async fn run_pass(app: &AppHandle) {
    let account_ids = app
        .state::<DetectionStore>()
        .account_ids(DetectedProviderId::Codex);
    for account_id in account_ids {
        let detection = app.state::<DetectionStore>();
        let runtime = app.state::<CodexOauthRuntime>();
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
    use crate::net::CODEX_USAGE_URL;
    use crate::test_support::{RecordingTransport, TempDir};
    use zeroize::Zeroizing;

    const NOW: u64 = 1_787_136_000_000;
    const TOKEN: &str = "codex-access-token-for-tests-only";

    fn valid_body() -> Vec<u8> {
        serde_json::json!({
            "rate_limit": {
                "primary_window": {
                    "used_percent": 23.5,
                    "limit_window_seconds": 18_000,
                    "reset_at": (NOW + 3_600_000) / 1_000
                },
                "secondary_window": {
                    "used_percent": 41.2,
                    "limit_window_seconds": 604_800,
                    "reset_at": (NOW + 86_400_000) / 1_000
                }
            }
        })
        .to_string()
        .into_bytes()
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
    async fn automatic_read_uses_the_known_endpoint_and_account_header() {
        let dir = TempDir::new();
        let runtime = CodexOauthRuntime::default();
        let transport = RecordingTransport::replying(200, valid_body(), None);
        let outcome = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            "opaque-account-one",
            &secret(TOKEN, "provider-account-one", "revision-one"),
            NOW,
        )
        .await;
        assert!(matches!(outcome, CodexOutcome::CacheCommitted { .. }));
        assert_eq!(transport.recorded_urls(), vec![CODEX_USAGE_URL]);
        assert_eq!(
            transport.recorded_auths(),
            vec![AuthApplication::CodexSessionBearer]
        );
        assert_eq!(
            transport.recorded_codex_account_ids(),
            vec![Some("provider-account-one".to_string())]
        );
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("FIVE_HOUR"));
        assert!(cache.contains("SEVEN_DAY"));
        assert!(!cache.contains(TOKEN));
    }

    #[tokio::test]
    async fn two_detected_accounts_keep_distinct_cache_rows() {
        let dir = TempDir::new();
        let runtime = CodexOauthRuntime::default();
        let transport = RecordingTransport::replying(200, valid_body(), None);
        for (opaque, provider, token, revision) in [
            ("opaque-account-one", "provider-account-one", TOKEN, "one"),
            (
                "opaque-account-two",
                "provider-account-two",
                "second-codex-token-for-tests-only",
                "two",
            ),
        ] {
            let outcome = collect_with_secret(
                &runtime,
                &transport,
                writer(&dir),
                opaque,
                &secret(token, provider, revision),
                NOW,
            )
            .await;
            assert!(matches!(outcome, CodexOutcome::CacheCommitted { .. }));
        }
        assert_eq!(
            transport.recorded_codex_account_ids(),
            vec![
                Some("provider-account-one".to_string()),
                Some("provider-account-two".to_string())
            ]
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
    async fn a_second_read_inside_the_cadence_never_reaches_the_provider() {
        let dir = TempDir::new();
        let runtime = CodexOauthRuntime::default();
        let transport = RecordingTransport::replying(200, valid_body(), None);
        let credential = secret(TOKEN, "provider-account-one", "revision-one");
        let _ = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            "opaque-account-one",
            &credential,
            NOW,
        )
        .await;
        let second = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            "opaque-account-one",
            &credential,
            NOW + 1_000,
        )
        .await;
        assert!(matches!(second, CodexOutcome::Cached { .. }));
        assert_eq!(transport.recorded_urls().len(), 1);
    }

    #[tokio::test]
    async fn response_drift_suppresses_old_rows_instead_of_writing_zero() {
        let dir = TempDir::new();
        let runtime = CodexOauthRuntime::default();
        let transport = RecordingTransport::replying(200, br#"{"rate_limit":{}}"#.to_vec(), None);
        let outcome = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            "opaque-account-one",
            &secret(TOKEN, "provider-account-one", "drift"),
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
    async fn an_expired_session_names_the_recovery_without_leaking_the_token() {
        let dir = TempDir::new();
        let runtime = CodexOauthRuntime::default();
        let transport = RecordingTransport::replying(401, Vec::new(), None);
        let outcome = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            "opaque-account-one",
            &secret(TOKEN, "provider-account-one", "stale"),
            NOW,
        )
        .await;
        let wire = serde_json::to_string(&outcome).expect("wire");
        assert!(wire.contains("reopen_cli"));
        assert!(wire.contains("Reopen Codex to refresh this login."));
        assert!(!wire.contains(TOKEN));
    }
}
