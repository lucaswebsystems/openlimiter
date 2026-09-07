use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use url::Url;
use zeroize::Zeroizing;

use crate::credentials::{CredentialError, KeyringStore, SecretStore};

const ACCOUNT_CREDENTIAL_ID: &str = "openlimiter-account-session";
const SYNC_SETTING_CREDENTIAL_ID: &str = "openlimiter-sync-enabled";
const SYNC_DEVICE_CREDENTIAL_ID: &str = "openlimiter-sync-device-id";
const SYNC_CURSOR_CREDENTIAL_ID: &str = "openlimiter-sync-cursor";
const CONFIGURED_PROVIDERS_CREDENTIAL_ID: &str = "openlimiter-configured-providers";
const LOOPBACK_CALLBACK: &str = "http://127.0.0.1:17391/auth/callback";
const MAX_RESPONSE_BYTES: usize = 131_072;
const MAX_REQUEST_BYTES: usize = 8_192;
const NETWORK_TIMEOUT_SECONDS: u64 = 15;
const OAUTH_TIMEOUT_SECONDS: u64 = 180;

/// The contract version the hosted sync surface accepts, and nothing else.
const SYNC_SCHEMA_VERSION: u8 = 2;

/// The largest envelope the hosted surface reads before refusing the request.
const SYNC_MAX_REQUEST_BYTES: usize = 131_072;

/// The most rows one envelope may carry, counting usage and spend together.
const SYNC_MAX_ROWS: usize = 128;

/// The shape of the cursor record kept beside the session.
const SYNC_CURSOR_VERSION: u8 = 1;

/// How long an upload in flight may still be retried as itself. The server
/// refuses an envelope observed more than twenty four hours ago, so this
/// stops an hour short of the refusal.
const SYNC_RESUME_WINDOW_HOURS: i64 = 23;

/// The longest entitlement token this window will put on the wire.
const MAX_ENTITLEMENT_BYTES: usize = 8_192;

fn configured_url() -> &'static str {
    option_env!("OPENLIMITER_SUPABASE_URL").unwrap_or("")
}

fn configured_key() -> &'static str {
    option_env!("OPENLIMITER_SUPABASE_ANON_KEY").unwrap_or("")
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AccountFailure {
    Unconfigured,
    InvalidInput,
    Authentication,
    Network,
    Storage,
    OauthBusy,
    OauthTimeout,
    OauthRejected,
    /// The service has not switched this provider on. Answered before a
    /// browser tab is opened, so the window can say so in its own words.
    ProviderDisabled,
    EmailConfirmationRequired,
    /// The account already holds as many devices as it may. The upload was
    /// refused for that reason alone, so the window says which reason it was
    /// instead of showing a sync that quietly never happens.
    DeviceCapReached,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredSession {
    version: u8,
    #[serde(default)]
    account_id: String,
    email: String,
    access_token: String,
    refresh_token: String,
    expires_at: i64,
}

#[derive(Debug, Deserialize)]
struct AuthUser {
    id: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AuthResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    user: Option<AuthUser>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmailAccountInput {
    pub email: String,
    pub password: String,
    pub create: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OauthAccountInput {
    pub provider: OauthProvider,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OauthProvider {
    Google,
    Github,
}

impl OauthProvider {
    fn as_str(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Github => "github",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub configured: bool,
    pub signed_in: bool,
    pub email: Option<String>,
    pub sync_enabled: bool,
    pub backend_reachable: bool,
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn valid_email(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.len() <= 320 && trimmed.contains('@') && !trimmed.chars().any(char::is_control)
}

fn valid_password(value: &str) -> bool {
    (8..=512).contains(&value.len()) && !value.chars().any(char::is_control)
}

fn configured() -> bool {
    Url::parse(configured_url())
        .ok()
        .is_some_and(|url| url.scheme() == "https" && url.path() == "/")
        && configured_key().starts_with("sb_publishable_")
}

fn sync_enabled_from(store: &dyn SecretStore) -> bool {
    match store.read_secret(SYNC_SETTING_CREDENTIAL_ID) {
        Ok(value) => value.as_str() != "false",
        Err(_) => true,
    }
}

fn normalize_configured_providers(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.to_ascii_uppercase().replace('-', "_"))
        .filter(|value| {
            matches!(
                value.as_str(),
                "CLAUDE"
                    | "OPENROUTER"
                    | "CODEX"
                    | "ANTIGRAVITY"
                    | "GEMINI_CLI"
                    | "OPENCODE"
                    | "GROK"
                    | "KIMI"
            ) && seen.insert(value.clone())
        })
        .collect()
}

fn save_configured_providers(
    store: &dyn SecretStore,
    values: Vec<String>,
) -> Result<(), AccountFailure> {
    let providers = normalize_configured_providers(values);
    let encoded = serde_json::to_string(&providers).map_err(|_| AccountFailure::Storage)?;
    store
        .store_secret(CONFIGURED_PROVIDERS_CREDENTIAL_ID, &encoded)
        .map_err(|_| AccountFailure::Storage)
}

fn configured_providers_from(store: &dyn SecretStore) -> HashSet<String> {
    store
        .read_secret(CONFIGURED_PROVIDERS_CREDENTIAL_ID)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .map(normalize_configured_providers)
        .unwrap_or_default()
        .into_iter()
        .collect()
}

fn jwt_subject(access_token: &str) -> Option<String> {
    let payload = access_token.split('.').nth(1)?;
    if payload.len() > 16_384 {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("sub")
        .and_then(serde_json::Value::as_str)
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .map(str::to_string)
}

pub(crate) fn is_valid_account_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn stored_session(store: &dyn SecretStore) -> Result<StoredSession, AccountFailure> {
    let raw = store
        .read_secret(ACCOUNT_CREDENTIAL_ID)
        .map_err(|error| match error {
            CredentialError::NotFound => AccountFailure::Authentication,
            CredentialError::Store => AccountFailure::Storage,
        })?;
    let mut session: StoredSession =
        serde_json::from_str(&raw).map_err(|_| AccountFailure::Storage)?;
    if session.account_id.is_empty() {
        session.account_id = jwt_subject(&session.access_token).ok_or(AccountFailure::Storage)?;
        session.version = 2;
        /* The migration only rewrites a record that is already valid, so a
        credential store that refuses the write must not cost the person their
        session. The session in hand is used as it is, the stored record is
        left exactly as it was, and the rewrite is tried again on the next
        read. Failing here signed people out over a transient keyring fault. */
        let _ = persist_session(store, &session);
    }
    if session.version != 2
        || !is_valid_account_id(&session.account_id)
        || !valid_email(&session.email)
        || session.access_token.len() < 20
        || session.access_token.len() > 32_768
        || session.refresh_token.len() < 20
        || session.refresh_token.len() > 32_768
    {
        return Err(AccountFailure::Storage);
    }
    Ok(session)
}

fn persist_session(store: &dyn SecretStore, session: &StoredSession) -> Result<(), AccountFailure> {
    let encoded =
        Zeroizing::new(serde_json::to_string(session).map_err(|_| AccountFailure::Storage)?);
    store
        .store_secret(ACCOUNT_CREDENTIAL_ID, &encoded)
        .map_err(|_| AccountFailure::Storage)
}

fn save_session(
    store: &dyn SecretStore,
    response: AuthResponse,
    previous: Option<&StoredSession>,
) -> Result<StoredSession, AccountFailure> {
    let access_token = response
        .access_token
        .ok_or(AccountFailure::Authentication)?;
    let refresh_token = response
        .refresh_token
        .or_else(|| previous.map(|value| value.refresh_token.clone()))
        .ok_or(AccountFailure::Authentication)?;
    let account_id = response
        .user
        .as_ref()
        .and_then(|user| user.id.clone())
        .or_else(|| jwt_subject(&access_token))
        .or_else(|| previous.map(|value| value.account_id.clone()))
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .ok_or(AccountFailure::Authentication)?;
    let email = response
        .user
        .and_then(|user| user.email)
        .or_else(|| previous.map(|value| value.email.clone()))
        .filter(|value| valid_email(value))
        .ok_or(AccountFailure::Authentication)?;
    if access_token.len() < 20
        || access_token.len() > 32_768
        || refresh_token.len() < 20
        || refresh_token.len() > 32_768
    {
        return Err(AccountFailure::Authentication);
    }
    let session = StoredSession {
        version: 2,
        account_id,
        email,
        access_token,
        refresh_token,
        expires_at: now_seconds() + response.expires_in.unwrap_or(3_600).clamp(60, 86_400),
    };
    if previous.is_some_and(|value| value.account_id != session.account_id) {
        crate::pro::clear_local_authorization(store).map_err(|_| AccountFailure::Storage)?;
    }
    persist_session(store, &session)?;
    Ok(session)
}

fn client() -> Result<reqwest::Client, AccountFailure> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(NETWORK_TIMEOUT_SECONDS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| AccountFailure::Network)
}

async fn auth_post(path: &str, body: serde_json::Value) -> Result<AuthResponse, AccountFailure> {
    if !configured() {
        return Err(AccountFailure::Unconfigured);
    }
    let endpoint = format!("{}{}", configured_url().trim_end_matches('/'), path);
    let payload = serde_json::to_vec(&body).map_err(|_| AccountFailure::InvalidInput)?;
    let mut response = client()?
        .post(endpoint)
        .header("apikey", configured_key())
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|_| AccountFailure::Network)?;
    if !response.status().is_success() {
        return Err(AccountFailure::Authentication);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AccountFailure::Network)?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(AccountFailure::Authentication);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| AccountFailure::Authentication)
}

async fn refresh_session(session: &StoredSession) -> Result<AuthResponse, AccountFailure> {
    auth_post(
        "/auth/v1/token?grant_type=refresh_token",
        serde_json::json!({ "refresh_token": session.refresh_token }),
    )
    .await
}

fn session_refresh_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub(crate) async fn current_access_token(
    store: &dyn SecretStore,
) -> Result<Zeroizing<String>, AccountFailure> {
    let _held = session_refresh_lock().lock().await;
    let mut session = stored_session(store)?;
    if session.expires_at <= now_seconds() + 120 {
        let response = refresh_session(&session).await?;
        session = save_session(store, response, Some(&session))?;
    }
    Ok(Zeroizing::new(session.access_token))
}

pub(crate) fn active_account_id(store: &dyn SecretStore) -> Result<String, AccountFailure> {
    stored_session(store).map(|session| session.account_id)
}

/// One usage row, named exactly as the hosted contract names it.
///
/// `meter` is the window's own code (`FIVE_HOUR`, `SEVEN_DAY_FABLE`), because
/// the current row on the server is unique per account, provider and meter: a
/// model scoped window that shared a meter with the plain weekly one would
/// overwrite it, and a person paying for Claude would see one bar where they
/// have three. `window_id` names the same window in the shape the web hub
/// reads back, so a row survives the round trip under the name it left with.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct UsageSample {
    pub account_id: String,
    pub provider: String,
    pub meter: String,
    pub window_id: String,
    pub usage_percent: Option<f64>,
    pub reset_at: Option<String>,
    pub observed_at: String,
    pub stale: bool,
}

/// The forecast the spend meter derived, or nothing at all. Every field is
/// bounded by the server, so nothing free form travels inside it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ForecastInput {
    pub first_observed_at: String,
    pub last_observed_at: String,
    pub sample_count: u32,
    pub burn_usd_per_day: f64,
}

/// One API spend row. The hosted contract compares this key set exactly, so
/// every field is present on every row, including the ones that are null.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ApiSpendSample {
    pub source_id: String,
    pub account_id: String,
    pub provider: String,
    pub key_label: String,
    pub month: String,
    pub spend_usd: f64,
    pub budget_usd: Option<f64>,
    pub source_period: [String; 2],
    pub currency_source: String,
    pub raw_unit_scale: f64,
    pub forecast_date: Option<String>,
    pub forecast_input: Option<ForecastInput>,
    pub period_complete: bool,
}

