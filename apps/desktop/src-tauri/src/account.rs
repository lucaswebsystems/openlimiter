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
const CONFIGURED_PROVIDERS_CREDENTIAL_ID: &str = "openlimiter-configured-providers";
const LOOPBACK_CALLBACK: &str = "http://127.0.0.1:17391/auth/callback";
const MAX_RESPONSE_BYTES: usize = 131_072;
const MAX_REQUEST_BYTES: usize = 8_192;
const NETWORK_TIMEOUT_SECONDS: u64 = 15;
const OAUTH_TIMEOUT_SECONDS: u64 = 180;

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
        persist_session(store, &session)?;
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

fn sync_device_id(store: &dyn SecretStore) -> Result<String, AccountFailure> {
    match store.read_secret(SYNC_DEVICE_CREDENTIAL_ID) {
        Ok(value) if value.starts_with("device_") && value.len() == 39 => Ok(value.to_string()),
        Ok(_) | Err(CredentialError::NotFound) => {
            let value = format!("device_{}", uuid::Uuid::new_v4().simple());
            store
                .store_secret(SYNC_DEVICE_CREDENTIAL_ID, &value)
                .map_err(|_| AccountFailure::Storage)?;
            Ok(value)
        }
        Err(CredentialError::Store) => Err(AccountFailure::Storage),
    }
}

fn sync_rows(store: &dyn SecretStore) -> Result<Vec<serde_json::Value>, AccountFailure> {
    let configured_providers = configured_providers_from(store);
    if configured_providers.is_empty() {
        return Ok(Vec::new());
    }
    let Some(raw) = crate::state::read_cache() else {
        return Ok(Vec::new());
    };
    let document: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| AccountFailure::Storage)?;
    let snapshots = document
        .get("snapshots")
        .and_then(serde_json::Value::as_array)
        .ok_or(AccountFailure::Storage)?;
    if snapshots.len() > 512 {
        return Err(AccountFailure::Storage);
    }
    let mut selected: HashMap<(String, String, String), (f64, Option<String>)> = HashMap::new();
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
        let Some(window_name) = snapshot.get("meter").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let account_label = snapshot
            .get("accountId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("default");
        let Some(usage_percent) = snapshot.get("value").and_then(serde_json::Value::as_f64) else {
            continue;
        };
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
        if !valid_code(provider, 32)
            || !valid_code(window_name, 48)
            || !valid_account(account_label)
            || !usage_percent.is_finite()
            || !(0.0..=100.0).contains(&usage_percent)
        {
            continue;
        }
        let reset_at = match snapshot.get("resetAt") {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(value))
                if value.len() <= 64
                    && time::OffsetDateTime::parse(
                        value,
                        &time::format_description::well_known::Rfc3339,
                    )
                    .is_ok() =>
            {
                Some(value.clone())
            }
            _ => continue,
        };
        let key = (
            provider.to_string(),
            account_label.to_string(),
            window_name.to_string(),
        );
        match selected.get(&key) {
            Some((current, _)) if *current >= usage_percent => {}
            _ => {
                selected.insert(key, (usage_percent, reset_at));
            }
        }
    }
    if selected.len() > 128 {
        return Err(AccountFailure::Storage);
    }
    let mut rows = selected.into_iter().collect::<Vec<_>>();
    rows.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(rows
        .into_iter()
        .map(
            |((provider, account_label, window_name), (usage_percent, reset_at))| {
                serde_json::json!({
                    "provider": provider,
                    "account_label": account_label,
                    "window_name": window_name,
                    "usage_percent": usage_percent,
                    "reset_at": reset_at,
                })
            },
        )
        .collect())
}

pub(crate) async fn sync_snapshot(store: &dyn SecretStore) -> Result<bool, AccountFailure> {
    if !sync_enabled_from(store) {
        return Ok(false);
    }
    let rows = sync_rows(store)?;
    if rows.is_empty() {
        return Ok(false);
    }
    let access_token = current_access_token(store).await?;
    let observed_at = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| AccountFailure::Storage)?;
    let payload = serde_json::to_vec(&serde_json::json!({
        "event_id": uuid::Uuid::new_v4().to_string(),
        "device_id": sync_device_id(store)?,
        "observed_at": observed_at,
        "snapshots": rows,
    }))
    .map_err(|_| AccountFailure::Storage)?;
    let endpoint = format!(
        "{}/functions/v1/sync-snapshots",
        configured_url().trim_end_matches('/')
    );
    let response = client()?
        .post(endpoint)
        .header("apikey", configured_key())
        .bearer_auth(&*access_token)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|_| AccountFailure::Network)?;
    if !response.status().is_success() {
        return Err(AccountFailure::Network);
    }
    Ok(true)
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
