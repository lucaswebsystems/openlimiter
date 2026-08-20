use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::cache_write::CacheWriter;
use crate::native_snapshot::{
    future_rfc3339, iso_from_epoch_ms, write_report, CacheReport, ConnectorLabels, Snapshot,
    SnapshotWindow,
};
use crate::net::{
    fetch_gemini_cli_load, fetch_gemini_cli_quota, GeminiProjectId, NetError, ReqwestTransport,
    Transport,
};
use crate::provider_detection::{
    DetectedCredentialError, DetectedProviderId, DetectedSecret, DetectionStore,
};

pub const REFRESH_SECONDS: u64 = 900;
const SNAPSHOT_TTL_SECONDS: u64 = 1_200;
const RATE_LIMIT_BACKOFF_SECONDS: u64 = 3_600;
const BLOCKED_BACKOFF_SECONDS: u64 = 86_400;
const MAX_RESET_HORIZON_SECONDS: u64 = 2_678_400 + 3_600;
const MAX_THROTTLE_ENTRIES: usize = 128;
const MAX_MODEL_ID_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GeminiCliFailure {
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
pub enum GeminiCliOutcome {
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
        reason: GeminiCliFailure,
    },
    Failed {
        account_id: String,
        reason: GeminiCliFailure,
    },
}

impl GeminiCliOutcome {
    fn reopen(account_id: &str) -> Self {
        Self::ReopenCli {
            account_id: account_id.to_string(),
            message: "Reopen Gemini CLI to refresh this login.".to_string(),
        }
    }

    fn fallback(account_id: &str, reason: GeminiCliFailure) -> Self {
        Self::Fallback {
            account_id: account_id.to_string(),
            reason,
        }
    }
}

#[derive(Default)]
struct RuntimeInner {
    next_allowed: BTreeMap<String, u64>,
    projects: BTreeMap<String, GeminiProjectId>,
}

#[derive(Default)]
pub struct GeminiCliOauthRuntime {
    inner: Mutex<RuntimeInner>,
}

impl GeminiCliOauthRuntime {
    fn key(account_id: &str, revision: &str) -> String {
        format!("{account_id}:{revision}")
    }

    fn begin(
        &self,
        account_id: &str,
        revision: &str,
        now_ms: u64,
    ) -> Result<Option<GeminiProjectId>, u64> {
        let key = Self::key(account_id, revision);
        let mut inner = self.inner.lock().map_err(|_| now_ms)?;
        if let Some(next) = inner.next_allowed.get(&key).copied() {
            if now_ms < next {
                return Err(next);
            }
        }
        if inner.next_allowed.len() >= MAX_THROTTLE_ENTRIES {
            let expired: Vec<String> = inner
                .next_allowed
                .iter()
                .filter(|(_, next)| **next <= now_ms)
                .map(|(entry, _)| entry.clone())
                .collect();
            for entry in expired {
                inner.next_allowed.remove(&entry);
                inner.projects.remove(&entry);
            }
        }
        if inner.next_allowed.len() >= MAX_THROTTLE_ENTRIES {
            if let Some(first) = inner.next_allowed.keys().next().cloned() {
                inner.next_allowed.remove(&first);
                inner.projects.remove(&first);
            }
        }
        inner.next_allowed.insert(
            key.clone(),
            now_ms.saturating_add(REFRESH_SECONDS.saturating_mul(1_000)),
        );
        Ok(inner.projects.get(&key).cloned())
    }

    fn remember_project(&self, account_id: &str, revision: &str, project: GeminiProjectId) {
        if let Ok(mut inner) = self.inner.lock() {
            inner
                .projects
                .insert(Self::key(account_id, revision), project);
        }
    }

    fn postpone(&self, account_id: &str, revision: &str, now_ms: u64, seconds: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.next_allowed.insert(
                Self::key(account_id, revision),
                now_ms.saturating_add(seconds.saturating_mul(1_000)),
            );
        }
    }
}