/// The whole upload: nine keys, no more and no fewer.
///
/// The server compares the key set exactly, so an extra field is not ignored,
/// it is a rejected upload. `api_balance_observations` is the one key the
/// contract allows to be absent, and it is absent here rather than null,
/// because a null is a present key and would fail the same comparison.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct SyncEnvelope {
    pub event_id: String,
    pub device_id: String,
    pub previous_sequence: u64,
    pub sequence: u64,
    pub observed_at: String,
    pub client_version: String,
    pub schema_version: u8,
    pub usage_samples: Vec<UsageSample>,
    pub api_spend_samples: Vec<ApiSpendSample>,
}

/// Everything about one upload that is not a reading.
pub(crate) struct EnvelopeIdentity<'a> {
    pub device_id: &'a str,
    pub event_id: &'a str,
    pub previous_sequence: u64,
    pub observed_at: &'a str,
    pub client_version: &'a str,
}

/// What this build calls itself on the wire. One string, from the crate.
pub(crate) fn client_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn instant(value: &str) -> Option<time::OffsetDateTime> {
    if value.len() > 64 {
        return None;
    }
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
}

fn now_rfc3339() -> Result<String, AccountFailure> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| AccountFailure::Storage)
}

/// One envelope from one set of readings.
///
/// A reading observed after the envelope itself is refused by the server, and
/// a clock that stepped backwards between the cache write and this call is the
/// ordinary way that happens, so a row later than the envelope is pulled back
/// to it rather than dropped.
pub(crate) fn build_envelope(
    identity: EnvelopeIdentity<'_>,
    usage_samples: Vec<UsageSample>,
    api_spend_samples: Vec<ApiSpendSample>,
) -> SyncEnvelope {
    let ceiling = instant(identity.observed_at);
    let usage_samples = usage_samples
        .into_iter()
        .map(|mut row| {
            let later = match (instant(&row.observed_at), ceiling) {
                (Some(observed), Some(limit)) => observed > limit,
                _ => true,
            };
            if later {
                row.observed_at = identity.observed_at.to_string();
            }
            row
        })
        .collect();
    SyncEnvelope {
        event_id: identity.event_id.to_string(),
        device_id: identity.device_id.to_string(),
        previous_sequence: identity.previous_sequence,
        sequence: identity.previous_sequence + 1,
        observed_at: identity.observed_at.to_string(),
        client_version: identity.client_version.to_string(),
        schema_version: SYNC_SCHEMA_VERSION,
        usage_samples,
        api_spend_samples,
    }
}

/// What this device has had accepted, and what it has in flight.
///
/// The record names the device it belongs to, which is what makes a device
/// identifier change safe: a cursor written under another identifier is not
/// inherited, it is replaced by a fresh one at zero, so the server's own
/// cursor for the new device and this one start from the same place.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct SyncCursor {
    version: u8,
    device_id: String,
    sequence: u64,
    #[serde(default)]
    pending_event_id: Option<String>,
    #[serde(default)]
    pending_sequence: Option<u64>,
    #[serde(default)]
    pending_observed_at: Option<String>,
    #[serde(default)]
    pending_digest: Option<String>,
}

impl SyncCursor {
    fn new(device_id: &str) -> Self {
        Self {
            version: SYNC_CURSOR_VERSION,
            device_id: device_id.to_string(),
            sequence: 0,
            pending_event_id: None,
            pending_sequence: None,
            pending_observed_at: None,
            pending_digest: None,
        }
    }

    fn awaiting(&self, envelope: &SyncEnvelope) -> Self {
        Self {
            pending_event_id: Some(envelope.event_id.clone()),
            pending_sequence: Some(envelope.sequence),
            pending_observed_at: Some(envelope.observed_at.clone()),
            pending_digest: Some(envelope_digest(envelope)),
            ..self.clone()
        }
    }

    fn settled(&self, sequence: u64) -> Self {
        Self {
            sequence,
            pending_event_id: None,
            pending_sequence: None,
            pending_observed_at: None,
            pending_digest: None,
            ..self.clone()
        }
    }
}

