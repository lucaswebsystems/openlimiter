use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
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
        crate::account::AccountFailure::InvalidInput
        | crate::account::AccountFailure::Authentication
        | crate::account::AccountFailure::OauthRejected
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
    interval: String,
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
    IngestSnapshot,
    SaveAlertRule,
    DeleteAlertRule,
    ListAlertRules,
    History,
    AgentContext,
    DispatchAlerts,
    DeviceStatus,
    RenameDevice,
    RevokeDevice,
    RevokeOtherDevices,
}

impl ProAction {
    fn as_str(self) -> &'static str {
        match self {
            ProAction::AccountStatus => "account_status",
            ProAction::IngestSnapshot => "ingest_snapshot",
            ProAction::SaveAlertRule => "save_alert_rule",
            ProAction::DeleteAlertRule => "delete_alert_rule",
            ProAction::ListAlertRules => "list_alert_rules",
            ProAction::History => "history",
            ProAction::AgentContext => "agent_context",
            ProAction::DispatchAlerts => "dispatch_alerts",
            ProAction::DeviceStatus => "device_status",
            ProAction::RenameDevice => "rename_device",
            ProAction::RevokeDevice => "revoke_device",
            ProAction::RevokeOtherDevices => "revoke_other_devices",
        }
    }

    fn required_feature(self) -> Option<EntitlementFeature> {
        match self {
            Self::IngestSnapshot | Self::History => Some(EntitlementFeature::History),
            Self::SaveAlertRule
            | Self::DeleteAlertRule
            | Self::ListAlertRules
            | Self::DispatchAlerts => Some(EntitlementFeature::Alerts),
            Self::AgentContext => Some(EntitlementFeature::Routing),
            Self::AccountStatus
            | Self::DeviceStatus
            | Self::RenameDevice
            | Self::RevokeDevice
            | Self::RevokeOtherDevices => None,
        }
    }
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
    let keys = key_set()?;
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
    let lifetime = claims
        .exp
        .checked_sub(claims.iat)
        .ok_or(ProFailure::InvalidEntitlement)?;
    let refresh = claims
        .refresh_after
        .checked_sub(claims.iat)
        .ok_or(ProFailure::InvalidEntitlement)?;
    let honor = claims
        .grace_until
        .checked_sub(claims.iat)
        .ok_or(ProFailure::InvalidEntitlement)?;
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
        || lifetime != TOKEN_LIFETIME_SECONDS
        || refresh != TOKEN_REFRESH_AFTER_SECONDS
        || honor != TOKEN_HONOR_UNTIL_SECONDS
        || claims.nbf > claims.iat
        || claims.iat.checked_sub(claims.nbf).unwrap_or(i64::MAX) > CLOCK_TOLERANCE_SECONDS
        || (claims.server_time - claims.iat).abs() > CLOCK_TOLERANCE_SECONDS
        || !sorted_features
        || claims.features.as_slice() != EntitlementFeature::ALL
        || !matches!(
            claims.plan_state.as_str(),
            "trialing" | "active" | "past_due"
        )
        || !matches!(claims.interval.as_str(), "monthly" | "annual")
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
    } else if effective <= token.claims.refresh_after {
        ProEntitlementState::Active
    } else if effective <= token.claims.exp {
        ProEntitlementState::RefreshDue
    } else if effective <= token.claims.grace_until {
        ProEntitlementState::Grace
    } else {
        ProEntitlementState::Expired
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
    let local_now = now_seconds()?;
    trust.highest_sequence = token.claims.seq;
    trust.highest_revocation_epoch = trust
        .highest_revocation_epoch
        .max(token.claims.revocation_epoch);
    trust.highest_server_time = trust.highest_server_time.max(token.claims.server_time);
    trust.anchor_local_time = local_now;
    trust.consecutive_refresh_failures = 0;
    trust.pending_request_id = None;
    trust.pending_previous_jti = None;
    save_trust(store, trust)
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
    if status == reqwest::StatusCode::CONFLICT && path == "/entitlement" {
        return Err(ProFailure::DeviceCapReached);
    }
    if !status.is_success() {
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
    serde_json::from_slice::<StrictValue>(&bytes)
        .map(|value| value.0)
        .map_err(|_| ProFailure::Service)
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

fn validate_hosted_context(value: &Value, store: &dyn SecretStore) -> Result<String, ProFailure> {
    let keys = key_set()?;
    validate_hosted_context_with_keys(value, store, &keys, now_seconds()?)
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
        .and_then(|value| validate_hosted_context(&value, store));
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
    let account_id = crate::account::active_account_id(store).map_err(|_| ProFailure::NoSession)?;
    let mut trust = load_trust(store, &account_id)?;
    if envelope.account_id != account_id
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

async fn refresh(store: &dyn SecretStore) -> Result<ProStatus, ProFailure> {
    if configured_service_url().is_empty() {
        return Err(ProFailure::Unconfigured);
    }
    let access_token = crate::account::current_access_token(store)
        .await
        .map_err(map_account_failure)?;
    let account_id = crate::account::active_account_id(store).map_err(|_| ProFailure::NoSession)?;
    let mut trust = load_trust(store, &account_id)?;
    let verified_cache = match read_cache()? {
        Some(cache) => Some(verify_token(&cache.token)?),
        None => None,
    };
    if let Some(token) = &verified_cache {
        reconcile_cached_token(store, &mut trust, token)?;
    }
    let previous_jti = verified_cache
        .as_ref()
        .map(|token| token.claims.jti.clone());
    let request_id = match &trust.pending_request_id {
        Some(value) => value.clone(),
        None => {
            let value = uuid::Uuid::new_v4().to_string();
            trust.pending_request_id = Some(value.clone());
            trust.pending_previous_jti = previous_jti.clone();
            save_trust(store, &trust)?;
            value
        }
    };
    if trust.pending_previous_jti != previous_jti {
        return Err(ProFailure::InvalidEntitlement);
    }
    let response = post_json(
        "/entitlement",
        &access_token,
        &json!({
            "device_id": trust.device_id,
            "request_id": request_id,
            "previous_jti": previous_jti,
        }),
    )
    .await?;
    let token_text = response
        .get("token")
        .and_then(Value::as_str)
        .ok_or(ProFailure::Service)?;
    let token = verify_token(token_text)?;
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
    write_cache(token_text)?;
    trust.highest_sequence = token.claims.seq;
    trust.highest_revocation_epoch = trust
        .highest_revocation_epoch
        .max(token.claims.revocation_epoch);
    trust.highest_server_time = trust.highest_server_time.max(token.claims.server_time);
    trust.anchor_local_time = now_seconds()?;
    trust.consecutive_refresh_failures = 0;
    trust.pending_request_id = None;
    trust.pending_previous_jti = None;
    save_trust(store, &trust)?;
    status_for(&token, &trust, trust.anchor_local_time)
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

async fn refresh_with_failure_tracking(store: &dyn SecretStore) -> Result<ProStatus, ProFailure> {
    match refresh(store).await {
        Ok(status) => Ok(status),
        Err(error) => {
            let clear_result = if matches!(
                error,
                ProFailure::InvalidEntitlement
                    | ProFailure::EntitlementRequired
                    | ProFailure::NoSession
            ) {
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
    let status = refresh_if_due(store).await?;
    if !matches!(
        status.state,
        ProEntitlementState::Active | ProEntitlementState::RefreshDue
    ) {
        let _ = remove_state_file(AGENT_CONTEXT_FILE_NAME);
        let _ = remove_hosted_trust();
        return Err(ProFailure::EntitlementRequired);
    }
    if input
        .action
        .required_feature()
        .is_some_and(|feature| !status.features.contains(&feature))
    {
        let _ = remove_state_file(AGENT_CONTEXT_FILE_NAME);
        let _ = remove_hosted_trust();
        return Err(ProFailure::EntitlementRequired);
    }
    let action = input.action;
    let mut payload = input.payload;
    if payload.contains_key("action") {
        return Err(ProFailure::InvalidInput);
    }
    validate_device_action_payload(action, &mut payload)?;
    let revokes_current_device = action == ProAction::RevokeDevice
        && payload.get("device_id").and_then(Value::as_str) == status.device_id.as_deref();
    let revokes_any_device = matches!(
        action,
        ProAction::RevokeDevice | ProAction::RevokeOtherDevices
    );
    payload.insert(
        "action".to_string(),
        Value::String(action.as_str().to_string()),
    );
    let access_token = crate::account::current_access_token(store)
        .await
        .map_err(map_account_failure)?;
    let result = post_json("/pro-service", &access_token, &Value::Object(payload)).await;
    if matches!(
        result,
        Err(ProFailure::EntitlementRequired | ProFailure::NoSession)
    ) {
        let _ = clear_entitlement_and_context();
    }
    if result.is_ok() && revokes_any_device {
        if revokes_current_device {
            clear_local_authorization(store)?;
        } else {
            clear_entitlement_and_context()?;
        }
    }
    result
}

fn validate_device_action_payload(
    action: ProAction,
    payload: &mut Map<String, Value>,
) -> Result<(), ProFailure> {
    match action {
        ProAction::DeviceStatus | ProAction::RevokeOtherDevices => {
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

async fn sync_agent_context(store: &dyn SecretStore) -> Result<bool, ProFailure> {
    let response = service_call(
        store,
        ProServiceInput {
            action: ProAction::AgentContext,
            payload: Map::new(),
        },
    )
    .await?;
    let path = state_file(AGENT_CONTEXT_FILE_NAME)?;
    let Some(raw_context) = response.get("context") else {
        remove_state_file(AGENT_CONTEXT_FILE_NAME)?;
        remove_hosted_trust()?;
        return Ok(false);
    };
    let context = match validate_hosted_context(raw_context, store) {
        Ok(value) => value,
        Err(error) => {
            let _ = remove_state_file(AGENT_CONTEXT_FILE_NAME);
            let _ = remove_hosted_trust();
            return Err(error);
        }
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
            interval: "monthly".to_string(),
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
        let mut short_grace = claims(now);
        short_grace.grace_until -= 1;
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
        let phone: EntitlementClaims = strict_json(claims_json(now, Some("read"), "phone").as_bytes())
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
            account_id: ACCOUNT_ID.to_string(),
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
        save_trust(&store, &trust(now)).expect("trust stored");
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
            validate_hosted_context_with_keys(&unknown, &context_store(now), &keys, now),
            Err(ProFailure::Service)
        );

        let mut tampered = serde_json::to_value(&envelope).expect("JSON value");
        tampered["payload"]["meters"][0]["level"] = Value::String("80".to_string());
        assert_eq!(
            validate_hosted_context_with_keys(&tampered, &context_store(now), &keys, now),
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
                    "account_id": "account-fixture",
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
            account_id: "account-fixture".to_string(),
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
        };
        save_trust(&store, &fixture_trust).expect("trust stored");

        let validated = validate_hosted_context_with_keys(envelope_value, &store, &keys, now)
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
