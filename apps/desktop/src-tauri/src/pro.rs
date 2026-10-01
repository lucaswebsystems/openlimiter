use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::de::{DeserializeOwned, Error as _, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Map, Value};
use tauri::State;
use unicode_normalization::UnicodeNormalization as _;

use crate::credentials::{CredentialError, KeyringStore, SecretStore};

pub const PRO_RAILS_ENABLED: bool = true;
const CACHE_VERSION: u8 = 2;
const TRUST_VERSION: u8 = 2;
const TRUST_CREDENTIAL_ID: &str = "openlimiter-pro-trust";
const ENTITLEMENT_FILE_NAME: &str = "openlimiter-pro-entitlement.json";
pub const AGENT_CONTEXT_FILE_NAME: &str = "openlimiter-pro-agent-context.json";
pub const HOSTED_TRUST_FILE_NAME: &str = "hosted-trust.json";
pub const HOSTED_TRUST_SCHEMA: &str = "openlimiter.hosted_trust";
pub const HOSTED_TRUST_VERSION: u8 = 1;
const MAX_TOKEN_BYTES: usize = 32_768;
const MAX_REQUEST_BYTES: usize = 131_072;
const MAX_RESPONSE_BYTES: usize = 1_048_576;
const MAX_CONTEXT_BYTES: usize = 16_384;
const CLOCK_TOLERANCE_SECONDS: i64 = 300;
const TOKEN_LIFETIME_SECONDS: i64 = 24 * 60 * 60;
const TOKEN_REFRESH_AFTER_SECONDS: i64 = 12 * 60 * 60;
const TOKEN_HONOR_UNTIL_SECONDS: i64 = 72 * 60 * 60;
const NETWORK_TIMEOUT_SECONDS: u64 = 15;
const MAX_CONSECUTIVE_REFRESH_FAILURES: u16 = 360;
/// What this machine calls itself in the account's device list.
const DEVICE_LABEL: &str = "Desktop";
/* The production verifier key is public by design. Keeping the first key in
the binary makes offline entitlement checks work in an ordinary release
build, while OPENLIMITER_PRO_PUBLIC_KEYS remains an explicit build time
rotation mechanism. */
const EMBEDDED_PRO_PUBLIC_KEYS: &str = "primary:vd23tzc92JlUML1MG9zc84dEbsQDCx7eHODpFMCoCeQ";

fn configured_service_url() -> &'static str {
    option_env!("OPENLIMITER_PRO_URL").unwrap_or("")
}

fn configured_public_keys() -> &'static str {
    match option_env!("OPENLIMITER_PRO_PUBLIC_KEYS") {
        Some(configured) if !configured.is_empty() => configured,
        _ => EMBEDDED_PRO_PUBLIC_KEYS,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProFailure {
    Unconfigured,
    InvalidInput,
    NoSession,
    InvalidEntitlement,
    ClockInvalid,
    Storage,
    CredentialStore,
    Network,
    Service,
    EntitlementRequired,
    DeviceCapReached,
    TokenRequestExpired,
    StaleGrant,
}

impl fmt::Display for ProFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sentence = match self {
            ProFailure::Unconfigured => "the Pro service is not configured in this build",
            ProFailure::InvalidInput => "the Pro request is outside its accepted shape",
            ProFailure::NoSession => "no Pro session is stored on this machine",
            ProFailure::InvalidEntitlement => "the stored entitlement could not be verified",
            ProFailure::ClockInvalid => {
                "the local clock moved backwards and needs a server refresh"
            }
            ProFailure::Storage => "the Pro state could not be read or written",
            ProFailure::CredentialStore => "the system credential store refused the Pro session",
            ProFailure::Network => "the Pro service could not be reached",
            ProFailure::Service => "the Pro service returned an unusable response",
            ProFailure::EntitlementRequired => "the hosted service requires an active entitlement",
            ProFailure::DeviceCapReached => "the account already has five active device grants",
            ProFailure::StaleGrant => {
                "the Pro service no longer chains this device's tokens, so it needs a fresh sign in"
            }
            ProFailure::TokenRequestExpired => {
                "the Pro service let an undelivered refresh expire, so the next one starts anew"
            }
        };
        formatter.write_str(sentence)
    }
}

impl From<CredentialError> for ProFailure {
    fn from(error: CredentialError) -> Self {
        match error {
            CredentialError::NotFound => ProFailure::NoSession,
            CredentialError::Store => ProFailure::CredentialStore,
        }
    }
}