/// What this device thinks it sent, so it can tell whether the upload in
/// flight and the upload it would build now are the same upload.
fn envelope_digest(envelope: &SyncEnvelope) -> String {
    let bytes = serde_json::to_vec(envelope).unwrap_or_default();
    Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The upload still in flight, when nothing has changed since it was built.
///
/// An upload whose reply never came may or may not have landed, so the retry
/// has to be the same upload: the same event identifier, the same sequence
/// and the same bytes, which is what the server deduplicates on. It keys an
/// event by its own digest and refuses the same identifier carrying anything
/// else, so a cycle whose readings have moved on cannot reuse the identifier
/// and mints a new one instead, leaving the cursor answer to close the gap.
fn resumable_upload(
    cursor: &SyncCursor,
    usage_samples: &[UsageSample],
    api_spend_samples: &[ApiSpendSample],
    client_version: &str,
    now: time::OffsetDateTime,
) -> Option<SyncEnvelope> {
    let event_id = cursor.pending_event_id.as_deref()?;
    let observed_at = cursor.pending_observed_at.as_deref()?;
    let digest = cursor.pending_digest.as_deref()?;
    if cursor.pending_sequence? != cursor.sequence + 1 {
        return None;
    }
    /* The server refuses an envelope observed more than a day ago, so an
    upload older than that is abandoned rather than sent to be rejected. */
    if now - instant(observed_at)? >= time::Duration::hours(SYNC_RESUME_WINDOW_HOURS) {
        return None;
    }
    let envelope = build_envelope(
        EnvelopeIdentity {
            device_id: &cursor.device_id,
            event_id,
            previous_sequence: cursor.sequence,
            observed_at,
            client_version,
        },
        usage_samples.to_vec(),
        api_spend_samples.to_vec(),
    );
    (envelope_digest(&envelope) == digest).then_some(envelope)
}

/// Whether the dollar totals may travel with this upload.
///
/// Free accounts sync current figures, spend included, and the surface takes
/// them with the account bearer alone. An entitled device is held to the
/// feature list its token carries: an upload that names a feature the account
/// does not hold is refused whole, which would take the percentages down with
/// it, so the totals are left out rather than risking the rest.
fn spend_samples_allowed(entitled: bool, api_spend_beta: bool) -> bool {
    !entitled || api_spend_beta
}

/// What the hosted surface answered, in the only five shapes it answers in.
#[derive(Clone, Copy, Debug, PartialEq)]
enum SyncOutcome {
    /// Stored. The sequence is the one the server now holds.
    Accepted(u64),
    /// Refused for pace. The event identifier is spent; the cursor is not.
    RateLimited,
    /// The server's cursor is elsewhere. Its number is the truth.
    Reconcile(u64),
    /// A conflict the server did not put a number on: nothing to adopt.
    Conflict,
    /// The account already holds as many devices as it may.
    DeviceCapReached,
    /// Anything else, including a refusal this device cannot answer.
    Unavailable,
}

fn sync_outcome(status: u16, body: &serde_json::Value, sent_sequence: u64) -> SyncOutcome {
    let error = body.get("error").and_then(serde_json::Value::as_str);
    if error == Some("rate_limited") {
        return SyncOutcome::RateLimited;
    }
    match status {
        200 if body.get("accepted").and_then(serde_json::Value::as_bool) == Some(true) => {
            SyncOutcome::Accepted(
                body.get("sequence")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(sent_sequence),
            )
        }
        409 if error == Some("device cap reached") => SyncOutcome::DeviceCapReached,
        409 => match body
            .get("current_sequence")
            .and_then(serde_json::Value::as_u64)
        {
            Some(sequence) => SyncOutcome::Reconcile(sequence),
            None => SyncOutcome::Conflict,
        },
        _ => SyncOutcome::Unavailable,
    }
}

/// Where the cursor stands after one answer.
///
/// Only an acceptance advances it, and only an answer that reached us clears
/// what is in flight: a request that never got a reply keeps its event
/// identifier and its sequence, so the retry is the same upload rather than a
/// second one.
fn cursor_after(cursor: &SyncCursor, outcome: SyncOutcome) -> SyncCursor {
    match outcome {
        SyncOutcome::Accepted(sequence) => cursor.settled(sequence),
        SyncOutcome::Reconcile(sequence) => cursor.settled(sequence),
        SyncOutcome::RateLimited | SyncOutcome::Conflict | SyncOutcome::DeviceCapReached => {
            cursor.settled(cursor.sequence)
        }
        SyncOutcome::Unavailable => cursor.clone(),
    }
}

fn is_sync_device_id(value: &str) -> bool {
    value.len() == 36
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
        && uuid::Uuid::parse_str(value).is_ok()
}

/// The identifier this device syncs under when it has no account device of
/// its own yet.
///
/// Version 2 of the contract takes a UUID and nothing else. The identifier
/// this window used to mint was `device_` and thirty two hex characters, which
/// no version of that column ever accepted, so an install carrying one is
/// migrated once, here. The old identifier is retired rather than translated:
/// it is overwritten, never sent again, and the cursor record above starts the
/// new identifier at zero.
fn local_sync_device_id(store: &dyn SecretStore) -> Result<String, AccountFailure> {
    match store.read_secret(SYNC_DEVICE_CREDENTIAL_ID) {
        Ok(value) if is_sync_device_id(&value) => Ok(value.to_string()),
        Ok(_) | Err(CredentialError::NotFound) => {
            let value = uuid::Uuid::new_v4().to_string();
            store
                .store_secret(SYNC_DEVICE_CREDENTIAL_ID, &value)
                .map_err(|_| AccountFailure::Storage)?;
            Ok(value)
        }
        Err(CredentialError::Store) => Err(AccountFailure::Storage),
    }
}

/// Who this device is inside the account, and whether it may say it is
/// entitled.
///
/// The account already knows this machine by a UUID once it has paired, and
/// the hosted surface checks that the entitlement token names the same device
/// as the envelope. So the paired identifier is the sync identifier, and the
/// entitlement header goes on only when a token is actually held. A free
/// account syncs its current percentages with the account bearer alone.
async fn sync_identity(
    store: &dyn SecretStore,
) -> Result<(String, Option<String>), AccountFailure> {
    match crate::pro::desktop_device_id(store) {
        Ok(device_id) if is_sync_device_id(&device_id) => {
            let known = store
                .read_secret(SYNC_DEVICE_CREDENTIAL_ID)
                .map(|value| value.as_str() == device_id);
            if known != Ok(true) {
                store
                    .store_secret(SYNC_DEVICE_CREDENTIAL_ID, &device_id)
                    .map_err(|_| AccountFailure::Storage)?;
            }
            let entitlement = crate::pro::current_device_token(store)
                .await
                .ok()
                .filter(|token| {
                    !token.is_empty()
                        && token.len() <= MAX_ENTITLEMENT_BYTES
                        && token.chars().all(|character| character.is_ascii_graphic())
                });
            Ok((device_id, entitlement))
        }
        _ => Ok((local_sync_device_id(store)?, None)),
    }
}

fn load_cursor(store: &dyn SecretStore, device_id: &str) -> SyncCursor {
    store
        .read_secret(SYNC_CURSOR_CREDENTIAL_ID)
        .ok()
        .and_then(|raw| serde_json::from_str::<SyncCursor>(&raw).ok())
        .filter(|cursor| cursor.version == SYNC_CURSOR_VERSION && cursor.device_id == device_id)
        .unwrap_or_else(|| SyncCursor::new(device_id))
}

fn save_cursor(store: &dyn SecretStore, cursor: &SyncCursor) -> Result<(), AccountFailure> {
    let encoded = serde_json::to_string(cursor).map_err(|_| AccountFailure::Storage)?;
    store
        .store_secret(SYNC_CURSOR_CREDENTIAL_ID, &encoded)
        .map_err(|_| AccountFailure::Storage)
}

/// The rows this device would upload, from the cache document it already
/// writes for the tray and the terminal.
///
/// Nothing is invented here. A reading that fails a bound is dropped rather
/// than repaired, and the highest reading of a window wins when two readers
/// saw the same window, because a percentage that went down inside a window
/// is a reader that lost track rather than usage that was returned.
fn usage_samples_from_cache(
    document: &serde_json::Value,
    configured_providers: &HashSet<String>,
    envelope_observed_at: &str,
    now: time::OffsetDateTime,
) -> Result<Vec<UsageSample>, AccountFailure> {
    let snapshots = document
        .get("snapshots")
        .and_then(serde_json::Value::as_array)
        .ok_or(AccountFailure::Storage)?;
    if snapshots.len() > 512 {
        return Err(AccountFailure::Storage);
    }
    let valid_code = |value: &str, max: usize| {
        (2..=max).contains(&value.len())
            && value.chars().all(|character| {
                character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
            })
    };
    let valid_account = |value: &str| {
        !value.is_empty()
            && value.len() <= 64
            && value.chars().enumerate().all(|(index, character)| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || (index > 0 && character == '-')
            })
    };
    let mut selected: HashMap<(String, String, String), UsageSample> = HashMap::new();
    for snapshot in snapshots {
        if snapshot.get("unit").and_then(serde_json::Value::as_str) != Some("PERCENT") {
            continue;
        }
        let Some(provider) = snapshot.get("provider").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if !configured_providers.contains(provider) {
            continue;
        }
        let Some(window) = snapshot.get("meter").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let account_id = snapshot
            .get("accountId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("default");
        let Some(usage_percent) = snapshot.get("value").and_then(serde_json::Value::as_f64) else {
            continue;
        };
        if !valid_code(provider, 32)
            || !valid_code(window, 48)
            || window == "API_BUDGET_PERCENT"
            || provider == "MOONSHOT"
            || !valid_account(account_id)
            || !usage_percent.is_finite()
            || !(0.0..=100.0).contains(&usage_percent)
        {
            continue;
        }
        let reset_at = match snapshot.get("resetAt") {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(value)) if instant(value).is_some() => {
                Some(value.clone())
            }
            _ => continue,
        };
        let observed_at = match snapshot
            .get("observedAt")
            .and_then(serde_json::Value::as_str)
        {
            Some(value) if instant(value).is_some() => value.to_string(),
            _ => envelope_observed_at.to_string(),
        };
        /* A reading past its own freshness window travels with that fact
        attached, so the hub can hatch the bar instead of drawing a number
        nobody has confirmed for hours. */
        let stale = snapshot
            .get("expiresAt")
            .and_then(serde_json::Value::as_str)
            .and_then(instant)
            .is_none_or(|expires| expires <= now);
        let sample = UsageSample {
            account_id: account_id.to_string(),
            provider: provider.to_string(),
            meter: window.to_string(),
            window_id: window.to_string(),
            usage_percent: Some(usage_percent),
            reset_at,
            observed_at,
            stale,
        };
        let key = (
            provider.to_string(),
            account_id.to_string(),
            window.to_string(),
        );
        match selected.get(&key) {
            Some(current) if current.usage_percent >= sample.usage_percent => {}
            _ => {
                selected.insert(key, sample);
            }
        }
    }
    if selected.len() > SYNC_MAX_ROWS {
        return Err(AccountFailure::Storage);
    }
    let mut rows = selected.into_iter().collect::<Vec<_>>();
    rows.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(rows.into_iter().map(|(_, sample)| sample).collect())
}

fn sync_rows(
    store: &dyn SecretStore,
    envelope_observed_at: &str,
) -> Result<Vec<UsageSample>, AccountFailure> {
    let configured_providers = configured_providers_from(store);
    if configured_providers.is_empty() {
        return Ok(Vec::new());
    }
    let Some(raw) = crate::state::read_cache() else {
        return Ok(Vec::new());
    };
    let document: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| AccountFailure::Storage)?;
    usage_samples_from_cache(
        &document,
        &configured_providers,
        envelope_observed_at,
        time::OffsetDateTime::now_utc(),
    )
}

/// One upload request, built and not yet sent.
///
/// The account bearer is always there, because the surface answers nothing
/// without it. The entitlement header is there only when this device holds a
/// token, because a free account syncs its current percentages too and a
/// header it cannot honour would be a refusal instead of an upload.
fn sync_request(
    http: &reqwest::Client,
    endpoint: &str,
    access_token: &str,
    entitlement: Option<&str>,
    payload: Vec<u8>,
) -> Result<reqwest::Request, AccountFailure> {
    if payload.len() > SYNC_MAX_REQUEST_BYTES {
        return Err(AccountFailure::Storage);
    }
    let mut builder = http
        .post(endpoint)
        .header("apikey", configured_key())
        .bearer_auth(access_token)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json");
    if let Some(token) = entitlement {
        builder = builder.header("x-openlimiter-entitlement", token);
    }
    builder
        .body(payload)
        .build()
        .map_err(|_| AccountFailure::Network)
}

