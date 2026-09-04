use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
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
use crate::request_policy::{GateRejection, RequestPolicy};

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
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_after_seconds: Option<u64>,
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
            retry_after_seconds: None,
            message: "Claude usage is unavailable. Statusline and manual entry remain available."
                .to_string(),
        }
    }

    fn rate_limited(
        account_id: &str,
        retry_at: Option<String>,
        retry_after_seconds: Option<u64>,
    ) -> Self {
        Self::Fallback {
            account_id: account_id.to_string(),
            reason: ClaudeOauthFailure::RateLimited,
            fallback: ClaudeFallback::Statusline,
            retry_at,
            retry_after_seconds,
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

/// The length of the session window, in seconds.
const FIVE_HOUR_SECONDS: u64 = 18_000;

/// The length of every weekly window, in seconds.
const SEVEN_DAY_SECONDS: u64 = 604_800;

/// Every root window this build names, with the meter code it keeps.
///
/// This list is an ORDER as much as a vocabulary. The meters leave this parse
/// in the order written here, then the root buckets this build does not name,
/// then the model scoped entries of `limits`, then extra usage. A stable order
/// is what stops a redraw reshuffling the rows under somebody's pointer, and a
/// second parse of one payload has to name the same meters in the same places.
const ROOT_WINDOWS: [(&str, &str, u64); 5] = [
    ("five_hour", "FIVE_HOUR", FIVE_HOUR_SECONDS),
    ("seven_day", "SEVEN_DAY", SEVEN_DAY_SECONDS),
    ("seven_day_opus", "SEVEN_DAY_OPUS", SEVEN_DAY_SECONDS),
    ("seven_day_sonnet", "SEVEN_DAY_SONNET", SEVEN_DAY_SECONDS),
    (
        "seven_day_oauth_apps",
        "SEVEN_DAY_OAUTH_APPS",
        SEVEN_DAY_SECONDS,
    ),
];

/// The prefix a weekly root key carries before the model it is scoped to.
const WEEKLY_KEY_PREFIX: &str = "seven_day_";

/// The prefix a model scoped meter code carries.
const WEEKLY_METER_PREFIX: &str = "SEVEN_DAY_";

/// The `limits` kind that states one model's own weekly allowance.
const WEEKLY_SCOPED_KIND: &str = "weekly_scoped";

/// The two root keys that are not windows.
const LIMITS_KEY: &str = "limits";
const EXTRA_USAGE_KEY: &str = "extra_usage";

/// The meter the paid overflow allowance is reported as.
const EXTRA_USAGE_METER: &str = "EXTRA_USAGE";

/// Longest meter code the cache accepts, mirroring `safe_identifier` in
/// `native_snapshot.rs`.
const MAX_METER_BYTES: usize = 32;

/// Largest amount the cache accepts on a row, mirroring `MAX_AMOUNT` there.
const MAX_EXTRA_USAGE_AMOUNT: f64 = 1_000_000.0;

/// The only currency the cache keeps amounts in.
const CACHE_CURRENCY: &str = "USD";

/// How far ahead a bucket of unstated length may reset: a year, the same bound
/// `scripts/sanitize-capture.mjs` holds every countdown it keeps to.
const UNKNOWN_WINDOW_MAX_AHEAD_SECONDS: u64 = 31_536_000;

/// The shape of one bucket's window, and how far ahead its reset may fall.
#[derive(Clone, Copy)]
struct BucketWindow {
    kind: &'static str,
    duration_seconds: Option<u64>,
}

impl BucketWindow {
    /// A window whose length the endpoint states.
    const fn rolling(duration_seconds: u64) -> Self {
        Self {
            kind: "rolling",
            duration_seconds: Some(duration_seconds),
        }
    }

    /// A bucket this build has never seen. Its length is not guessed, because
    /// a guessed length is a claim about a window nobody here has read.
    const UNKNOWN: Self = Self {
        kind: "unknown",
        duration_seconds: None,
    };

    /// The paid overflow allowance: a budget with a billing period, and the
    /// endpoint states neither its length nor when it turns over.
    const BILLING_PERIOD: Self = Self {
        kind: "fixed",
        duration_seconds: None,
    };

    fn maximum_ahead(self) -> u64 {
        match self.duration_seconds {
            Some(seconds) => seconds
                .saturating_mul(2)
                .saturating_add(CLOCK_SKEW_SECONDS),
            None => UNKNOWN_WINDOW_MAX_AHEAD_SECONDS,
        }
    }
}

/// Name a dropped bucket in a development build, and nothing in a shipped one.
///
/// One bucket that does not hold together is dropped ALONE now rather than
/// taking the whole read with it, which is the right behaviour and is also
/// silent, so a development build says which bucket went. Only this file's own
/// vocabulary reaches the stream: `stage` is a literal from the call sites
/// below and `meter` is a code this parse already validated, so nothing a
/// provider wrote can be printed by this.
fn dropped(stage: &str, meter: &str) {
    #[cfg(debug_assertions)]
    eprintln!("openlimiter: claude usage dropped a {stage} bucket ({meter})");
    #[cfg(not(debug_assertions))]
    let _ = (stage, meter);
}

fn percentage(value: Option<&Value>) -> Option<f64> {
    let value = value?.as_f64()?;
    (value.is_finite() && (0.0..=100.0).contains(&value)).then_some(value)
}

fn amount(value: Option<&Value>) -> Option<f64> {
    let value = value?.as_f64()?;
    (value.is_finite() && (0.0..=MAX_EXTRA_USAGE_AMOUNT).contains(&value)).then_some(value)
}

fn percent_of(used: f64, limit: f64) -> Option<f64> {
    if limit <= 0.0 || used > limit {
        return None;
    }
    let percent = used / limit * 100.0;
    (percent.is_finite() && (0.0..=100.0).contains(&percent)).then_some(percent)
}

/// Fold a provider's own name for a bucket into one upper snake token.
///
/// Anything that is not a letter or a digit becomes a separator, so
/// `cinder_cove` becomes `CINDER_COVE` and a display name like `Claude Opus
/// 4.5` becomes `CLAUDE_OPUS_4_5`. A name with nothing alphanumeric in it
/// yields nothing rather than an empty code.
fn upper_snake(name: &str) -> Option<String> {
    let mut token = String::with_capacity(name.len());
    let mut separated = false;
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            if separated && !token.is_empty() {
                token.push('_');
            }
            separated = false;
            token.push(character.to_ascii_uppercase());
        } else {
            separated = true;
        }
    }
    (!token.is_empty()).then_some(token)
}

