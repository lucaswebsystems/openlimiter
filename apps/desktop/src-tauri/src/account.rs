use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::TcpListener;
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
const PRO_SESSION_CREDENTIAL_ID: &str = "openlimiter-pro-session";
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
    EmailConfirmationRequired,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredSession {
    version: u8,
    email: String,
    access_token: String,
    refresh_token: String,
    expires_at: i64,
}

#[derive(Debug, Deserialize)]
struct AuthUser {
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

fn stored_session(store: &dyn SecretStore) -> Result<StoredSession, AccountFailure> {
    let raw = store
        .read_secret(ACCOUNT_CREDENTIAL_ID)
        .map_err(|error| match error {
            CredentialError::NotFound => AccountFailure::Authentication,
            CredentialError::Store => AccountFailure::Storage,
        })?;
    serde_json::from_str(&raw).map_err(|_| AccountFailure::Storage)
}

fn save_session(
    store: &dyn SecretStore,
    response: AuthResponse,
) -> Result<StoredSession, AccountFailure> {
    let access_token = response
        .access_token
        .ok_or(AccountFailure::Authentication)?;
    let refresh_token = response
        .refresh_token
        .ok_or(AccountFailure::Authentication)?;
    let email = response
        .user
        .and_then(|user| user.email)
        .filter(|value| valid_email(value))
        .ok_or(AccountFailure::Authentication)?;
    if access_token.len() < 20 || access_token.len() > 32_768 || refresh_token.len() < 20 {
        return Err(AccountFailure::Authentication);
    }
    let session = StoredSession {
        version: 1,
        email,
        access_token,
        refresh_token,
        expires_at: now_seconds() + response.expires_in.unwrap_or(3_600).clamp(60, 86_400),
    };
    let encoded =
        Zeroizing::new(serde_json::to_string(&session).map_err(|_| AccountFailure::Storage)?);
    store
        .store_secret(ACCOUNT_CREDENTIAL_ID, &encoded)
        .map_err(|_| AccountFailure::Storage)?;
    store
        .store_secret(PRO_SESSION_CREDENTIAL_ID, &session.access_token)
        .map_err(|_| AccountFailure::Storage)?;
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
    let mut session = stored_session(store)?;
    if session.expires_at <= now_seconds() + 120 {
        session = save_session(store, refresh_session(&session).await?)?;
    }
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
        .bearer_auth(&session.access_token)
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
    let Ok(session) = stored_session(store.inner()) else {
        return Ok(status_for(store.inner(), configured()));
    };
    if session.expires_at > now_seconds() + 120 {
        return Ok(status_for(store.inner(), true));
    }
    Ok(match refresh_session(&session).await {
        Ok(response) => match save_session(store.inner(), response) {
            Ok(_) => status_for(store.inner(), true),
            Err(_) => status_for(store.inner(), false),
        },
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
    save_session(store.inner(), response)?;
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
                    .ok_or(AccountFailure::OauthRejected)?;
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
    let state = uuid::Uuid::new_v4().simple().to_string();
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
        .append_pair("code_challenge_method", "s256")
        .append_pair("state", &state);
    app.opener()
        .open_url(authorize.as_str(), None::<&str>)
        .map_err(|_| AccountFailure::OauthRejected)?;
    let (code, returned_state) =
        tauri::async_runtime::spawn_blocking(move || oauth_request(&listener))
            .await
            .map_err(|_| AccountFailure::OauthRejected)??;
    if returned_state != state {
        return Err(AccountFailure::OauthRejected);
    }
    let response = auth_post(
        "/auth/v1/token?grant_type=pkce",
        serde_json::json!({ "auth_code": code, "code_verifier": verifier }),
    )
    .await?;
    save_session(store.inner(), response)?;
    Ok(status_for(store.inner(), true))
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
pub fn account_logout(store: State<'_, KeyringStore>) -> Result<(), AccountFailure> {
    for id in [ACCOUNT_CREDENTIAL_ID, PRO_SESSION_CREDENTIAL_ID] {
        match store.delete_secret(id) {
            Ok(()) | Err(CredentialError::NotFound) => {}
            Err(_) => return Err(AccountFailure::Storage),
        }
    }
    Ok(())
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
            version: 1,
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
}