async fn post_envelope(
    envelope: &SyncEnvelope,
    access_token: &str,
    entitlement: Option<&str>,
) -> Result<(u16, serde_json::Value), AccountFailure> {
    let payload = serde_json::to_vec(envelope).map_err(|_| AccountFailure::Storage)?;
    let endpoint = format!(
        "{}/functions/v1/sync-snapshots",
        configured_url().trim_end_matches('/')
    );
    let http = client()?;
    let request = sync_request(&http, &endpoint, access_token, entitlement, payload)?;
    let mut response = http
        .execute(request)
        .await
        .map_err(|_| AccountFailure::Network)?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AccountFailure::Network)?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    ))
}

/// One upload, on the version 2 contract.
///
/// The sequence is a compare and swap against the server's own cursor, so the
/// three ways an upload can end are all handled here: a reply that accepts it
/// advances the cursor by one, a reply that never came leaves the event
/// identifier and the sequence in place so the immediate retry is the same
/// upload rather than a second one, and a reply that says the cursor is
/// somewhere else hands us its number, which we adopt and use once.
///
/// A retry in a later cycle mints a new event identifier on purpose. The
/// server keys an event on its own digest, so the same identifier carrying
/// readings that have moved on is refused rather than deduplicated, and the
/// cursor answer above is what closes the gap instead.
pub(crate) async fn sync_snapshot(store: &dyn SecretStore) -> Result<bool, AccountFailure> {
    if !sync_enabled_from(store) {
        return Ok(false);
    }
    let now = time::OffsetDateTime::now_utc();
    let observed_at = now_rfc3339()?;
    let usage_samples = sync_rows(store, &observed_at)?;
    let mut api_spend_samples =
        crate::api_spend::synced_spend_samples(SYNC_MAX_ROWS.saturating_sub(usage_samples.len()));
    if usage_samples.is_empty() && api_spend_samples.is_empty() {
        return Ok(false);
    }
    let access_token = current_access_token(store).await?;
    let (device_id, entitlement) = sync_identity(store).await?;
    if !spend_samples_allowed(entitlement.is_some(), crate::pro::api_spend_cap_lifted()) {
        api_spend_samples = Vec::new();
    }
    if usage_samples.is_empty() && api_spend_samples.is_empty() {
        return Ok(false);
    }
    let mut cursor = load_cursor(store, &device_id);
    let mut resumed = resumable_upload(
        &cursor,
        &usage_samples,
        &api_spend_samples,
        client_version(),
        now,
    );
    for round in 0..2 {
        let envelope = match resumed.take() {
            Some(envelope) => envelope,
            None => {
                let event_id = uuid::Uuid::new_v4().to_string();
                build_envelope(
                    EnvelopeIdentity {
                        device_id: &device_id,
                        event_id: &event_id,
                        previous_sequence: cursor.sequence,
                        observed_at: &observed_at,
                        client_version: client_version(),
                    },
                    usage_samples.clone(),
                    api_spend_samples.clone(),
                )
            }
        };
        save_cursor(store, &cursor.awaiting(&envelope))?;
        let answer = match post_envelope(&envelope, &access_token, entitlement.as_deref()).await {
            Ok(answer) => answer,
            /* The first failure is a lost reply, not a refusal, so the same
            bytes go again under the same event identifier. */
            Err(_) => post_envelope(&envelope, &access_token, entitlement.as_deref()).await?,
        };
        let outcome = sync_outcome(answer.0, &answer.1, envelope.sequence);
        cursor = cursor_after(&cursor, outcome);
        save_cursor(store, &cursor)?;
        match outcome {
            SyncOutcome::Accepted(_) => return Ok(true),
            SyncOutcome::Reconcile(_) if round == 0 => {}
            SyncOutcome::DeviceCapReached => return Err(AccountFailure::DeviceCapReached),
            SyncOutcome::Unavailable => return Err(AccountFailure::Network),
            _ => return Ok(false),
        }
    }
    Ok(false)
}

fn status_for(store: &dyn SecretStore, backend_reachable: bool) -> AccountStatus {
    let session = stored_session(store).ok();
    AccountStatus {
        configured: configured(),
        signed_in: session.is_some(),
        email: session.map(|value| value.email),
        sync_enabled: sync_enabled_from(store),
        backend_reachable,
    }
}

#[tauri::command]
pub async fn account_status(
    store: State<'_, KeyringStore>,
) -> Result<AccountStatus, AccountFailure> {
    let Ok(_session) = stored_session(store.inner()) else {
        return Ok(status_for(store.inner(), configured()));
    };
    Ok(match current_access_token(store.inner()).await {
        Ok(_) => status_for(store.inner(), true),
        Err(_) => status_for(store.inner(), false),
    })
}

#[tauri::command]
pub async fn account_email(
    input: EmailAccountInput,
    store: State<'_, KeyringStore>,
) -> Result<AccountStatus, AccountFailure> {
    let email = input.email.trim().to_lowercase();
    if !valid_email(&email) || !valid_password(&input.password) {
        return Err(AccountFailure::InvalidInput);
    }
    let path = if input.create {
        "/auth/v1/signup"
    } else {
        "/auth/v1/token?grant_type=password"
    };
    let response = auth_post(
        path,
        serde_json::json!({ "email": email, "password": input.password }),
    )
    .await?;
    if input.create
        && response.access_token.is_none()
        && response
            .user
            .as_ref()
            .and_then(|user| user.email.as_deref())
            .is_some_and(valid_email)
    {
        return Err(AccountFailure::EmailConfirmationRequired);
    }
    let previous = stored_session(store.inner()).ok();
    save_session(store.inner(), response, previous.as_ref())?;
    Ok(status_for(store.inner(), true))
}

fn oauth_request(listener: &TcpListener) -> Result<(String, String), AccountFailure> {
    let deadline = std::time::Instant::now() + Duration::from_secs(OAUTH_TIMEOUT_SECONDS);
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut request = [0_u8; MAX_REQUEST_BYTES];
                let count = stream
                    .read(&mut request)
                    .map_err(|_| AccountFailure::OauthRejected)?;
                let head = std::str::from_utf8(&request[..count])
                    .map_err(|_| AccountFailure::OauthRejected)?;
                let target = head
                    .lines()
                    .next()
                    .and_then(|line| line.strip_prefix("GET "))
                    .and_then(|line| line.split_once(' ').map(|pair| pair.0))
                    .ok_or(AccountFailure::OauthRejected)?;
                let url = Url::parse(&format!("http://127.0.0.1:17391{target}"))
                    .map_err(|_| AccountFailure::OauthRejected)?;
                let code = url
                    .query_pairs()
                    .find(|(key, _)| key == "code")
                    .map(|(_, value)| value.into_owned())
                    .ok_or(AccountFailure::OauthRejected)?;
                let state = url
                    .query_pairs()
                    .find(|(key, _)| key == "state")
                    .map(|(_, value)| value.into_owned())
                    .unwrap_or_default();
                let body = "OpenLimiter is signed in. You can close this tab.";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                let _ = stream.write_all(response.as_bytes());
                return Ok((code, state));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    return Err(AccountFailure::OauthTimeout);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return Err(AccountFailure::OauthRejected),
        }
    }
}

/// Whether an authorize answer is the service refusing a provider it has not
/// switched on. Only that exact refusal counts: a 400 with the provider named
/// as not enabled. Any other status, and any other 400, is not a claim about
/// the provider and is left for the browser to meet as it always has.
fn provider_refused(status: reqwest::StatusCode, body: &[u8]) -> bool {
    if status != reqwest::StatusCode::BAD_REQUEST {
        return false;
    }
    let text = String::from_utf8_lossy(body).to_ascii_lowercase();
    text.contains("not enabled") || text.contains("unsupported provider")
}

/// Ask the service whether the provider is switched on before a browser tab
/// is opened for it.
///
/// A provider the project has not enabled does not fail when the tab opens.
/// The service answers the authorize address with a 400 and a JSON body, the
/// person is left looking at that JSON in place of the product, and this
/// window waits three minutes for a callback that can never come before it
/// reports a timeout. So the address is asked once first, with redirects left
/// unfollowed: a switched on provider answers with a redirect to itself, a
/// switched off one answers with the refusal. Anything short of that exact
/// refusal, including a probe that could not be made at all, lets the sign
/// in proceed, so this can only ever fall back to the old behaviour and
/// never invent a refusal of its own.
async fn provider_switched_on(authorize: &Url) -> Result<(), AccountFailure> {
    let Ok(mut response) = client()?
        .get(authorize.clone())
        .header("apikey", configured_key())
        .header(ACCEPT, "application/json")
        .send()
        .await
    else {
        return Ok(());
    };
    let status = response.status();
    if status != reqwest::StatusCode::BAD_REQUEST {
        return Ok(());
    }
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    if provider_refused(status, &bytes) {
        return Err(AccountFailure::ProviderDisabled);
    }
    Ok(())
}