fn map_account_failure(error: crate::account::AccountFailure) -> ProFailure {
    match error {
        crate::account::AccountFailure::Unconfigured => ProFailure::Unconfigured,
        crate::account::AccountFailure::Network
        | crate::account::AccountFailure::OauthBusy
        | crate::account::AccountFailure::OauthTimeout => ProFailure::Network,
        crate::account::AccountFailure::Storage => ProFailure::CredentialStore,
        crate::account::AccountFailure::DeviceCapReached => ProFailure::DeviceCapReached,
        crate::account::AccountFailure::InvalidInput
        | crate::account::AccountFailure::Authentication
        | crate::account::AccountFailure::OauthRejected
        | crate::account::AccountFailure::ProviderDisabled
        | crate::account::AccountFailure::EmailConfirmationRequired => ProFailure::NoSession,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProEntitlementState {
    Unconfigured,
    Unlicensed,
    Active,
    RefreshDue,
    Grace,
    Expired,
    ClockInvalid,
    Invalid,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProStatus {
    pub rails_enabled: bool,
    pub state: ProEntitlementState,
    pub sequence: Option<u64>,
    pub expires_at: Option<i64>,
    pub grace_until: Option<i64>,
    pub refresh_after: Option<i64>,
    pub key_id: Option<String>,
    pub revocation_epoch: Option<u64>,
    pub device_id: Option<String>,
    pub plan_state: Option<String>,
    pub features: Vec<EntitlementFeature>,
    pub multi_account: bool,
    pub theme_preset: bool,
    pub device_cap: u8,
}

impl ProStatus {
    fn simple(state: ProEntitlementState) -> Self {
        Self {
            rails_enabled: PRO_RAILS_ENABLED,
            state,
            sequence: None,
            expires_at: None,
            grace_until: None,
            refresh_after: None,
            key_id: None,
            revocation_epoch: None,
            device_id: None,
            plan_state: None,
            features: Vec::new(),
            multi_account: false,
            theme_preset: false,
            device_cap: 5,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntitlementFeature {
    Alerts,
    ApiSpendBeta,
    History,
    MultiAccount,
    Routing,
    ThemePreset,
}

impl EntitlementFeature {
    const ALL: [Self; 6] = [
        Self::Alerts,
        Self::ApiSpendBeta,
        Self::History,
        Self::MultiAccount,
        Self::Routing,
        Self::ThemePreset,
    ];

    fn code(self) -> &'static str {
        match self {
            Self::Alerts => "alerts",
            Self::ApiSpendBeta => "api_spend_beta",
            Self::History => "history",
            Self::MultiAccount => "multi_account",
            Self::Routing => "routing",
            Self::ThemePreset => "theme_preset",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenHeader {
    alg: String,
    kid: String,
    typ: String,
}

/// The audience and scope a desktop token must carry.
///
/// The Pro service issues phone tokens beside desktop ones now, and the two
/// differ only in these two claims: a phone gets `aud` phone with `scope`
/// read, a desktop gets `aud` desktop with `scope` full. A read scoped token
/// authorises reading snapshots and nothing else, so it must never reach this
/// window as an entitlement, whatever features it happens to list.
const DESKTOP_AUDIENCE: &str = "desktop";
const DESKTOP_SCOPE: &str = "full";

/// What a token that predates the scope claim means.
///
/// Tokens minted before the phone pairing migration carry no `scope` at all
/// and were desktop tokens by construction, so an absent claim reads as the
/// full desktop scope. A phone token cannot slip through this door: it always
/// carries `scope` read explicitly, and it carries `aud` phone besides.
fn desktop_scope() -> String {
    DESKTOP_SCOPE.to_string()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EntitlementClaims {
    ver: u8,
    iss: String,
    aud: String,
    #[serde(default = "desktop_scope")]
    scope: String,
    sub: String,
    device_id: String,
    jti: String,
    seq: u64,
    iat: i64,
    nbf: i64,
    exp: i64,
    refresh_after: i64,
    grace_until: i64,
    server_time: i64,
    revocation_epoch: u64,
    features: Vec<EntitlementFeature>,
    plan_state: String,
    /* Null for a trial, and always present: the issuer writes the key either
    way, so a token missing it is not one the issuer made. */
    #[serde(deserialize_with = "Option::deserialize")]
    interval: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EntitlementCache {
    version: u8,
    token: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TrustState {
    version: u8,
    account_id: String,
    device_id: String,
    highest_sequence: u64,
    highest_revocation_epoch: u64,
    #[serde(default)]
    highest_context_sequence: u64,
    #[serde(default)]
    last_context_event_id: Option<String>,
    #[serde(default, alias = "trusted_server_time")]
    highest_server_time: i64,
    anchor_local_time: i64,
    #[serde(default)]
    consecutive_refresh_failures: u16,
    pending_request_id: Option<String>,
    pending_previous_jti: Option<String>,
    /* The jti the device grant on the server ends with, kept apart from the
    cached token so a cleared cache can still chain the next issue. A 2.0.2
    record has no such key and loads as none. */
    #[serde(default)]
    last_jti: Option<String>,
    /* Never written. A build that rotated devices briefly existed, and this
    record refuses unknown keys, so one that build saved still loads. */
    #[serde(default, skip_serializing)]
    #[allow(dead_code)]
    retired_device_id: Option<String>,
}

impl TrustState {
    fn new(account_id: String) -> Self {
        Self {
            version: TRUST_VERSION,
            account_id,
            device_id: uuid::Uuid::new_v4().to_string(),
            highest_sequence: 0,
            highest_revocation_epoch: 0,
            highest_context_sequence: 0,
            last_context_event_id: None,
            highest_server_time: 0,
            anchor_local_time: 0,
            consecutive_refresh_failures: 0,
            pending_request_id: None,
            pending_previous_jti: None,
            last_jti: None,
            retired_device_id: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProServiceInput {
    pub action: ProAction,
    #[serde(default)]
    pub payload: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProAction {
    AccountStatus,
    SaveNotificationPreference,
    ListNotificationPreferences,
    History,
    HostedContext,
    DeviceStatus,
    RenameDevice,
    RevokeDevice,
    RevokeOtherDevices,
}

impl ProAction {
    /// The function and the action name the server dispatches this on.
    ///
    /// Account and device management live on `entitlement`, which only needs
    /// the account bearer; the feature actions live on `pro-service`.
    fn route(self) -> (&'static str, &'static str) {
        match self {
            Self::AccountStatus | Self::DeviceStatus => ("/entitlement", "status"),
            Self::RenameDevice => ("/entitlement", "rename"),
            Self::RevokeDevice => ("/entitlement", "revoke"),
            Self::RevokeOtherDevices => ("/entitlement", "revoke_others"),
            Self::History => ("/pro-service", "history"),
            Self::SaveNotificationPreference => ("/pro-service", "save_notification_preference"),
            Self::ListNotificationPreferences => ("/pro-service", "list_notification_preferences"),
            Self::HostedContext => ("/pro-service", "hosted_context"),
        }
    }

    fn required_feature(self) -> Option<EntitlementFeature> {
        match self {
            Self::History => Some(EntitlementFeature::History),
            Self::SaveNotificationPreference | Self::ListNotificationPreferences => {
                Some(EntitlementFeature::Alerts)
            }
            Self::HostedContext => Some(EntitlementFeature::Routing),
            Self::AccountStatus
            | Self::DeviceStatus
            | Self::RenameDevice
            | Self::RevokeDevice
            | Self::RevokeOtherDevices => None,
        }
    }

    /// Whether the action needs a locally valid entitlement before it is sent.
    ///
    /// Only the feature actions do, and they also carry this device's token,
    /// because `authorizeHostedRequest` checks it against the live grant.
    /// Account status (how an account without Pro learns about its trial) and
    /// device management are not Pro, and the server asks only for the account.
    fn needs_entitlement(self) -> bool {
        self.required_feature().is_some()
    }
}

/// The device list in the shape the window renders: live grants only, with
/// `last_seen_at` in epoch milliseconds.
fn device_list(response: Value) -> Value {
    let devices = response
        .get("devices")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|row| row.get("revoked") == Some(&Value::Bool(false)))
        .filter_map(|row| {
            let id = row.get("device_id").and_then(Value::as_str)?;
            let seen = row
                .get("last_seen_at")
                .and_then(Value::as_str)
                .and_then(|value| {
                    time::OffsetDateTime::parse(
                        value,
                        &time::format_description::well_known::Rfc3339,
                    )
                    .ok()
                })
                .map(|instant| (instant.unix_timestamp_nanos() / 1_000_000) as i64);
            Some(json!({
                "id": id,
                "name": row.get("label").and_then(Value::as_str).unwrap_or(id),
                "current": row.get("is_current") == Some(&Value::Bool(true)),
                "last_seen_at": seen,
            }))
        })
        .collect::<Vec<_>>();
    json!({ "devices": devices })
}

/// Whether a hosted answer costs this machine its entitlement token.
///
/// Only revoking this very device does. A refusal of a feature action never
/// does: the token stays until the issuer itself refuses a refresh.
fn clears_local_token(
    action: ProAction,
    revokes_current_device: bool,
    result: &Result<Value, ProFailure>,
) -> bool {
    action == ProAction::RevokeDevice && revokes_current_device && result.is_ok()
}

/// What a 409 from `/entitlement` means, from its body (`functions/entitlement`).
/// Only the real cap is the cap.
fn entitlement_conflict(body: &Value) -> ProFailure {
    match body.get("error").and_then(Value::as_str) {
        Some("device cap reached") => ProFailure::DeviceCapReached,
        Some("token request expired") => ProFailure::TokenRequestExpired,
        Some("stale entitlement token" | "entitlement epoch changed") => ProFailure::StaleGrant,
        _ => ProFailure::Service,
    }
}

/// The envelope to keep when several usage accounts answered.
///
/// The agent hook reads one envelope, so it gets the account under the most
/// pressure; on a tie, the first account in order.
fn most_pressing_context(contexts: Vec<String>) -> Option<String> {
    let pressure = |text: &str| {
        serde_json::from_str::<HostedContextEnvelope>(text)
            .map(|envelope| {
                envelope
                    .payload
                    .meters
                    .iter()
                    .map(|meter| match meter.level.as_str() {
                        "90" => 3,
                        "80" => 2,
                        "60" => 1,
                        _ => 0,
                    })
                    .max()
                    .unwrap_or(0)
            })
            .unwrap_or(0)
    };
    let mut kept: Option<(u8, String)> = None;
    for text in contexts {
        let level = pressure(&text);
        if kept.as_ref().is_none_or(|(top, _)| level > *top) {
            kept = Some((level, text));
        }
    }
    kept.map(|(_, text)| text)
}

/// The hosted path and body one service action is sent as.
fn service_request(
    action: ProAction,
    mut payload: Map<String, Value>,
    device_id: &str,
) -> (&'static str, Value) {
    let (path, name) = action.route();
    let mut scope = |key: &str, value: &str| {
        payload.insert(key.to_string(), Value::String(value.to_string()));
    };
    match action {
        /* The current device is marked in the list, and is the one kept. */
        ProAction::DeviceStatus | ProAction::RevokeOtherDevices => scope("device_id", device_id),
        ProAction::HostedContext => scope("device_id", device_id),
        _ => {}
    }
    payload.insert("action".to_string(), Value::String(name.to_string()));
    (path, Value::Object(payload))
}

impl EntitlementClaims {
    /// Whether this token authorises this window rather than a paired phone.
    fn is_desktop(&self) -> bool {
        self.aud == DESKTOP_AUDIENCE && self.scope == DESKTOP_SCOPE
    }
}

struct VerifiedToken {
    header: TokenHeader,
    claims: EntitlementClaims,
}

fn now_seconds() -> Result<i64, ProFailure> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ProFailure::ClockInvalid)?;
    i64::try_from(duration.as_secs()).map_err(|_| ProFailure::ClockInvalid)
}

fn state_file(name: &str) -> Result<PathBuf, ProFailure> {
    crate::state::state_directory()
        .map(|directory| directory.join(name))
        .ok_or(ProFailure::Storage)
}

fn read_cache() -> Result<Option<EntitlementCache>, ProFailure> {
    let path = state_file(ENTITLEMENT_FILE_NAME)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = crate::fsx::bounded_read(&path).ok_or(ProFailure::Storage)?;
    if text.len() > MAX_TOKEN_BYTES {
        return Err(ProFailure::InvalidEntitlement);
    }
    let cache: EntitlementCache =
        serde_json::from_str(&text).map_err(|_| ProFailure::InvalidEntitlement)?;
    if cache.version != CACHE_VERSION || cache.token.len() > MAX_TOKEN_BYTES {
        return Err(ProFailure::InvalidEntitlement);
    }
    Ok(Some(cache))
}

fn write_cache(token: &str) -> Result<(), ProFailure> {
    if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
        return Err(ProFailure::InvalidEntitlement);
    }
    let path = state_file(ENTITLEMENT_FILE_NAME)?;
    let parent = path.parent().ok_or(ProFailure::Storage)?;
    crate::fsx::ensure_private_dir(parent).map_err(|_| ProFailure::Storage)?;
    let text = serde_json::to_string(&EntitlementCache {
        version: CACHE_VERSION,
        token: token.to_string(),
    })
    .map_err(|_| ProFailure::Storage)?;
    crate::fsx::atomic_write(&path, &text).map_err(|_| ProFailure::Storage)
}

fn entitlement_commit_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostedTrustDocument {
    pub schema: String,
    pub version: u8,
    pub account_id: String,
    pub device_id: String,
    pub entitlement_epoch: u64,
    pub last_verified_sequence: u64,
    pub routing_state: String,
    pub pinned_public_key_ids: Vec<String>,
}

pub fn hosted_trust_path() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        let base = crate::state::non_empty("APPDATA")
            .or_else(|| crate::state::home().map(|path| path.join("AppData").join("Roaming")))?;
        return Some(base.join("OpenLimiter").join(HOSTED_TRUST_FILE_NAME));
    }
    if cfg!(target_os = "macos") {
        return Some(
            crate::state::home()?
                .join("Library")
                .join("Application Support")
                .join("OpenLimiter")
                .join(HOSTED_TRUST_FILE_NAME),
        );
    }
    let base = crate::state::non_empty("XDG_CONFIG_HOME")
        .or_else(|| crate::state::home().map(|path| path.join(".config")))?;
    Some(base.join("openlimiter").join(HOSTED_TRUST_FILE_NAME))
}

pub fn write_hosted_trust_to_path(
    path: &std::path::Path,
    account_id: &str,
    device_id: &str,
    entitlement_epoch: u64,
    last_verified_sequence: u64,
    routing_enabled: bool,
    key_ids: &[String],
) -> Result<(), ProFailure> {
    if account_id.is_empty()
        || account_id.len() > 80
        || !account_id
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        || !account_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(ProFailure::InvalidInput);
    }
    if uuid::Uuid::parse_str(device_id).is_err() {
        return Err(ProFailure::InvalidInput);
    }
    let mut sorted_keys = key_ids.to_vec();
    sorted_keys.sort();
    sorted_keys.dedup();
    if sorted_keys.is_empty() || sorted_keys.len() > 8 {
        return Err(ProFailure::InvalidInput);
    }
    for key_id in &sorted_keys {
        if key_id.is_empty()
            || key_id.len() > 64
            || !key_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        {
            return Err(ProFailure::InvalidInput);
        }
    }
    let parent = path.parent().ok_or(ProFailure::Storage)?;
    crate::fsx::ensure_private_dir(parent).map_err(|_| ProFailure::Storage)?;
    let document = HostedTrustDocument {
        schema: HOSTED_TRUST_SCHEMA.to_string(),
        version: HOSTED_TRUST_VERSION,
        account_id: account_id.to_string(),
        device_id: device_id.to_string(),
        entitlement_epoch,
        last_verified_sequence: last_verified_sequence.max(1),
        routing_state: if routing_enabled {
            "enabled"
        } else {
            "disabled"
        }
        .to_string(),
        pinned_public_key_ids: sorted_keys,
    };
    let json_text = serde_json::to_string(&document).map_err(|_| ProFailure::Storage)?;
    crate::fsx::atomic_write(path, &json_text).map_err(|_| ProFailure::Storage)?;
    Ok(())
}

fn write_hosted_trust(
    account_id: &str,
    device_id: &str,
    entitlement_epoch: u64,
    last_verified_sequence: u64,
    routing_enabled: bool,
    key_ids: &[String],
) -> Result<(), ProFailure> {
    #[cfg(not(test))]
    {
        let Some(path) = hosted_trust_path() else {
            return Err(ProFailure::Storage);
        };
        write_hosted_trust_to_path(
            &path,
            account_id,
            device_id,
            entitlement_epoch,
            last_verified_sequence,
            routing_enabled,
            key_ids,
        )?;
    }
    #[cfg(test)]
    {
        let _ = (
            account_id,
            device_id,
            entitlement_epoch,
            last_verified_sequence,
            routing_enabled,
            key_ids,
        );
    }
    Ok(())
}

fn remove_state_file(name: &str) -> Result<(), ProFailure> {
    #[cfg(not(test))]
    {
        let path = state_file(name)?;
        if path.exists() {
            std::fs::remove_file(path).map_err(|_| ProFailure::Storage)?;
        }
    }
    #[cfg(test)]
    let _ = name;
    Ok(())
}

fn remove_hosted_trust() -> Result<(), ProFailure> {
    #[cfg(not(test))]
    {
        if let Some(path) = hosted_trust_path() {
            if path.exists() {
                std::fs::remove_file(path).map_err(|_| ProFailure::Storage)?;
            }
        }
    }
    Ok(())
}

fn clear_entitlement_and_context() -> Result<(), ProFailure> {
    let entitlement_cleared = remove_state_file(ENTITLEMENT_FILE_NAME);
    let context_cleared = remove_state_file(AGENT_CONTEXT_FILE_NAME);
    let trust_cleared = remove_hosted_trust();
    entitlement_cleared?;
    context_cleared?;
    trust_cleared
}

pub(crate) fn clear_local_authorization(store: &dyn SecretStore) -> Result<(), ProFailure> {
    let trust_cleared: Result<(), ProFailure> = match store.delete_secret(TRUST_CREDENTIAL_ID) {
        Ok(()) | Err(CredentialError::NotFound) => Ok(()),
        Err(error) => Err(error.into()),
    };
    let files_cleared = clear_entitlement_and_context();
    trust_cleared?;
    files_cleared
}

fn load_trust(store: &dyn SecretStore, account_id: &str) -> Result<TrustState, ProFailure> {
    if !crate::account::is_valid_account_id(account_id) {
        return Err(ProFailure::NoSession);
    }
    match store.read_secret(TRUST_CREDENTIAL_ID) {
        Ok(raw) => {
            let parsed = serde_json::from_str::<TrustState>(&raw);
            let trust = match parsed {
                Ok(value) => value,
                Err(_) => {
                    let trust = TrustState::new(account_id.to_string());
                    save_trust(store, &trust)?;
                    return Ok(trust);
                }
            };
            if trust.version != TRUST_VERSION
                || trust.account_id != account_id
                || uuid::Uuid::parse_str(&trust.device_id).is_err()
            {
                return Err(ProFailure::CredentialStore);
            }
            Ok(trust)
        }
        Err(CredentialError::NotFound) => {
            let trust = TrustState::new(account_id.to_string());
            save_trust(store, &trust)?;
            Ok(trust)
        }
        Err(error) => Err(error.into()),
    }
}

fn save_trust(store: &dyn SecretStore, trust: &TrustState) -> Result<(), ProFailure> {
    let text = serde_json::to_string(trust).map_err(|_| ProFailure::CredentialStore)?;
    store
        .store_secret(TRUST_CREDENTIAL_ID, &text)
        .map_err(ProFailure::from)
}

fn parse_key_set(configured: &str) -> Result<HashMap<String, VerifyingKey>, ProFailure> {
    if configured.is_empty() {
        return Err(ProFailure::Unconfigured);
    }
    let mut keys = HashMap::new();
    for item in configured.split(',') {
        let Some((key_id, encoded)) = item.split_once(':') else {
            return Err(ProFailure::Unconfigured);
        };
        if key_id.is_empty()
            || key_id.len() > 32
            || !key_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '.')
            })
        {
            return Err(ProFailure::Unconfigured);
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| ProFailure::Unconfigured)?;
        let array: [u8; 32] = bytes.try_into().map_err(|_| ProFailure::Unconfigured)?;
        let key = VerifyingKey::from_bytes(&array).map_err(|_| ProFailure::Unconfigured)?;
        if keys.insert(key_id.to_string(), key).is_some() {
            return Err(ProFailure::Unconfigured);
        }
    }
    if keys.is_empty() {
        return Err(ProFailure::Unconfigured);
    }
    Ok(keys)
}

fn key_set() -> Result<HashMap<String, VerifyingKey>, ProFailure> {
    parse_key_set(configured_public_keys())
}

fn decode_segment(segment: &str, maximum: usize) -> Result<Vec<u8>, ProFailure> {
    if segment.is_empty() || segment.len() > maximum {
        return Err(ProFailure::InvalidEntitlement);
    }
    URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| ProFailure::InvalidEntitlement)
}

fn strict_json<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ProFailure> {
    let value = serde_json::from_slice::<StrictValue>(bytes)
        .map(|value| value.0)
        .map_err(|_| ProFailure::InvalidEntitlement)?;
    serde_json::from_value(value).map_err(|_| ProFailure::InvalidEntitlement)
}

fn verify_token(raw: &str) -> Result<VerifiedToken, ProFailure> {
    verify_token_with_keys(raw, &key_set()?)
}

fn verify_token_with_keys(
    raw: &str,
    keys: &HashMap<String, VerifyingKey>,
) -> Result<VerifiedToken, ProFailure> {
    if raw.is_empty() || raw.len() > MAX_TOKEN_BYTES {
        return Err(ProFailure::InvalidEntitlement);
    }
    let mut segments = raw.split('.');
    let header_segment = segments.next().ok_or(ProFailure::InvalidEntitlement)?;
    let payload_segment = segments.next().ok_or(ProFailure::InvalidEntitlement)?;
    let signature_segment = segments.next().ok_or(ProFailure::InvalidEntitlement)?;
    if segments.next().is_some() {
        return Err(ProFailure::InvalidEntitlement);
    }
    let header: TokenHeader = strict_json(&decode_segment(header_segment, 1_024)?)?;
    if header.alg != "EdDSA" || header.typ != "OLP2" {
        return Err(ProFailure::InvalidEntitlement);
    }
    let key = keys
        .get(&header.kid)
        .ok_or(ProFailure::InvalidEntitlement)?;
    let signature_bytes = decode_segment(signature_segment, 256)?;
    let signature =
        Signature::from_slice(&signature_bytes).map_err(|_| ProFailure::InvalidEntitlement)?;
    let signing_input = format!("{header_segment}.{payload_segment}");
    key.verify_strict(signing_input.as_bytes(), &signature)
        .map_err(|_| ProFailure::InvalidEntitlement)?;
    let claims: EntitlementClaims = strict_json(&decode_segment(payload_segment, 16_384)?)?;
    validate_claim_shape(&claims)?;
    Ok(VerifiedToken { header, claims })
}

fn validate_claim_shape(claims: &EntitlementClaims) -> Result<(), ProFailure> {
    let offset = |instant: i64| {
        instant
            .checked_sub(claims.iat)
            .ok_or(ProFailure::InvalidEntitlement)
    };
    let refresh = offset(claims.refresh_after)?;
    let lifetime = offset(claims.exp)?;
    let honor = offset(claims.grace_until)?;
    let skew = offset(claims.server_time)?;
    let early = claims
        .iat
        .checked_sub(claims.nbf)
        .ok_or(ProFailure::InvalidEntitlement)?;
    /* The issuer clips every deadline at the end of paid or trial access, so
    near that end refresh and expiry collapse onto grace. There is no access
    end claim and none is inferred here: the signature authenticates the
    clipped deadlines, and these rules pin them to exactly what the issuer
    computes from one. */
    let deadlines_valid = 0 < refresh
        && refresh <= lifetime
        && lifetime <= honor
        && honor <= TOKEN_HONOR_UNTIL_SECONDS
        && refresh == TOKEN_REFRESH_AFTER_SECONDS.min(honor)
        && lifetime == TOKEN_LIFETIME_SECONDS.min(honor);
    let interval_valid = match claims.interval.as_deref() {
        Some("monthly" | "annual") => true,
        None => matches!(claims.plan_state.as_str(), "trialing" | "comped"),
        Some(_) => false,
    };
    /* The issuer gives a comp an access end of now plus the full grace, so a
    comped token is never clipped. */
    let comp_valid = claims.plan_state != "comped" || honor == TOKEN_HONOR_UNTIL_SECONDS;
    let sorted_features = claims
        .features
        .windows(2)
        .all(|pair| pair[0].code() < pair[1].code());
    if claims.ver != 2
        || claims.iss != "openlimiter-pro"
        || !claims.is_desktop()
        || uuid::Uuid::parse_str(&claims.sub).is_err()
        || uuid::Uuid::parse_str(&claims.jti).is_err()
        || uuid::Uuid::parse_str(&claims.device_id).is_err()
        || claims.seq == 0
        || !deadlines_valid
        || !(0..=CLOCK_TOLERANCE_SECONDS).contains(&early)
        || skew.unsigned_abs() > CLOCK_TOLERANCE_SECONDS.unsigned_abs()
        || !sorted_features
        || claims.features.as_slice() != EntitlementFeature::ALL
        || !matches!(
            claims.plan_state.as_str(),
            "trialing" | "active" | "past_due" | "comped"
        )
        || !interval_valid
        || !comp_valid
    {
        return Err(ProFailure::InvalidEntitlement);
    }
    Ok(())
}

fn effective_time(trust: &TrustState, local_now: i64) -> Result<i64, ProFailure> {
    if trust.anchor_local_time == 0 || trust.highest_server_time == 0 {
        return Ok(local_now);
    }
    if local_now.saturating_add(CLOCK_TOLERANCE_SECONDS) < trust.anchor_local_time
        || local_now.saturating_add(CLOCK_TOLERANCE_SECONDS) < trust.highest_server_time
    {
        return Err(ProFailure::ClockInvalid);
    }
    let elapsed = local_now.saturating_sub(trust.anchor_local_time).max(0);
    Ok(trust.highest_server_time.saturating_add(elapsed))
}

fn status_for(
    token: &VerifiedToken,
    trust: &TrustState,
    local_now: i64,
) -> Result<ProStatus, ProFailure> {
    if token.claims.sub != trust.account_id
        || token.claims.device_id != trust.device_id
        || token.claims.seq < trust.highest_sequence
        || token.claims.revocation_epoch < trust.highest_revocation_epoch
    {
        return Err(ProFailure::InvalidEntitlement);
    }
    let effective = effective_time(trust, local_now)?;
    let state = if trust.consecutive_refresh_failures >= MAX_CONSECUTIVE_REFRESH_FAILURES {
        ProEntitlementState::Expired
    } else if effective < token.claims.nbf {
        ProEntitlementState::Invalid
    } else if effective >= token.claims.grace_until {
        /* First, because a clipped token's refresh and expiry sit on grace:
        access ends at that instant, not one second after it. */
        ProEntitlementState::Expired
    } else if effective <= token.claims.refresh_after {
        ProEntitlementState::Active
    } else if effective <= token.claims.exp {
        ProEntitlementState::RefreshDue
    } else {
        ProEntitlementState::Grace
    };
    let locally_entitled = token.claims.is_desktop()
        && matches!(
            state,
            ProEntitlementState::Active
                | ProEntitlementState::RefreshDue
                | ProEntitlementState::Grace
        );
    let features = if locally_entitled {
        token.claims.features.clone()
    } else {
        Vec::new()
    };
    Ok(ProStatus {
        rails_enabled: PRO_RAILS_ENABLED,
        state,
        sequence: Some(token.claims.seq),
        expires_at: Some(token.claims.exp),
        grace_until: Some(token.claims.grace_until),
        refresh_after: Some(token.claims.refresh_after),
        key_id: Some(token.header.kid.clone()),
        revocation_epoch: Some(token.claims.revocation_epoch),
        device_id: Some(token.claims.device_id.clone()),
        plan_state: Some(token.claims.plan_state.clone()),
        multi_account: features.contains(&EntitlementFeature::MultiAccount),
        theme_preset: features.contains(&EntitlementFeature::ThemePreset),
        device_cap: 5,
        features,
    })
}

fn reconcile_cached_token(
    store: &dyn SecretStore,
    trust: &mut TrustState,
    token: &VerifiedToken,
) -> Result<(), ProFailure> {
    if token.claims.sub != trust.account_id
        || token.claims.device_id != trust.device_id
        || token.claims.seq < trust.highest_sequence
        || token.claims.revocation_epoch < trust.highest_revocation_epoch
    {
        return Err(ProFailure::InvalidEntitlement);
    }
    if token.claims.seq == trust.highest_sequence {
        return if token.claims.revocation_epoch == trust.highest_revocation_epoch {
            Ok(())
        } else {
            Err(ProFailure::InvalidEntitlement)
        };
    }
    if trust.pending_request_id.is_none() {
        return Err(ProFailure::InvalidEntitlement);
    }
    adopt_token(trust, &token.claims, now_seconds()?);
    save_trust(store, trust)
}

/// Record a token this machine has just accepted.
///
/// A replayed token, or the same claims handed back for a retried request,
/// carries the server time of its first issue. Re-anchoring the clock to it
/// would wind the effective time back and restart that token's lifetime, so
/// the effective time only moves forward. The forward carry lives in the
/// anchor, never in `highest_server_time`, which stays a pure server maximum:
/// a local clock that ran ahead and is put right sheds the carry with it
/// instead of tripping the rollback guard. Only a newer sequence resets the
/// failure allowance.
fn adopt_token(trust: &mut TrustState, claims: &EntitlementClaims, local_now: i64) {
    let carried = if trust.anchor_local_time == 0 || trust.highest_server_time == 0 {
        claims.server_time
    } else {
        trust
            .highest_server_time
            .saturating_add(local_now.saturating_sub(trust.anchor_local_time).max(0))
    };
    let server_floor = trust.highest_server_time.max(claims.server_time);
    let effective = carried.max(claims.server_time);
    if claims.seq > trust.highest_sequence {
        trust.consecutive_refresh_failures = 0;
    }
    trust.highest_sequence = trust.highest_sequence.max(claims.seq);
    trust.highest_revocation_epoch = trust.highest_revocation_epoch.max(claims.revocation_epoch);
    trust.highest_server_time = server_floor;
    trust.anchor_local_time = local_now.saturating_sub(effective.saturating_sub(server_floor));
    trust.last_jti = Some(claims.jti.clone());
    trust.pending_request_id = None;
    trust.pending_previous_jti = None;
}

fn current_status(store: &dyn SecretStore) -> ProStatus {
    let _ = maintain_hosted_context(store);
    current_status_inner(store)
}

fn current_status_inner(store: &dyn SecretStore) -> ProStatus {
    if configured_service_url().is_empty() || key_set().is_err() {
        return ProStatus::simple(ProEntitlementState::Unconfigured);
    }
    let account_id = match crate::account::active_account_id(store) {
        Ok(value) => value,
        Err(_) => return ProStatus::simple(ProEntitlementState::Unlicensed),
    };
    let mut trust = match load_trust(store, &account_id) {
        Ok(value) => value,
        Err(_) => {
            let _ = clear_entitlement_and_context();
            return ProStatus::simple(ProEntitlementState::Invalid);
        }
    };
    let cache = match read_cache() {
        Ok(Some(value)) => value,
        Ok(None) => return ProStatus::simple(ProEntitlementState::Unlicensed),
        Err(_) => {
            let _ = clear_entitlement_and_context();
            return ProStatus::simple(ProEntitlementState::Invalid);
        }
    };
    let token = match verify_token(&cache.token) {
        Ok(value) => value,
        Err(ProFailure::Unconfigured) => {
            return ProStatus::simple(ProEntitlementState::Unconfigured)
        }
        Err(_) => {
            let _ = clear_entitlement_and_context();
            return ProStatus::simple(ProEntitlementState::Invalid);
        }
    };
    if reconcile_cached_token(store, &mut trust, &token).is_err() {
        let _ = clear_entitlement_and_context();
        return ProStatus::simple(ProEntitlementState::Invalid);
    }
    match now_seconds().and_then(|now| status_for(&token, &trust, now)) {
        Ok(status) => {
            if matches!(
                status.state,
                ProEntitlementState::Expired
                    | ProEntitlementState::Invalid
                    | ProEntitlementState::ClockInvalid
            ) {
                let _ = remove_state_file(AGENT_CONTEXT_FILE_NAME);
                let _ = remove_hosted_trust();
            }
            status
        }
        Err(ProFailure::ClockInvalid) => {
            let _ = remove_state_file(AGENT_CONTEXT_FILE_NAME);
            let _ = remove_hosted_trust();
            ProStatus::simple(ProEntitlementState::ClockInvalid)
        }
        Err(_) => {
            let _ = clear_entitlement_and_context();
            ProStatus::simple(ProEntitlementState::Invalid)
        }
    }
}

/// Whether this machine may raise a native alert right now.
///
/// Every notification is a Pro capability, so this is the one question the
/// notification evaluator asks before it queues a toast. It follows the same
/// honour policy the local feature gate above follows: a valid signed grace
/// token keeps alerts, and malformed, expired, revoked or clock invalid state
/// falls back to Free without deleting a single stored event.
pub(crate) fn alerts_enabled(store: &dyn SecretStore) -> bool {
    current_status(store)
        .features
        .contains(&EntitlementFeature::Alerts)
}

pub(crate) fn multi_account_enabled(store: &dyn SecretStore) -> bool {
    /* This is deliberately an honor policy for local features, not invasive
    tamper resistance. A valid signed grace token keeps its local feature;
    malformed, expired, revoked, or clock invalid state falls back to Free
    without deleting a connection, credential, or history row. */
    current_status(store).multi_account
}

/// Whether this machine's entitlement permits hosted API spend sync.
///
/// Local API spend tracking is available to every account. The hosted surface
/// remains a Pro feature, so a valid signed grace token enables its sync row;
/// malformed, expired, revoked or clock invalid state leaves the row local.
pub(crate) fn api_spend_sync_enabled() -> bool {
    current_status(&KeyringStore)
        .features
        .contains(&EntitlementFeature::ApiSpendBeta)
}

fn endpoint(path: &str) -> Result<reqwest::Url, ProFailure> {
    let base = configured_service_url().trim_end_matches('/');
    if base.is_empty() || !path.starts_with('/') || path.contains("..") {
        return Err(ProFailure::Unconfigured);
    }
    let url =
        reqwest::Url::parse(&format!("{base}{path}")).map_err(|_| ProFailure::Unconfigured)?;
    if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
        return Err(ProFailure::Unconfigured);
    }
    Ok(url)
}

fn network_client() -> Result<reqwest::Client, ProFailure> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(NETWORK_TIMEOUT_SECONDS))
        .build()
        .map_err(|_| ProFailure::Network)
}

struct StrictValue(Value);

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct StrictVisitor;

        impl<'de> Visitor<'de> for StrictVisitor {
            type Value = StrictValue;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("strict JSON without duplicate keys")
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Bool(value)))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Number(value.into())))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Number(value.into())))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                serde_json::Number::from_f64(value)
                    .map(Value::Number)
                    .map(StrictValue)
                    .ok_or_else(|| E::custom("nonfinite JSON number"))
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                self.visit_string(value.to_string())
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::String(value)))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Null))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Null))
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: Deserializer<'de>,
            {
                StrictValue::deserialize(deserializer)
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<StrictValue>()? {
                    values.push(value.0);
                }
                Ok(StrictValue(Value::Array(values)))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut values = Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(A::Error::custom("duplicate JSON key"));
                    }
                    values.insert(key, map.next_value::<StrictValue>()?.0);
                }
                Ok(StrictValue(Value::Object(values)))
            }
        }

        deserializer.deserialize_any(StrictVisitor)
    }
}