fn net_failure(error: NetError) -> GeminiCliFailure {
    match error {
        NetError::Timeout => GeminiCliFailure::Timeout,
        NetError::Connect => GeminiCliFailure::Connect,
        NetError::Tls => GeminiCliFailure::Tls,
        NetError::TooLarge => GeminiCliFailure::TooLarge,
        NetError::Protocol => GeminiCliFailure::Protocol,
    }
}

fn project_from_load(body: &str) -> Option<GeminiProjectId> {
    let root: Value = serde_json::from_str(body).ok()?;
    let project = root.get("cloudaicompanionProject")?.as_str()?;
    GeminiProjectId::parse(project)
}

fn meter_from_model(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > MAX_MODEL_ID_BYTES || !value.is_ascii() {
        return None;
    }
    let mut meter = String::with_capacity(value.len());
    let mut separator = false;
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() {
            meter.push(char::from(byte.to_ascii_uppercase()));
            separator = false;
        } else if matches!(byte, b'-' | b'_' | b'.') && !separator && !meter.is_empty() {
            meter.push('_');
            separator = true;
        } else if !matches!(byte, b'-' | b'_' | b'.') {
            return None;
        }
    }
    while meter.ends_with('_') {
        meter.pop();
    }
    let valid = !meter.is_empty()
        && meter.len() <= 32
        && meter
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_uppercase())
        && meter
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_');
    valid.then_some(meter)
}

fn quota_snapshots(body: &str, now_ms: u64, account_id: &str) -> Option<Vec<Snapshot>> {
    let root: Value = serde_json::from_str(body).ok()?;
    let buckets = root.get("buckets")?.as_array()?;
    let observed_at = iso_from_epoch_ms(now_ms)?;
    let expires_at =
        iso_from_epoch_ms(now_ms.saturating_add(SNAPSHOT_TTL_SECONDS.saturating_mul(1_000)))?;
    let mut seen = BTreeSet::new();
    let mut snapshots = Vec::new();
    for entry in buckets {
        let bucket = entry.as_object()?;
        let model = bucket.get("modelId")?.as_str()?;
        let meter = meter_from_model(model)?;
        if !seen.insert(meter.clone()) {
            return None;
        }
        if let Some(token_type) = bucket.get("tokenType") {
            let token_type = token_type.as_str()?;
            if token_type.is_empty()
                || token_type.len() > 32
                || !token_type
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
            {
                return None;
            }
        }
        let remaining = bucket.get("remainingFraction")?.as_f64()?;
        if !remaining.is_finite() || !(0.0..=1.0).contains(&remaining) {
            return None;
        }
        let reset_at = future_rfc3339(
            bucket.get("resetTime")?.as_str()?,
            now_ms,
            MAX_RESET_HORIZON_SECONDS,
        )?;
        let value = ((1.0 - remaining).clamp(0.0, 1.0) * 1_000.0).round() / 10.0;
        snapshots.push(Snapshot {
            provider: "GEMINI_CLI".to_string(),
            meter,
            value,
            unit: "PERCENT".to_string(),
            window: SnapshotWindow {
                kind: "fixed".to_string(),
                duration_seconds: None,
            },
            reset_at: Some(reset_at),
            source: "internal_payload".to_string(),
            precision: "estimated".to_string(),
            observed_at: observed_at.clone(),
            expires_at: expires_at.clone(),
            labels: ConnectorLabels {
                credential_origin: "official-local-tool".to_string(),
                data_interface_status: "internal-endpoint".to_string(),
                automation_risk: "high".to_string(),
                verification: "UNVERIFIED".to_string(),
            },
            used_amount: None,
            limit_amount: None,
            currency: None,
            account_id: Some(account_id.to_string()),
            provenance: Some(serde_json::json!({
                "observedVia": "remote_http",
                "sourceKind": "remote_api"
            })),
        });
    }
    (!snapshots.is_empty()).then_some(snapshots)
}

async fn commit_report(writer: Arc<CacheWriter>, account_id: String, report: CacheReport) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        write_report(&writer, "GEMINI_CLI", Some(&account_id), report)
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