#[tauri::command]
pub async fn account_oauth(
    input: OauthAccountInput,
    app: AppHandle,
    store: State<'_, KeyringStore>,
) -> Result<AccountStatus, AccountFailure> {
    if !configured() {
        return Err(AccountFailure::Unconfigured);
    }
    let listener = TcpListener::bind("127.0.0.1:17391").map_err(|_| AccountFailure::OauthBusy)?;
    listener
        .set_nonblocking(true)
        .map_err(|_| AccountFailure::OauthBusy)?;
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut authorize = Url::parse(&format!(
        "{}/auth/v1/authorize",
        configured_url().trim_end_matches('/')
    ))
    .map_err(|_| AccountFailure::Unconfigured)?;
    authorize
        .query_pairs_mut()
        .append_pair("provider", input.provider.as_str())
        .append_pair("redirect_to", LOOPBACK_CALLBACK)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "s256");
    /* No state of our own. The service forwards whatever state it is given
       straight to the provider, and then cannot resolve it on the way back:
       every sign in died with "OAuth state not found or expired" (2026-09-06).
       Left alone, the service mints its own state and resolves it, and the
       proof of custody stays the PKCE verifier, which never leaves here. */
    provider_switched_on(&authorize).await?;
    /* The address is kept for the length of this one attempt, so the window
       can open the browser to it again, and cleared however the attempt ends. */
    set_pending_authorize(Some(authorize.to_string()));
    let outcome = complete_oauth(&app, store.inner(), authorize, listener, verifier).await;
    set_pending_authorize(None);
    outcome
}

async fn complete_oauth(
    app: &AppHandle,
    store: &KeyringStore,
    authorize: Url,
    listener: TcpListener,
    verifier: String,
) -> Result<AccountStatus, AccountFailure> {
    app.opener()
        .open_url(authorize.as_str(), None::<&str>)
        .map_err(|_| AccountFailure::OauthRejected)?;
    let (code, _state) = tauri::async_runtime::spawn_blocking(move || oauth_request(&listener))
        .await
        .map_err(|_| AccountFailure::OauthRejected)??;
    let response = auth_post(
        "/auth/v1/token?grant_type=pkce",
        serde_json::json!({ "auth_code": code, "code_verifier": verifier }),
    )
    .await?;
    let previous = stored_session(store).ok();
    save_session(store, response, previous.as_ref())?;
    Ok(status_for(store, true))
}

/// The authorize address of the sign in in flight, if there is one.
///
/// A browser tab can be closed or lost while this window waits on it, and the
/// window offers to open the link again. The address is set for the length of
/// one attempt and cleared with it, whichever way the attempt ends, so a
/// reopen outside an attempt has nothing to open.
fn pending_authorize() -> &'static std::sync::Mutex<Option<String>> {
    static PENDING: OnceLock<std::sync::Mutex<Option<String>>> = OnceLock::new();
    PENDING.get_or_init(|| std::sync::Mutex::new(None))
}

fn set_pending_authorize(value: Option<String>) {
    if let Ok(mut slot) = pending_authorize().lock() {
        *slot = value;
    }
}

fn pending_authorize_url() -> Option<String> {
    pending_authorize().lock().ok().and_then(|slot| slot.clone())
}

/// Open the browser to the sign in already in flight, once more. Nothing in
/// flight is an input error rather than a new attempt: a new attempt is what
/// the provider buttons are for.
#[tauri::command]
pub fn account_oauth_reopen(app: AppHandle) -> Result<(), AccountFailure> {
    let Some(url) = pending_authorize_url() else {
        return Err(AccountFailure::InvalidInput);
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| AccountFailure::OauthRejected)
}

#[tauri::command]
pub fn account_set_sync(
    enabled: bool,
    store: State<'_, KeyringStore>,
) -> Result<AccountStatus, AccountFailure> {
    store
        .store_secret(
            SYNC_SETTING_CREDENTIAL_ID,
            if enabled { "true" } else { "false" },
        )
        .map_err(|_| AccountFailure::Storage)?;
    Ok(status_for(store.inner(), true))
}

#[tauri::command]
pub async fn account_logout(store: State<'_, KeyringStore>) -> Result<(), AccountFailure> {
    if let Ok(access_token) = current_access_token(store.inner()).await {
        let endpoint = format!("{}/auth/v1/logout", configured_url().trim_end_matches('/'));
        if let Ok(client) = client() {
            let _ = client
                .post(endpoint)
                .header("apikey", configured_key())
                .bearer_auth(&*access_token)
                .send()
                .await;
        }
    }
    let account_cleared = matches!(
        store.delete_secret(ACCOUNT_CREDENTIAL_ID),
        Ok(()) | Err(CredentialError::NotFound)
    );
    let pro_cleared = crate::pro::clear_local_authorization(store.inner()).is_ok();
    if account_cleared && pro_cleared {
        Ok(())
    } else {
        Err(AccountFailure::Storage)
    }
}

#[tauri::command]
pub async fn account_sync_snapshot(store: State<'_, KeyringStore>) -> Result<bool, AccountFailure> {
    sync_snapshot(store.inner()).await
}

#[tauri::command]
pub async fn account_sync_configured_snapshot(
    configured_providers: Vec<String>,
    store: State<'_, KeyringStore>,
) -> Result<bool, AccountFailure> {
    save_configured_providers(store.inner(), configured_providers)?;
    sync_snapshot(store.inner()).await
}