async fn post_json(path: &str, access_token: &str, payload: &Value) -> Result<Value, ProFailure> {
    post_signed_json(path, access_token, None, payload).await
}

/// The one request shape, with the device token attached when the endpoint
/// wants it.
///
/// `/pair-device` authorises the desktop twice over: the Supabase bearer says
/// which account is asking, and `x-openlimiter-entitlement` says which device
/// inside it. Sending the second only where it is required keeps every other
/// call exactly as narrow as it was.
async fn post_signed_json(
    path: &str,
    access_token: &str,
    entitlement: Option<&str>,
    payload: &Value,
) -> Result<Value, ProFailure> {
    let body = serde_json::to_vec(payload).map_err(|_| ProFailure::InvalidInput)?;
    if body.len() > MAX_REQUEST_BYTES {
        return Err(ProFailure::InvalidInput);
    }
    let mut request = network_client()?
        .post(endpoint(path)?)
        .bearer_auth(access_token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(token) = entitlement {
        if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
            return Err(ProFailure::InvalidEntitlement);
        }
        request = request.header("x-openlimiter-entitlement", token);
    }
    let response = request
        .body(body)
        .send()
        .await
        .map_err(|_| ProFailure::Network)?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(ProFailure::NoSession);
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err(ProFailure::EntitlementRequired);
    }
    let conflict = status == reqwest::StatusCode::CONFLICT && path == "/entitlement";
    if !status.is_success() && !conflict {
        return Err(ProFailure::Service);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(ProFailure::Service);
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ProFailure::Network)? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(ProFailure::Service);
        }
        bytes.extend_from_slice(&chunk);
    }
    let parsed = serde_json::from_slice::<StrictValue>(&bytes)
        .map(|value| value.0)
        .map_err(|_| ProFailure::Service);
    if conflict {
        return Err(entitlement_conflict(&parsed.unwrap_or(Value::Null)));
    }
    parsed
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HostedContextSource {
    kind: String,
    event_id: String,
    sequence: u64,
    observed_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HostedContextMeter {
    provider: String,
    meter: String,
    level: String,
    reset_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HostedRoutingHint {
    kind: String,
    provider: String,
    reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HostedContextPayload {
    meters: Vec<HostedContextMeter>,
    routing_hints: Vec<HostedRoutingHint>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HostedContextEnvelope {
    schema: String,
    version: u8,
    kid: String,
    generated_at: String,
    expires_at: String,
    account_id: String,
    device_id: String,
    revocation_epoch: u64,
    source: HostedContextSource,
    payload: HostedContextPayload,
    signature: String,
}

fn context_time(value: &str) -> Result<i64, ProFailure> {
    if value.len() > 64 {
        return Err(ProFailure::Service);
    }
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .map(|value| value.unix_timestamp())
        .map_err(|_| ProFailure::Service)
}

fn valid_context_provider(value: &str) -> bool {
    matches!(
        value,
        "anthropic"
            | "claude"
            | "codex"
            | "gemini"
            | "kimi"
            | "manual"
            | "openai"
            | "opencode"
            | "openrouter"
            | "xai"
    )
}

fn canonical_context(envelope: &HostedContextEnvelope) -> Result<Vec<u8>, ProFailure> {
    let mut value = serde_json::to_value(envelope).map_err(|_| ProFailure::Service)?;
    value
        .as_object_mut()
        .and_then(|object| object.remove("signature"))
        .ok_or(ProFailure::Service)?;
    let canonical = serde_json::to_vec(&value).map_err(|_| ProFailure::Service)?;
    if canonical.len() > 12_288 {
        return Err(ProFailure::Service);
    }
    Ok(canonical)
}

fn validate_hosted_context(
    value: &Value,
    store: &dyn SecretStore,
    scope: Option<&str>,
) -> Result<String, ProFailure> {
    let keys = key_set()?;
    validate_hosted_context_with_keys(value, store, &keys, now_seconds()?, scope)
}

fn maintain_hosted_context(store: &dyn SecretStore) -> Result<bool, ProFailure> {
    let path = state_file(AGENT_CONTEXT_FILE_NAME)?;
    if !path.exists() {
        return Ok(false);
    }
    let validated = crate::fsx::bounded_read(&path)
        .ok_or(ProFailure::Storage)
        .and_then(|raw| {
            serde_json::from_str::<StrictValue>(&raw)
                .map(|value| value.0)
                .map_err(|_| ProFailure::InvalidEntitlement)
        })
        .and_then(|value| validate_hosted_context(&value, store, None));
    match validated {
        Ok(canonical) => {
            let current = crate::fsx::bounded_read(&path).ok_or(ProFailure::Storage)?;
            if current != canonical {
                crate::fsx::atomic_write(&path, &canonical).map_err(|_| ProFailure::Storage)?;
            }
            if let Ok(envelope) = serde_json::from_str::<HostedContextEnvelope>(&canonical) {
                if let Ok(keys) = key_set() {
                    let key_ids = keys.into_keys().collect::<Vec<_>>();
                    let routing_enabled = current_status_inner(store)
                        .features
                        .contains(&EntitlementFeature::Routing);
                    let _ = write_hosted_trust(
                        &envelope.account_id,
                        &envelope.device_id,
                        envelope.revocation_epoch,
                        envelope.source.sequence,
                        routing_enabled,
                        &key_ids,
                    );
                }
            }
            Ok(true)
        }
        Err(error) => {
            let _ = remove_state_file(AGENT_CONTEXT_FILE_NAME);
            let _ = remove_hosted_trust();
            Err(error)
        }
    }
}

fn validate_hosted_context_with_keys(
    value: &Value,
    store: &dyn SecretStore,
    keys: &HashMap<String, VerifyingKey>,
    now: i64,
    scope: Option<&str>,
) -> Result<String, ProFailure> {
    let envelope: HostedContextEnvelope =
        serde_json::from_value(value.clone()).map_err(|_| ProFailure::Service)?;
    let record_count = envelope.payload.meters.len() + envelope.payload.routing_hints.len();
    if envelope.schema != "openlimiter.hosted_context"
        || envelope.version != 1
        || record_count > 40
        || envelope.source.kind != "accepted_snapshot"
        || uuid::Uuid::parse_str(&envelope.source.event_id).is_err()
        || envelope.source.sequence == 0
        || envelope.payload.meters.iter().any(|meter| {
            !valid_context_provider(&meter.provider)
                || !matches!(
                    meter.meter.as_str(),
                    "provider_usage_percent" | "api_budget_percent"
                )
                || !matches!(meter.level.as_str(), "60" | "80" | "90" | "reset")
                || meter
                    .reset_at
                    .as_deref()
                    .is_some_and(|value| context_time(value).is_err())
        })
        || envelope.payload.routing_hints.iter().any(|hint| {
            !matches!(
                hint.kind.as_str(),
                "prefer_lower_cost_when_capable" | "preserve_current_provider"
            ) || !valid_context_provider(&hint.provider)
                || !matches!(
                    hint.reason.as_str(),
                    "high_usage" | "budget_pressure" | "normal"
                )
        })
    {
        return Err(ProFailure::Service);
    }
    /* The login binds the trust record and so the device; the envelope's
    account is the usage account it was requested for. A stored context
    re-read later (no scope) was already checked against its request. */
    let login = crate::account::active_account_id(store).map_err(|_| ProFailure::NoSession)?;
    let mut trust = load_trust(store, &login)?;
    if !crate::account::is_valid_account_id(&envelope.account_id)
        || scope.is_some_and(|scope| envelope.account_id != scope)
        || envelope.device_id != trust.device_id
        || envelope.revocation_epoch != trust.highest_revocation_epoch
        || envelope.source.sequence < trust.highest_context_sequence
        || (envelope.source.sequence == trust.highest_context_sequence
            && trust.highest_context_sequence > 0
            && trust.last_context_event_id.as_deref() != Some(&envelope.source.event_id))
    {
        return Err(ProFailure::InvalidEntitlement);
    }
    let generated = context_time(&envelope.generated_at)?;
    let expires = context_time(&envelope.expires_at)?;
    let observed = context_time(&envelope.source.observed_at)?;
    if generated > now + CLOCK_TOLERANCE_SECONDS
        || expires <= generated
        || expires - generated > 15 * 60
        || now >= expires
        || observed > generated
        || generated - observed > 30 * 60
    {
        return Err(ProFailure::InvalidEntitlement);
    }
    if envelope.signature.contains('=') || envelope.signature.len() > 128 {
        return Err(ProFailure::InvalidEntitlement);
    }
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(&envelope.signature)
        .map_err(|_| ProFailure::InvalidEntitlement)?;
    if URL_SAFE_NO_PAD.encode(&signature_bytes) != envelope.signature {
        return Err(ProFailure::InvalidEntitlement);
    }
    let signature =
        Signature::from_slice(&signature_bytes).map_err(|_| ProFailure::InvalidEntitlement)?;
    let key = keys
        .get(&envelope.kid)
        .ok_or(ProFailure::InvalidEntitlement)?;
    key.verify_strict(&canonical_context(&envelope)?, &signature)
        .map_err(|_| ProFailure::InvalidEntitlement)?;
    if envelope.source.sequence > trust.highest_context_sequence {
        trust.highest_context_sequence = envelope.source.sequence;
        trust.last_context_event_id = Some(envelope.source.event_id.clone());
        save_trust(store, &trust)?;
    }
    let encoded = serde_json::to_string(&envelope).map_err(|_| ProFailure::Service)?;
    if encoded.len() > MAX_CONTEXT_BYTES {
        return Err(ProFailure::Service);
    }
    Ok(encoded)
}

/// The request identifier the next issue reuses, or a new one, and whether it
/// is new. A pending request is only reused for the same previous token.
fn pending_request(
    trust: &mut TrustState,
    previous_jti: Option<&str>,
) -> Result<(String, bool), ProFailure> {
    let (request_id, created) = match &trust.pending_request_id {
        Some(value) => (value.clone(), false),
        None => {
            let value = uuid::Uuid::new_v4().to_string();
            trust.pending_request_id = Some(value.clone());
            trust.pending_previous_jti = previous_jti.map(str::to_string);
            (value, true)
        }
    };
    if trust.pending_previous_jti.as_deref() != previous_jti {
        return Err(ProFailure::InvalidEntitlement);
    }
    Ok((request_id, created))
}

/// A request the issuer let expire undelivered is never retried: the next
/// issue starts a fresh one.
fn drop_expired_request(trust: &mut TrustState) {
    trust.pending_request_id = None;
    trust.pending_previous_jti = None;
}

/// The token the next issue request names as the one it replaces.
///
/// The issuer chains every token to the grant's last jti. A refusal (a trial
/// that ended, a lapsed payment) or a corrupt cache deletes the cached token,
/// so the trust record remembers the last accepted jti, and a record written
/// before it did falls back to the pending request that named it. Either way
/// the retry after a purchase chains instead of stranding the grant.
fn previous_jti(cache: Option<&VerifiedToken>, trust: &TrustState) -> Option<String> {
    match cache {
        Some(token) => Some(token.claims.jti.clone()),
        None if trust.last_jti.is_some() => trust.last_jti.clone(),
        None if trust.pending_request_id.is_some() => trust.pending_previous_jti.clone(),
        None => None,
    }
}

/// The `/entitlement` bodies one refresh sends, in order. The last answer
/// carries the token.
///
/// The issuer refuses a device without a grant, and sync, the other path that
/// creates one, skips a machine with no readings. So a device this trust has
/// never been issued a token for registers first. Registration is idempotent
/// on the server, and is skipped afterwards so a renamed device keeps its name.
fn issue_requests(trust: &TrustState, request_id: &str, previous_jti: Option<&str>) -> Vec<Value> {
    let issue = json!({
        "device_id": trust.device_id,
        "request_id": request_id,
        "previous_jti": previous_jti,
    });
    if trust.highest_sequence > 0 {
        return vec![issue];
    }
    vec![
        json!({
            "action": "register",
            "device_id": trust.device_id,
            "label": DEVICE_LABEL,
            "client_version": crate::account::client_version(),
        }),
        issue,
    ]
}

async fn refresh(store: &dyn SecretStore) -> Result<ProStatus, ProFailure> {
    if configured_service_url().is_empty() {
        return Err(ProFailure::Unconfigured);
    }
    let access_token = crate::account::current_access_token(store)
        .await
        .map_err(map_account_failure)?;
    let keys = key_set()?;
    let access = access_token.as_str();
    refresh_with(store, &keys, move |body: Value| async move {
        post_json("/entitlement", access, &body).await
    })
    .await
}

/// One refresh against `/entitlement`, through `post`, so the issuer's chain
/// rules can be exercised without a network.
async fn refresh_with<F, R>(
    store: &dyn SecretStore,
    keys: &HashMap<String, VerifyingKey>,
    mut post: F,
) -> Result<ProStatus, ProFailure>
where
    F: FnMut(Value) -> R,
    R: std::future::Future<Output = Result<Value, ProFailure>>,
{
    let account_id = crate::account::active_account_id(store).map_err(|_| ProFailure::NoSession)?;
    let mut trust = load_trust(store, &account_id)?;
    let verified_cache = match read_cache()? {
        Some(cache) => Some(verify_token_with_keys(&cache.token, keys)?),
        None => None,
    };
    if let Some(token) = &verified_cache {
        reconcile_cached_token(store, &mut trust, token)?;
    }
    let mut expired = false;
    let response = 'issue: loop {
        let previous_jti = previous_jti(verified_cache.as_ref(), &trust);
        let (request_id, created) = pending_request(&mut trust, previous_jti.as_deref())?;
        if created {
            save_trust(store, &trust)?;
        }
        let mut response = Value::Null;
        for body in issue_requests(&trust, &request_id, previous_jti.as_deref()) {
            response = match post(body).await {
                /* The issuer let an undelivered token expire: a fresh request
                follows at once, and meets the chain the server advanced. */
                Err(ProFailure::TokenRequestExpired) if !expired => {
                    expired = true;
                    drop_expired_request(&mut trust);
                    save_trust(store, &trust)?;
                    continue 'issue;
                }
                Err(ProFailure::TokenRequestExpired) => return Err(ProFailure::Service),
                /* A stale token or a changed epoch means the chain moved past
                what this machine holds. The device never revokes itself to
                get out: any revoke bumps the account's epoch and signs the
                owner's phone out. StaleGrant goes up as it is, the window
                asks for a sign in, and the trust record keeps its last jti. */
                other => other?,
            };
        }
        break response;
    };
    let token_text = response
        .get("token")
        .and_then(Value::as_str)
        .ok_or(ProFailure::Service)?;
    let token = verify_token_with_keys(token_text, keys)?;
    if token.claims.sub != trust.account_id
        || token.claims.device_id != trust.device_id
        || token.claims.seq < trust.highest_sequence
        || token.claims.revocation_epoch < trust.highest_revocation_epoch
        || verified_cache.as_ref().is_some_and(|previous| {
            token.claims.seq < previous.claims.seq
                || (token.claims.seq == previous.claims.seq
                    && token.claims.jti != previous.claims.jti)
        })
    {
        return Err(ProFailure::InvalidEntitlement);
    }
    /* Network requests may overlap, but their durable commit cannot. Read the
    trust and cache again inside this gate so a delayed response can never
    replace a token that another refresh already advanced past. */
    let _commit = entitlement_commit_lock().lock().await;
    let mut persisted_trust = load_trust(store, &account_id)?;
    let persisted_cache = match read_cache()? {
        Some(cache) => Some(verify_token_with_keys(&cache.token, keys)?),
        None => None,
    };
    if token.claims.sub != persisted_trust.account_id
        || token.claims.device_id != persisted_trust.device_id
        || token.claims.seq < persisted_trust.highest_sequence
        || token.claims.revocation_epoch < persisted_trust.highest_revocation_epoch
        || (token.claims.seq == persisted_trust.highest_sequence
            && persisted_trust.last_jti.as_deref().is_some_and(|jti| jti != token.claims.jti))
        || persisted_cache.as_ref().is_some_and(|persisted| {
            token.claims.seq < persisted.claims.seq
                || (token.claims.seq == persisted.claims.seq
                    && token.claims.jti != persisted.claims.jti)
        })
    {
        return Err(ProFailure::InvalidEntitlement);
    }
    write_cache(token_text)?;
    let local_now = now_seconds()?;
    adopt_token(&mut persisted_trust, &token.claims, local_now);
    save_trust(store, &persisted_trust)?;
    status_for(&token, &persisted_trust, local_now)
}

fn countable_refresh_failure(error: ProFailure) -> bool {
    matches!(
        error,
        ProFailure::Network | ProFailure::Service | ProFailure::EntitlementRequired
    )
}

fn record_refresh_failure(store: &dyn SecretStore) -> Result<(), ProFailure> {
    let account_id = crate::account::active_account_id(store).map_err(|_| ProFailure::NoSession)?;
    let mut trust = load_trust(store, &account_id)?;
    trust.consecutive_refresh_failures = trust.consecutive_refresh_failures.saturating_add(1);
    save_trust(store, &trust)
}

/// Whether a failed refresh ends the local token.
///
/// Only the issuer refusing this account or device does. A lost session, a
/// network fault or an unusable answer leaves a signed token to its own
/// deadlines, and a token that no longer verifies is dropped by the status
/// read itself.
fn refresh_failure_clears_token(error: ProFailure) -> bool {
    error == ProFailure::EntitlementRequired
}

async fn refresh_with_failure_tracking(store: &dyn SecretStore) -> Result<ProStatus, ProFailure> {
    match refresh(store).await {
        Ok(status) => Ok(status),
        Err(error) => {
            let clear_result = if refresh_failure_clears_token(error) {
                clear_entitlement_and_context()
            } else {
                Ok(())
            };
            let tracking_result = if countable_refresh_failure(error) {
                record_refresh_failure(store)
            } else {
                Ok(())
            };
            clear_result?;
            tracking_result?;
            Err(error)
        }
    }
}

async fn refresh_if_due(store: &dyn SecretStore) -> Result<ProStatus, ProFailure> {
    let status = current_status(store);
    if matches!(
        status.state,
        ProEntitlementState::Active | ProEntitlementState::Unlicensed
    ) {
        return Ok(status);
    }
    refresh_with_failure_tracking(store).await
}

async fn service_call(
    store: &dyn SecretStore,
    input: ProServiceInput,
) -> Result<Value, ProFailure> {
    let action = input.action;
    let mut payload = input.payload;
    if payload.contains_key("action") {
        return Err(ProFailure::InvalidInput);
    }
    validate_device_action_payload(action, &mut payload)?;
    let mut device_token = None;
    if action.needs_entitlement() {
        let status = refresh_if_due(store).await?;
        if !matches!(
            status.state,
            ProEntitlementState::Active | ProEntitlementState::RefreshDue
        ) {
            let _ = remove_state_file(AGENT_CONTEXT_FILE_NAME);
            let _ = remove_hosted_trust();
            return Err(ProFailure::EntitlementRequired);
        }
        if action
            .required_feature()
            .is_some_and(|feature| !status.features.contains(&feature))
        {
            let _ = remove_state_file(AGENT_CONTEXT_FILE_NAME);
            let _ = remove_hosted_trust();
            return Err(ProFailure::EntitlementRequired);
        }
        device_token = Some(read_cache()?.ok_or(ProFailure::EntitlementRequired)?.token);
    }
    let account_id = crate::account::active_account_id(store).map_err(|_| ProFailure::NoSession)?;
    let device_id = load_trust(store, &account_id)?.device_id;
    let revokes_current_device = action == ProAction::RevokeDevice
        && payload.get("device_id").and_then(Value::as_str) == Some(device_id.as_str());
    let access_token = crate::account::current_access_token(store)
        .await
        .map_err(map_account_failure)?;
    let (path, body) = service_request(action, payload, &device_id);
    let result = post_signed_json(path, &access_token, device_token.as_deref(), &body).await;
    if clears_local_token(action, revokes_current_device, &result) {
        clear_local_authorization(store)?;
    }
    if action == ProAction::DeviceStatus {
        return result.map(device_list);
    }
    result
}

fn validate_device_action_payload(
    action: ProAction,
    payload: &mut Map<String, Value>,
) -> Result<(), ProFailure> {
    match action {
        ProAction::HostedContext => {
            /* One usage account, as sync uploads it, and nothing else: the
            device is added from this machine's own trust. */
            if payload.len() != 1
                || !payload
                    .get("account_id")
                    .and_then(Value::as_str)
                    .is_some_and(crate::account::is_valid_account_id)
            {
                return Err(ProFailure::InvalidInput);
            }
        }
        ProAction::AccountStatus
        | ProAction::DeviceStatus
        | ProAction::RevokeOtherDevices
        | ProAction::ListNotificationPreferences => {
            if !payload.is_empty() {
                return Err(ProFailure::InvalidInput);
            }
        }
        ProAction::RevokeDevice => {
            if payload.len() != 1
                || !payload
                    .get("device_id")
                    .and_then(Value::as_str)
                    .is_some_and(|value| uuid::Uuid::parse_str(value).is_ok())
            {
                return Err(ProFailure::InvalidInput);
            }
        }
        ProAction::RenameDevice => {
            if payload.len() != 2
                || !payload
                    .get("device_id")
                    .and_then(Value::as_str)
                    .is_some_and(|value| uuid::Uuid::parse_str(value).is_ok())
            {
                return Err(ProFailure::InvalidInput);
            }
            let label = payload
                .get("label")
                .and_then(Value::as_str)
                .ok_or(ProFailure::InvalidInput)?;
            let normalized: String = label.trim().nfc().collect();
            if normalized.is_empty()
                || normalized.chars().count() > 80
                || normalized.chars().any(char::is_control)
            {
                return Err(ProFailure::InvalidInput);
            }
            payload.insert("label".to_string(), Value::String(normalized));
        }
        _ => {}
    }
    Ok(())
}

/// The billing period a person chose, in the vocabulary the Pro service reads.
///
/// The window says monthly and yearly because that is what the price page
/// says. `create-checkout` reads `month` and `year`, so the translation lives
/// here rather than in the interface, where a typo would be a silent 400.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProPlan {
    Monthly,
    Yearly,
}

impl ProPlan {
    fn interval(self) -> &'static str {
        match self {
            Self::Monthly => "month",
            Self::Yearly => "year",
        }
    }
}

/// Whether the person is being sent to manage billing or to cancel.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PortalIntent {
    Manage,
    Cancel,
}