async fn status_outcome(
    runtime: &GeminiCliOauthRuntime,
    writer: Arc<CacheWriter>,
    account_id: &str,
    revision: &str,
    now_ms: u64,
    status: u16,
    retry_after_seconds: Option<u64>,
) -> GeminiCliOutcome {
    match status {
        401 => {
            runtime.postpone(account_id, revision, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, account_id, false, now_ms).await;
            GeminiCliOutcome::reopen(account_id)
        }
        403 | 404 | 410 => {
            runtime.postpone(account_id, revision, now_ms, BLOCKED_BACKOFF_SECONDS);
            fallback_report(writer, account_id, false, now_ms).await;
            GeminiCliOutcome::fallback(account_id, GeminiCliFailure::ProviderBlocked)
        }
        429 => {
            let seconds = retry_after_seconds
                .unwrap_or(0)
                .max(RATE_LIMIT_BACKOFF_SECONDS)
                .min(BLOCKED_BACKOFF_SECONDS);
            runtime.postpone(account_id, revision, now_ms, seconds);
            fallback_report(writer, account_id, false, now_ms).await;
            GeminiCliOutcome::fallback(account_id, GeminiCliFailure::RateLimited)
        }
        _ => GeminiCliOutcome::Failed {
            account_id: account_id.to_string(),
            reason: GeminiCliFailure::ProviderResponse,
        },
    }
}

async fn collect_with_secret<T: Transport>(
    runtime: &GeminiCliOauthRuntime,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: &str,
    secret: &DetectedSecret,
    now_ms: u64,
) -> GeminiCliOutcome {
    let cached_project = match runtime.begin(account_id, &secret.credential_revision, now_ms) {
        Ok(project) => project,
        Err(retry_ms) => {
            return GeminiCliOutcome::Cached {
                account_id: account_id.to_string(),
                retry_at: iso_from_epoch_ms(retry_ms)
                    .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
            }
        }
    };
    let project = if let Some(project) = cached_project {
        project
    } else {
        let response = match fetch_gemini_cli_load(transport, &secret.access_token).await {
            Ok(response) => response,
            Err(error) => {
                return GeminiCliOutcome::Failed {
                    account_id: account_id.to_string(),
                    reason: net_failure(error),
                }
            }
        };
        if !(200..=299).contains(&response.status) {
            return status_outcome(
                runtime,
                writer,
                account_id,
                &secret.credential_revision,
                now_ms,
                response.status,
                response.retry_after_seconds,
            )
            .await;
        }
        let Some(project) = response.body.as_deref().and_then(project_from_load) else {
            fallback_report(writer, account_id, true, now_ms).await;
            return GeminiCliOutcome::fallback(account_id, GeminiCliFailure::Drift);
        };
        runtime.remember_project(account_id, &secret.credential_revision, project.clone());
        project
    };

    let response = match fetch_gemini_cli_quota(transport, &secret.access_token, &project).await {
        Ok(response) => response,
        Err(error) => {
            return GeminiCliOutcome::Failed {
                account_id: account_id.to_string(),
                reason: net_failure(error),
            }
        }
    };
    if !(200..=299).contains(&response.status) {
        return status_outcome(
            runtime,
            writer,
            account_id,
            &secret.credential_revision,
            now_ms,
            response.status,
            response.retry_after_seconds,
        )
        .await;
    }
    let snapshots = response
        .body
        .as_deref()
        .and_then(|body| quota_snapshots(body, now_ms, account_id));
    let Some(snapshots) = snapshots else {
        fallback_report(writer, account_id, true, now_ms).await;
        return GeminiCliOutcome::fallback(account_id, GeminiCliFailure::Drift);
    };
    if commit_report(
        writer,
        account_id.to_string(),
        CacheReport::Success(snapshots),
    )
    .await
    {
        GeminiCliOutcome::CacheCommitted {
            account_id: account_id.to_string(),
        }
    } else {
        GeminiCliOutcome::Failed {
            account_id: account_id.to_string(),
            reason: GeminiCliFailure::Cache,
        }
    }
}