pub fn spawn_sync() {
    tauri::async_runtime::spawn(async move {
        let store = KeyringStore;
        let mut interval = tokio::time::interval(Duration::from_secs(5 * 60));
        loop {
            interval.tick().await;
            let _ = sync_snapshot(&store).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::InMemorySecrets;

    #[test]
    fn account_failure_crosses_ipc_without_payload() {
        assert_eq!(
            serde_json::to_value(AccountFailure::Network).expect("failure"),
            serde_json::json!({ "kind": "network" })
        );
    }

    #[test]
    fn account_status_never_contains_tokens() {
        let value = serde_json::to_string(&AccountStatus {
            configured: true,
            signed_in: true,
            email: Some("person@example.com".to_string()),
            sync_enabled: true,
            backend_reachable: false,
        })
        .expect("status");
        assert!(!value.contains("token"));
        assert!(!value.contains("secret"));
    }

    #[test]
    fn email_and_password_validation_is_bounded() {
        assert!(valid_email("person@example.com"));
        assert!(!valid_email("missing-at.example.com"));
        assert!(valid_password("eight888"));
        assert!(!valid_password("short"));
    }

    #[test]
    fn configured_provider_list_is_bounded_and_excludes_manual() {
        assert_eq!(
            normalize_configured_providers(vec![
                "codex".to_string(),
                "CODEX".to_string(),
                "gemini-cli".to_string(),
                "MANUAL".to_string(),
                "OTHER".to_string(),
            ]),
            vec!["CODEX".to_string(), "GEMINI_CLI".to_string()]
        );
    }

    #[test]
    fn sync_defaults_on_and_a_person_can_turn_it_off() {
        let store = InMemorySecrets::new();
        assert!(sync_enabled_from(&store));
        store
            .store_secret(SYNC_SETTING_CREDENTIAL_ID, "false")
            .expect("sync preference");
        assert!(!sync_enabled_from(&store));
    }

    #[test]
    fn cached_session_remains_signed_in_when_the_backend_is_unreachable() {
        let store = InMemorySecrets::new();
        let session = StoredSession {
            version: 2,
            account_id: "00000000-0000-4000-8000-000000000001".to_string(),
            email: "person@example.com".to_string(),
            access_token: "a".repeat(32),
            refresh_token: "r".repeat(32),
            expires_at: now_seconds() + 3_600,
        };
        store
            .store_secret(
                ACCOUNT_CREDENTIAL_ID,
                &serde_json::to_string(&session).expect("session"),
            )
            .expect("cached session");

        let status = status_for(&store, false);
        assert!(status.signed_in);
        assert!(!status.backend_reachable);
        assert_eq!(status.email.as_deref(), Some("person@example.com"));
    }

    #[test]
    fn pending_email_confirmation_has_a_closed_failure_kind() {
        assert_eq!(
            serde_json::to_value(AccountFailure::EmailConfirmationRequired)
                .expect("email confirmation failure"),
            serde_json::json!({ "kind": "email_confirmation_required" })
        );
    }

    #[test]
    fn a_switched_off_provider_has_a_closed_failure_kind() {
        assert_eq!(
            serde_json::to_value(AccountFailure::ProviderDisabled).expect("provider disabled failure"),
            serde_json::json!({ "kind": "provider_disabled" })
        );
    }

    #[test]
    fn the_pending_link_is_kept_for_one_attempt_and_cleared_with_it() {
        set_pending_authorize(Some(
            "https://auth.example/authorize?provider=github".to_string(),
        ));
        assert_eq!(
            pending_authorize_url().as_deref(),
            Some("https://auth.example/authorize?provider=github")
        );
        set_pending_authorize(None);
        assert_eq!(pending_authorize_url(), None);
    }

    #[test]
    fn only_the_service_refusal_reads_as_a_switched_off_provider() {
        assert!(provider_refused(
            reqwest::StatusCode::BAD_REQUEST,
            br#"{"code":400,"error_code":"validation_failed","msg":"Unsupported provider: provider is not enabled"}"#
        ));
        assert!(!provider_refused(
            reqwest::StatusCode::BAD_REQUEST,
            br#"{"code":400,"msg":"Bad redirect"}"#
        ));
        assert!(!provider_refused(reqwest::StatusCode::FOUND, b""));
        assert!(!provider_refused(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            b"provider is not enabled"
        ));
    }

    #[test]
    fn an_account_switch_clears_the_previous_device_grant_before_save() {
        let store = InMemorySecrets::new();
        let previous = StoredSession {
            version: 2,
            account_id: "00000000-0000-4000-8000-000000000001".to_string(),
            email: "first@example.com".to_string(),
            access_token: "first-access-token-at-least-twenty".to_string(),
            refresh_token: "first-refresh-token-at-least-twenty".to_string(),
            expires_at: now_seconds() + 3_600,
        };
        persist_session(&store, &previous).expect("previous session");
        store
            .store_secret("openlimiter-pro-trust", "old-device-grant")
            .expect("old grant");

        let saved = save_session(
            &store,
            AuthResponse {
                access_token: Some("second-access-token-at-least-twenty".to_string()),
                refresh_token: Some("second-refresh-token-at-least-twenty".to_string()),
                expires_in: Some(3_600),
                user: Some(AuthUser {
                    id: Some("00000000-0000-4000-8000-000000000002".to_string()),
                    email: Some("second@example.com".to_string()),
                }),
            },
            Some(&previous),
        )
        .expect("switched session");
        assert_eq!(saved.account_id, "00000000-0000-4000-8000-000000000002");
        assert_eq!(
            store.read_secret("openlimiter-pro-trust"),
            Err(CredentialError::NotFound)
        );
        assert_eq!(store.stored_count(), 1);
    }

    #[test]
    fn the_refresh_token_lives_in_the_credential_store_and_nowhere_else() {
        /* The refresh token is the one value that can mint a new session, so
        it goes to the operating system credential store and to no file this
        window writes. One record holds the whole session; there is no second
        copy anywhere for a backup tool to pick up. */
        let store = InMemorySecrets::new();
        let saved = save_session(
            &store,
            AuthResponse {
                access_token: Some("an-access-token-at-least-twenty".to_string()),
                refresh_token: Some("a-refresh-token-at-least-twenty".to_string()),
                expires_in: Some(3_600),
                user: Some(AuthUser {
                    id: Some("00000000-0000-4000-8000-000000000001".to_string()),
                    email: Some("person@example.com".to_string()),
                }),
            },
            None,
        )
        .expect("a stored session");
        assert_eq!(saved.refresh_token, "a-refresh-token-at-least-twenty");
        assert_eq!(store.stored_count(), 1);

        let read_back = stored_session(&store).expect("the session survives a read back");
        assert_eq!(read_back.refresh_token, saved.refresh_token);
        assert_eq!(read_back.account_id, saved.account_id);

        /* And what the window is allowed to see carries neither token. */
        let visible = serde_json::to_string(&status_for(&store, true)).expect("the status");
        assert!(!visible.contains("a-refresh-token-at-least-twenty"));
        assert!(!visible.contains("an-access-token-at-least-twenty"));
    }

    #[test]
    fn a_renewal_keeps_the_refresh_token_the_service_did_not_reissue() {
        /* Supabase rotates a refresh token on some renewals and not others.
        Dropping the previous one when none came back would end the session at
        the next renewal, which is a silent sign out an hour later. */
        let store = InMemorySecrets::new();
        let previous = StoredSession {
            version: 2,
            account_id: "00000000-0000-4000-8000-000000000001".to_string(),
            email: "person@example.com".to_string(),
            access_token: "the-old-access-token-at-least-twenty".to_string(),
            refresh_token: "the-kept-refresh-token-at-least-twenty".to_string(),
            expires_at: now_seconds() + 60,
        };
        persist_session(&store, &previous).expect("the previous session");

        let renewed = save_session(
            &store,
            AuthResponse {
                access_token: Some("the-new-access-token-at-least-twenty".to_string()),
                refresh_token: None,
                expires_in: Some(3_600),
                user: None,
            },
            Some(&previous),
        )
        .expect("the renewed session");
        assert_eq!(renewed.refresh_token, previous.refresh_token);
        assert_eq!(renewed.account_id, previous.account_id);
        assert_eq!(renewed.email, previous.email);
        assert!(renewed.expires_at > previous.expires_at);
    }

    #[test]
    fn a_session_shorter_than_the_bound_is_refused_rather_than_stored() {
        let store = InMemorySecrets::new();
        let outcome = save_session(
            &store,
            AuthResponse {
                access_token: Some("short".to_string()),
                refresh_token: Some("a-refresh-token-at-least-twenty".to_string()),
                expires_in: Some(3_600),
                user: Some(AuthUser {
                    id: Some("00000000-0000-4000-8000-000000000001".to_string()),
                    email: Some("person@example.com".to_string()),
                }),
            },
            None,
        );
        assert!(matches!(outcome, Err(AccountFailure::Authentication)));
        assert_eq!(store.stored_count(), 0);
    }

    /// The shared envelope both this window and the server test against.
    const SYNC_FIXTURE: &str =
        include_str!("../../../../packages/core/fixtures/sync-envelope-v2.json");

    /// The same document with every value replaced by the name of its type,
    /// which is what "the same shape" means when one side writes 98 and the
    /// other writes 98.0 for the same reading.
    fn shape_of(value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(fields) => serde_json::Value::Object(
                fields
                    .iter()
                    .map(|(name, field)| (name.clone(), shape_of(field)))
                    .collect(),
            ),
            serde_json::Value::Array(items) => {
                serde_json::Value::Array(items.iter().map(shape_of).collect())
            }
            serde_json::Value::Null => serde_json::Value::String("null".to_string()),
            serde_json::Value::Bool(_) => serde_json::Value::String("boolean".to_string()),
            serde_json::Value::Number(_) => serde_json::Value::String("number".to_string()),
            serde_json::Value::String(_) => serde_json::Value::String("string".to_string()),
        }
    }

    fn fixture_envelope() -> SyncEnvelope {
        build_envelope(
            EnvelopeIdentity {
                device_id: "9c1d4f60-2e83-4b17-8a5c-71e0d3f95b46",
                event_id: "3f7a2b18-5c94-4a6d-9f21-6b0d5c8e4a72",
                previous_sequence: 41,
                observed_at: "2026-09-07T12:00:00.000Z",
                client_version: "1.3.0",
            },
            vec![
                UsageSample {
                    account_id: "claude-personal".to_string(),
                    provider: "CLAUDE".to_string(),
                    meter: "FIVE_HOUR".to_string(),
                    window_id: "FIVE_HOUR".to_string(),
                    usage_percent: Some(27.5),
                    reset_at: Some("2026-09-07T14:00:00.000Z".to_string()),
                    observed_at: "2026-09-07T11:59:30.000Z".to_string(),
                    stale: false,
                },
                UsageSample {
                    account_id: "claude-personal".to_string(),
                    provider: "CLAUDE".to_string(),
                    meter: "SEVEN_DAY_FABLE".to_string(),
                    window_id: "SEVEN_DAY_FABLE".to_string(),
                    usage_percent: Some(62.5),
                    reset_at: Some("2026-09-11T09:00:00.000Z".to_string()),
                    observed_at: "2026-09-07T11:59:30.000Z".to_string(),
                    stale: false,
                },
                UsageSample {
                    account_id: "codex-personal".to_string(),
                    provider: "CODEX".to_string(),
                    meter: "PRIMARY_WINDOW".to_string(),
                    window_id: "PRIMARY_WINDOW".to_string(),
                    usage_percent: Some(98.0),
                    reset_at: Some("2026-09-12T03:00:00.000Z".to_string()),
                    observed_at: "2026-09-07T11:58:00.000Z".to_string(),
                    stale: true,
                },
            ],
            vec![ApiSpendSample {
                source_id: "b28c9d51-7f0a-4c3e-9d64-5a1b8e2f7c03".to_string(),
                account_id: "openrouter-key".to_string(),
                provider: "OPENROUTER".to_string(),
                key_label: "OpenRouter key".to_string(),
                month: "2026-09-01".to_string(),
                spend_usd: 40.9,
                budget_usd: Some(100.0),
                source_period: [
                    "2026-09-01T00:00:00.000Z".to_string(),
                    "2026-09-07T12:00:00.000Z".to_string(),
                ],
                currency_source: "PROVIDER_USD".to_string(),
                raw_unit_scale: 1.0,
                forecast_date: None,
                forecast_input: None,
                period_complete: false,
            }],
        )
    }

    /// A credential store that reads but refuses every write, which is what a
    /// locked or momentarily unavailable operating system vault looks like.
    struct ReadOnlySecrets {
        record: String,
    }

    impl SecretStore for ReadOnlySecrets {
        fn store_secret(&self, _connection_id: &str, _secret: &str) -> Result<(), CredentialError> {
            Err(CredentialError::Store)
        }

        fn read_secret(&self, connection_id: &str) -> Result<Zeroizing<String>, CredentialError> {
            if connection_id == ACCOUNT_CREDENTIAL_ID {
                Ok(Zeroizing::new(self.record.clone()))
            } else {
                Err(CredentialError::NotFound)
            }
        }

        fn delete_secret(&self, _connection_id: &str) -> Result<(), CredentialError> {
            Err(CredentialError::Store)
        }
    }

    #[test]
    fn a_refused_write_does_not_sign_the_person_out_during_the_migration() {
        /* The account identifier was added to the stored session later, so an
        older record has it empty and is filled in on the next read. That
        rewrite is a convenience: a vault that refuses it must leave the person
        signed in with the record they already have, and the rewrite is tried
        again next time. Failing the read instead reported a signed out
        account over a transient fault. */
        let subject = "00000000-0000-4000-8000-000000000001";
        let claims = URL_SAFE_NO_PAD.encode(format!("{{\"sub\":\"{subject}\"}}"));
        let record = serde_json::json!({
            "version": 1,
            "account_id": "",
            "email": "person@example.com",
            "access_token": format!("header.{claims}.signature"),
            "refresh_token": "r".repeat(32),
            "expires_at": now_seconds() + 3_600,
        })
        .to_string();
        let store = ReadOnlySecrets { record };

        let session = stored_session(&store).expect("the session survives a refused rewrite");
        assert_eq!(session.account_id, subject);
        assert_eq!(session.version, 2);
        assert!(status_for(&store, true).signed_in);
    }

    #[test]
    fn the_envelope_matches_the_shared_fixture_field_for_field() {
        /* The server keeps a byte identical copy of this file and asserts its
        own parser accepts it. One fixture, two repositories, so a field
        renamed on either side fails a test here instead of failing every
        upload in the field. */
        let built = fixture_envelope();
        let fixture: SyncEnvelope =
            serde_json::from_str(SYNC_FIXTURE).expect("the fixture is this contract");
        assert_eq!(built, fixture);

        let produced = serde_json::to_value(&built).expect("the built envelope");
        let expected: serde_json::Value =
            serde_json::from_str(SYNC_FIXTURE).expect("the shared fixture");
        assert_eq!(shape_of(&produced), shape_of(&expected));

        /* Nine keys, and the tenth absent rather than null: the server
        compares the key set exactly and a null is a present key. */
        let keys = produced
            .as_object()
            .expect("an object")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            keys,
            vec![
                "api_spend_samples",
                "client_version",
                "device_id",
                "event_id",
                "observed_at",
                "previous_sequence",
                "schema_version",
                "sequence",
                "usage_samples",
            ]
        );
        assert!(produced.get("api_balance_observations").is_none());
        assert_eq!(built.schema_version, 2);
        assert_eq!((built.previous_sequence, built.sequence), (41, 42));
        assert_eq!(built.usage_samples[1].window_id, "SEVEN_DAY_FABLE");

        /* Percentages and dollars sync. Credentials never do. */
        let text = SYNC_FIXTURE.to_ascii_lowercase();
        for forbidden in ["token", "secret", "password", "bearer", "cookie"] {
            assert!(!text.contains(forbidden));
        }
    }

    #[test]
    fn the_client_version_of_an_upload_is_this_build() {
        let envelope = build_envelope(
            EnvelopeIdentity {
                device_id: "9c1d4f60-2e83-4b17-8a5c-71e0d3f95b46",
                event_id: "3f7a2b18-5c94-4a6d-9f21-6b0d5c8e4a72",
                previous_sequence: 0,
                observed_at: "2026-09-07T12:00:00.000Z",
                client_version: client_version(),
            },
            fixture_envelope().usage_samples,
            Vec::new(),
        );
        assert_eq!(envelope.client_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(envelope.sequence, 1);
    }

    #[test]
    fn a_reading_later_than_its_own_envelope_is_pulled_back_to_it() {
        /* The server refuses a row observed after the envelope, and a clock
        that stepped between the cache write and this call is the ordinary way
        that happens. The reading is still worth uploading. */
        let mut sample = fixture_envelope().usage_samples[0].clone();
        sample.observed_at = "2026-09-07T12:00:01.000Z".to_string();
        let envelope = build_envelope(
            EnvelopeIdentity {
                device_id: "9c1d4f60-2e83-4b17-8a5c-71e0d3f95b46",
                event_id: "3f7a2b18-5c94-4a6d-9f21-6b0d5c8e4a72",
                previous_sequence: 0,
                observed_at: "2026-09-07T12:00:00.000Z",
                client_version: client_version(),
            },
            vec![sample],
            Vec::new(),
        );
        assert_eq!(envelope.usage_samples[0].observed_at, envelope.observed_at);
    }

    #[test]
    fn the_old_device_identifier_is_retired_for_a_uuid_and_the_cursor_starts_fresh() {
        /* The contract takes a UUID and nothing else, and this window used to
        mint `device_` and thirty two hex characters, so every upload an
        existing install ever made was refused before it was read. */
        let store = InMemorySecrets::new();
        let legacy = format!("device_{}", uuid::Uuid::new_v4().simple());
        store
            .store_secret(SYNC_DEVICE_CREDENTIAL_ID, &legacy)
            .expect("the identifier of an existing install");
        save_cursor(
            &store,
            &SyncCursor {
                version: SYNC_CURSOR_VERSION,
                device_id: legacy.clone(),
                sequence: 9,
                pending_event_id: None,
                pending_sequence: None,
                pending_observed_at: None,
                pending_digest: None,
            },
        )
        .expect("a cursor under the old identifier");

        let migrated = local_sync_device_id(&store).expect("a migrated identifier");
        assert!(is_sync_device_id(&migrated));
        assert!(!migrated.starts_with("device_"));
        /* Once, and then it is stable. */
        assert_eq!(
            local_sync_device_id(&store).expect("a stable identifier"),
            migrated
        );
        assert_eq!(
            store
                .read_secret(SYNC_DEVICE_CREDENTIAL_ID)
                .expect("the stored identifier")
                .as_str(),
            migrated
        );
        /* The old identifier is retired, not translated, so nothing it
        counted is inherited: the new device starts where the server's own
        cursor for it starts. */
        assert_eq!(load_cursor(&store, &migrated).sequence, 0);
        assert_eq!(load_cursor(&store, &legacy).sequence, 9);
    }

    /// The upload a cursor would have in flight, built the way sync builds it.
    fn pending_envelope(cursor: &SyncCursor, event_id: &str, observed_at: &str) -> SyncEnvelope {
        build_envelope(
            EnvelopeIdentity {
                device_id: &cursor.device_id,
                event_id,
                previous_sequence: cursor.sequence,
                observed_at,
                client_version: client_version(),
            },
            fixture_envelope().usage_samples,
            Vec::new(),
        )
    }

    #[test]
    fn the_sequence_advances_only_on_an_upload_the_server_accepted() {
        let cursor = SyncCursor::new("9c1d4f60-2e83-4b17-8a5c-71e0d3f95b46");
        let waiting = cursor.awaiting(&pending_envelope(
            &cursor,
            "3f7a2b18-5c94-4a6d-9f21-6b0d5c8e4a72",
            "2026-09-07T12:00:00.000Z",
        ));
        assert_eq!(waiting.sequence, 0);

        let accepted = cursor_after(
            &waiting,
            sync_outcome(
                200,
                &serde_json::json!({ "accepted": true, "sequence": 1 }),
                1,
            ),
        );
        assert_eq!(accepted.sequence, 1);
        assert_eq!(accepted.pending_event_id, None);
        assert_eq!(accepted.pending_sequence, None);

        /* Refused for pace: the event identifier is spent, so the next cycle
        mints a new one, but nothing was stored and the cursor stays put. */
        let paced = cursor_after(
            &waiting,
            sync_outcome(
                429,
                &serde_json::json!({ "accepted": false, "error": "rate_limited" }),
                1,
            ),
        );
        assert_eq!(paced.sequence, 0);
        assert_eq!(paced.pending_event_id, None);
    }

    #[test]
    fn a_cursor_mismatch_adopts_the_sequence_the_server_reports() {
        let cursor = SyncCursor {
            version: SYNC_CURSOR_VERSION,
            device_id: "9c1d4f60-2e83-4b17-8a5c-71e0d3f95b46".to_string(),
            sequence: 3,
            pending_event_id: Some("3f7a2b18-5c94-4a6d-9f21-6b0d5c8e4a72".to_string()),
            pending_sequence: Some(4),
            pending_observed_at: Some("2026-09-07T12:00:00.000Z".to_string()),
            pending_digest: Some("a".repeat(64)),
        };
        let outcome = sync_outcome(
            409,
            &serde_json::json!({ "error": "snapshot conflict", "current_sequence": 12 }),
            4,
        );
        assert_eq!(outcome, SyncOutcome::Reconcile(12));

        let reconciled = cursor_after(&cursor, outcome);
        assert_eq!(reconciled.sequence, 12);
        assert_eq!(reconciled.pending_event_id, None);

        let next = build_envelope(
            EnvelopeIdentity {
                device_id: &reconciled.device_id,
                event_id: "6d0b7c94-1a52-4e38-b9d7-2f4c8e17a05b",
                previous_sequence: reconciled.sequence,
                observed_at: "2026-09-07T12:00:00.000Z",
                client_version: client_version(),
            },
            fixture_envelope().usage_samples,
            Vec::new(),
        );
        assert_eq!((next.previous_sequence, next.sequence), (12, 13));

        /* A conflict the server put no number on leaves the cursor alone
        rather than guessing at one. */
        assert_eq!(
            sync_outcome(409, &serde_json::json!({ "error": "event conflict" }), 4),
            SyncOutcome::Conflict
        );
        assert_eq!(
            cursor_after(&cursor, SyncOutcome::Conflict).sequence,
            cursor.sequence
        );
    }

    #[test]
    fn a_lost_reply_keeps_the_event_identifier_and_the_sequence_for_the_retry() {
        /* An upload with no reply may or may not have landed, so the retry is
        the same upload: same event identifier, same sequence, same bytes. The
        server stores an event once and answers the second copy with the first
        answer. */
        let store = InMemorySecrets::new();
        let device_id = local_sync_device_id(&store).expect("an identifier");
        let base = load_cursor(&store, &device_id);
        let envelope = pending_envelope(
            &base,
            "3f7a2b18-5c94-4a6d-9f21-6b0d5c8e4a72",
            "2026-09-07T12:00:00.000Z",
        );
        let cursor = base.awaiting(&envelope);
        save_cursor(&store, &cursor).expect("the record of an upload in flight");

        let kept = cursor_after(&cursor, SyncOutcome::Unavailable);
        assert_eq!(kept, cursor);
        save_cursor(&store, &kept).expect("the record survives");
        let reloaded = load_cursor(&store, &device_id);
        assert_eq!(
            reloaded.pending_event_id.as_deref(),
            Some("3f7a2b18-5c94-4a6d-9f21-6b0d5c8e4a72")
        );
        assert_eq!(reloaded.pending_sequence, Some(1));
        assert_eq!(reloaded.sequence, 0);
        assert_eq!(
            sync_outcome(503, &serde_json::Value::Null, 1),
            SyncOutcome::Unavailable
        );

        /* The next cycle sends that same upload again, under the same event
        identifier, because the server deduplicates on it and answers the
        second copy with the answer it gave the first. */
        let now = instant("2026-09-07T12:04:00.000Z").expect("a clock");
        let resumed = resumable_upload(
            &reloaded,
            &fixture_envelope().usage_samples,
            &[],
            client_version(),
            now,
        )
        .expect("the same upload");
        assert_eq!(resumed, envelope);
        assert_eq!(resumed.event_id, "3f7a2b18-5c94-4a6d-9f21-6b0d5c8e4a72");
        assert_eq!(resumed.sequence, 1);
        assert_eq!(resumed.observed_at, "2026-09-07T12:00:00.000Z");
    }

    #[test]
    fn an_upload_whose_readings_moved_on_is_a_new_upload_rather_than_a_retry() {
        /* Reusing the identifier with different readings is refused by the
        server, which keys an event by its own digest, so the retry stops
        being a retry the moment the readings change and the cursor answer
        closes any gap instead. */
        let base = SyncCursor::new("9c1d4f60-2e83-4b17-8a5c-71e0d3f95b46");
        let envelope = pending_envelope(
            &base,
            "3f7a2b18-5c94-4a6d-9f21-6b0d5c8e4a72",
            "2026-09-07T12:00:00.000Z",
        );
        let cursor = base.awaiting(&envelope);
        let now = instant("2026-09-07T12:04:00.000Z").expect("a clock");

        let mut moved = fixture_envelope().usage_samples;
        moved[0].usage_percent = Some(31.0);
        assert_eq!(
            resumable_upload(&cursor, &moved, &[], client_version(), now),
            None
        );

        /* And an upload the server would refuse for age is abandoned rather
        than sent. */
        let stale_clock = instant("2026-09-08T11:30:00.000Z").expect("a clock");
        assert_eq!(
            resumable_upload(
                &cursor,
                &fixture_envelope().usage_samples,
                &[],
                client_version(),
                stale_clock
            ),
            None
        );
        /* So is one the cursor has already moved past. */
        let advanced = SyncCursor {
            sequence: 4,
            ..cursor.clone()
        };
        assert_eq!(
            resumable_upload(
                &advanced,
                &fixture_envelope().usage_samples,
                &[],
                client_version(),
                now
            ),
            None
        );
    }

    #[test]
    fn a_full_account_is_named_rather_than_a_sync_that_silently_never_happens() {
        let cursor = SyncCursor {
            version: SYNC_CURSOR_VERSION,
            device_id: "9c1d4f60-2e83-4b17-8a5c-71e0d3f95b46".to_string(),
            sequence: 3,
            pending_event_id: Some("3f7a2b18-5c94-4a6d-9f21-6b0d5c8e4a72".to_string()),
            pending_sequence: Some(4),
            pending_observed_at: Some("2026-09-07T12:00:00.000Z".to_string()),
            pending_digest: Some("a".repeat(64)),
        };
        let outcome = sync_outcome(
            409,
            &serde_json::json!({ "error": "device cap reached", "device_cap": 5 }),
            4,
        );
        assert_eq!(outcome, SyncOutcome::DeviceCapReached);
        /* Nothing was stored, so nothing advances, and the upload in flight
        is over rather than left to be retried forever. */
        let after = cursor_after(&cursor, outcome);
        assert_eq!(after.sequence, 3);
        assert_eq!(after.pending_event_id, None);
        assert_eq!(
            serde_json::to_value(AccountFailure::DeviceCapReached).expect("device cap failure"),
            serde_json::json!({ "kind": "device_cap_reached" })
        );
    }

    #[test]
    fn dollar_totals_travel_on_a_free_account_and_wait_for_the_feature_on_a_paid_one() {
        /* A free upload carries the account bearer alone and the surface
        takes the totals with it. An entitled upload is checked against the
        feature list its token carries, and one naming a feature the account
        does not hold is refused whole, percentages included. */
        assert!(spend_samples_allowed(false, false));
        assert!(spend_samples_allowed(false, true));
        assert!(!spend_samples_allowed(true, false));
        assert!(spend_samples_allowed(true, true));
    }

    #[test]
    fn the_cache_becomes_contract_rows_and_a_model_scoped_window_keeps_its_own() {
        let now = time::OffsetDateTime::parse(
            "2026-09-07T12:00:00Z",
            &time::format_description::well_known::Rfc3339,
        )
        .expect("a clock");
        let document = serde_json::json!({ "snapshots": [
            {
                "provider": "CLAUDE", "meter": "FIVE_HOUR", "unit": "PERCENT", "value": 27.5,
                "accountId": "claude-personal", "resetAt": "2026-09-07T14:00:00.000Z",
                "observedAt": "2026-09-07T11:59:30.000Z", "expiresAt": "2026-09-07T12:14:30.000Z"
            },
            {
                "provider": "CLAUDE", "meter": "FIVE_HOUR", "unit": "PERCENT", "value": 4.0,
                "accountId": "claude-personal", "resetAt": "2026-09-07T14:00:00.000Z",
                "observedAt": "2026-09-07T11:40:00.000Z", "expiresAt": "2026-09-07T11:55:00.000Z"
            },
            {
                "provider": "CLAUDE", "meter": "SEVEN_DAY_FABLE", "unit": "PERCENT", "value": 62.5,
                "accountId": "claude-personal", "resetAt": "2026-09-11T09:00:00.000Z",
                "observedAt": "2026-09-07T09:00:00.000Z", "expiresAt": "2026-09-07T09:15:00.000Z"
            },
            {
                "provider": "GROK", "meter": "SEVEN_DAY", "unit": "PERCENT", "value": 12.0,
                "accountId": "grok-personal", "resetAt": null,
                "observedAt": "2026-09-07T11:59:00.000Z", "expiresAt": "2026-09-07T12:14:00.000Z"
            },
            {
                "provider": "OPENROUTER", "meter": "CREDITS", "unit": "USD", "value": 40.9,
                "accountId": "openrouter-personal", "resetAt": null,
                "observedAt": "2026-09-07T11:59:00.000Z", "expiresAt": "2026-09-07T12:14:00.000Z"
            }
        ]});
        let configured = ["CLAUDE".to_string(), "OPENROUTER".to_string()]
            .into_iter()
            .collect::<HashSet<String>>();

        let rows =
            usage_samples_from_cache(&document, &configured, "2026-09-07T12:00:00.000Z", now)
                .expect("the rows of this cache");

        /* The model scoped window is a row of its own, because the current
        row on the server is unique per account, provider and meter: a window
        that shared a meter with the plain weekly one would overwrite it. */
        assert_eq!(
            rows.iter()
                .map(|row| row.meter.as_str())
                .collect::<Vec<_>>(),
            vec!["FIVE_HOUR", "SEVEN_DAY_FABLE"]
        );
        assert!(rows.iter().all(|row| row.window_id == row.meter));
        assert_eq!(rows[0].usage_percent, Some(27.5));
        assert_eq!(rows[0].account_id, "claude-personal");
        assert!(!rows[0].stale);
        /* Read three hours ago, past its own freshness window: it travels
        with the fact attached rather than as a fresh number. */
        assert!(rows[1].stale);
        /* A provider nobody configured, and a reading that is money rather
        than a percentage, are both absent. */
        assert!(rows.iter().all(|row| row.provider == "CLAUDE"));
    }

    #[test]
    fn the_entitlement_header_travels_only_when_this_device_holds_a_token() {
        /* Two authorities, two headers. The account bearer says who is
        asking and is always there, because a free account syncs its current
        percentages too. The entitlement header says which device inside that
        account, and a device that holds none says nothing rather than
        claiming one. */
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = client().expect("a client");
        let endpoint = "https://project.example.test/functions/v1/sync-snapshots";
        let payload = serde_json::to_vec(&fixture_envelope()).expect("an envelope");

        let free = sync_request(&http, endpoint, "account-bearer", None, payload.clone())
            .expect("the free request");
        assert_eq!(
            free.headers()[reqwest::header::AUTHORIZATION],
            "Bearer account-bearer"
        );
        assert!(free.headers().get("x-openlimiter-entitlement").is_none());

        let entitled = sync_request(
            &http,
            endpoint,
            "account-bearer",
            Some("device.entitlement.value"),
            payload,
        )
        .expect("the entitled request");
        assert_eq!(
            entitled.headers()[reqwest::header::AUTHORIZATION],
            "Bearer account-bearer"
        );
        assert_eq!(
            entitled.headers()["x-openlimiter-entitlement"],
            "device.entitlement.value"
        );

        /* An envelope larger than the surface reads is refused here rather
        than sent and rejected there. */
        assert!(matches!(
            sync_request(
                &http,
                endpoint,
                "account-bearer",
                None,
                vec![b'x'; SYNC_MAX_REQUEST_BYTES + 1]
            ),
            Err(AccountFailure::Storage)
        ));
    }

    #[test]
    fn pro_has_no_mirrored_supabase_session_record() {
        let legacy_key = concat!("openlimiter-pro-", "session");
        let account_source = include_str!("account.rs");
        let pro_source = include_str!("pro.rs");
        assert!(!account_source.contains(legacy_key));
        assert!(!pro_source.contains(legacy_key));
        let pro_implementation = pro_source
            .split("#[cfg(test)]")
            .next()
            .expect("production implementation");
        assert!(!pro_implementation.contains("refresh_token"));
    }
}