impl PortalIntent {
    fn action(self) -> &'static str {
        match self {
            Self::Manage => "manage",
            Self::Cancel => "cancel",
        }
    }
}

/// A hosted address the window is about to hand to the system browser.
///
/// Both hosted billing surfaces answer with one absolute URL and nothing
/// else, so both come back through this shape and both are checked the same
/// way before anything is opened.
fn hosted_url(response: &Value) -> Result<String, ProFailure> {
    let url = response
        .get("url")
        .and_then(Value::as_str)
        .ok_or(ProFailure::Service)?;
    if url.len() > 2_048 {
        return Err(ProFailure::Service);
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| ProFailure::Service)?;
    if parsed.scheme() != "https" || parsed.username() != "" || parsed.password().is_some() {
        return Err(ProFailure::Service);
    }
    Ok(url.to_string())
}

/// The Supabase bearer for the signed in person, or a plain no session.
pub(crate) async fn access_token(
    store: &dyn SecretStore,
) -> Result<zeroize::Zeroizing<String>, ProFailure> {
    crate::account::current_access_token(store)
        .await
        .map_err(map_account_failure)
}

/// The device token this machine currently holds, refreshing it when it is due.
///
/// `pair-device` verifies the token against the live grant, so a token inside
/// its refresh window would be rejected by the server rather than accepted on
/// the honour system the way a local feature is. Refreshing first turns that
/// into an ordinary success instead of an unexplained 401.
pub(crate) async fn current_device_token(store: &dyn SecretStore) -> Result<String, ProFailure> {
    let status = refresh_if_due(store).await?;
    if !matches!(
        status.state,
        ProEntitlementState::Active | ProEntitlementState::RefreshDue
    ) {
        return Err(ProFailure::EntitlementRequired);
    }
    read_cache()?
        .map(|cache| cache.token)
        .ok_or(ProFailure::NoSession)
}

/// The identifier this machine is known by inside the account.
pub(crate) fn desktop_device_id(store: &dyn SecretStore) -> Result<String, ProFailure> {
    let account_id = crate::account::active_account_id(store).map_err(|_| ProFailure::NoSession)?;
    Ok(load_trust(store, &account_id)?.device_id)
}

/// One `pair-device` action, authorised as both the account and this device.
pub(crate) async fn post_pairing(
    store: &dyn SecretStore,
    payload: Value,
) -> Result<Value, ProFailure> {
    let access = access_token(store).await?;
    let device_token = current_device_token(store).await?;
    post_signed_json("/pair-device", &access, Some(&device_token), &payload).await
}

/// One hosted service action, for callers outside this module.
pub(crate) async fn call_service(
    store: &dyn SecretStore,
    input: ProServiceInput,
) -> Result<Value, ProFailure> {
    service_call(store, input).await
}

#[tauri::command]
pub async fn pro_checkout_url(
    plan: ProPlan,
    store: State<'_, KeyringStore>,
) -> Result<String, ProFailure> {
    let access = access_token(store.inner()).await?;
    let response = post_json(
        "/create-checkout",
        &access,
        &json!({ "interval": plan.interval() }),
    )
    .await?;
    hosted_url(&response)
}

#[tauri::command]
pub async fn pro_portal_url(
    intent: PortalIntent,
    store: State<'_, KeyringStore>,
) -> Result<String, ProFailure> {
    let access = access_token(store.inner()).await?;
    let response = post_json(
        "/customer-portal",
        &access,
        &json!({ "action": intent.action() }),
    )
    .await?;
    hosted_url(&response)
}

#[tauri::command]
pub fn pro_status(store: State<'_, KeyringStore>) -> ProStatus {
    current_status(store.inner())
}

#[tauri::command]
pub async fn pro_refresh(store: State<'_, KeyringStore>) -> Result<ProStatus, ProFailure> {
    refresh_with_failure_tracking(store.inner()).await
}

#[tauri::command]
pub async fn pro_service(
    input: ProServiceInput,
    store: State<'_, KeyringStore>,
) -> Result<Value, ProFailure> {
    service_call(store.inner(), input).await
}

/// Ask for the hosted context of each usage account this machine uploads (the
/// server keys a context by usage account, never by login) and keep the one
/// under the most pressure.
async fn sync_agent_context(store: &dyn SecretStore) -> Result<bool, ProFailure> {
    let mut accepted = Vec::new();
    let mut failure = None;
    for account in crate::account::uploaded_usage_accounts(store) {
        let input = ProServiceInput {
            action: ProAction::HostedContext,
            payload: Map::from_iter([("account_id".to_string(), Value::String(account.clone()))]),
        };
        let answer =
            service_call(store, input)
                .await
                .and_then(|response| match response.get("context") {
                    Some(raw) => validate_hosted_context(raw, store, Some(&account)).map(Some),
                    None => Ok(None),
                });
        match answer {
            Ok(Some(context)) => accepted.push(context),
            Ok(None) => {}
            Err(error) => failure = Some(error),
        }
    }
    let path = state_file(AGENT_CONTEXT_FILE_NAME)?;
    let Some(context) = most_pressing_context(accepted) else {
        if let Some(error) = failure {
            return Err(error);
        }
        remove_state_file(AGENT_CONTEXT_FILE_NAME)?;
        remove_hosted_trust()?;
        return Ok(false);
    };
    let parent = path.parent().ok_or(ProFailure::Storage)?;
    crate::fsx::ensure_private_dir(parent).map_err(|_| ProFailure::Storage)?;
    crate::fsx::atomic_write(&path, &context).map_err(|_| ProFailure::Storage)?;
    let envelope: HostedContextEnvelope =
        serde_json::from_str(&context).map_err(|_| ProFailure::Service)?;
    let keys = key_set()?;
    let key_ids = keys.into_keys().collect::<Vec<_>>();
    let routing_enabled = current_status_inner(store)
        .features
        .contains(&EntitlementFeature::Routing);
    write_hosted_trust(
        &envelope.account_id,
        &envelope.device_id,
        envelope.revocation_epoch,
        envelope.source.sequence,
        routing_enabled,
        &key_ids,
    )?;
    Ok(true)
}

#[tauri::command]
pub async fn pro_sync_agent_context(store: State<'_, KeyringStore>) -> Result<bool, ProFailure> {
    sync_agent_context(store.inner()).await
}

#[tauri::command]
pub async fn pro_sync_hosted(store: State<'_, KeyringStore>) -> Result<bool, ProFailure> {
    let uploaded = crate::account::sync_snapshot(store.inner())
        .await
        .map_err(|_| ProFailure::Network)?;
    let context = sync_agent_context(store.inner()).await.unwrap_or(false);
    Ok(uploaded || context)
}

#[tauri::command]
pub fn pro_disconnect(store: State<'_, KeyringStore>) -> Result<(), ProFailure> {
    clear_local_authorization(store.inner())
}