fn credential_failure(account_id: &str, _error: DetectedCredentialError) -> GeminiCliOutcome {
    GeminiCliOutcome::reopen(account_id)
}

pub async fn collect_account<T: Transport>(
    detection: &DetectionStore,
    runtime: &GeminiCliOauthRuntime,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: String,
    now_ms: u64,
) -> GeminiCliOutcome {
    let secret = match detection.read_credential(DetectedProviderId::GeminiCli, &account_id) {
        Ok(secret) => secret,
        Err(error) => {
            detection.mark_stale(DetectedProviderId::GeminiCli, &account_id);
            return credential_failure(&account_id, error);
        }
    };
    let outcome =
        collect_with_secret(runtime, transport, writer, &account_id, &secret, now_ms).await;
    match &outcome {
        GeminiCliOutcome::CacheCommitted { .. } => {
            detection.mark_ready(DetectedProviderId::GeminiCli, &account_id)
        }
        GeminiCliOutcome::ReopenCli { .. } => {
            detection.mark_stale(DetectedProviderId::GeminiCli, &account_id)
        }
        GeminiCliOutcome::Fallback { .. } => {
            detection.mark_fallback(DetectedProviderId::GeminiCli, &account_id)
        }
        GeminiCliOutcome::Cached { .. } | GeminiCliOutcome::Failed { .. } => {}
    }
    outcome
}

