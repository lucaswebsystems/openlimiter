use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::cache_write::CacheWriter;
use crate::native_snapshot::{
    future_rfc3339, iso_from_epoch_ms, write_report, CacheReport, ConnectorLabels, Snapshot,
    SnapshotWindow,
};
use crate::net::{fetch_endpoint, NetError, ProviderEndpoint, ReqwestTransport, Transport};
use crate::provider_detection::{
    DetectedCredentialError, DetectedProviderId, DetectedSecret, DetectionStore,
};
use crate::reader_registry::AuthApplication;

pub const REFRESH_SECONDS: u64 = 900;
pub const RATE_LIMIT_BACKOFF_SECONDS: u64 = 3_600;
pub const BLOCKED_BACKOFF_SECONDS: u64 = 86_400;
const CACHE_FRESH_SECONDS: u64 = 1_200;
const MAX_THROTTLE_ENTRIES: usize = 128;
const CLOCK_SKEW_SECONDS: u64 = 3_600;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeOauthFailure {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeFallback {
    Statusline,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClaudeOauthOutcome {
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
        reason: ClaudeOauthFailure,
        fallback: ClaudeFallback,
        retry_at: Option<String>,
        message: String,
    },
    Failed {
        account_id: String,
        reason: ClaudeOauthFailure,
    },
}

impl ClaudeOauthOutcome {
    fn fallback(account_id: &str, reason: ClaudeOauthFailure, retry_at: Option<String>) -> Self {
        Self::Fallback {
            account_id: account_id.to_string(),
            reason,
            fallback: ClaudeFallback::Statusline,
            retry_at,
            message: "Claude usage is unavailable. Statusline and manual entry remain available."
                .to_string(),
        }
    }

    fn reopen(account_id: &str) -> Self {
        Self::ReopenCli {
            account_id: account_id.to_string(),
            message: "Reopen Claude Code to refresh this login.".to_string(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RefreshDetectedClaudeInput {
    pub account_id: String,
}

#[derive(Default)]
pub struct ClaudeOauthRuntime {
    next_allowed: Mutex<BTreeMap<String, u64>>,
}

impl ClaudeOauthRuntime {
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
            let first = entries.keys().next().cloned();
            if let Some(first) = first {
                entries.remove(&first);
            }
        }
        entries.insert(
            account_id.to_string(),
            now_ms.saturating_add(REFRESH_SECONDS.saturating_mul(1_000)),
        );
        Ok(())
    }

    fn postpone(&self, account_id: &str, now_ms: u64, seconds: u64) -> u64 {
        let next = now_ms.saturating_add(seconds.saturating_mul(1_000));
        if let Ok(mut entries) = self.next_allowed.lock() {
            entries.insert(account_id.to_string(), next);
        }
        next
    }
}

fn labels() -> ConnectorLabels {
    ConnectorLabels {
        credential_origin: "official-local-tool".to_string(),
        data_interface_status: "internal-endpoint".to_string(),
        automation_risk: "high".to_string(),
        verification: "UNVERIFIED".to_string(),
    }
}

fn percentage(value: Option<&Value>) -> Option<f64> {
    let value = value?.as_f64()?;
    (value.is_finite() && (0.0..=100.0).contains(&value)).then_some(value)
}

fn parse_window(
    root: &Value,
    key: &str,
    meter: &str,
    duration_seconds: u64,
    now_ms: u64,
    account_id: &str,
) -> Option<Snapshot> {
    let window = root.get(key)?.as_object()?;
    let value = percentage(window.get("utilization"))?;
    let maximum_ahead = duration_seconds
        .saturating_mul(2)
        .saturating_add(CLOCK_SKEW_SECONDS);
    let reset_at = future_rfc3339(window.get("resets_at")?.as_str()?, now_ms, maximum_ahead)?;
    let observed_at = iso_from_epoch_ms(now_ms)?;
    let expires_at =
        iso_from_epoch_ms(now_ms.saturating_add(CACHE_FRESH_SECONDS.saturating_mul(1_000)))?;
    Some(Snapshot {
        provider: "CLAUDE".to_string(),
        meter: meter.to_string(),
        value,
        unit: "PERCENT".to_string(),
        window: SnapshotWindow {
            kind: "rolling".to_string(),
            duration_seconds: Some(duration_seconds),
        },
        reset_at: Some(reset_at),
        source: "internal_payload".to_string(),
        precision: "exact".to_string(),
        observed_at,
        expires_at,
        labels: labels(),
        used_amount: None,
        limit_amount: None,
        currency: None,
        account_id: Some(account_id.to_string()),
        provenance: Some(serde_json::json!({
            "observedVia": "remote_http",
            "sourceKind": "remote_api"
        })),
    })
}

pub fn parse_usage(body: &str, now_ms: u64, account_id: &str) -> Option<Vec<Snapshot>> {
    let root: Value = serde_json::from_str(body).ok()?;
    if !root.is_object() {
        return None;
    }
    let session = parse_window(&root, "five_hour", "FIVE_HOUR", 18_000, now_ms, account_id)?;
    let weekly = parse_window(&root, "seven_day", "SEVEN_DAY", 604_800, now_ms, account_id)?;
    Some(vec![session, weekly])
}

fn net_failure(error: NetError) -> ClaudeOauthFailure {
    match error {
        NetError::Timeout => ClaudeOauthFailure::Timeout,
        NetError::Connect => ClaudeOauthFailure::Connect,
        NetError::Tls => ClaudeOauthFailure::Tls,
        NetError::TooLarge => ClaudeOauthFailure::TooLarge,
        NetError::Protocol => ClaudeOauthFailure::Protocol,
    }
}

async fn commit_report(writer: Arc<CacheWriter>, account_id: String, report: CacheReport) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        write_report(&writer, "CLAUDE", Some(&account_id), report)
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
    runtime: &ClaudeOauthRuntime,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: &str,
    secret: &DetectedSecret,
    now_ms: u64,
) -> ClaudeOauthOutcome {
    if let Err(retry_ms) = runtime.begin(account_id, now_ms) {
        return ClaudeOauthOutcome::Cached {
            account_id: account_id.to_string(),
            retry_at: iso_from_epoch_ms(retry_ms)
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
        };
    }
    let response = match fetch_endpoint(
        transport,
        ProviderEndpoint::ClaudeOauthUsage,
        AuthApplication::ClaudeOauthBearer,
        &secret.access_token,
        None,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            return ClaudeOauthOutcome::Failed {
                account_id: account_id.to_string(),
                reason: net_failure(error),
            }
        }
    };
    match response.status {
        200..=299 => {
            let Some(body) = response.body else {
                fallback_report(writer, account_id, true, now_ms).await;
                return ClaudeOauthOutcome::fallback(account_id, ClaudeOauthFailure::Drift, None);
            };
            let Some(snapshots) = parse_usage(&body, now_ms, account_id) else {
                fallback_report(writer, account_id, true, now_ms).await;
                return ClaudeOauthOutcome::fallback(account_id, ClaudeOauthFailure::Drift, None);
            };
            if commit_report(
                writer,
                account_id.to_string(),
                CacheReport::Success(snapshots),
            )
            .await
            {
                ClaudeOauthOutcome::CacheCommitted {
                    account_id: account_id.to_string(),
                }
            } else {
                ClaudeOauthOutcome::Failed {
                    account_id: account_id.to_string(),
                    reason: ClaudeOauthFailure::Cache,
                }
            }
        }
        401 => {
            runtime.postpone(account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, account_id, false, now_ms).await;
            ClaudeOauthOutcome::reopen(account_id)
        }
        403 | 404 | 410 => {
            let retry_ms = runtime.postpone(account_id, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, account_id, false, now_ms).await;
            ClaudeOauthOutcome::fallback(
                account_id,
                ClaudeOauthFailure::ProviderBlocked,
                iso_from_epoch_ms(retry_ms),
            )
        }
        429 => {
            let seconds = response
                .retry_after_seconds
                .unwrap_or(0)
                .max(RATE_LIMIT_BACKOFF_SECONDS)
                .min(BLOCKED_BACKOFF_SECONDS);
            let retry_ms = runtime.postpone(account_id, now_ms, seconds);
            fallback_report(writer, account_id, false, now_ms).await;
            ClaudeOauthOutcome::fallback(
                account_id,
                ClaudeOauthFailure::RateLimited,
                iso_from_epoch_ms(retry_ms),
            )
        }
        _ => ClaudeOauthOutcome::Failed {
            account_id: account_id.to_string(),
            reason: ClaudeOauthFailure::ProviderResponse,
        },
    }
}

fn credential_failure(account_id: &str, error: DetectedCredentialError) -> ClaudeOauthOutcome {
    match error {
        DetectedCredentialError::Stale
        | DetectedCredentialError::NotFound
        | DetectedCredentialError::Unreadable => ClaudeOauthOutcome::reopen(account_id),
    }
}

pub async fn collect_account<T: Transport>(
    detection: &DetectionStore,
    runtime: &ClaudeOauthRuntime,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: String,
    now_ms: u64,
) -> ClaudeOauthOutcome {
    let secret = match detection.read_credential(DetectedProviderId::Claude, &account_id) {
        Ok(secret) => secret,
        Err(error) => {
            detection.mark_stale(DetectedProviderId::Claude, &account_id);
            return credential_failure(&account_id, error);
        }
    };
    let outcome =
        collect_with_secret(runtime, transport, writer, &account_id, &secret, now_ms).await;
    match &outcome {
        ClaudeOauthOutcome::CacheCommitted { .. } => {
            detection.mark_ready(DetectedProviderId::Claude, &account_id)
        }
        ClaudeOauthOutcome::ReopenCli { .. } => {
            detection.mark_stale(DetectedProviderId::Claude, &account_id)
        }
        ClaudeOauthOutcome::Fallback { .. } => {
            detection.mark_fallback(DetectedProviderId::Claude, &account_id)
        }
        ClaudeOauthOutcome::Cached { .. } | ClaudeOauthOutcome::Failed { .. } => {}
    }
    outcome
}

pub async fn run_pass(app: &AppHandle) {
    let account_ids = app
        .state::<DetectionStore>()
        .account_ids(DetectedProviderId::Claude);
    for account_id in account_ids {
        let detection = app.state::<DetectionStore>();
        let runtime = app.state::<ClaudeOauthRuntime>();
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
    use crate::test_support::{RecordingTransport, TempDir};
    use zeroize::Zeroizing;

    const NOW: u64 = 1_787_136_000_000;
    const ACCOUNT: &str = "claude-test-account";
    const TOKEN: &str = "claude-oauth-token-for-tests-only";

    fn valid_body() -> Vec<u8> {
        br#"{
            "five_hour":{"utilization":23.5,"resets_at":"2026-08-19T15:00:00Z"},
            "seven_day":{"utilization":41.2,"resets_at":"2026-08-24T12:00:00Z"},
            "seven_day_opus":null,
            "extra_usage":{"is_enabled":false}
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

    #[test]
    fn the_oauth_contract_returns_the_session_and_weekly_windows() {
        let rows = parse_usage(
            std::str::from_utf8(&valid_body()).expect("fixture"),
            NOW,
            ACCOUNT,
        )
        .expect("usage");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].meter, "FIVE_HOUR");
        assert_eq!(rows[0].value, 23.5);
        assert_eq!(rows[0].window.duration_seconds, Some(18_000));
        assert_eq!(rows[1].meter, "SEVEN_DAY");
        assert_eq!(rows[1].value, 41.2);
        assert_eq!(rows[1].window.duration_seconds, Some(604_800));
        assert!(rows
            .iter()
            .all(|row| row.account_id.as_deref() == Some(ACCOUNT)));
    }

    #[test]
    fn any_required_window_drift_makes_the_whole_contract_unknown() {
        for body in [
            r#"{"five_hour":{"utilization":20,"resets_at":"2026-08-19T23:00:00Z"}}"#,
            r#"{"five_hour":{"utilization":"20","resets_at":"2026-08-19T23:00:00Z"},"seven_day":{"utilization":30,"resets_at":"2026-08-24T12:00:00Z"}}"#,
            r#"{"five_hour":{"utilization":20,"resets_at":"2020-01-01T00:00:00Z"},"seven_day":{"utilization":30,"resets_at":"2026-08-24T12:00:00Z"}}"#,
            r#"{"five_hour":{"utilization":101,"resets_at":"2026-08-19T23:00:00Z"},"seven_day":{"utilization":30,"resets_at":"2026-08-24T12:00:00Z"}}"#,
        ] {
            assert!(parse_usage(body, NOW, ACCOUNT).is_none());
        }
    }

    #[tokio::test]
    async fn one_success_is_cached_and_the_next_call_never_reaches_the_provider() {
        let dir = TempDir::new();
        let runtime = ClaudeOauthRuntime::default();
        let transport = RecordingTransport::replying(200, valid_body(), None);
        let credential = secret("revision-one");
        let first = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &credential,
            NOW,
        )
        .await;
        assert!(matches!(first, ClaudeOauthOutcome::CacheCommitted { .. }));
        let second = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &credential,
            NOW + 1_000,
        )
        .await;
        assert!(matches!(second, ClaudeOauthOutcome::Cached { .. }));
        assert_eq!(transport.recorded_urls().len(), 1);
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("FIVE_HOUR"));
        assert!(cache.contains("SEVEN_DAY"));
        assert!(!cache.contains(TOKEN));
    }

    #[tokio::test]
    async fn a_new_cli_token_revision_keeps_the_account_throttle() {
        let dir = TempDir::new();
        let runtime = ClaudeOauthRuntime::default();
        let transport = RecordingTransport::replying(200, valid_body(), None);
        let _ = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &secret("old"),
            NOW,
        )
        .await;
        let second = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &secret("new"),
            NOW + 1_000,
        )
        .await;
        assert!(matches!(second, ClaudeOauthOutcome::Cached { .. }));
        assert_eq!(transport.recorded_urls().len(), 1);
    }

    #[tokio::test]
    async fn rate_limit_zero_still_backs_off_for_one_hour() {
        let dir = TempDir::new();
        let runtime = ClaudeOauthRuntime::default();
        let transport = RecordingTransport::replying(429, Vec::new(), Some(0));
        let credential = secret("rate-limit");
        let first = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &credential,
            NOW,
        )
        .await;
        let ClaudeOauthOutcome::Fallback {
            reason,
            retry_at: Some(retry_at),
            ..
        } = first
        else {
            panic!("rate limit fallback");
        };
        assert_eq!(reason, ClaudeOauthFailure::RateLimited);
        assert_eq!(retry_at, iso_from_epoch_ms(NOW + 3_600_000).unwrap());
        let second = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &credential,
            NOW + 60_000,
        )
        .await;
        assert!(matches!(second, ClaudeOauthOutcome::Cached { .. }));
        assert_eq!(transport.recorded_urls().len(), 1);
    }

    #[tokio::test]
    async fn a_provider_block_falls_back_visibly_and_pauses_for_one_day() {
        let dir = TempDir::new();
        let runtime = ClaudeOauthRuntime::default();
        let seed_transport = RecordingTransport::replying(200, valid_body(), None);
        let seeded = collect_with_secret(
            &runtime,
            &seed_transport,
            writer(&dir),
            ACCOUNT,
            &secret("seed"),
            NOW,
        )
        .await;
        assert!(matches!(seeded, ClaudeOauthOutcome::CacheCommitted { .. }));

        let transport = RecordingTransport::replying(403, Vec::new(), None);
        let credential = secret("provider-blocked");
        let blocked_at = NOW + REFRESH_SECONDS * 1_000;
        let first = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &credential,
            blocked_at,
        )
        .await;
        let ClaudeOauthOutcome::Fallback {
            reason,
            fallback,
            retry_at: Some(retry_at),
            message,
            ..
        } = first
        else {
            panic!("provider block fallback");
        };
        assert_eq!(reason, ClaudeOauthFailure::ProviderBlocked);
        assert_eq!(fallback, ClaudeFallback::Statusline);
        assert_eq!(
            retry_at,
            iso_from_epoch_ms(blocked_at + 86_400_000).unwrap()
        );
        assert!(message.contains("Statusline and manual entry remain available."));

        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(!cache.contains("FIVE_HOUR"));
        assert!(!cache.contains("SEVEN_DAY"));
        assert!(!cache.contains(ACCOUNT));

        let second = collect_with_secret(
            &runtime,
            &transport,
            writer(&dir),
            ACCOUNT,
            &credential,
            blocked_at + 3_600_000,
        )
        .await;
        assert!(matches!(second, ClaudeOauthOutcome::Cached { .. }));
        assert_eq!(transport.recorded_urls().len(), 1);
    }

    #[tokio::test]
    async fn an_unexpected_success_shape_writes_a_visible_unknown_suppression() {
        let dir = TempDir::new();
        let runtime = ClaudeOauthRuntime::default();
        let transport = RecordingTransport::replying(200, br#"{"usage":40}"#.to_vec(), None);
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
            ClaudeOauthOutcome::Fallback {
                reason: ClaudeOauthFailure::Drift,
                ..
            }
        ));
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("suppressions"));
        assert!(cache.contains("drift"));
        assert!(!cache.contains("\"value\":40"));
    }

    #[tokio::test]
    async fn a_stale_server_response_names_the_only_recovery() {
        let dir = TempDir::new();
        let runtime = ClaudeOauthRuntime::default();
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
        assert!(wire.contains("Reopen Claude Code to refresh this login."));
        assert!(!wire.contains(TOKEN));
    }
}