pub fn spawn_silent_refresh() {
    tauri::async_runtime::spawn(async move {
        let store = KeyringStore;
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            let _ = maintain_hosted_context(&store);
        }
    });
    tauri::async_runtime::spawn(async move {
        let store = KeyringStore;
        let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
        loop {
            interval.tick().await;
            let _ = refresh_with_failure_tracking(&store).await;
            let _ = sync_agent_context(&store).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::InMemorySecrets;
    use ed25519_dalek::{Signer as _, SigningKey, Verifier as _};

    const ACCOUNT_ID: &str = "00000000-0000-4000-8000-000000000001";
    const DEVICE_ID: &str = "00000000-0000-4000-8000-000000000003";

    fn claims(now: i64) -> EntitlementClaims {
        EntitlementClaims {
            ver: 2,
            iss: "openlimiter-pro".to_string(),
            aud: "desktop".to_string(),
            scope: "full".to_string(),
            sub: ACCOUNT_ID.to_string(),
            device_id: DEVICE_ID.to_string(),
            jti: "00000000-0000-4000-8000-000000000002".to_string(),
            seq: 4,
            iat: now,
            nbf: now,
            exp: now + TOKEN_LIFETIME_SECONDS,
            refresh_after: now + TOKEN_REFRESH_AFTER_SECONDS,
            grace_until: now + TOKEN_HONOR_UNTIL_SECONDS,
            server_time: now,
            revocation_epoch: 2,
            features: EntitlementFeature::ALL.to_vec(),
            plan_state: "active".to_string(),
            interval: Some("monthly".to_string()),
        }
    }

    fn trust(now: i64) -> TrustState {
        TrustState {
            version: TRUST_VERSION,
            account_id: ACCOUNT_ID.to_string(),
            device_id: DEVICE_ID.to_string(),
            highest_sequence: 4,
            highest_revocation_epoch: 2,
            highest_context_sequence: 0,
            last_context_event_id: None,
            highest_server_time: now,
            anchor_local_time: now,
            consecutive_refresh_failures: 0,
            pending_request_id: None,
            pending_previous_jti: None,
            last_jti: None,
            retired_device_id: None,
        }
    }

    fn verified(now: i64) -> VerifiedToken {
        VerifiedToken {
            header: TokenHeader {
                alg: "EdDSA".to_string(),
                kid: "primary".to_string(),
                typ: "OLP2".to_string(),
            },
            claims: claims(now),
        }
    }

    #[test]
    fn token_contract_requires_short_life_and_bounded_grace() {
        let now = 1_800_000_000;
        assert!(validate_claim_shape(&claims(now)).is_ok());
        let mut too_long = claims(now);
        too_long.exp += 1;
        assert_eq!(
            validate_claim_shape(&too_long),
            Err(ProFailure::InvalidEntitlement)
        );
        /* Grace clipped at the access end is a shape the issuer really
        sends; grace beyond three days, or before expiry, is not. */
        let mut clipped_grace = claims(now);
        clipped_grace.grace_until -= 1;
        assert!(validate_claim_shape(&clipped_grace).is_ok());
        let mut long_grace = claims(now);
        long_grace.grace_until += 1;
        assert_eq!(
            validate_claim_shape(&long_grace),
            Err(ProFailure::InvalidEntitlement)
        );
        let mut short_grace = claims(now);
        short_grace.grace_until = short_grace.exp - 1;
        assert_eq!(
            validate_claim_shape(&short_grace),
            Err(ProFailure::InvalidEntitlement)
        );
    }

    /// The claim payload the Pro service signs, as JSON, so the test exercises
    /// the same deserializer a real token goes through rather than a struct
    /// literal that cannot tell a present claim from a defaulted one.
    fn claims_json(now: i64, scope: Option<&str>, aud: &str) -> String {
        let mut payload = json!({
            "ver": 2,
            "iss": "openlimiter-pro",
            "aud": aud,
            "sub": ACCOUNT_ID,
            "device_id": DEVICE_ID,
            "jti": "00000000-0000-4000-8000-000000000002",
            "seq": 4,
            "iat": now,
            "nbf": now,
            "exp": now + TOKEN_LIFETIME_SECONDS,
            "refresh_after": now + TOKEN_REFRESH_AFTER_SECONDS,
            "grace_until": now + TOKEN_HONOR_UNTIL_SECONDS,
            "server_time": now,
            "revocation_epoch": 2,
            "features": EntitlementFeature::ALL
                .iter()
                .map(|feature| feature.code())
                .collect::<Vec<_>>(),
            "plan_state": "active",
            "interval": "monthly",
        });
        if let Some(scope) = scope {
            payload
                .as_object_mut()
                .expect("claim object")
                .insert("scope".to_string(), Value::String(scope.to_string()));
        }
        payload.to_string()
    }

    #[test]
    fn a_desktop_token_carrying_the_new_scope_claim_still_parses() {
        let now = 1_800_000_000;
        let parsed: EntitlementClaims =
            strict_json(claims_json(now, Some("full"), "desktop").as_bytes())
                .expect("a scoped desktop token parses");
        assert_eq!(parsed.scope, "full");
        assert!(parsed.is_desktop());
        assert!(validate_claim_shape(&parsed).is_ok());
    }

    #[test]
    fn a_token_minted_before_the_scope_claim_reads_as_the_desktop_scope() {
        let now = 1_800_000_000;
        let parsed: EntitlementClaims = strict_json(claims_json(now, None, "desktop").as_bytes())
            .expect("an unscoped desktop token parses");
        assert_eq!(parsed.scope, "full");
        assert!(validate_claim_shape(&parsed).is_ok());
    }

    #[test]
    fn a_read_scoped_phone_token_is_refused_and_unlocks_nothing() {
        let now = 1_800_000_000;
        let phone: EntitlementClaims =
            strict_json(claims_json(now, Some("read"), "phone").as_bytes())
                .expect("a phone token parses as JSON");
        assert!(!phone.is_desktop());
        assert_eq!(
            validate_claim_shape(&phone),
            Err(ProFailure::InvalidEntitlement)
        );

        /* Even if one reached status_for through some other door, it grants no
        local feature: the phone scope is a read authorisation, never a plan. */
        let token = VerifiedToken {
            header: TokenHeader {
                alg: "EdDSA".to_string(),
                kid: "primary".to_string(),
                typ: "OLP2".to_string(),
            },
            claims: phone,
        };
        let status = status_for(&token, &trust(now), now).expect("a status is still derived");
        assert!(status.features.is_empty());
        assert!(!status.multi_account);
        assert!(!status.theme_preset);
    }

    #[test]
    fn a_desktop_audience_with_a_read_scope_is_refused() {
        let now = 1_800_000_000;
        let mixed: EntitlementClaims =
            strict_json(claims_json(now, Some("read"), "desktop").as_bytes())
                .expect("the mixed token parses as JSON");
        assert_eq!(
            validate_claim_shape(&mixed),
            Err(ProFailure::InvalidEntitlement)
        );
    }

    #[test]
    fn status_moves_from_active_to_refresh_to_grace_to_expired() {
        let now = 1_800_000_000;
        let token = verified(now);
        let trust = trust(now);
        assert_eq!(
            status_for(&token, &trust, now).unwrap().state,
            ProEntitlementState::Active
        );
        assert_eq!(
            status_for(&token, &trust, token.claims.refresh_after + 1)
                .unwrap()
                .state,
            ProEntitlementState::RefreshDue
        );
        assert_eq!(
            status_for(&token, &trust, token.claims.exp + 1)
                .unwrap()
                .state,
            ProEntitlementState::Grace
        );
        assert_eq!(
            status_for(&token, &trust, token.claims.grace_until + 1)
                .unwrap()
                .state,
            ProEntitlementState::Expired
        );
    }

    #[test]
    fn clock_rollback_is_refused_instead_of_extending_grace() {
        let now = 1_800_000_000;
        let mut trust = trust(now);
        trust.highest_server_time = now - 1_000;
        assert_eq!(
            effective_time(&trust, now - CLOCK_TOLERANCE_SECONDS - 1),
            Err(ProFailure::ClockInvalid)
        );
    }

    #[test]
    fn local_time_before_the_highest_server_time_is_refused() {
        let now = 1_800_000_000;
        let mut trust = trust(now);
        trust.anchor_local_time = now - 1_000;
        assert_eq!(
            effective_time(&trust, now - CLOCK_TOLERANCE_SECONDS - 1),
            Err(ProFailure::ClockInvalid)
        );
    }

    #[test]
    fn local_skew_never_moves_effective_time_before_the_server_maximum() {
        let now = 1_800_000_000;
        assert_eq!(effective_time(&trust(now), now - 1), Ok(now));
    }

    #[test]
    fn failed_refresh_ceiling_expires_a_frozen_clock_token() {
        let now = 1_800_000_000;
        let token = verified(now);
        let mut trust = trust(now);
        trust.consecutive_refresh_failures = MAX_CONSECUTIVE_REFRESH_FAILURES;
        assert_eq!(
            status_for(&token, &trust, now).unwrap().state,
            ProEntitlementState::Expired
        );
    }

    #[test]
    fn refresh_failure_count_is_persisted() {
        let now = 1_800_000_000;
        let store = context_store(now);
        record_refresh_failure(&store).expect("failure stored");
        assert_eq!(
            load_trust(&store, ACCOUNT_ID)
                .expect("stored trust")
                .consecutive_refresh_failures,
            1
        );
    }

    #[test]
    fn legacy_trust_state_is_replaced_by_an_account_bound_grant() {
        let raw = r#"{
            "version":1,
            "device_id":"device_00000000000040008000000000000001",
            "highest_sequence":4,
            "trusted_server_time":1800000000,
            "anchor_local_time":1800000000,
            "pending_request_id":null,
            "pending_previous_jti":null
        }"#;
        let store = InMemorySecrets::new();
        store
            .store_secret(TRUST_CREDENTIAL_ID, raw)
            .expect("legacy grant stored");
        let trust = load_trust(&store, ACCOUNT_ID).expect("replacement grant");
        assert_eq!(trust.version, TRUST_VERSION);
        assert_eq!(trust.account_id, ACCOUNT_ID);
        assert!(uuid::Uuid::parse_str(&trust.device_id).is_ok());
        assert_eq!(trust.highest_sequence, 0);
        assert_eq!(trust.highest_revocation_epoch, 0);
        assert_eq!(trust.consecutive_refresh_failures, 0);
    }

    #[test]
    fn entitlement_denial_counts_as_a_failed_refresh() {
        assert!(countable_refresh_failure(ProFailure::Network));
        assert!(countable_refresh_failure(ProFailure::Service));
        assert!(countable_refresh_failure(ProFailure::EntitlementRequired));
        assert!(!countable_refresh_failure(ProFailure::NoSession));
    }

    #[test]
    fn account_network_failure_never_impersonates_logout() {
        assert_eq!(
            map_account_failure(crate::account::AccountFailure::Network),
            ProFailure::Network
        );
        assert_eq!(
            map_account_failure(crate::account::AccountFailure::Authentication),
            ProFailure::NoSession
        );
        assert_eq!(
            map_account_failure(crate::account::AccountFailure::Storage),
            ProFailure::CredentialStore
        );
    }

    #[test]
    fn old_sequence_is_a_replay() {
        let now = 1_800_000_000;
        let token = verified(now);
        let mut trust = trust(now);
        trust.highest_sequence = token.claims.seq + 1;
        assert_eq!(
            status_for(&token, &trust, now),
            Err(ProFailure::InvalidEntitlement)
        );
    }

    #[test]
    fn a_cache_write_survives_a_crash_before_the_trust_write() {
        let now = 1_800_000_000;
        let store = InMemorySecrets::new();
        let token = verified(now);
        let mut trust = trust(now);
        trust.highest_sequence = token.claims.seq - 1;
        trust.pending_request_id = Some("00000000-0000-4000-8000-000000000003".to_string());
        trust.pending_previous_jti = Some("00000000-0000-4000-8000-000000000004".to_string());
        reconcile_cached_token(&store, &mut trust, &token).expect("reconciled");
        assert_eq!(trust.highest_sequence, token.claims.seq);
        assert_eq!(trust.pending_request_id, None);
        assert_eq!(trust.pending_previous_jti, None);
    }

    fn hosted_context_fixture(now: i64, key: &SigningKey) -> HostedContextEnvelope {
        let timestamp = |value| {
            time::OffsetDateTime::from_unix_timestamp(value)
                .expect("timestamp")
                .format(&time::format_description::well_known::Rfc3339)
                .expect("RFC3339")
        };
        let mut envelope = HostedContextEnvelope {
            schema: "openlimiter.hosted_context".to_string(),
            version: 1,
            kid: "context-test".to_string(),
            generated_at: timestamp(now),
            expires_at: timestamp(now + 15 * 60),
            account_id: USAGE_ACCOUNT.to_string(),
            device_id: DEVICE_ID.to_string(),
            revocation_epoch: 2,
            source: HostedContextSource {
                kind: "accepted_snapshot".to_string(),
                event_id: "00000000-0000-4000-8000-000000000004".to_string(),
                sequence: 42,
                observed_at: timestamp(now - 60),
            },
            payload: HostedContextPayload {
                meters: vec![HostedContextMeter {
                    provider: "codex".to_string(),
                    meter: "provider_usage_percent".to_string(),
                    level: "90".to_string(),
                    reset_at: None,
                }],
                routing_hints: vec![HostedRoutingHint {
                    kind: "prefer_lower_cost_when_capable".to_string(),
                    provider: "codex".to_string(),
                    reason: "high_usage".to_string(),
                }],
            },
            signature: String::new(),
        };
        envelope.signature = URL_SAFE_NO_PAD.encode(
            key.sign(&canonical_context(&envelope).expect("canonical envelope"))
                .to_bytes(),
        );
        envelope
    }

    fn context_store(now: i64) -> InMemorySecrets {
        let store = session_store(now);
        save_trust(&store, &trust(now)).expect("trust stored");
        store
    }

    /// A signed in account with no trust record yet: a fresh machine.
    fn session_store(now: i64) -> InMemorySecrets {
        let store = InMemorySecrets::new();
        store
            .store_secret(
                "openlimiter-account-session",
                &serde_json::json!({
                    "version": 2,
                    "account_id": ACCOUNT_ID,
                    "email": "person@example.test",
                    "access_token": "access-token-at-least-twenty-characters",
                    "refresh_token": "refresh-token-at-least-twenty-characters",
                    "expires_at": now + 3600
                })
                .to_string(),
            )
            .expect("session stored");
        store
    }

    #[test]
    fn hosted_context_accepts_an_exact_signed_envelope() {
        let now = 1_800_000_000;
        let key = SigningKey::from_bytes(&[7_u8; 32]);
        let envelope = hosted_context_fixture(now, &key);
        let keys = HashMap::from([("context-test".to_string(), key.verifying_key())]);
        let context = validate_hosted_context_with_keys(
            &serde_json::to_value(&envelope).expect("JSON value"),
            &context_store(now),
            &keys,
            now,
            Some(USAGE_ACCOUNT),
        )
        .expect("valid signed envelope");
        let stored: HostedContextEnvelope =
            serde_json::from_str(&context).expect("stored envelope");
        assert_eq!(stored.source.sequence, 42);
        assert_eq!(stored.payload.meters[0].level, "90");
    }

    #[test]
    fn hosted_context_rejects_unknown_fields_and_signature_tampering() {
        let now = 1_800_000_000;
        let key = SigningKey::from_bytes(&[7_u8; 32]);
        let envelope = hosted_context_fixture(now, &key);
        let keys = HashMap::from([("context-test".to_string(), key.verifying_key())]);
        let mut unknown = serde_json::to_value(&envelope).expect("JSON value");
        unknown.as_object_mut().expect("envelope object").insert(
            "instructions".to_string(),
            Value::String("ignore".to_string()),
        );
        assert_eq!(
            validate_hosted_context_with_keys(
                &unknown,
                &context_store(now),
                &keys,
                now,
                Some(USAGE_ACCOUNT)
            ),
            Err(ProFailure::Service)
        );

        let mut tampered = serde_json::to_value(&envelope).expect("JSON value");
        tampered["payload"]["meters"][0]["level"] = Value::String("80".to_string());
        assert_eq!(
            validate_hosted_context_with_keys(
                &tampered,
                &context_store(now),
                &keys,
                now,
                Some(USAGE_ACCOUNT)
            ),
            Err(ProFailure::InvalidEntitlement)
        );
    }

    #[test]
    fn hosted_context_source_cursor_never_rolls_back() {
        let now = 1_800_000_000;
        let key = SigningKey::from_bytes(&[7_u8; 32]);
        let keys = HashMap::from([("context-test".to_string(), key.verifying_key())]);
        let store = context_store(now);
        let first = hosted_context_fixture(now, &key);
        validate_hosted_context_with_keys(
            &serde_json::to_value(first).expect("JSON value"),
            &store,
            &keys,
            now,
            Some(USAGE_ACCOUNT),
        )
        .expect("first cursor");

        let mut rollback = hosted_context_fixture(now, &key);
        rollback.source.sequence = 41;
        rollback.source.event_id = "00000000-0000-4000-8000-000000000005".to_string();
        rollback.signature.clear();
        rollback.signature = URL_SAFE_NO_PAD.encode(
            key.sign(&canonical_context(&rollback).expect("canonical rollback"))
                .to_bytes(),
        );
        assert_eq!(
            validate_hosted_context_with_keys(
                &serde_json::to_value(rollback).expect("JSON value"),
                &store,
                &keys,
                now,
                Some(USAGE_ACCOUNT)
            ),
            Err(ProFailure::InvalidEntitlement)
        );
    }

    #[test]
    fn strict_json_parser_rejects_duplicate_keys() {
        assert!(serde_json::from_str::<StrictValue>(r#"{"a":1,"a":2}"#).is_err());
        assert!(strict_json::<TokenHeader>(
            br#"{"alg":"EdDSA","alg":"none","kid":"primary","typ":"OLP2"}"#
        )
        .is_err());
    }

    #[test]
    fn device_actions_are_closed_and_labels_are_normalized() {
        let mut rename = Map::from_iter([
            (
                "device_id".to_string(),
                Value::String(DEVICE_ID.to_string()),
            ),
            (
                "label".to_string(),
                Value::String("  Cafe\u{301}  ".to_string()),
            ),
        ]);
        validate_device_action_payload(ProAction::RenameDevice, &mut rename).expect("valid rename");
        assert_eq!(rename.get("label").and_then(Value::as_str), Some("Café"));

        let mut widened = rename.clone();
        widened.insert("admin".to_string(), Value::Bool(true));
        assert_eq!(
            validate_device_action_payload(ProAction::RenameDevice, &mut widened),
            Err(ProFailure::InvalidInput)
        );
        assert_eq!(
            validate_device_action_payload(
                ProAction::RevokeDevice,
                &mut Map::from_iter([(
                    "device_id".to_string(),
                    Value::String("not-a-device".to_string())
                )])
            ),
            Err(ProFailure::InvalidInput)
        );
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let text = std::str::from_utf8(pair).expect("ASCII hex");
                u8::from_str_radix(text, 16).expect("valid hex")
            })
            .collect()
    }

    #[test]
    fn production_entitlement_key_is_embedded_in_the_verifier_path() {
        let keys = parse_key_set(EMBEDDED_PRO_PUBLIC_KEYS).expect("embedded production key");
        let key = keys.get("primary").expect("primary production key");
        assert_eq!(
            URL_SAFE_NO_PAD.encode(key.to_bytes()),
            "vd23tzc92JlUML1MG9zc84dEbsQDCx7eHODpFMCoCeQ"
        );
    }

    #[test]
    fn ed25519_verifier_accepts_a_matching_fixture_and_rejects_tampering() {
        let public: [u8; 32] =
            decode_hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
                .try_into()
                .expect("public key length");
        let signature_text = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155\
             5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
            .replace(' ', "");
        let signature =
            Signature::from_slice(&decode_hex(&signature_text)).expect("signature length");
        let key = VerifyingKey::from_bytes(&public).expect("public key");
        assert!(key.verify(b"", &signature).is_ok());
        assert!(key.verify(b"tampered", &signature).is_err());
    }

    #[test]
    fn golden_fixture_cross_implementation_validation() {
        let fixture_json = r#"{
  "fixture_version": 1,
  "enum_contract": {
    "providers": [
      "anthropic",
      "claude",
      "codex",
      "gemini",
      "kimi",
      "manual",
      "openai",
      "opencode",
      "openrouter",
      "xai"
    ],
    "meters": [
      "provider_usage_percent",
      "api_budget_percent"
    ],
    "levels": [
      "60",
      "80",
      "90",
      "reset"
    ],
    "routing_kinds": [
      "prefer_lower_cost_when_capable",
      "preserve_current_provider"
    ],
    "routing_reasons": [
      "high_usage",
      "budget_pressure",
      "normal"
    ]
  },
  "private_key_pkcs8_base64url": "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f",
  "public_key_spki_base64url": "MCowBQYDK2VwAyEAA6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
  "public_key_raw_base64url": "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
  "canonical_unsigned": "{\"account_id\":\"account-fixture\",\"device_id\":\"33333333-3333-4333-8333-333333333333\",\"expires_at\":\"2026-09-01T12:15:00.000Z\",\"generated_at\":\"2026-09-01T12:00:00.000Z\",\"kid\":\"context-fixture-1\",\"payload\":{\"meters\":[{\"level\":\"60\",\"meter\":\"provider_usage_percent\",\"provider\":\"anthropic\",\"reset_at\":null},{\"level\":\"80\",\"meter\":\"api_budget_percent\",\"provider\":\"claude\",\"reset_at\":\"2026-09-01T13:00:00.000Z\"},{\"level\":\"90\",\"meter\":\"provider_usage_percent\",\"provider\":\"codex\",\"reset_at\":\"2026-09-01T13:00:00.000Z\"},{\"level\":\"reset\",\"meter\":\"api_budget_percent\",\"provider\":\"gemini\",\"reset_at\":null},{\"level\":\"60\",\"meter\":\"provider_usage_percent\",\"provider\":\"kimi\",\"reset_at\":\"2026-09-01T13:00:00.000Z\"},{\"level\":\"80\",\"meter\":\"api_budget_percent\",\"provider\":\"manual\",\"reset_at\":\"2026-09-01T13:00:00.000Z\"},{\"level\":\"90\",\"meter\":\"provider_usage_percent\",\"provider\":\"openai\",\"reset_at\":null},{\"level\":\"reset\",\"meter\":\"api_budget_percent\",\"provider\":\"opencode\",\"reset_at\":\"2026-09-01T13:00:00.000Z\"},{\"level\":\"60\",\"meter\":\"provider_usage_percent\",\"provider\":\"openrouter\",\"reset_at\":\"2026-09-01T13:00:00.000Z\"},{\"level\":\"80\",\"meter\":\"api_budget_percent\",\"provider\":\"xai\",\"reset_at\":null}],\"routing_hints\":[{\"kind\":\"prefer_lower_cost_when_capable\",\"provider\":\"openai\",\"reason\":\"high_usage\"},{\"kind\":\"preserve_current_provider\",\"provider\":\"xai\",\"reason\":\"budget_pressure\"},{\"kind\":\"preserve_current_provider\",\"provider\":\"manual\",\"reason\":\"normal\"}]},\"revocation_epoch\":7,\"schema\":\"openlimiter.hosted_context\",\"source\":{\"event_id\":\"55555555-5555-4555-8555-555555555555\",\"kind\":\"accepted_snapshot\",\"observed_at\":\"2026-09-01T11:55:00.000Z\",\"sequence\":42},\"version\":1}",
  "envelope": {
    "schema": "openlimiter.hosted_context",
    "version": 1,
    "kid": "context-fixture-1",
    "generated_at": "2026-09-01T12:00:00.000Z",
    "expires_at": "2026-09-01T12:15:00.000Z",
    "account_id": "account-fixture",
    "device_id": "33333333-3333-4333-8333-333333333333",
    "revocation_epoch": 7,
    "source": {
      "kind": "accepted_snapshot",
      "event_id": "55555555-5555-4555-8555-555555555555",
      "sequence": 42,
      "observed_at": "2026-09-01T11:55:00.000Z"
    },
    "payload": {
      "meters": [
        { "provider": "anthropic", "meter": "provider_usage_percent", "level": "60", "reset_at": null },
        { "provider": "claude", "meter": "api_budget_percent", "level": "80", "reset_at": "2026-09-01T13:00:00.000Z" },
        { "provider": "codex", "meter": "provider_usage_percent", "level": "90", "reset_at": "2026-09-01T13:00:00.000Z" },
        { "provider": "gemini", "meter": "api_budget_percent", "level": "reset", "reset_at": null },
        { "provider": "kimi", "meter": "provider_usage_percent", "level": "60", "reset_at": "2026-09-01T13:00:00.000Z" },
        { "provider": "manual", "meter": "api_budget_percent", "level": "80", "reset_at": "2026-09-01T13:00:00.000Z" },
        { "provider": "openai", "meter": "provider_usage_percent", "level": "90", "reset_at": null },
        { "provider": "opencode", "meter": "api_budget_percent", "level": "reset", "reset_at": "2026-09-01T13:00:00.000Z" },
        { "provider": "openrouter", "meter": "provider_usage_percent", "level": "60", "reset_at": "2026-09-01T13:00:00.000Z" },
        { "provider": "xai", "meter": "api_budget_percent", "level": "80", "reset_at": null }
      ],
      "routing_hints": [
        { "kind": "prefer_lower_cost_when_capable", "provider": "openai", "reason": "high_usage" },
        { "kind": "preserve_current_provider", "provider": "xai", "reason": "budget_pressure" },
        { "kind": "preserve_current_provider", "provider": "manual", "reason": "normal" }
      ]
    },
    "signature": "ZkAGEPj8K0HQdoNGQZ4AQVAWcdNw6gxdwicE7zu5ksBB6DxUL4Zukg2YlwHGj4CrUdfGM1Tq0bV-U_8HxBGEAQ"
  },
  "trust_document": {
    "schema": "openlimiter.hosted_trust",
    "version": 1,
    "account_id": "account-fixture",
    "device_id": "33333333-3333-4333-8333-333333333333",
    "entitlement_epoch": 7,
    "last_verified_sequence": 42,
    "routing_state": "enabled",
    "pinned_public_key_ids": ["context-fixture-1"]
  }
}"#;
        let fixture: Value = serde_json::from_str(fixture_json).expect("valid fixture json");
        let envelope_value = &fixture["envelope"];
        let envelope: HostedContextEnvelope =
            serde_json::from_value(envelope_value.clone()).expect("parse envelope");

        let canonical = canonical_context(&envelope).expect("canonical context");
        let canonical_str = std::str::from_utf8(&canonical).expect("utf-8 canonical");
        assert_eq!(
            canonical_str,
            fixture["canonical_unsigned"].as_str().unwrap()
        );

        let pubkey_bytes = URL_SAFE_NO_PAD
            .decode(fixture["public_key_raw_base64url"].as_str().unwrap())
            .expect("decode pubkey");
        let pubkey_array: [u8; 32] = pubkey_bytes.try_into().expect("32 byte pubkey");
        let pubkey = VerifyingKey::from_bytes(&pubkey_array).expect("verifying key");
        let sig_bytes = URL_SAFE_NO_PAD
            .decode(envelope.signature.as_str())
            .expect("decode signature");
        let signature = Signature::from_slice(&sig_bytes).expect("signature");
        assert!(pubkey.verify_strict(&canonical, &signature).is_ok());

        let keys = HashMap::from([("context-fixture-1".to_string(), pubkey)]);
        let store = InMemorySecrets::new();
        let now = 1_788_264_000;
        store
            .store_secret(
                "openlimiter-account-session",
                &serde_json::json!({
                    "version": 2,
                    "account_id": FIXTURE_LOGIN,
                    "email": "fixture@example.test",
                    "access_token": "access-token-fixture-at-least-twenty",
                    "refresh_token": "refresh-token-fixture-at-least-twenty",
                    "expires_at": now + 3600
                })
                .to_string(),
            )
            .expect("session stored");
        let fixture_trust = TrustState {
            version: TRUST_VERSION,
            account_id: FIXTURE_LOGIN.to_string(),
            device_id: "33333333-3333-4333-8333-333333333333".to_string(),
            highest_sequence: 42,
            highest_revocation_epoch: 7,
            highest_context_sequence: 0,
            last_context_event_id: None,
            highest_server_time: now,
            anchor_local_time: now,
            consecutive_refresh_failures: 0,
            pending_request_id: None,
            pending_previous_jti: None,
            last_jti: None,
            retired_device_id: None,
        };
        save_trust(&store, &fixture_trust).expect("trust stored");

        /* The envelope covers the usage account "account-fixture", signed in
        as a different login: asked for another usage account it is refused,
        asked for its own it is accepted. */
        assert_eq!(
            validate_hosted_context_with_keys(envelope_value, &store, &keys, now, Some("default")),
            Err(ProFailure::InvalidEntitlement)
        );
        let validated = validate_hosted_context_with_keys(
            envelope_value,
            &store,
            &keys,
            now,
            Some("account-fixture"),
        )
        .expect("envelope validated");
        let parsed_validated: HostedContextEnvelope =
            serde_json::from_str(&validated).expect("parse validated");
        assert_eq!(parsed_validated.account_id, "account-fixture");
        assert_eq!(parsed_validated.payload.meters.len(), 10);
        assert_eq!(parsed_validated.payload.routing_hints.len(), 3);

        let trust_doc_value = &fixture["trust_document"];
        let trust_doc: HostedTrustDocument =
            serde_json::from_value(trust_doc_value.clone()).expect("parse trust doc");
        assert_eq!(trust_doc.schema, "openlimiter.hosted_trust");
        assert_eq!(trust_doc.version, 1);
        assert_eq!(trust_doc.account_id, "account-fixture");
        assert_eq!(trust_doc.device_id, "33333333-3333-4333-8333-333333333333");
        assert_eq!(trust_doc.entitlement_epoch, 7);
        assert_eq!(trust_doc.last_verified_sequence, 42);
        assert_eq!(trust_doc.routing_state, "enabled");
        assert_eq!(trust_doc.pinned_public_key_ids, vec!["context-fixture-1"]);
    }

    #[test]
    fn hosted_context_enums_alignment() {
        let aligned_providers = [
            "anthropic",
            "claude",
            "codex",
            "gemini",
            "kimi",
            "manual",
            "openai",
            "opencode",
            "openrouter",
            "xai",
        ];
        for provider in aligned_providers {
            assert!(valid_context_provider(provider));
        }

        let unaligned_providers = ["gemini_cli", "antigravity", "grok", "moonshot", "unknown"];
        for provider in unaligned_providers {
            assert!(!valid_context_provider(provider));
        }
    }

    #[test]
    fn hosted_trust_writer_creates_secure_file_and_roundtrips() {
        let dir = crate::test_support::TempDir::new();
        let path = dir.path().join("OpenLimiter").join("hosted-trust.json");

        let key_ids = vec![
            "context-fixture-1".to_string(),
            "context-fixture-2".to_string(),
        ];
        write_hosted_trust_to_path(
            &path,
            "account-fixture",
            "33333333-3333-4333-8333-333333333333",
            7,
            42,
            true,
            &key_ids,
        )
        .expect("hosted trust written");

        let raw = crate::fsx::bounded_read(&path).expect("readable");
        let doc: HostedTrustDocument = serde_json::from_str(&raw).expect("valid doc");
        assert_eq!(doc.schema, HOSTED_TRUST_SCHEMA);
        assert_eq!(doc.version, HOSTED_TRUST_VERSION);
        assert_eq!(doc.account_id, "account-fixture");
        assert_eq!(doc.device_id, "33333333-3333-4333-8333-333333333333");
        assert_eq!(doc.entitlement_epoch, 7);
        assert_eq!(doc.last_verified_sequence, 42);
        assert_eq!(doc.routing_state, "enabled");
        assert_eq!(doc.pinned_public_key_ids, key_ids);

        // Disabled routing state
        write_hosted_trust_to_path(
            &path,
            "account-fixture",
            "33333333-3333-4333-8333-333333333333",
            7,
            42,
            false,
            &key_ids,
        )
        .expect("hosted trust written disabled");
        let raw_disabled = crate::fsx::bounded_read(&path).expect("readable");
        let doc_disabled: HostedTrustDocument =
            serde_json::from_str(&raw_disabled).expect("valid doc disabled");
        assert_eq!(doc_disabled.routing_state, "disabled");

        // Invalid account id rejected
        assert_eq!(
            write_hosted_trust_to_path(
                &path,
                "INVALID_ACCOUNT",
                "33333333-3333-4333-8333-333333333333",
                7,
                42,
                true,
                &key_ids,
            ),
            Err(ProFailure::InvalidInput)
        );

        // Invalid device id rejected
        assert_eq!(
            write_hosted_trust_to_path(
                &path,
                "account-fixture",
                "not-a-uuid",
                7,
                42,
                true,
                &key_ids,
            ),
            Err(ProFailure::InvalidInput)
        );

        // Empty key ids rejected
        assert_eq!(
            write_hosted_trust_to_path(
                &path,
                "account-fixture",
                "33333333-3333-4333-8333-333333333333",
                7,
                42,
                true,
                &[],
            ),
            Err(ProFailure::InvalidInput)
        );
    }

    /* ------------------------------------------------ the 2.0.3 token contract */

    const TEST_KID: &str = "test";
    const DAY: i64 = 86_400;

    fn test_key() -> SigningKey {
        SigningKey::from_bytes(&[9_u8; 32])
    }

    fn test_keys() -> HashMap<String, VerifyingKey> {
        HashMap::from([(TEST_KID.to_string(), test_key().verifying_key())])
    }

    /// The claims `issue_device_token_v2` builds for a desktop grant, field for
    /// field (`openlimiter-pro` migration `20260908150000_cli_delivery_proof.sql`):
    /// every deadline is clipped at `access_end`, and `interval` is null unless
    /// the entitlement row says month or year.
    fn issued(now: i64, access_end: i64, plan_state: &str, interval: Option<&str>) -> Value {
        json!({
            "ver": 2,
            "iss": "openlimiter-pro",
            "aud": "desktop",
            "scope": "full",
            "sub": ACCOUNT_ID,
            "device_id": DEVICE_ID,
            "jti": "00000000-0000-4000-8000-000000000002",
            "seq": 4,
            "iat": now,
            "nbf": now,
            "exp": (now + 86_400).min(access_end),
            "refresh_after": (now + 43_200).min(access_end),
            "grace_until": (now + 259_200).min(access_end),
            "server_time": now,
            "revocation_epoch": 2,
            "features": ["alerts", "api_spend_beta", "history", "multi_account", "routing", "theme_preset"],
            "plan_state": plan_state,
            "interval": interval,
        })
    }

    /// Signed the way `signClaims` signs: compact JSON header and payload,
    /// base64url without padding, Ed25519 over `header.payload`.
    fn signed_with(claims: &Value, key: &SigningKey) -> String {
        let header = URL_SAFE_NO_PAD.encode(
            json!({ "alg": "EdDSA", "kid": TEST_KID, "typ": "OLP2" })
                .to_string()
                .as_bytes(),
        );
        let payload = URL_SAFE_NO_PAD.encode(claims.to_string().as_bytes());
        let input = format!("{header}.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(key.sign(input.as_bytes()).to_bytes());
        format!("{input}.{signature}")
    }

    fn verify(claims: &Value) -> Result<VerifiedToken, ProFailure> {
        verify_token_with_keys(&signed_with(claims, &test_key()), &test_keys())
    }

    fn with(mut claims: Value, field: &str, value: Value) -> Value {
        claims[field] = value;
        claims
    }

    fn state_at(claims: &Value, now: i64, at: i64) -> ProEntitlementState {
        let token = verify(claims).expect("a valid signed token");
        status_for(&token, &trust(now), at).expect("a status").state
    }

    #[test]
    fn a_new_trial_token_with_a_null_interval_unlocks_pro() {
        let now = 1_800_000_000;
        let claims = issued(now, now + 30 * DAY, "trialing", None);
        let token = verify(&claims).expect("a new trial token verifies");
        let status = status_for(&token, &trust(now), now).expect("a status");
        assert_eq!(status.state, ProEntitlementState::Active);
        assert_eq!(status.plan_state.as_deref(), Some("trialing"));
        assert_eq!(status.features, EntitlementFeature::ALL.to_vec());
    }

    #[test]
    fn the_last_day_of_a_trial_verifies_with_every_deadline_clipped() {
        let now = 1_800_000_000;
        let ends = now + 3_600;
        let claims = issued(now, ends, "trialing", None);
        assert_eq!(claims["refresh_after"], ends);
        assert_eq!(claims["exp"], ends);
        assert_eq!(claims["grace_until"], ends);
        assert_eq!(state_at(&claims, now, now), ProEntitlementState::Active);
        assert_eq!(
            state_at(&claims, now, ends - 1),
            ProEntitlementState::Active
        );
        assert_eq!(state_at(&claims, now, ends), ProEntitlementState::Expired);

        /* Two days left clips grace only. */
        let two_days = issued(now, now + 2 * DAY, "trialing", None);
        assert_eq!(two_days["grace_until"], now + 2 * DAY);
        assert_eq!(state_at(&two_days, now, now), ProEntitlementState::Active);
    }

    #[test]
    fn a_paid_renewal_verifies_whole_and_near_the_period_end() {
        let now = 1_800_000_000;
        for interval in ["monthly", "annual"] {
            let renewal = issued(now, now + 20 * DAY, "active", Some(interval));
            assert_eq!(state_at(&renewal, now, now), ProEntitlementState::Active);
        }
        let last_hours = issued(now, now + 30_000, "active", Some("monthly"));
        assert_eq!(state_at(&last_hours, now, now), ProEntitlementState::Active);
        assert_eq!(
            state_at(&last_hours, now, now + 30_000),
            ProEntitlementState::Expired
        );
    }

    #[test]
    fn a_past_due_token_is_entitled_inside_its_signed_window_only() {
        let now = 1_800_000_000;
        let claims = issued(now, now + 2 * DAY, "past_due", Some("monthly"));
        let token = verify(&claims).expect("a past due token verifies");
        let inside = status_for(&token, &trust(now), now).expect("a status");
        assert_eq!(inside.state, ProEntitlementState::Active);
        assert_eq!(inside.plan_state.as_deref(), Some("past_due"));
        assert!(!inside.features.is_empty());
        let outside = status_for(&token, &trust(now), now + 2 * DAY).expect("a status");
        assert_eq!(outside.state, ProEntitlementState::Expired);
        assert!(outside.features.is_empty());
    }

    #[test]
    fn a_null_interval_outside_a_trial_fails_closed() {
        let now = 1_800_000_000;
        for plan_state in ["active", "past_due"] {
            let claims = issued(now, now + 20 * DAY, plan_state, None);
            assert_eq!(verify(&claims).err(), Some(ProFailure::InvalidEntitlement));
        }
        let unknown = issued(now, now + 20 * DAY, "trialing", Some("weekly"));
        assert_eq!(verify(&unknown).err(), Some(ProFailure::InvalidEntitlement));
        let mut missing = issued(now, now + 20 * DAY, "trialing", None);
        missing.as_object_mut().expect("claims").remove("interval");
        assert_eq!(verify(&missing).err(), Some(ProFailure::InvalidEntitlement));
    }

    #[test]
    fn a_bad_signature_fails_closed() {
        let now = 1_800_000_000;
        let claims = issued(now, now + 30 * DAY, "trialing", None);
        let foreign = SigningKey::from_bytes(&[10_u8; 32]);
        assert_eq!(
            verify_token_with_keys(&signed_with(&claims, &foreign), &test_keys()).err(),
            Some(ProFailure::InvalidEntitlement)
        );
        let token = signed_with(&claims, &test_key());
        let mut parts = token.split('.').map(str::to_string).collect::<Vec<_>>();
        parts[1] = URL_SAFE_NO_PAD.encode(
            with(claims, "plan_state", json!("active"))
                .to_string()
                .as_bytes(),
        );
        assert_eq!(
            verify_token_with_keys(&parts.join("."), &test_keys()).err(),
            Some(ProFailure::InvalidEntitlement)
        );
    }

    #[test]
    fn the_wrong_audience_scope_account_or_device_fails_closed() {
        let now = 1_800_000_000;
        let base = issued(now, now + 30 * DAY, "trialing", None);
        for (aud, scope) in [("phone", "read"), ("cli", "sync"), ("desktop", "read")] {
            let claims = with(with(base.clone(), "aud", json!(aud)), "scope", json!(scope));
            assert_eq!(verify(&claims).err(), Some(ProFailure::InvalidEntitlement));
        }
        let other = "00000000-0000-4000-8000-000000000009";
        for field in ["sub", "device_id"] {
            let token = verify(&with(base.clone(), field, json!(other))).expect("signed");
            assert_eq!(
                status_for(&token, &trust(now), now).err(),
                Some(ProFailure::InvalidEntitlement)
            );
            assert_eq!(
                verify(&with(base.clone(), field, json!("not-a-uuid"))).err(),
                Some(ProFailure::InvalidEntitlement)
            );
        }
    }

    #[test]
    fn an_older_sequence_or_revocation_epoch_fails_closed() {
        let now = 1_800_000_000;
        let token = verify(&issued(now, now + 30 * DAY, "trialing", None)).expect("signed");
        let mut newer_sequence = trust(now);
        newer_sequence.highest_sequence = 5;
        assert_eq!(
            status_for(&token, &newer_sequence, now).err(),
            Some(ProFailure::InvalidEntitlement)
        );
        let mut newer_epoch = trust(now);
        newer_epoch.highest_revocation_epoch = 3;
        assert_eq!(
            status_for(&token, &newer_epoch, now).err(),
            Some(ProFailure::InvalidEntitlement)
        );
    }

    #[test]
    fn a_clock_rollback_fails_closed() {
        let now = 1_800_000_000;
        let token = verify(&issued(now, now + 30 * DAY, "trialing", None)).expect("signed");
        assert_eq!(
            status_for(&token, &trust(now), now - CLOCK_TOLERANCE_SECONDS - 1).err(),
            Some(ProFailure::ClockInvalid)
        );
    }

    #[test]
    fn overflowing_claims_fail_closed_without_panicking() {
        let now = 1_800_000_000;
        let base = claims(now);
        let cases: [fn(&mut EntitlementClaims); 6] = [
            |c| c.server_time = i64::MIN,
            |c| c.iat = i64::MIN,
            |c| c.iat = i64::MAX,
            |c| c.nbf = i64::MIN,
            |c| c.grace_until = i64::MAX,
            |c| {
                c.iat = i64::MAX;
                c.server_time = i64::MIN;
            },
        ];
        for mutate in cases {
            let mut claims = base.clone();
            mutate(&mut claims);
            let outcome = std::panic::catch_unwind(|| validate_claim_shape(&claims));
            assert_eq!(
                outcome.expect("validation never panics"),
                Err(ProFailure::InvalidEntitlement)
            );
        }
    }

    #[test]
    fn reversed_or_excessive_deadlines_fail_closed() {
        let now = 1_800_000_000;
        let base = issued(now, now + 30 * DAY, "active", Some("monthly"));
        let refuse = |claims: Value| {
            assert_eq!(verify(&claims).err(), Some(ProFailure::InvalidEntitlement));
        };
        /* Reversed. */
        refuse(with(base.clone(), "refresh_after", json!(now)));
        refuse(with(base.clone(), "refresh_after", json!(now - 1)));
        refuse(with(
            with(base.clone(), "refresh_after", json!(now + 50_000)),
            "exp",
            json!(now + 40_000),
        ));
        refuse(with(base.clone(), "grace_until", json!(now + 80_000)));
        /* Excessive. */
        refuse(with(base.clone(), "refresh_after", json!(now + 43_201)));
        refuse(with(base.clone(), "exp", json!(now + 86_401)));
        refuse(with(base.clone(), "grace_until", json!(now + 259_201)));
        refuse(with(base.clone(), "nbf", json!(now + 1)));
        refuse(with(base.clone(), "nbf", json!(now - 301)));
        refuse(with(base.clone(), "server_time", json!(now + 301)));
        refuse(with(base, "server_time", json!(now - 301)));
    }

    #[test]
    fn deadlines_that_break_the_minimum_rule_fail_closed() {
        let now = 1_800_000_000;
        let whole = issued(now, now + 30 * DAY, "active", Some("monthly"));
        let refuse = |claims: Value| {
            assert_eq!(verify(&claims).err(), Some(ProFailure::InvalidEntitlement));
        };
        refuse(with(whole.clone(), "refresh_after", json!(now + 43_199)));
        refuse(with(whole, "exp", json!(now + 86_399)));
        /* Clipped grace: refresh and expiry must sit exactly on it. */
        let clipped = issued(now, now + 3_600, "trialing", None);
        refuse(with(clipped.clone(), "refresh_after", json!(now + 3_599)));
        refuse(with(clipped, "exp", json!(now + 3_599)));
        let one_day = issued(now, now + 50_000, "trialing", None);
        assert_eq!(one_day["refresh_after"], now + 43_200);
        assert!(verify(&one_day).is_ok());
        refuse(with(one_day, "exp", json!(now + 43_200)));
    }

    #[test]
    fn access_ends_exactly_at_grace_until() {
        let now = 1_800_000_000;
        let token = verified(now);
        let trust = trust(now);
        let grace = token.claims.grace_until;
        assert_eq!(
            status_for(&token, &trust, grace - 1).unwrap().state,
            ProEntitlementState::Grace
        );
        let ended = status_for(&token, &trust, grace).unwrap();
        assert_eq!(ended.state, ProEntitlementState::Expired);
        assert!(ended.features.is_empty());
    }

    #[test]
    fn replaying_an_accepted_token_never_winds_the_clock_back_or_resets_failures() {
        let now = 1_800_000_000;
        let token = verified(now);
        let mut trust = trust(now);
        trust.consecutive_refresh_failures = 3;
        let later = now + 10 * 3_600;
        let before = effective_time(&trust, later).expect("effective time");
        adopt_token(&mut trust, &token.claims, later);
        assert_eq!(effective_time(&trust, later), Ok(before));
        assert_eq!(trust.consecutive_refresh_failures, 3);
        assert_eq!(
            status_for(&token, &trust, now + 12 * 3_600 + 1)
                .unwrap()
                .state,
            ProEntitlementState::RefreshDue
        );
    }

    #[test]
    fn an_idempotent_retry_is_accepted_without_extra_time() {
        let now = 1_800_000_000;
        let mut trust = trust(now);
        trust.pending_request_id = Some("00000000-0000-4000-8000-000000000005".to_string());
        trust.consecutive_refresh_failures = 3;
        /* Issued an hour in, its answer lost, the same request retried ten
        hours in: the server hands back the very same claims. */
        let mut retried = verified(now + 3_600);
        retried.claims.seq = 5;
        let later = now + 10 * 3_600;
        adopt_token(&mut trust, &retried.claims, later);
        assert_eq!(trust.highest_sequence, 5);
        assert_eq!(trust.pending_request_id, None);
        assert_eq!(trust.consecutive_refresh_failures, 0);
        assert_eq!(effective_time(&trust, later), Ok(later));
        let refresh_due = retried.claims.refresh_after + 1;
        assert_eq!(
            status_for(&retried, &trust, refresh_due).unwrap().state,
            ProEntitlementState::RefreshDue
        );
    }

    #[test]
    fn a_first_token_anchors_to_server_time_not_the_local_clock() {
        let now = 1_800_000_000;
        let token = verified(now);
        let mut fresh = TrustState::new(ACCOUNT_ID.to_string());
        fresh.device_id = DEVICE_ID.to_string();
        adopt_token(&mut fresh, &token.claims, now + 200);
        assert_eq!(effective_time(&fresh, now + 200), Ok(now));
    }

    #[test]
    fn a_corrected_forward_clock_jump_does_not_lock_pro() {
        let now = 1_800_000_000;
        let mut trust = trust(now);
        /* The local clock runs two days ahead while a refresh lands an hour
        in, then is put right. */
        let mut next = verified(now + 3_600);
        next.claims.seq = 5;
        adopt_token(&mut trust, &next.claims, now + 2 * DAY);
        let corrected = now + 3_600 + 60;
        assert_eq!(effective_time(&trust, corrected), Ok(corrected));
        assert_eq!(
            status_for(&next, &trust, corrected).unwrap().state,
            ProEntitlementState::Active
        );
    }

    #[test]
    fn a_crash_recovered_token_keeps_the_clock_moving_forward() {
        let store = InMemorySecrets::new();
        let real_now = now_seconds().expect("clock");
        let issued_at = real_now - 10 * 3_600;
        let mut trust = trust(issued_at);
        trust.pending_request_id = Some("00000000-0000-4000-8000-000000000005".to_string());
        let mut token = verified(issued_at);
        token.claims.seq = 5;
        reconcile_cached_token(&store, &mut trust, &token).expect("reconciled");
        let after = now_seconds().expect("clock");
        assert!(effective_time(&trust, after).expect("effective") >= after);
    }

    #[test]
    fn account_status_is_readable_without_pro_and_reads_trial_state() {
        assert!(!ProAction::AccountStatus.needs_entitlement());
        for action in [ProAction::History, ProAction::HostedContext] {
            assert!(action.needs_entitlement());
        }
        assert_eq!(
            service_request(ProAction::AccountStatus, Map::new(), DEVICE_ID),
            ("/entitlement", json!({ "action": "status" }))
        );
        assert_eq!(
            validate_device_action_payload(
                ProAction::AccountStatus,
                &mut Map::from_iter([("admin".to_string(), json!(true))])
            ),
            Err(ProFailure::InvalidInput)
        );
    }

    #[test]
    fn a_device_never_issued_a_token_registers_before_the_first_issue() {
        let request = "00000000-0000-4000-8000-000000000005";
        let fresh = TrustState {
            highest_sequence: 0,
            ..trust(1_800_000_000)
        };
        let bodies = issue_requests(&fresh, request, None);
        assert_eq!(bodies.len(), 2);
        assert_eq!(bodies[0]["action"], "register");
        assert_eq!(bodies[0]["device_id"], DEVICE_ID);
        assert_eq!(bodies[0]["label"], DEVICE_LABEL);
        assert_eq!(
            bodies[0]["client_version"],
            crate::account::client_version()
        );
        assert_eq!(
            bodies[1],
            json!({ "device_id": DEVICE_ID, "request_id": request, "previous_jti": null })
        );

        let returning = issue_requests(&trust(1_800_000_000), request, Some(DEVICE_ID));
        assert_eq!(returning.len(), 1);
        assert_eq!(returning[0]["request_id"], request);
    }

    #[test]
    fn a_refused_refresh_keeps_the_grant_chain_so_a_later_purchase_unlocks() {
        let now = 1_800_000_000;
        let token = verified(now);
        let mut trust = TrustState {
            highest_sequence: 3,
            ..trust(now)
        };
        adopt_token(&mut trust, &token.claims, now);
        assert_eq!(
            previous_jti(Some(&token), &trust),
            Some(token.claims.jti.clone())
        );
        /* The trial ends: the issuer answers 403, the cached token is
        deleted, and the pending request still names the token it replaces.
        The server's grant still holds that jti, so the retry after a
        purchase must name it too. */
        trust.pending_request_id = Some("00000000-0000-4000-8000-000000000005".to_string());
        trust.pending_previous_jti = Some(token.claims.jti.clone());
        assert_eq!(previous_jti(None, &trust), trust.pending_previous_jti);
    }

    /* ------------------------------------- 2.0.3 round two: Pro fully working */

    const OTHER_DEVICE: &str = "00000000-0000-4000-8000-000000000009";
    /// A usage account as sync uploads it, distinct from the login id.
    const USAGE_ACCOUNT: &str = "claude-personal";
    const FIXTURE_LOGIN: &str = "00000000-0000-4000-8000-0000000000aa";

    fn payload(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("an object payload")
    }

    /// Every desktop action, checked against the dispatchers in `openlimiter-pro`:
    /// `functions/entitlement/index.ts` (status, rename, revoke, revoke_others)
    /// and `functions/pro-service/index.ts` (the feature actions).
    #[test]
    fn every_action_reaches_the_server_under_its_own_name_and_shape() {
        let preference = json!({
            "channel": "push",
            "enabled": true,
            "time_zone": "UTC",
            "quiet_start": "22:00",
            "quiet_end": "07:00",
            "snoozed_until": null,
        });
        let mut saved = preference.clone();
        saved["action"] = json!("save_notification_preference");
        let cases = [
            (
                ProAction::AccountStatus,
                json!({}),
                "/entitlement",
                json!({ "action": "status" }),
            ),
            (
                ProAction::DeviceStatus,
                json!({}),
                "/entitlement",
                json!({ "action": "status", "device_id": DEVICE_ID }),
            ),
            (
                ProAction::RenameDevice,
                json!({ "device_id": OTHER_DEVICE, "label": "Studio" }),
                "/entitlement",
                json!({ "action": "rename", "device_id": OTHER_DEVICE, "label": "Studio" }),
            ),
            (
                ProAction::RevokeDevice,
                json!({ "device_id": OTHER_DEVICE }),
                "/entitlement",
                json!({ "action": "revoke", "device_id": OTHER_DEVICE }),
            ),
            (
                ProAction::RevokeOtherDevices,
                json!({}),
                "/entitlement",
                json!({ "action": "revoke_others", "device_id": DEVICE_ID }),
            ),
            (
                ProAction::History,
                json!({ "days": 30 }),
                "/pro-service",
                json!({ "action": "history", "days": 30 }),
            ),
            (
                ProAction::SaveNotificationPreference,
                preference,
                "/pro-service",
                saved,
            ),
            (
                ProAction::ListNotificationPreferences,
                json!({}),
                "/pro-service",
                json!({ "action": "list_notification_preferences" }),
            ),
            (
                ProAction::HostedContext,
                json!({ "account_id": USAGE_ACCOUNT }),
                "/pro-service",
                json!({
                    "action": "hosted_context",
                    "device_id": DEVICE_ID,
                    "account_id": USAGE_ACCOUNT,
                }),
            ),
        ];
        for (action, sent, path, body) in cases {
            assert_eq!(
                service_request(action, payload(sent), DEVICE_ID),
                (path, body),
                "{action:?}"
            );
        }
        /* Actions the server no longer has, or never had, are not accepted
        from the window at all. */
        for gone in [
            "ingest_snapshot",
            "dispatch_alerts",
            "delete_alert_rule",
            "save_alert_rule",
            "list_alert_rules",
            "agent_context",
        ] {
            assert!(
                serde_json::from_value::<ProAction>(json!(gone)).is_err(),
                "{gone}"
            );
        }
    }

    #[test]
    fn feature_actions_carry_the_device_token_and_device_management_needs_no_pro() {
        for action in [
            ProAction::History,
            ProAction::SaveNotificationPreference,
            ProAction::ListNotificationPreferences,
            ProAction::HostedContext,
        ] {
            assert!(action.needs_entitlement(), "{action:?}");
        }
        /* Behind the gate, every feature action sends the device token that
        authorizeHostedRequest checks. */
        let source = include_str!("pro.rs");
        let call = &source[source.find("async fn service_call(").expect("service_call")..];
        let call = &call[..call
            .find(
                "
}
",
            )
            .expect("end of service_call")];
        let gate = call.find("if action.needs_entitlement()").expect("gate");
        let token = call
            .find("device_token = Some(read_cache()?")
            .expect("token read");
        let post = call
            .find("post_signed_json(path, &access_token, device_token.as_deref(), &body)")
            .expect("signed post");
        assert!(gate < token && token < post);
        for action in [
            ProAction::AccountStatus,
            ProAction::DeviceStatus,
            ProAction::RenameDevice,
            ProAction::RevokeDevice,
            ProAction::RevokeOtherDevices,
        ] {
            assert!(!action.needs_entitlement(), "{action:?}");
        }
    }

    #[test]
    fn a_hosted_refusal_never_clears_the_local_token() {
        let refusals = [
            Err(ProFailure::EntitlementRequired),
            Err(ProFailure::NoSession),
            Err(ProFailure::Service),
            Err(ProFailure::InvalidInput),
        ];
        for action in [
            ProAction::History,
            ProAction::HostedContext,
            ProAction::SaveNotificationPreference,
            ProAction::ListNotificationPreferences,
            ProAction::AccountStatus,
            ProAction::DeviceStatus,
            ProAction::RevokeOtherDevices,
        ] {
            for result in &refusals {
                assert!(!clears_local_token(action, false, result), "{action:?}");
            }
        }
        /* Revoking the other devices leaves this one's token alone; revoking
        this very device is the one answer that ends it here. */
        assert!(!clears_local_token(
            ProAction::RevokeOtherDevices,
            false,
            &Ok(json!({ "revoked": 2 }))
        ));
        assert!(!clears_local_token(
            ProAction::RevokeDevice,
            false,
            &Ok(json!({ "revoked": true }))
        ));
        assert!(clears_local_token(
            ProAction::RevokeDevice,
            true,
            &Ok(json!({ "revoked": true }))
        ));
        assert!(!clears_local_token(
            ProAction::RevokeDevice,
            true,
            &Err(ProFailure::Service)
        ));
    }

    #[test]
    fn the_device_list_reaches_the_window_in_its_own_shape() {
        let answer = json!({
            "entitlement": null,
            "devices": [
                {
                    "device_id": DEVICE_ID,
                    "label": "Desktop",
                    "created_at": "2026-09-01T10:00:00+00:00",
                    "last_seen_at": "2026-09-30T12:00:00.5+00:00",
                    "is_current": true,
                    "revoked": false,
                    "updated_at": "2026-09-30T12:00:00+00:00",
                },
                {
                    "device_id": OTHER_DEVICE,
                    "label": "Pixel",
                    "created_at": "2026-09-02T10:00:00+00:00",
                    "last_seen_at": null,
                    "is_current": false,
                    "revoked": false,
                    "updated_at": "2026-09-02T10:00:00+00:00",
                },
                {
                    "device_id": "00000000-0000-4000-8000-00000000000a",
                    "label": "Old laptop",
                    "created_at": "2026-08-01T10:00:00+00:00",
                    "last_seen_at": "2026-08-02T10:00:00+00:00",
                    "is_current": false,
                    "revoked": true,
                    "updated_at": "2026-08-03T10:00:00+00:00",
                },
            ],
        });
        assert_eq!(
            device_list(answer),
            json!({
                "devices": [
                    {
                        "id": DEVICE_ID,
                        "name": "Desktop",
                        "current": true,
                        "last_seen_at": 1_790_769_600_500_i64,
                    },
                    { "id": OTHER_DEVICE, "name": "Pixel", "current": false, "last_seen_at": null },
                ],
            })
        );
    }

    #[test]
    fn a_comped_token_unlocks_pro() {
        let now = 1_800_000_000;
        /* The issuer sets access_end to now plus 259200 for comped, so a
        comped token is never clipped. */
        for interval in [None, Some("monthly"), Some("annual")] {
            let claims = issued(now, now + 259_200, "comped", interval);
            let token = verify(&claims).expect("a comped token verifies");
            let status = status_for(&token, &trust(now), now).expect("a status");
            assert_eq!(status.state, ProEntitlementState::Active);
            assert_eq!(status.plan_state.as_deref(), Some("comped"));
            assert_eq!(status.features, EntitlementFeature::ALL.to_vec());
        }
    }

    #[test]
    fn a_comped_token_with_clipped_deadlines_fails_closed() {
        let now = 1_800_000_000;
        for access_end in [now + 3_600, now + 2 * DAY] {
            let claims = issued(now, access_end, "comped", None);
            assert_eq!(verify(&claims).err(), Some(ProFailure::InvalidEntitlement));
        }
        let weekly = issued(now, now + 259_200, "comped", Some("weekly"));
        assert_eq!(verify(&weekly).err(), Some(ProFailure::InvalidEntitlement));
        for plan_state in ["canceled", "expired", "refunded", "revoked", "deleted"] {
            let claims = issued(now, now + 259_200, plan_state, Some("monthly"));
            assert_eq!(verify(&claims).err(), Some(ProFailure::InvalidEntitlement));
        }
    }

    #[test]
    fn a_request_left_pending_past_its_24_hour_life_is_replaced() {
        assert_eq!(
            entitlement_conflict(&json!({ "error": "token request expired" })),
            ProFailure::TokenRequestExpired
        );
        for body in [
            json!({ "error": "stale entitlement token" }),
            json!({ "error": "entitlement epoch changed" }),
        ] {
            assert_eq!(entitlement_conflict(&body), ProFailure::StaleGrant);
        }
        assert_eq!(
            entitlement_conflict(&json!({ "error": "device cap reached", "device_cap": 5 })),
            ProFailure::DeviceCapReached
        );
        for body in [
            json!("token request expired"),
            Value::Null,
            json!({ "error": "other" }),
        ] {
            assert_eq!(entitlement_conflict(&body), ProFailure::Service);
        }

        /* A refresh goes out, its answer is lost, and the machine stays
        offline for more than a day. The retry of that same request is
        answered "token request expired"; the next refresh must not send it
        again. */
        let now = 1_800_000_000;
        let mut trust = trust(now);
        let previous = "00000000-0000-4000-8000-000000000002";
        let (stale, created) = pending_request(&mut trust, Some(previous)).expect("a request");
        assert!(created);
        let (retried, created) = pending_request(&mut trust, Some(previous)).expect("a retry");
        assert_eq!((retried.as_str(), created), (stale.as_str(), false));
        drop_expired_request(&mut trust);
        let (fresh, created) = pending_request(&mut trust, Some(previous)).expect("a fresh one");
        assert!(created);
        assert_ne!(fresh, stale);
        assert_eq!(trust.pending_previous_jti.as_deref(), Some(previous));
        assert_eq!(
            issue_requests(&trust, &fresh, Some(previous))[0]["request_id"],
            fresh
        );
    }

    #[test]
    fn the_last_accepted_jti_survives_a_cleared_cache() {
        let now = 1_800_000_000;
        let token = verified(now);
        let mut trust = TrustState {
            highest_sequence: 3,
            ..trust(now)
        };
        adopt_token(&mut trust, &token.claims, now);
        /* A refusal outside the issue path, or a corrupt cache, deletes the
        token with no request pending. */
        assert_eq!(trust.pending_request_id, None);
        assert_eq!(previous_jti(None, &trust), Some(token.claims.jti.clone()));
        let store = InMemorySecrets::new();
        save_trust(&store, &trust).expect("trust stored");
        let loaded = load_trust(&store, ACCOUNT_ID).expect("trust read back");
        assert_eq!(previous_jti(None, &loaded), Some(token.claims.jti));
    }

    #[test]
    fn a_trust_record_written_by_2_0_2_still_loads() {
        let raw = format!(
            r#"{{"version":2,"account_id":"{ACCOUNT_ID}","device_id":"{DEVICE_ID}","highest_sequence":4,"highest_revocation_epoch":2,"highest_context_sequence":0,"last_context_event_id":null,"highest_server_time":1800000000,"anchor_local_time":1800000000,"consecutive_refresh_failures":0,"pending_request_id":null,"pending_previous_jti":null}}"#
        );
        let store = InMemorySecrets::new();
        store
            .store_secret(TRUST_CREDENTIAL_ID, &raw)
            .expect("2.0.2 trust stored");
        let trust = load_trust(&store, ACCOUNT_ID).expect("2.0.2 trust loads");
        assert_eq!(trust.device_id, DEVICE_ID);
        assert_eq!(trust.highest_sequence, 4);
        assert_eq!(previous_jti(None, &trust), None);
    }

    #[test]
    fn only_the_issuer_refusing_a_refresh_ends_the_local_token() {
        assert!(refresh_failure_clears_token(
            ProFailure::EntitlementRequired
        ));
        for error in [
            ProFailure::NoSession,
            ProFailure::InvalidEntitlement,
            ProFailure::Network,
            ProFailure::Service,
            ProFailure::DeviceCapReached,
            ProFailure::TokenRequestExpired,
            ProFailure::ClockInvalid,
            ProFailure::CredentialStore,
        ] {
            assert!(!refresh_failure_clears_token(error), "{error:?}");
        }
    }

    /* ------------------------------------- 2.0.3 round three: recovery, scope */

    #[derive(Default)]
    struct ModelGrant {
        revoked: bool,
        last_jti: Option<String>,
        seq: u64,
    }

    /// The chain rules of `issue_device_token_v2` (`openlimiter-pro` migration
    /// `20260908150000_cli_delivery_proof.sql`) and the register and revoke
    /// actions of the `entitlement` function, with its 409 bodies, in memory.
    struct ModelIssuer {
        now: i64,
        epoch: u64,
        grants: HashMap<String, ModelGrant>,
        issues: HashMap<String, Value>,
        lose_next_answer: bool,
        actions: Vec<String>,
    }

    impl ModelIssuer {
        fn new(now: i64) -> Self {
            Self {
                now,
                epoch: 2,
                grants: HashMap::new(),
                issues: HashMap::new(),
                lose_next_answer: false,
                actions: Vec::new(),
            }
        }

        fn conflict(error: &str) -> Result<Value, ProFailure> {
            Err(entitlement_conflict(&json!({ "error": error })))
        }

        fn handle(&mut self, body: Value) -> Result<Value, ProFailure> {
            let device = body["device_id"].as_str().expect("a device").to_string();
            let action = body
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("issue")
                .to_string();
            self.actions.push(format!("{action} {device}"));
            match action.as_str() {
                "register" => match self.grants.get(&device) {
                    Some(grant) if grant.revoked => Err(ProFailure::Service),
                    Some(_) => Ok(json!({ "device": { "created": false } })),
                    None if self.grants.values().filter(|g| !g.revoked).count() >= 5 => {
                        Self::conflict("device cap reached")
                    }
                    None => {
                        self.grants.insert(device, ModelGrant::default());
                        Ok(json!({ "device": { "created": true } }))
                    }
                },
                "revoke" => {
                    let revoked = self.grants.get_mut(&device).is_some_and(|grant| {
                        let was_live = !grant.revoked;
                        grant.revoked = true;
                        was_live
                    });
                    Ok(json!({ "revoked": revoked }))
                }
                "issue" => self.issue(device, &body),
                other => panic!("the desktop sent an unknown action {other}"),
            }
        }

        fn issue(&mut self, device: String, body: &Value) -> Result<Value, ProFailure> {
            let (now, epoch) = (self.now, self.epoch);
            let Some(grant) = self.grants.get_mut(&device).filter(|grant| !grant.revoked) else {
                return Err(ProFailure::EntitlementRequired);
            };
            let request = body["request_id"].as_str().expect("a request").to_string();
            if let Some(claims) = self.issues.get(&request) {
                if claims["revocation_epoch"] != json!(epoch) {
                    return Self::conflict("entitlement epoch changed");
                }
                if claims["exp"].as_i64().expect("exp") <= now {
                    return Self::conflict("token request expired");
                }
                if grant.last_jti.as_deref() != claims["jti"].as_str() {
                    return Self::conflict("stale entitlement token");
                }
                return Ok(json!({ "token": signed_with(claims, &test_key()) }));
            }
            if grant.last_jti.as_deref() != body["previous_jti"].as_str() {
                return Self::conflict("stale entitlement token");
            }
            let jti = uuid::Uuid::new_v4().to_string();
            grant.seq += 1;
            grant.last_jti = Some(jti.clone());
            let mut claims = issued(now, now + 30 * DAY, "active", Some("monthly"));
            claims["device_id"] = json!(device);
            claims["jti"] = json!(jti);
            claims["seq"] = json!(grant.seq);
            claims["revocation_epoch"] = json!(epoch);
            self.issues.insert(request, claims.clone());
            if std::mem::take(&mut self.lose_next_answer) {
                return Err(ProFailure::Network);
            }
            Ok(json!({ "token": signed_with(&claims, &test_key()) }))
        }

        /// A day passes for every issued request.
        fn expire_issued(&mut self) {
            let past = self.now - 1;
            for claims in self.issues.values_mut() {
                claims["exp"] = json!(past);
            }
        }
    }

    async fn refresh_against(
        store: &InMemorySecrets,
        model: &std::cell::RefCell<ModelIssuer>,
    ) -> Result<ProStatus, ProFailure> {
        refresh_with(store, &test_keys(), |body| {
            let answer = model.borrow_mut().handle(body);
            async move { answer }
        })
        .await
    }

    #[tokio::test]
    async fn a_delayed_refresh_cannot_replace_a_newer_token() {
        let now = now_seconds().expect("clock");
        let store = session_store(now);
        let keys = test_keys();
        let first_jti = "00000000-0000-4000-8000-000000000011";
        let second_jti = "00000000-0000-4000-8000-000000000012";
        let response = |body: &Value, sequence: u64, jti: &str| {
            if body.get("action").and_then(Value::as_str) == Some("register") {
                return json!({ "device": { "created": true } });
            }
            let mut claims = issued(now, now + 30 * DAY, "active", Some("monthly"));
            claims["device_id"] = body["device_id"].clone();
            claims["jti"] = json!(jti);
            claims["seq"] = json!(sequence);
            json!({ "token": signed_with(&claims, &test_key()) })
        };
        let (a_pending_tx, a_pending_rx) = tokio::sync::oneshot::channel();
        let (release_a_tx, release_a_rx) = tokio::sync::oneshot::channel();

        let delayed = async {
            let mut a_pending_tx = Some(a_pending_tx);
            let mut release_a_rx = Some(release_a_rx);
            refresh_with(&store, &keys, |body| {
                let wait = body.get("action").is_none();
                let pending = wait.then(|| a_pending_tx.take().expect("one issue request"));
                let release = wait.then(|| release_a_rx.take().expect("one release"));
                let answer = response(&body, 1, first_jti);
                async move {
                    if let Some(pending) = pending {
                        pending.send(()).expect("the coordinator is waiting");
                    }
                    if let Some(release) = release {
                        release.await.expect("the delayed answer is released");
                    }
                    Ok(answer)
                }
            })
            .await
        };
        let advance = async {
            a_pending_rx.await.expect("A reached the issuer");
            let first = refresh_with(&store, &keys, |body| {
                let answer = response(&body, 1, first_jti);
                async move { Ok(answer) }
            })
            .await
            .expect("B commits T1");
            assert_eq!(first.sequence, Some(1));
            let second = refresh_with(&store, &keys, |body| {
                let answer = response(&body, 2, second_jti);
                async move { Ok(answer) }
            })
            .await
            .expect("C commits T2");
            assert_eq!(second.sequence, Some(2));
            release_a_tx.send(()).expect("A is still pending");
        };

        let (delayed_result, ()) = tokio::join!(delayed, advance);
        assert_eq!(delayed_result, Err(ProFailure::InvalidEntitlement));
        let trust = load_trust(&store, ACCOUNT_ID).expect("final trust");
        assert_eq!(trust.highest_sequence, 2);
        assert_eq!(trust.last_jti.as_deref(), Some(second_jti));
        let cache = read_cache().expect("cache").expect("cached T2");
        let token = verify_token_with_keys(&cache.token, &keys).expect("verified cache");
        assert_eq!(token.claims.seq, 2);
        assert_eq!(token.claims.jti, second_jti);
    }

    fn device_of(store: &InMemorySecrets) -> String {
        load_trust(store, ACCOUNT_ID).expect("trust").device_id
    }

    /// Nothing the refresh sent may revoke or register: any revoke bumps the
    /// account's epoch and signs the owner's phone out.
    fn assert_no_rotation(model: &ModelIssuer, before: usize) {
        for action in &model.actions[before..] {
            assert!(
                !action.starts_with("revoke") && !action.starts_with("register"),
                "{action}"
            );
        }
    }

    #[tokio::test]
    async fn an_undelivered_token_that_expires_asks_to_sign_in_again_without_rotating() {
        let now = now_seconds().expect("clock");
        let store = session_store(now);
        let model = std::cell::RefCell::new(ModelIssuer::new(now));
        let first = refresh_against(&store, &model).await.expect("first issue");
        assert_eq!(first.state, ProEntitlementState::Active);
        let before = load_trust(&store, ACCOUNT_ID).expect("trust");

        /* The issuer advances the grant to a token whose answer never
        arrives, and the machine stays offline past that token's life. */
        model.borrow_mut().lose_next_answer = true;
        assert_eq!(
            refresh_against(&store, &model).await.err(),
            Some(ProFailure::Network)
        );
        model.borrow_mut().expire_issued();

        let sent = model.borrow().actions.len();
        assert_eq!(
            refresh_against(&store, &model).await.err(),
            Some(ProFailure::StaleGrant)
        );
        let after = load_trust(&store, ACCOUNT_ID).expect("trust");
        assert_eq!(after.device_id, before.device_id);
        assert_eq!(after.last_jti, before.last_jti);
        assert!(after.last_jti.is_some());
        assert!(!model.borrow().grants[&before.device_id].revoked);
        assert_no_rotation(&model.borrow(), sent);
        /* The expired request got its one fresh retry, then stopped. */
        assert_eq!(model.borrow().actions.len() - sent, 2);
        assert!(read_cache().expect("cache").is_some(), "the entitlement stays");
    }

    #[tokio::test]
    async fn an_epoch_change_on_a_pending_request_asks_to_sign_in_again_without_rotating() {
        let now = now_seconds().expect("clock");
        let store = session_store(now);
        let model = std::cell::RefCell::new(ModelIssuer::new(now));
        refresh_against(&store, &model).await.expect("first issue");
        let before = load_trust(&store, ACCOUNT_ID).expect("trust");
        model.borrow_mut().lose_next_answer = true;
        assert_eq!(
            refresh_against(&store, &model).await.err(),
            Some(ProFailure::Network)
        );
        model.borrow_mut().epoch = 3;

        let sent = model.borrow().actions.len();
        assert_eq!(
            refresh_against(&store, &model).await.err(),
            Some(ProFailure::StaleGrant)
        );
        let after = load_trust(&store, ACCOUNT_ID).expect("trust");
        assert_eq!(after.device_id, before.device_id);
        assert_eq!(after.last_jti, before.last_jti);
        assert!(!model.borrow().grants[&before.device_id].revoked);
        assert_no_rotation(&model.borrow(), sent);
    }

    #[test]
    fn a_trust_record_from_2_0_2_or_with_the_retired_key_still_loads() {
        let now = 1_800_000_000;
        let store = context_store(now);
        let mut record = serde_json::to_value(trust(now)).expect("JSON");
        let object = record.as_object_mut().expect("an object");
        /* 2.0.2 wrote none of the three newer keys. */
        for key in ["last_jti", "highest_context_sequence", "last_context_event_id"] {
            object.remove(key);
        }
        assert!(!object.contains_key("retired_device_id"), "never written");
        store
            .store_secret(TRUST_CREDENTIAL_ID, &record.to_string())
            .expect("stored");
        assert_eq!(load_trust(&store, ACCOUNT_ID).expect("2.0.2").device_id, DEVICE_ID);

        record["retired_device_id"] = json!(OTHER_DEVICE);
        store
            .store_secret(TRUST_CREDENTIAL_ID, &record.to_string())
            .expect("stored");
        let loaded = load_trust(&store, ACCOUNT_ID).expect("with the key");
        assert_eq!(loaded.device_id, DEVICE_ID);
        assert!(!serde_json::to_string(&loaded)
            .expect("JSON")
            .contains("retired_device_id"));
    }

    #[tokio::test]
    async fn a_real_device_cap_still_surfaces_as_the_cap() {
        let now = now_seconds().expect("clock");
        let store = session_store(now);
        let model = std::cell::RefCell::new(ModelIssuer::new(now));
        for slot in 0..5 {
            model.borrow_mut().grants.insert(
                format!("00000000-0000-4000-8000-00000000010{slot}"),
                ModelGrant::default(),
            );
        }
        let device = device_of(&store);
        assert_eq!(
            refresh_against(&store, &model).await.err(),
            Some(ProFailure::DeviceCapReached)
        );
        assert_eq!(device_of(&store), device);
        assert_eq!(model.borrow().actions, [format!("register {device}")]);
    }

    #[test]
    fn hosted_context_is_asked_for_one_usage_account() {
        let mut scoped = payload(json!({ "account_id": USAGE_ACCOUNT }));
        assert_eq!(
            validate_device_action_payload(ProAction::HostedContext, &mut scoped),
            Ok(())
        );
        for refused in [
            json!({}),
            json!({ "account_id": "Claude Personal" }),
            json!({ "account_id": USAGE_ACCOUNT, "device_id": OTHER_DEVICE }),
            json!({ "account_id": 7 }),
        ] {
            assert_eq!(
                validate_device_action_payload(ProAction::HostedContext, &mut payload(refused)),
                Err(ProFailure::InvalidInput)
            );
        }
    }

    #[test]
    fn a_context_for_another_usage_account_is_refused() {
        let now = 1_800_000_000;
        let key = SigningKey::from_bytes(&[7_u8; 32]);
        let keys = HashMap::from([("context-test".to_string(), key.verifying_key())]);
        let envelope = serde_json::to_value(hosted_context_fixture(now, &key)).expect("JSON");
        let store = context_store(now);
        for other in ["default", "codex-work", ACCOUNT_ID] {
            assert_eq!(
                validate_hosted_context_with_keys(&envelope, &store, &keys, now, Some(other)),
                Err(ProFailure::InvalidEntitlement),
                "{other}"
            );
        }
        assert!(validate_hosted_context_with_keys(
            &envelope,
            &store,
            &keys,
            now,
            Some(USAGE_ACCOUNT)
        )
        .is_ok());
        /* The device check stays: the right account on another device is refused. */
        let mut foreign = hosted_context_fixture(now, &key);
        foreign.device_id = OTHER_DEVICE.to_string();
        foreign.signature = URL_SAFE_NO_PAD.encode(
            key.sign(&canonical_context(&foreign).expect("canonical"))
                .to_bytes(),
        );
        assert_eq!(
            validate_hosted_context_with_keys(
                &serde_json::to_value(foreign).expect("JSON"),
                &store,
                &keys,
                now,
                Some(USAGE_ACCOUNT)
            ),
            Err(ProFailure::InvalidEntitlement)
        );
    }

    #[test]
    fn the_most_pressing_context_is_kept_when_several_accounts_answer() {
        let now = 1_800_000_000;
        let key = SigningKey::from_bytes(&[7_u8; 32]);
        let with_level = |account: &str, level: &str| {
            let mut envelope = hosted_context_fixture(now, &key);
            envelope.account_id = account.to_string();
            envelope.payload.meters[0].level = level.to_string();
            serde_json::to_string(&envelope).expect("JSON")
        };
        assert_eq!(
            most_pressing_context(vec![
                with_level("claude-personal", "60"),
                with_level("default", "90"),
                with_level("grok-personal", "80"),
            ]),
            Some(with_level("default", "90"))
        );
        assert_eq!(
            most_pressing_context(vec![
                with_level("claude-personal", "80"),
                with_level("default", "80")
            ]),
            Some(with_level("claude-personal", "80"))
        );
        assert_eq!(most_pressing_context(Vec::new()), None);
    }

    #[test]
    fn hosted_trust_path_resolves_platform_location() {
        let path = hosted_trust_path();
        if let Some(p) = path {
            assert!(p.ends_with(HOSTED_TRUST_FILE_NAME));
        }
        let _ = write_hosted_trust(
            "account-fixture",
            "33333333-3333-4333-8333-333333333333",
            7,
            42,
            true,
            &["context-fixture-1".to_string()],
        );
        let _ = remove_hosted_trust();
    }
}