pub async fn run_pass(app: &AppHandle) {
    let account_ids = app
        .state::<DetectionStore>()
        .account_ids(DetectedProviderId::GeminiCli);
    for account_id in account_ids {
        let detection = app.state::<DetectionStore>();
        let runtime = app.state::<GeminiCliOauthRuntime>();
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
    use std::collections::VecDeque;
    use std::fs;
    use std::future::Future;
    use std::path::Path;

    use crate::cache_write::CACHE_FILE_NAME;
    use crate::net::{
        EndpointRequest, HttpMethod, TransportFailure, TransportReply, GEMINI_CLI_LOAD_BODY,
        GEMINI_CLI_LOAD_URL, GEMINI_CLI_QUOTA_URL,
    };
    use crate::provider_detection::{DetectedCollectionState, ProviderPresence};
    use crate::reader_registry::AuthApplication;
    use crate::test_support::TempDir;
    use zeroize::Zeroizing;

    const NOW: u64 = 1_787_136_000_000;
    const TOKEN: &str = "gemini-access-token-for-tests-only";

    struct ScriptedTransport {
        replies: Mutex<VecDeque<TransportReply>>,
        urls: Mutex<Vec<String>>,
        methods: Mutex<Vec<HttpMethod>>,
        auths: Mutex<Vec<AuthApplication>>,
        bodies: Mutex<Vec<Option<String>>>,
    }

    impl ScriptedTransport {
        fn new(replies: Vec<(u16, Vec<u8>, Option<u64>)>) -> Self {
            Self {
                replies: Mutex::new(
                    replies
                        .into_iter()
                        .map(|(status, body, retry_after_seconds)| TransportReply {
                            status,
                            body,
                            retry_after_seconds,
                            location_workspace: None,
                        })
                        .collect(),
                ),
                urls: Mutex::new(Vec::new()),
                methods: Mutex::new(Vec::new()),
                auths: Mutex::new(Vec::new()),
                bodies: Mutex::new(Vec::new()),
            }
        }

        fn urls(&self) -> Vec<String> {
            self.urls.lock().expect("urls").clone()
        }

        fn bodies(&self) -> Vec<Option<String>> {
            self.bodies.lock().expect("bodies").clone()
        }
    }

    impl Transport for ScriptedTransport {
        fn send(
            &self,
            request: &EndpointRequest<'_>,
            _secret: &str,
        ) -> impl Future<Output = Result<TransportReply, TransportFailure>> + Send {
            self.urls
                .lock()
                .expect("urls")
                .push(request.url.to_string());
            self.methods.lock().expect("methods").push(request.method);
            self.auths.lock().expect("auths").push(request.auth);
            self.bodies
                .lock()
                .expect("bodies")
                .push(request.body.map(str::to_string));
            let result = self
                .replies
                .lock()
                .map_err(|_| TransportFailure::Protocol)
                .and_then(|mut replies| replies.pop_front().ok_or(TransportFailure::Protocol));
            async move { result }
        }
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("directory");
        fs::write(path, text).expect("fixture");
    }

    fn detection(dir: &TempDir) -> DetectionStore {
        let id_token =
            "eyJhbGciOiJub25lIn0.eyJzdWIiOiJnb29nbGUtdGVzdC11c2VyIiwiZW1haWwiOiJ0ZXN0QGV4YW1wbGUuY29tIn0.signature";
        write(
            &dir.path().join(".gemini").join("oauth_creds.json"),
            &format!(
                r#"{{"access_token":"{TOKEN}","id_token":"{id_token}","expiry_date":1900000000000}}"#
            ),
        );
        DetectionStore::for_test_home(dir.path(), NOW)
    }

    fn writer(dir: &TempDir) -> Arc<CacheWriter> {
        Arc::new(CacheWriter::at(Some(dir.path().to_path_buf())))
    }

    fn load_body() -> Vec<u8> {
        br#"{"cloudaicompanionProject":"managed-project-123","currentTier":{"id":"standard-tier"}}"#
            .to_vec()
    }

    fn quota_body() -> Vec<u8> {
        br#"{
            "buckets":[
                {"remainingFraction":0.75,"resetTime":"2026-08-20T12:00:00Z","tokenType":"REQUESTS","modelId":"gemini-3.1-pro-preview"},
                {"remainingFraction":1,"resetTime":"2026-08-20T12:00:00Z","tokenType":"REQUESTS","modelId":"gemini-3-flash-preview"}
            ]
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

    #[tokio::test]
    async fn fixture_proves_discovery_collection_caching_and_every_window() {
        let dir = TempDir::new();
        let detection = detection(&dir);
        let account_ids = detection.account_ids(DetectedProviderId::GeminiCli);
        assert_eq!(account_ids.len(), 1);
        let runtime = GeminiCliOauthRuntime::default();
        let transport = ScriptedTransport::new(vec![
            (200, load_body(), None),
            (200, quota_body(), None),
            (200, quota_body(), None),
        ]);
        let cache_writer = writer(&dir);

        let first = collect_account(
            &detection,
            &runtime,
            &transport,
            Arc::clone(&cache_writer),
            account_ids[0].clone(),
            NOW,
        )
        .await;
        assert!(matches!(first, GeminiCliOutcome::CacheCommitted { .. }));
        let duplicate = collect_account(
            &detection,
            &runtime,
            &transport,
            Arc::clone(&cache_writer),
            account_ids[0].clone(),
            NOW + 1_000,
        )
        .await;
        assert!(matches!(duplicate, GeminiCliOutcome::Cached { .. }));
        let due = collect_account(
            &detection,
            &runtime,
            &transport,
            Arc::clone(&cache_writer),
            account_ids[0].clone(),
            NOW + REFRESH_SECONDS * 1_000,
        )
        .await;
        assert!(matches!(due, GeminiCliOutcome::CacheCommitted { .. }));

        assert_eq!(
            transport.urls(),
            vec![
                GEMINI_CLI_LOAD_URL.to_string(),
                GEMINI_CLI_QUOTA_URL.to_string(),
                GEMINI_CLI_QUOTA_URL.to_string(),
            ]
        );
        let bodies = transport.bodies();
        assert_eq!(bodies[0].as_deref(), Some(GEMINI_CLI_LOAD_BODY));
        assert!(bodies[1]
            .as_deref()
            .is_some_and(|body| body.contains("managed-project-123")));
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("GEMINI_CLI"));
        assert!(cache.contains("GEMINI_3_1_PRO_PREVIEW"));
        assert!(cache.contains("GEMINI_3_FLASH_PREVIEW"));
        assert!(cache.contains("25.0"));
        assert!(cache.contains("0.0"));
        assert!(!cache.contains(TOKEN));
        let report = detection.report();
        let gemini = report
            .providers
            .iter()
            .find(|provider| provider.provider_id == DetectedProviderId::GeminiCli)
            .expect("Gemini row");
        assert_eq!(gemini.state, ProviderPresence::Present);
        assert_eq!(
            gemini.accounts[0].collection_state,
            DetectedCollectionState::Ready
        );
    }

    #[test]
    fn cadence_is_per_account_and_per_credential_revision() {
        let runtime = GeminiCliOauthRuntime::default();
        assert!(runtime.begin("account-a", "revision-one", NOW).is_ok());
        assert!(runtime.begin("account-a", "revision-one", NOW + 1).is_err());
        assert!(runtime.begin("account-b", "revision-one", NOW + 1).is_ok());
        assert!(runtime.begin("account-a", "revision-two", NOW + 1).is_ok());
    }

    #[tokio::test]
    async fn quota_drift_is_visible_and_never_becomes_zero() {
        let dir = TempDir::new();
        let detection = detection(&dir);
        let account_id = detection
            .account_ids(DetectedProviderId::GeminiCli)
            .into_iter()
            .next()
            .expect("Gemini account");
        let runtime = GeminiCliOauthRuntime::default();
        let transport = ScriptedTransport::new(vec![
            (200, load_body(), None),
            (200, br#"{"buckets":[]}"#.to_vec(), None),
        ]);
        let outcome = collect_account(
            &detection,
            &runtime,
            &transport,
            writer(&dir),
            account_id,
            NOW,
        )
        .await;
        assert!(matches!(
            outcome,
            GeminiCliOutcome::Fallback {
                reason: GeminiCliFailure::Drift,
                ..
            }
        ));
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("suppressions"));
        assert!(cache.contains("drift"));
        assert!(!cache.contains("\"value\":0"));
        let report = detection.report();
        let gemini = report
            .providers
            .iter()
            .find(|provider| provider.provider_id == DetectedProviderId::GeminiCli)
            .expect("Gemini row");
        assert_eq!(
            gemini.accounts[0].collection_state,
            DetectedCollectionState::Fallback
        );
    }

    #[tokio::test]
    async fn provider_block_preserves_other_provider_rows() {
        let dir = TempDir::new();
        let cache_writer = writer(&dir);
        let other = Snapshot {
            provider: "CODEX".to_string(),
            meter: "PRIMARY".to_string(),
            value: 40.0,
            unit: "PERCENT".to_string(),
            window: SnapshotWindow {
                kind: "rolling".to_string(),
                duration_seconds: Some(18_000),
            },
            reset_at: Some("2026-08-19T15:00:00.000Z".to_string()),
            source: "internal_payload".to_string(),
            precision: "estimated".to_string(),
            observed_at: "2026-08-19T12:00:00.000Z".to_string(),
            expires_at: "2026-08-19T12:20:00.000Z".to_string(),
            labels: ConnectorLabels {
                credential_origin: "official-local-tool".to_string(),
                data_interface_status: "internal-endpoint".to_string(),
                automation_risk: "high".to_string(),
                verification: "UNVERIFIED".to_string(),
            },
            used_amount: None,
            limit_amount: None,
            currency: None,
            account_id: Some("codex-other-account".to_string()),
            provenance: None,
        };
        write_report(
            &cache_writer,
            "CODEX",
            Some("codex-other-account"),
            CacheReport::Success(vec![other]),
        )
        .expect("seed");
        let transport = ScriptedTransport::new(vec![(403, b"blocked".to_vec(), None)]);
        let outcome = collect_with_secret(
            &GeminiCliOauthRuntime::default(),
            &transport,
            Arc::clone(&cache_writer),
            "gemini-blocked-account",
            &secret("blocked"),
            NOW,
        )
        .await;
        assert!(matches!(
            outcome,
            GeminiCliOutcome::Fallback {
                reason: GeminiCliFailure::ProviderBlocked,
                ..
            }
        ));
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        assert!(cache.contains("CODEX"));
        assert!(cache.contains("codex-other-account"));
        assert!(!cache.contains("gemini-blocked-account"));
    }
}