/// Turn a bucket's name into a meter code the cache will accept, or nothing.
///
/// The cache's identifier rule is narrow on purpose: uppercase letters, digits
/// and underscores, a letter first, thirty two bytes at most. A name that
/// cannot survive that is refused rather than trimmed, because a trimmed code
/// no longer names the bucket it came from.
fn meter_code(prefix: &str, name: &str) -> Option<String> {
    let code = format!("{prefix}{}", upper_snake(name)?);
    let mut bytes = code.bytes();
    let starts_with_letter = bytes.next().is_some_and(|byte| byte.is_ascii_uppercase());
    (starts_with_letter
        && code.len() <= MAX_METER_BYTES
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'))
    .then_some(code)
}

/// One cache row, built from a reading that already passed its own bounds.
fn snapshot(
    meter: &str,
    value: f64,
    window: BucketWindow,
    reset_at: Option<String>,
    now_ms: u64,
    account_id: &str,
) -> Option<Snapshot> {
    Some(Snapshot {
        provider: "CLAUDE".to_string(),
        meter: meter.to_string(),
        value,
        unit: "PERCENT".to_string(),
        window: SnapshotWindow {
            kind: window.kind.to_string(),
            duration_seconds: window.duration_seconds,
        },
        reset_at,
        source: "internal_payload".to_string(),
        precision: "exact".to_string(),
        observed_at: iso_from_epoch_ms(now_ms)?,
        expires_at: iso_from_epoch_ms(
            now_ms.saturating_add(CACHE_FRESH_SECONDS.saturating_mul(1_000)),
        )?,
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

/// Read one bucket: a percentage under `percent_key`, and a reset that is
/// ahead of this clock but not further ahead than its own window allows.
///
/// The root windows spell the percentage `utilization` and the scoped entries
/// of `limits` spell it `percent`; nothing else about them differs, so one
/// function reads both.
fn parse_reading(
    bucket: &Map<String, Value>,
    percent_key: &str,
    meter: &str,
    window: BucketWindow,
    now_ms: u64,
    account_id: &str,
) -> Option<Snapshot> {
    let value = percentage(bucket.get(percent_key))?;
    let reset_at = future_rfc3339(
        bucket.get("resets_at")?.as_str()?,
        now_ms,
        window.maximum_ahead(),
    )?;
    snapshot(meter, value, window, Some(reset_at), now_ms, account_id)
}

/// The paid overflow allowance, as a percentage carrying its own dollars.
///
/// The row is a percentage like every other meter, which is what the bands and
/// the bars read, and the dollars ride along in the amount fields the cache
/// already has. They are attached only in the currency the cache keeps amounts
/// in and only when the used figure fits inside the limit, because
/// `normalize_snapshot` drops all three otherwise and a row that lost its
/// amounts silently would still claim to carry them here.
fn parse_extra_usage(
    extra: &Map<String, Value>,
    now_ms: u64,
    account_id: &str,
) -> Option<Snapshot> {
    let used = amount(extra.get("used_credits"));
    let limit = amount(extra.get("monthly_limit"));
    let value = match percentage(extra.get("utilization")) {
        Some(percent) => percent,
        None => percent_of(used?, limit?)?,
    };
    let currency = extra
        .get("currency")
        .and_then(Value::as_str)
        .map(str::to_ascii_uppercase)
        .filter(|currency| currency == CACHE_CURRENCY);
    let mut row = snapshot(
        EXTRA_USAGE_METER,
        value,
        BucketWindow::BILLING_PERIOD,
        None,
        now_ms,
        account_id,
    )?;
    if let (Some(used), Some(limit), Some(currency)) = (used, limit, currency) {
        if used <= limit {
            row.used_amount = Some(used);
            row.limit_amount = Some(limit);
            row.currency = Some(currency);
        }
    }
    Some(row)
}

/// The account's usage, one meter per bucket the endpoint states.
///
/// WHY EVERY BUCKET IS READ INDEPENDENTLY. This used to demand `five_hour` and
/// `seven_day`, loop a literal list of two model windows, and abandon the
/// whole read through `?` the moment any one of them did not parse. An account
/// whose plan reports its weekly allowance per model, and no session window,
/// therefore showed NOTHING at all, and one malformed optional bucket erased
/// every good bucket beside it. So there are no required buckets left: each
/// one is read on its own, a bucket that does not hold together is dropped
/// alone, and the read fails only when nothing survived to report.
///
/// Four sources, in one fixed order:
///
///   the root windows this build names, keeping their own meter codes
///   every other root object carrying a `utilization` and a `resets_at`,
///     which keeps a bucket the endpoint adds next month readable today
///   the model scoped entries of `limits`, which is where a weekly allowance
///     for one model arrives with a display name rather than a fixed key
///   `extra_usage`, when the account has the paid overflow enabled
///
/// A model stated twice, once as a root key and once in `limits`, is reported
/// once. The root bucket wins because its meter code is one this build names
/// and the UI already labels, and a display name that renames the same model
/// would otherwise open a second bar for the same allowance.
pub fn parse_usage(body: &str, now_ms: u64, account_id: &str) -> Option<Vec<Snapshot>> {
    let root: Value = serde_json::from_str(body).ok()?;
    let root = root.as_object()?;
    let mut rows: Vec<Snapshot> = Vec::new();
    let mut taken: BTreeSet<String> = BTreeSet::new();
    let mut root_models: BTreeSet<String> = BTreeSet::new();

    for (key, meter, duration_seconds) in ROOT_WINDOWS {
        let Some(bucket) = root.get(key).filter(|value| !value.is_null()) else {
            continue;
        };
        let parsed = bucket.as_object().and_then(|bucket| {
            parse_reading(
                bucket,
                "utilization",
                meter,
                BucketWindow::rolling(duration_seconds),
                now_ms,
                account_id,
            )
        });
        let Some(row) = parsed else {
            dropped("root window", meter);
            continue;
        };
        if taken.insert(meter.to_string()) {
            if let Some(model) = key.strip_prefix(WEEKLY_KEY_PREFIX) {
                root_models.insert(model.to_string());
            }
            rows.push(row);
        }
    }

    for (key, value) in root {
        let named = ROOT_WINDOWS.iter().any(|(root_key, _, _)| *root_key == key);
        if named || key == LIMITS_KEY || key == EXTRA_USAGE_KEY {
            continue;
        }
        let Some(bucket) = value.as_object() else {
            continue;
        };
        if !bucket.contains_key("utilization") || !bucket.contains_key("resets_at") {
            continue;
        }
        let Some(meter) = meter_code("", key) else {
            dropped("unnamed root window", "unnamed");
            continue;
        };
        let Some(row) = parse_reading(
            bucket,
            "utilization",
            &meter,
            BucketWindow::UNKNOWN,
            now_ms,
            account_id,
        ) else {
            dropped("unnamed root window", &meter);
            continue;
        };
        if taken.insert(meter) {
            rows.push(row);
        }
    }

    for entry in root
        .get(LIMITS_KEY)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(entry) = entry.as_object() else {
            continue;
        };
        if entry.get("kind").and_then(Value::as_str) != Some(WEEKLY_SCOPED_KIND) {
            continue;
        }
        let Some(display_name) = entry
            .get("scope")
            .and_then(Value::as_object)
            .and_then(|scope| scope.get("model"))
            .and_then(Value::as_object)
            .and_then(|model| model.get("display_name"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let (Some(model), Some(meter)) = (
            upper_snake(display_name),
            meter_code(WEEKLY_METER_PREFIX, display_name),
        ) else {
            dropped("model scoped", "unnamed");
            continue;
        };
        if root_models.contains(&model.to_ascii_lowercase()) || taken.contains(&meter) {
            continue;
        }
        let Some(row) = parse_reading(
            entry,
            "percent",
            &meter,
            BucketWindow::rolling(SEVEN_DAY_SECONDS),
            now_ms,
            account_id,
        ) else {
            dropped("model scoped", &meter);
            continue;
        };
        taken.insert(meter);
        rows.push(row);
    }

    if let Some(extra) = root.get(EXTRA_USAGE_KEY).and_then(Value::as_object) {
        if extra.get("is_enabled").and_then(Value::as_bool) == Some(true) {
            match parse_extra_usage(extra, now_ms, account_id) {
                Some(row) if taken.insert(EXTRA_USAGE_METER.to_string()) => rows.push(row),
                Some(_) => {}
                None => dropped("extra usage", EXTRA_USAGE_METER),
            }
        }
    }

    (!rows.is_empty()).then_some(rows)
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
        429 | 503 if response.status == 429 || response.retry_after_seconds.is_some() => {
            let retry_after_seconds = response.retry_after_seconds;
            let seconds = response
                .retry_after_seconds
                .unwrap_or(0)
                .max(RATE_LIMIT_BACKOFF_SECONDS)
                .min(BLOCKED_BACKOFF_SECONDS);
            let retry_ms = runtime.postpone(account_id, now_ms, seconds);
            fallback_report(writer, account_id, false, now_ms).await;
            ClaudeOauthOutcome::rate_limited(
                account_id,
                iso_from_epoch_ms(retry_ms),
                retry_after_seconds,
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

pub async fn collect_account_guarded<T: Transport>(
    detection: &DetectionStore,
    runtime: &ClaudeOauthRuntime,
    policy: &RequestPolicy,
    transport: &T,
    writer: Arc<CacheWriter>,
    account_id: String,
    now_ms: u64,
) -> (ClaudeOauthOutcome, bool) {
    let _lease = match policy.begin(DetectedProviderId::Claude, &account_id, now_ms) {
        Ok(lease) => lease,
        Err(GateRejection::Deferred { retry_at }) => {
            return (
                ClaudeOauthOutcome::Cached {
                    account_id,
                    retry_at: iso_from_epoch_ms(retry_at)
                        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
                },
                false,
            )
        }
        Err(GateRejection::Busy | GateRejection::Unavailable) => {
            return (
                ClaudeOauthOutcome::Failed {
                    account_id,
                    reason: ClaudeOauthFailure::Protocol,
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
        ClaudeOauthOutcome::Fallback {
            reason: ClaudeOauthFailure::ProviderBlocked,
            ..
        } => {
            policy.block_provider(DetectedProviderId::Claude, now_ms, BLOCKED_BACKOFF_SECONDS);
            true
        }
        ClaudeOauthOutcome::Fallback {
            reason: ClaudeOauthFailure::RateLimited,
            retry_after_seconds,
            ..
        } => {
            policy.rate_limit_account(
                DetectedProviderId::Claude,
                &account_id,
                now_ms,
                *retry_after_seconds,
            );
            true
        }
        ClaudeOauthOutcome::ReopenCli { .. } => {
            policy.complete_after(
                DetectedProviderId::Claude,
                &account_id,
                now_ms,
                BLOCKED_BACKOFF_SECONDS,
            );
            false
        }
        _ => {
            policy.complete_after(
                DetectedProviderId::Claude,
                &account_id,
                now_ms,
                REFRESH_SECONDS,
            );
            false
        }
    };
    (outcome, abort_provider)
}

pub async fn run_pass(app: &AppHandle, automatic_account_limit: usize) {
    let mut account_ids = app
        .state::<DetectionStore>()
        .account_ids(DetectedProviderId::Claude);
    account_ids.truncate(automatic_account_limit);
    for account_id in account_ids {
        let detection = app.state::<DetectionStore>();
        let runtime = app.state::<ClaudeOauthRuntime>();
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
    fn optional_model_family_windows_are_emitted_when_the_endpoint_states_them() {
        let rows = parse_usage(
            r#"{
                "five_hour":{"utilization":23.5,"resets_at":"2026-08-19T15:00:00Z"},
                "seven_day":{"utilization":41.2,"resets_at":"2026-08-24T12:00:00Z"},
                "seven_day_opus":{"utilization":37.0,"resets_at":"2026-08-24T12:00:00Z"},
                "seven_day_sonnet":{"utilization":19.0,"resets_at":"2026-08-24T12:00:00Z"}
            }"#,
            NOW,
            ACCOUNT,
        )
        .expect("usage");

        assert_eq!(rows.len(), 4);
        assert!(rows
            .iter()
            .any(|row| row.meter == "SEVEN_DAY_OPUS" && row.value == 37.0));
        assert!(rows
            .iter()
            .any(|row| row.meter == "SEVEN_DAY_SONNET" && row.value == 19.0));
    }

    /// The four payloads that used to make the whole read unknown.
    ///
    /// Each one still carries a bucket that does not hold together, and each
    /// one now costs exactly that bucket. Only the first reports nothing, and
    /// only because nothing else was in it.
    #[test]
    fn a_drifted_bucket_no_longer_takes_the_whole_contract_with_it() {
        let weekly = r#""seven_day":{"utilization":30,"resets_at":"2026-08-24T12:00:00Z"}"#;
        for (drifted, surviving) in [
            (
                r#""five_hour":{"utilization":20,"resets_at":"2026-08-19T23:00:00Z"}"#,
                Vec::new(),
            ),
            (
                r#""five_hour":{"utilization":"20","resets_at":"2026-08-19T15:00:00Z"}"#,
                vec!["SEVEN_DAY"],
            ),
            (
                r#""five_hour":{"utilization":20,"resets_at":"2020-01-01T00:00:00Z"}"#,
                vec!["SEVEN_DAY"],
            ),
            (
                r#""five_hour":{"utilization":101,"resets_at":"2026-08-19T15:00:00Z"}"#,
                vec!["SEVEN_DAY"],
            ),
        ] {
            let body = if surviving.is_empty() {
                format!("{{{drifted}}}")
            } else {
                format!("{{{drifted},{weekly}}}")
            };
            match parse_usage(&body, NOW, ACCOUNT) {
                Some(rows) => assert_eq!(meters(&rows), surviving),
                None => assert!(surviving.is_empty()),
            }
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

    #[tokio::test]
    async fn service_retry_after_reaches_the_shared_policy_boundary() {
        let dir = TempDir::new();
        let outcome = collect_with_secret(
            &ClaudeOauthRuntime::default(),
            &RecordingTransport::replying(503, Vec::new(), Some(7_200)),
            writer(&dir),
            ACCOUNT,
            &secret("service-backoff"),
            NOW,
        )
        .await;
        assert!(matches!(
            outcome,
            ClaudeOauthOutcome::Fallback {
                reason: ClaudeOauthFailure::RateLimited,
                retry_after_seconds: Some(7_200),
                ..
            }
        ));
    }

    /* --------------------------------------------------- every bucket sent */

    /// One capture of the Claude Code 2.1.261 `api/oauth/usage` response.
    ///
    /// Every shape this reader has to survive is here at once: the five root
    /// windows the endpoint names, a root bucket this build has never heard
    /// of, the extra usage block, and the `limits` array, whose model scoped
    /// entries carry a display name rather than a fixed key. The percentages
    /// and the instants are this file's own; no account's readings are here.
    fn full_contract_body() -> String {
        r#"{
            "five_hour":{"utilization":23.5,"resets_at":"2026-08-19T15:00:00Z","overage_status":"none"},
            "seven_day":{"utilization":41.2,"resets_at":"2026-08-24T12:00:00Z"},
            "seven_day_oauth_apps":{"utilization":3.0,"resets_at":"2026-08-24T12:00:00Z"},
            "seven_day_opus":{"utilization":37.0,"resets_at":"2026-08-24T12:00:00Z"},
            "seven_day_sonnet":{"utilization":19.0,"resets_at":"2026-08-24T12:00:00Z"},
            "cinder_cove":{"utilization":8.5,"resets_at":"2026-08-24T12:00:00Z"},
            "extra_usage":{"is_enabled":true,"monthly_limit":100.0,"used_credits":12.5,
                "utilization":12.5,"currency":"USD","disabled_reason":null},
            "limits":[
                {"kind":"weekly_scoped","group":"model","percent":62.5,
                 "resets_at":"2026-08-24T12:00:00Z","scope":{"model":{"display_name":"Fable"}}},
                {"kind":"weekly_scoped","group":"model","percent":91.0,
                 "resets_at":"2026-08-24T12:00:00Z","scope":{"model":{"display_name":"Opus"}}},
                {"kind":"five_hour","group":"account","percent":23.5,
                 "resets_at":"2026-08-19T15:00:00Z","scope":{}}
            ]
        }"#
        .to_string()
    }

    fn meters(rows: &[Snapshot]) -> Vec<String> {
        rows.iter().map(|row| row.meter.clone()).collect()
    }

    fn meter<'a>(rows: &'a [Snapshot], code: &str) -> &'a Snapshot {
        rows.iter()
            .find(|row| row.meter == code)
            .unwrap_or_else(|| panic!("{code} is missing"))
    }

    #[test]
    fn every_bucket_the_endpoint_states_becomes_its_own_meter() {
        let rows = parse_usage(&full_contract_body(), NOW, ACCOUNT).expect("usage");

        assert_eq!(
            meters(&rows),
            [
                "FIVE_HOUR",
                "SEVEN_DAY",
                "SEVEN_DAY_OPUS",
                "SEVEN_DAY_SONNET",
                "SEVEN_DAY_OAUTH_APPS",
                "CINDER_COVE",
                "SEVEN_DAY_FABLE",
                "EXTRA_USAGE"
            ]
        );
        let fable = meter(&rows, "SEVEN_DAY_FABLE");
        assert_eq!(fable.value, 62.5);
        assert_eq!(fable.unit, "PERCENT");
        assert_eq!(fable.window.duration_seconds, Some(604_800));
        assert_eq!(fable.reset_at.as_deref(), Some("2026-08-24T12:00:00.000Z"));
        let unnamed = meter(&rows, "CINDER_COVE");
        assert_eq!(unnamed.value, 8.5);
        assert_eq!(unnamed.window.kind, "unknown");
        assert_eq!(unnamed.window.duration_seconds, None);
        let extra = meter(&rows, "EXTRA_USAGE");
        assert_eq!(extra.value, 12.5);
        assert_eq!(extra.used_amount, Some(12.5));
        assert_eq!(extra.limit_amount, Some(100.0));
        assert_eq!(extra.currency.as_deref(), Some("USD"));
        assert!(rows
            .iter()
            .all(|row| row.account_id.as_deref() == Some(ACCOUNT)));
    }

    #[test]
    fn a_payload_with_no_session_window_still_reports_its_model_buckets() {
        let rows = parse_usage(
            r#"{
                "five_hour":null,
                "seven_day_opus":{"utilization":37.0,"resets_at":"2026-08-24T12:00:00Z"},
                "limits":[{"kind":"weekly_scoped","group":"model","percent":62.5,
                    "resets_at":"2026-08-24T12:00:00Z",
                    "scope":{"model":{"display_name":"Fable"}}}]
            }"#,
            NOW,
            ACCOUNT,
        )
        .expect("usage");

        assert_eq!(meters(&rows), ["SEVEN_DAY_OPUS", "SEVEN_DAY_FABLE"]);
        assert_eq!(meter(&rows, "SEVEN_DAY_FABLE").value, 62.5);
    }

    #[test]
    fn one_malformed_bucket_is_dropped_without_taking_the_others() {
        let rows = parse_usage(
            r#"{
                "five_hour":{"utilization":23.5,"resets_at":"2026-08-19T15:00:00Z"},
                "seven_day":{"utilization":41.2,"resets_at":"2026-08-24T12:00:00Z"},
                "seven_day_sonnet":{"utilization":"nineteen","resets_at":"2026-08-24T12:00:00Z"},
                "seven_day_opus":{"utilization":37.0,"resets_at":"2020-01-01T00:00:00Z"},
                "limits":[{"kind":"weekly_scoped","group":"model","percent":140.0,
                    "resets_at":"2026-08-24T12:00:00Z",
                    "scope":{"model":{"display_name":"Fable"}}}]
            }"#,
            NOW,
            ACCOUNT,
        )
        .expect("usage");

        assert_eq!(meters(&rows), ["FIVE_HOUR", "SEVEN_DAY"]);
    }

    #[test]
    fn a_model_stated_twice_is_reported_once_from_its_root_bucket() {
        let rows = parse_usage(
            r#"{
                "seven_day":{"utilization":41.2,"resets_at":"2026-08-24T12:00:00Z"},
                "seven_day_opus":{"utilization":37.0,"resets_at":"2026-08-24T12:00:00Z"},
                "limits":[
                    {"kind":"weekly_scoped","group":"model","percent":91.0,
                     "resets_at":"2026-08-24T12:00:00Z",
                     "scope":{"model":{"display_name":"Opus"}}},
                    {"kind":"weekly_scoped","group":"model","percent":11.0,
                     "resets_at":"2026-08-24T12:00:00Z",
                     "scope":{"model":{"display_name":"opus"}}}
                ]
            }"#,
            NOW,
            ACCOUNT,
        )
        .expect("usage");

        assert_eq!(meters(&rows), ["SEVEN_DAY", "SEVEN_DAY_OPUS"]);
        assert_eq!(meter(&rows, "SEVEN_DAY_OPUS").value, 37.0);
    }

    #[test]
    fn the_same_payload_names_the_same_meters_in_the_same_order_every_time() {
        let body = full_contract_body();
        let first = parse_usage(&body, NOW, ACCOUNT).expect("usage");
        let second = parse_usage(&body, NOW, ACCOUNT).expect("usage");

        assert_eq!(meters(&first), meters(&second));
        assert_eq!(
            serde_json::to_string(&first).expect("wire"),
            serde_json::to_string(&second).expect("wire")
        );
    }

    #[test]
    fn extra_usage_keeps_its_dollars_only_in_the_currency_the_cache_states() {
        let rows = parse_usage(
            r#"{
                "seven_day":{"utilization":41.2,"resets_at":"2026-08-24T12:00:00Z"},
                "extra_usage":{"is_enabled":true,"monthly_limit":80.0,"used_credits":20.0,
                    "utilization":25.0,"currency":"EUR","disabled_reason":null}
            }"#,
            NOW,
            ACCOUNT,
        )
        .expect("usage");

        let extra = meter(&rows, "EXTRA_USAGE");
        assert_eq!(extra.value, 25.0);
        assert_eq!(extra.used_amount, None);
        assert_eq!(extra.limit_amount, None);
        assert_eq!(extra.currency, None);
    }

    #[test]
    fn the_contract_is_unknown_only_when_no_bucket_survives() {
        for body in [
            r#"{}"#,
            r#"{"usage":40}"#,
            r#"{"five_hour":{"utilization":"20","resets_at":"2026-08-19T15:00:00Z"}}"#,
            r#"{"five_hour":{"utilization":20,"resets_at":"2020-01-01T00:00:00Z"}}"#,
            r#"{"five_hour":{"utilization":101,"resets_at":"2026-08-19T15:00:00Z"}}"#,
            r#"{"extra_usage":{"is_enabled":false,"monthly_limit":100,"used_credits":4}}"#,
        ] {
            assert!(parse_usage(body, NOW, ACCOUNT).is_none());
        }
        assert!(parse_usage(
            r#"{"five_hour":{"utilization":20,"resets_at":"2026-08-19T15:00:00Z"}}"#,
            NOW,
            ACCOUNT
        )
        .is_some());
    }

    /// The bug was that the desktop showed nothing, so parsing is only half of
    /// it: every new meter has to survive the cache's own validator too, which
    /// drops a row it does not accept without saying so.
    #[tokio::test]
    async fn every_new_meter_survives_the_write_and_reaches_the_cache() {
        let dir = TempDir::new();
        let transport = RecordingTransport::replying(
            200,
            full_contract_body().into_bytes(),
            None,
        );
        let outcome = collect_with_secret(
            &ClaudeOauthRuntime::default(),
            &transport,
            writer(&dir),
            ACCOUNT,
            &secret("every-bucket"),
            NOW,
        )
        .await;

        assert!(matches!(outcome, ClaudeOauthOutcome::CacheCommitted { .. }));
        let cache = fs::read_to_string(dir.path().join(CACHE_FILE_NAME)).expect("cache");
        for meter in [
            "FIVE_HOUR",
            "SEVEN_DAY",
            "SEVEN_DAY_OPUS",
            "SEVEN_DAY_SONNET",
            "SEVEN_DAY_OAUTH_APPS",
            "CINDER_COVE",
            "SEVEN_DAY_FABLE",
            "EXTRA_USAGE",
        ] {
            assert!(cache.contains(meter), "{meter} never reached the cache");
        }
        assert!(cache.contains("\"usedAmount\":12.5"));
        assert!(cache.contains("\"limitAmount\":100.0"));
        assert!(!cache.contains(TOKEN));
    }
}
