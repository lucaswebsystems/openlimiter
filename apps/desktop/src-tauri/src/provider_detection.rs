use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::fsx;
use crate::native_snapshot::{epoch_ms_from_rfc3339, iso_from_epoch_ms};

const MAX_PROFILE_DIRECTORIES: usize = 32;
const MAX_ACCOUNTS_PER_FILE: usize = 16;
const MAX_TOKEN_BYTES: usize = 4_096;
const MAX_IDENTITY_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectedProviderId {
    Claude,
    Codex,
    Antigravity,
    Opencode,
    Openrouter,
    Grok,
    Kimi,
}

impl DetectedProviderId {
    pub const ALL: [Self; 7] = [
        Self::Claude,
        Self::Codex,
        Self::Antigravity,
        Self::Opencode,
        Self::Openrouter,
        Self::Grok,
        Self::Kimi,
    ];

    const fn slug(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Antigravity => "antigravity",
            Self::Opencode => "opencode",
            Self::Openrouter => "openrouter",
            Self::Grok => "grok",
            Self::Kimi => "kimi",
        }
    }

    const fn display_name(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Antigravity => "Antigravity",
            Self::Opencode => "OpenCode",
            Self::Openrouter => "OpenRouter",
            Self::Grok => "Grok",
            Self::Kimi => "Kimi",
        }
    }

    const fn supports_automatic_collection(self) -> bool {
        matches!(
            self,
            Self::Claude | Self::Codex | Self::Antigravity | Self::Grok | Self::Kimi
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderPresence {
    Present,
    InstalledLoggedOut,
    Absent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectedAuthState {
    Ready,
    ExpiryUnknown,
    Stale,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectedCollectionState {
    Waiting,
    Ready,
    Fallback,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentityQuality {
    ProviderAccount,
    JwtSubject,
    CredentialBound,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction {
    ReopenCli,
    SignInToCli,
    ConnectApiKey,
    ManualEntry,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionMode {
    Automatic,
    ApiKey,
    ManualEntry,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DetectedAccount {
    pub account_id: String,
    pub label: String,
    pub auth_state: DetectedAuthState,
    pub collection_state: DetectedCollectionState,
    pub identity_quality: IdentityQuality,
    pub automatic_collection: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<RecoveryAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProviderDetection {
    pub provider_id: DetectedProviderId,
    pub state: ProviderPresence,
    pub accounts: Vec<DetectedAccount>,
    pub connection_mode: ConnectionMode,
    pub manual_entry_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<RecoveryAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn connection_mode(provider: DetectedProviderId) -> ConnectionMode {
    match provider {
        DetectedProviderId::Claude
        | DetectedProviderId::Codex
        | DetectedProviderId::Antigravity
        | DetectedProviderId::Grok
        | DetectedProviderId::Kimi => ConnectionMode::Automatic,
        DetectedProviderId::Openrouter => ConnectionMode::ApiKey,
        DetectedProviderId::Opencode => ConnectionMode::ManualEntry,
    }
}

fn provider_recovery(
    provider: DetectedProviderId,
    state: ProviderPresence,
) -> Option<RecoveryAction> {
    if state == ProviderPresence::Present {
        return None;
    }
    match provider {
        DetectedProviderId::Openrouter => Some(RecoveryAction::ConnectApiKey),
        DetectedProviderId::Opencode => Some(RecoveryAction::ManualEntry),
        DetectedProviderId::Claude
        | DetectedProviderId::Codex
        | DetectedProviderId::Antigravity
        | DetectedProviderId::Grok
        | DetectedProviderId::Kimi => match state {
            ProviderPresence::InstalledLoggedOut => Some(RecoveryAction::SignInToCli),
            ProviderPresence::Absent => Some(RecoveryAction::ManualEntry),
            ProviderPresence::Present => None,
        },
    }
}

fn provider_message(provider: DetectedProviderId, state: ProviderPresence) -> Option<String> {
    match provider {
        DetectedProviderId::Openrouter => Some(if state == ProviderPresence::Present {
            "OpenRouter collection uses a user provided API key.".to_string()
        } else {
            "Connect an OpenRouter API key to collect its documented credits.".to_string()
        }),
        DetectedProviderId::Opencode => Some(
            "OpenCode exposes no zero setup subscription quota source. Add usage manually."
                .to_string(),
        ),
        _ => match state {
            ProviderPresence::Present => None,
            ProviderPresence::InstalledLoggedOut => Some(format!(
                "Sign in with {} to connect this account.",
                provider.display_name()
            )),
            ProviderPresence::Absent => Some("Manual entry remains available.".to_string()),
        },
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DetectionReport {
    pub version: u8,
    pub scanned_at: String,
    pub providers: Vec<ProviderDetection>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiscoveryPlatform {
    Windows,
    Macos,
    Linux,
}

impl DiscoveryPlatform {
    fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }
}

#[derive(Clone)]
struct DiscoveryContext {
    platform: DiscoveryPlatform,
    read_native_credentials: bool,
    home: Option<PathBuf>,
    roaming: Option<PathBuf>,
    local: Option<PathBuf>,
    application_support: Option<PathBuf>,
    xdg_config: Option<PathBuf>,
    xdg_data: Option<PathBuf>,
    codex_home: Option<PathBuf>,
    grok_home: Option<PathBuf>,
    kimi_code_home: Option<PathBuf>,
    kimi_share_dir: Option<PathBuf>,
    path_entries: Vec<PathBuf>,
}

fn non_empty_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

impl DiscoveryContext {
    fn current() -> Self {
        let platform = DiscoveryPlatform::current();
        let home = crate::state::home();
        let roaming = non_empty_path("APPDATA");
        let local = non_empty_path("LOCALAPPDATA");
        let application_support = home
            .as_ref()
            .map(|value| value.join("Library").join("Application Support"));
        let xdg_config = non_empty_path("XDG_CONFIG_HOME")
            .or_else(|| home.as_ref().map(|value| value.join(".config")));
        let xdg_data = non_empty_path("XDG_DATA_HOME").or_else(|| {
            home.as_ref()
                .map(|value| value.join(".local").join("share"))
        });
        let path_entries = env::var_os("PATH")
            .map(|value| env::split_paths(&value).collect())
            .unwrap_or_default();
        Self {
            platform,
            read_native_credentials: true,
            home,
            roaming,
            local,
            application_support,
            xdg_config,
            xdg_data,
            codex_home: non_empty_path("CODEX_HOME"),
            grok_home: non_empty_path("GROK_HOME"),
            kimi_code_home: non_empty_path("KIMI_CODE_HOME"),
            kimi_share_dir: non_empty_path("KIMI_SHARE_DIR"),
            path_entries,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CandidateKind {
    Credential,
    Marker,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CandidatePath {
    path: PathBuf,
    kind: CandidateKind,
}

fn push_candidate(
    paths: &mut Vec<CandidatePath>,
    base: Option<&Path>,
    relative: &[&str],
    kind: CandidateKind,
) {
    let Some(mut path) = base.map(Path::to_path_buf) else {
        return;
    };
    for part in relative {
        path.push(part);
    }
    paths.push(CandidatePath { path, kind });
}

fn candidate_paths(provider: DetectedProviderId, context: &DiscoveryContext) -> Vec<CandidatePath> {
    use CandidateKind::{Credential, Marker};
    let mut paths = Vec::new();
    let home = context.home.as_deref();
    match provider {
        DetectedProviderId::Claude => {
            push_candidate(
                &mut paths,
                home,
                &[".claude", ".credentials.json"],
                Credential,
            );
            push_candidate(&mut paths, home, &[".claude", "settings.json"], Marker);
            push_candidate(
                &mut paths,
                context.xdg_config.as_deref(),
                &["claude", ".credentials.json"],
                Credential,
            );
            push_candidate(
                &mut paths,
                context.xdg_config.as_deref(),
                &["claude-code", ".credentials.json"],
                Credential,
            );
            push_candidate(
                &mut paths,
                context.xdg_data.as_deref(),
                &["claude-code", ".credentials.json"],
                Credential,
            );
        }
        DetectedProviderId::Codex => {
            push_candidate(
                &mut paths,
                context.codex_home.as_deref(),
                &["auth.json"],
                Credential,
            );
            push_candidate(&mut paths, home, &[".codex", "auth.json"], Credential);
            push_candidate(&mut paths, home, &[".codex", "config.toml"], Marker);
            push_candidate(
                &mut paths,
                context.xdg_config.as_deref(),
                &["codex", "auth.json"],
                Credential,
            );
            push_candidate(
                &mut paths,
                context.xdg_data.as_deref(),
                &["codex", "auth.json"],
                Credential,
            );
        }
        DetectedProviderId::Antigravity => {
            push_candidate(
                &mut paths,
                home,
                &[".gemini", "antigravity-cli", "settings.json"],
                Marker,
            );
        }
        DetectedProviderId::Opencode => {
            push_candidate(
                &mut paths,
                context.xdg_data.as_deref(),
                &["opencode", "auth.json"],
                Credential,
            );
            push_candidate(
                &mut paths,
                context.xdg_config.as_deref(),
                &["opencode", "auth.json"],
                Credential,
            );
            push_candidate(
                &mut paths,
                context.xdg_config.as_deref(),
                &["opencode", "opencode.json"],
                Marker,
            );
        }
        DetectedProviderId::Openrouter => {
            push_candidate(
                &mut paths,
                home,
                &[".openrouter", "config.json"],
                Credential,
            );
            push_candidate(
                &mut paths,
                context.xdg_config.as_deref(),
                &["openrouter", "config.json"],
                Credential,
            );
            push_candidate(
                &mut paths,
                context.xdg_data.as_deref(),
                &["openrouter", "config.json"],
                Credential,
            );
        }
        DetectedProviderId::Grok => {
            push_candidate(
                &mut paths,
                context.grok_home.as_deref(),
                &["auth.json"],
                Credential,
            );
            push_candidate(&mut paths, home, &[".grok", "auth.json"], Credential);
        }
        DetectedProviderId::Kimi => {
            push_candidate(
                &mut paths,
                context.kimi_code_home.as_deref(),
                &["credentials", "kimi-code.json"],
                Credential,
            );
            push_candidate(
                &mut paths,
                home,
                &[".kimi-code", "credentials", "kimi-code.json"],
                Credential,
            );
            push_candidate(
                &mut paths,
                context.kimi_share_dir.as_deref(),
                &["credentials", "kimi-code.json"],
                Credential,
            );
            push_candidate(
                &mut paths,
                home,
                &[".kimi", "credentials", "kimi-code.json"],
                Credential,
            );
        }
    }

    match context.platform {
        DiscoveryPlatform::Windows => {
            let roaming = context.roaming.as_deref();
            let local = context.local.as_deref();
            match provider {
                DetectedProviderId::Claude => {
                    for base in [roaming, local] {
                        push_candidate(
                            &mut paths,
                            base,
                            &["Claude", ".credentials.json"],
                            Credential,
                        );
                        push_candidate(
                            &mut paths,
                            base,
                            &["Claude", "claude-code", ".credentials.json"],
                            Credential,
                        );
                    }
                }
                DetectedProviderId::Codex => {
                    for base in [roaming, local] {
                        push_candidate(
                            &mut paths,
                            base,
                            &["OpenAI", "Codex", "auth.json"],
                            Credential,
                        );
                        push_candidate(&mut paths, base, &["Codex", "auth.json"], Credential);
                    }
                }
                DetectedProviderId::Antigravity => {
                    push_candidate(
                        &mut paths,
                        roaming,
                        &["Antigravity", "User", "globalStorage"],
                        Marker,
                    );
                }
                DetectedProviderId::Opencode => {
                    for base in [roaming, local] {
                        push_candidate(&mut paths, base, &["opencode", "auth.json"], Credential);
                        push_candidate(&mut paths, base, &["opencode"], Marker);
                    }
                }
                DetectedProviderId::Openrouter => {
                    for base in [roaming, local] {
                        push_candidate(
                            &mut paths,
                            base,
                            &["OpenRouter", "config.json"],
                            Credential,
                        );
                    }
                }
                DetectedProviderId::Grok | DetectedProviderId::Kimi => {}
            }
        }
        DiscoveryPlatform::Macos => {
            let support = context.application_support.as_deref();
            if provider == DetectedProviderId::Antigravity {
                push_candidate(
                    &mut paths,
                    support,
                    &["Antigravity", "User", "globalStorage"],
                    Marker,
                );
            } else if !matches!(
                provider,
                DetectedProviderId::Grok | DetectedProviderId::Kimi
            ) {
                let directory = match provider {
                    DetectedProviderId::Claude => "Claude Code",
                    DetectedProviderId::Codex => "Codex",
                    DetectedProviderId::Antigravity => unreachable!(),
                    DetectedProviderId::Opencode => "opencode",
                    DetectedProviderId::Openrouter => "OpenRouter",
                    DetectedProviderId::Grok | DetectedProviderId::Kimi => unreachable!(),
                };
                let file = match provider {
                    DetectedProviderId::Claude => ".credentials.json",
                    DetectedProviderId::Codex | DetectedProviderId::Opencode => "auth.json",
                    DetectedProviderId::Antigravity => unreachable!(),
                    DetectedProviderId::Openrouter => "config.json",
                    DetectedProviderId::Grok | DetectedProviderId::Kimi => unreachable!(),
                };
                push_candidate(&mut paths, support, &[directory, file], Credential);
                if provider == DetectedProviderId::Claude {
                    push_candidate(
                        &mut paths,
                        support,
                        &["Claude", ".credentials.json"],
                        Credential,
                    );
                }
            }
        }
        DiscoveryPlatform::Linux => {
            if !matches!(
                provider,
                DetectedProviderId::Antigravity
                    | DetectedProviderId::Grok
                    | DetectedProviderId::Kimi
            ) {
                let directory = provider.slug();
                let file = match provider {
                    DetectedProviderId::Claude => "credentials.json",
                    DetectedProviderId::Codex | DetectedProviderId::Opencode => "auth.json",
                    DetectedProviderId::Antigravity => unreachable!(),
                    DetectedProviderId::Openrouter => "config.json",
                    DetectedProviderId::Grok | DetectedProviderId::Kimi => unreachable!(),
                };
                push_candidate(
                    &mut paths,
                    context.xdg_config.as_deref(),
                    &[directory, file],
                    Credential,
                );
                push_candidate(
                    &mut paths,
                    context.xdg_data.as_deref(),
                    &[directory, file],
                    Credential,
                );
            }
        }
    }

    let mut seen = BTreeSet::new();
    paths.retain(|entry| seen.insert(entry.path.clone()));
    paths
}

fn profile_prefix(provider: DetectedProviderId) -> Option<(&'static str, &'static str)> {
    match provider {
        DetectedProviderId::Claude => Some((".claude", ".credentials.json")),
        DetectedProviderId::Codex => Some((".codex", "auth.json")),
        DetectedProviderId::Antigravity
        | DetectedProviderId::Opencode
        | DetectedProviderId::Openrouter
        | DetectedProviderId::Grok
        | DetectedProviderId::Kimi => None,
    }
}

fn profile_candidates(provider: DetectedProviderId, home: Option<&Path>) -> Vec<CandidatePath> {
    let Some((prefix, file)) = profile_prefix(provider) else {
        return Vec::new();
    };
    let Some(home) = home else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(home) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten().take(MAX_PROFILE_DIRECTORIES * 4) {
        if found.len() >= MAX_PROFILE_DIRECTORIES {
            break;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let is_profile = name == prefix
            || name
                .strip_prefix(prefix)
                .is_some_and(|suffix| suffix.starts_with('-') || suffix.starts_with('_'));
        if !is_profile {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        found.push(CandidatePath {
            path: path.join(file),
            kind: CandidateKind::Credential,
        });
    }
    found.sort_by(|left, right| left.path.cmp(&right.path));
    found
}

fn safe_path_present(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| !metadata.file_type().is_symlink())
}

fn executable_names(provider: DetectedProviderId, platform: DiscoveryPlatform) -> Vec<String> {
    let base = match provider {
        DetectedProviderId::Claude => "claude",
        DetectedProviderId::Codex => "codex",
        DetectedProviderId::Antigravity => "antigravity",
        DetectedProviderId::Opencode => "opencode",
        DetectedProviderId::Openrouter => "openrouter",
        DetectedProviderId::Grok => "grok",
        DetectedProviderId::Kimi => "kimi",
    };
    if platform == DiscoveryPlatform::Windows {
        [".exe", ".cmd", ".bat"]
            .into_iter()
            .map(|suffix| format!("{base}{suffix}"))
            .collect()
    } else {
        vec![base.to_string()]
    }
}

fn executable_present(provider: DetectedProviderId, context: &DiscoveryContext) -> bool {
    let names = executable_names(provider, context.platform);
    context.path_entries.iter().any(|directory| {
        names
            .iter()
            .any(|name| safe_path_present(&directory.join(name)))
    })
}

fn valid_secret(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_TOKEN_BYTES
        && !value.chars().any(char::is_control)
}

fn valid_identity(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_IDENTITY_BYTES
        && !value.chars().any(char::is_control)
}

fn string_field<'a>(object: &'a Map<String, Value>, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| object.get(*name).and_then(Value::as_str))
        .filter(|value| valid_identity(value))
}

fn nested_object<'a>(
    object: &'a Map<String, Value>,
    names: &[&str],
) -> Option<&'a Map<String, Value>> {
    names
        .iter()
        .find_map(|name| object.get(*name).and_then(Value::as_object))
}

fn epoch_milliseconds(value: &Value) -> Option<u64> {
    if let Some(text) = value.as_str() {
        return epoch_ms_from_rfc3339(text);
    }
    let number = match value.as_u64() {
        Some(number) => number,
        None => {
            let number = value.as_f64()?;
            if !number.is_finite() || number < 0.0 || number.fract() != 0.0 {
                return None;
            }
            number as u64
        }
    };
    let milliseconds = if number < 10_000_000_000 {
        number.checked_mul(1_000)?
    } else {
        number
    };
    (milliseconds <= 4_102_444_800_000).then_some(milliseconds)
}

fn expiry_field(object: &Map<String, Value>) -> Option<u64> {
    ["expiresAt", "expires_at", "expires", "expiration"]
        .iter()
        .find_map(|name| object.get(*name).and_then(epoch_milliseconds))
}

fn base64url_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

fn decode_base64url(input: &str) -> Option<Vec<u8>> {
    if input.is_empty() || input.len() > 32_768 {
        return None;
    }
    let mut output = Vec::with_capacity(input.len() * 3 / 4);
    let mut accumulator = 0u32;
    let mut bits = 0u8;
    for byte in input.bytes().take_while(|byte| *byte != b'=') {
        accumulator = (accumulator << 6) | u32::from(base64url_value(byte)?);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    Some(output)
}

fn jwt_claims(token: &str) -> Option<Map<String, Value>> {
    let mut segments = token.split('.');
    let _header = segments.next()?;
    let payload = segments.next()?;
    let _signature = segments.next()?;
    if segments.next().is_some() {
        return None;
    }
    let decoded = decode_base64url(payload)?;
    serde_json::from_slice::<Value>(&decoded)
        .ok()?
        .as_object()
        .cloned()
}

#[derive(Clone)]
struct IdentityHint {
    value: String,
    email: Option<String>,
}

fn claude_identity_hint(credential_path: &Path) -> Option<IdentityHint> {
    let directory = credential_path.parent()?;
    let name = directory.file_name()?.to_str()?;
    if !name.starts_with(".claude") {
        return None;
    }
    let metadata_path = directory.parent()?.join(format!("{name}.json"));
    let raw = Zeroizing::new(fsx::bounded_read(&metadata_path)?);
    let root: Value = serde_json::from_str(&raw).ok()?;
    let account = root.get("oauthAccount")?.as_object()?;
    let value = string_field(
        account,
        &[
            "accountUuid",
            "account_id",
            "accountId",
            "user_id",
            "userId",
        ],
    )?;
    let email = string_field(account, &["emailAddress", "email"]).map(str::to_string);
    Some(IdentityHint {
        value: value.to_string(),
        email,
    })
}

struct ParsedCredential {
    token: Zeroizing<String>,
    provider_account_id: Option<String>,
    identity_material: String,
    email: Option<String>,
    expires_at_ms: Option<u64>,
    identity_quality: IdentityQuality,
}

fn account_objects(
    provider: DetectedProviderId,
    root: &Map<String, Value>,
) -> Vec<&Map<String, Value>> {
    let mut objects = Vec::new();
    if provider == DetectedProviderId::Grok {
        objects.extend(
            root.values()
                .take(MAX_ACCOUNTS_PER_FILE)
                .filter_map(Value::as_object),
        );
    }
    if let Some(entries) = root.get("accounts").and_then(Value::as_array) {
        objects.extend(
            entries
                .iter()
                .take(MAX_ACCOUNTS_PER_FILE)
                .filter_map(Value::as_object),
        );
    }
    if let Some(entries) = root.get("profiles").and_then(Value::as_object) {
        objects.extend(
            entries
                .values()
                .take(MAX_ACCOUNTS_PER_FILE.saturating_sub(objects.len()))
                .filter_map(Value::as_object),
        );
    }
    if objects.is_empty() {
        objects.push(root);
    }
    objects
}

fn token_object<'a>(
    provider: DetectedProviderId,
    account: &'a Map<String, Value>,
) -> &'a Map<String, Value> {
    let names: &[&str] = match provider {
        DetectedProviderId::Claude => &["claudeAiOauth", "oauth", "credentials"],
        DetectedProviderId::Codex => &["tokens", "oauth", "credentials"],
        DetectedProviderId::Antigravity => &["oauth", "token", "tokens", "credentials"],
        DetectedProviderId::Opencode => &["session", "auth", "credentials"],
        DetectedProviderId::Openrouter => &["openrouter", "credentials"],
        DetectedProviderId::Grok => &["auth", "credentials"],
        DetectedProviderId::Kimi => &["oauth", "credentials"],
    };
    nested_object(account, names).unwrap_or(account)
}

fn access_token<'a>(
    provider: DetectedProviderId,
    object: &'a Map<String, Value>,
) -> Option<&'a str> {
    let names: &[&str] = match provider {
        DetectedProviderId::Claude => &["accessToken", "access_token", "token"],
        DetectedProviderId::Codex => &["access_token", "accessToken"],
        DetectedProviderId::Antigravity => &["access_token", "accessToken", "token"],
        DetectedProviderId::Opencode => &["cookie", "session", "access_token", "accessToken"],
        DetectedProviderId::Openrouter => &["api_key", "apiKey", "key", "OPENROUTER_API_KEY"],
        DetectedProviderId::Grok => &["key", "access_token", "accessToken"],
        DetectedProviderId::Kimi => &["access_token", "accessToken"],
    };
    names
        .iter()
        .find_map(|name| object.get(*name).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| valid_secret(value))
}

fn claim_identity(claims: &Map<String, Value>) -> Option<(&str, IdentityQuality)> {
    let provider = string_field(
        claims,
        &[
            "chatgpt_account_id",
            "account_id",
            "accountId",
            "organization_id",
            "organizationId",
        ],
    );
    if let Some(value) = provider {
        return Some((value, IdentityQuality::ProviderAccount));
    }
    string_field(claims, &["sub", "user_id", "userId"])
        .map(|value| (value, IdentityQuality::JwtSubject))
}

fn token_digest(token: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(token.as_bytes());
    format!("{:x}", digest.finalize())
}

pub(crate) fn resolved_credential_account_id(
    provider: DetectedProviderId,
    credential: &str,
) -> String {
    let claims = jwt_claims(credential);
    let material = claims
        .as_ref()
        .and_then(claim_identity)
        .map(|(value, _)| value.to_string())
        .unwrap_or_else(|| token_digest(credential));
    opaque_account_id(provider, &material)
}

fn parse_credential_file(provider: DetectedProviderId, path: &Path) -> Vec<ParsedCredential> {
    let Some(raw) = fsx::bounded_read(path) else {
        return Vec::new();
    };
    let raw = Zeroizing::new(raw);
    let Ok(root) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let Some(root) = root.as_object() else {
        return Vec::new();
    };
    let claude_hint = (provider == DetectedProviderId::Claude)
        .then(|| claude_identity_hint(path))
        .flatten();
    let mut parsed = Vec::new();
    for account in account_objects(provider, root) {
        let object = token_object(provider, account);
        let Some(token) = access_token(provider, object) else {
            continue;
        };
        let claims = jwt_claims(token);
        let id_token_claims = string_field(object, &["id_token", "idToken"]).and_then(jwt_claims);
        let explicit_id = string_field(
            object,
            &[
                "account_id",
                "accountId",
                "accountUuid",
                "workspace_id",
                "workspaceId",
                "user_id",
                "userId",
            ],
        )
        .or_else(|| {
            string_field(
                account,
                &[
                    "account_id",
                    "accountId",
                    "accountUuid",
                    "workspace_id",
                    "workspaceId",
                    "user_id",
                    "userId",
                ],
            )
        });
        let claim = claims
            .as_ref()
            .and_then(claim_identity)
            .or_else(|| id_token_claims.as_ref().and_then(claim_identity));
        let hinted = claude_hint.as_ref().map(|hint| hint.value.as_str());
        let refresh_token = string_field(object, &["refresh_token", "refreshToken"])
            .filter(|value| valid_secret(value));
        let (identity_material, identity_quality) = if let Some(value) = explicit_id.or(hinted) {
            (value.to_string(), IdentityQuality::ProviderAccount)
        } else if let Some((value, quality)) = claim {
            (value.to_string(), quality)
        } else {
            (
                token_digest(refresh_token.unwrap_or(token)),
                IdentityQuality::CredentialBound,
            )
        };
        let provider_account_id = match provider {
            DetectedProviderId::Codex => explicit_id.or_else(|| {
                claims
                    .as_ref()
                    .and_then(|value| string_field(value, &["chatgpt_account_id", "account_id"]))
            }),
            DetectedProviderId::Grok => explicit_id.or_else(|| {
                claims
                    .as_ref()
                    .and_then(|value| string_field(value, &["user_id", "userId", "sub"]))
            }),
            _ => explicit_id,
        }
        .map(str::to_string);
        let email = string_field(object, &["email", "emailAddress"])
            .or_else(|| string_field(account, &["email", "emailAddress"]))
            .or_else(|| {
                claims
                    .as_ref()
                    .and_then(|value| string_field(value, &["email"]))
            })
            .or_else(|| {
                id_token_claims
                    .as_ref()
                    .and_then(|value| string_field(value, &["email"]))
            })
            .map(str::to_string)
            .or_else(|| claude_hint.as_ref().and_then(|hint| hint.email.clone()));
        let expires_at_ms = expiry_field(object)
            .or_else(|| expiry_field(account))
            .or_else(|| {
                claims
                    .as_ref()
                    .and_then(|value| value.get("exp"))
                    .and_then(epoch_milliseconds)
            });
        parsed.push(ParsedCredential {
            token: Zeroizing::new(token.to_string()),
            provider_account_id,
            identity_material,
            email,
            expires_at_ms,
            identity_quality,
        });
    }
    parsed
}

pub(crate) fn opaque_account_id(provider: DetectedProviderId, material: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(provider.slug().as_bytes());
    digest.update([0]);
    digest.update(material.as_bytes());
    let hash = format!("{:x}", digest.finalize());
    format!("{}-{}", provider.slug(), &hash[..24])
}

fn masked_email(value: &str) -> Option<String> {
    let (local, domain) = value.split_once('@')?;
    let first = local.chars().next()?;
    if domain.is_empty()
        || domain.len() > 253
        || !domain
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
    {
        return None;
    }
    Some(format!("{first}***@{domain}"))
}

fn account_label(provider: DetectedProviderId, email: Option<&str>, account_id: &str) -> String {
    masked_email(email.unwrap_or_default()).unwrap_or_else(|| {
        let suffix = account_id.rsplit('-').next().unwrap_or(account_id);
        let visible = suffix.get(..6).unwrap_or(suffix);
        format!("{} account {visible}", provider.display_name())
    })
}

#[derive(Clone)]
enum CredentialSource {
    File(PathBuf),
    AntigravityKeyring,
}

fn parse_credential_source(
    provider: DetectedProviderId,
    source: &CredentialSource,
) -> Vec<ParsedCredential> {
    match source {
        CredentialSource::File(path) => parse_credential_file(provider, path),
        CredentialSource::AntigravityKeyring if provider == DetectedProviderId::Antigravity => {
            let Ok(credential) = crate::antigravity_credential::read() else {
                return Vec::new();
            };
            vec![ParsedCredential {
                token: credential.access_token,
                provider_account_id: None,
                identity_material: credential.identity_material,
                email: None,
                expires_at_ms: credential.expires_at_ms,
                identity_quality: IdentityQuality::CredentialBound,
            }]
        }
        CredentialSource::AntigravityKeyring => Vec::new(),
    }
}

#[derive(Clone)]
struct CredentialReference {
    provider: DetectedProviderId,
    account_id: String,
    source: CredentialSource,
}

struct Inventory {
    report: DetectionReport,
    credentials: BTreeMap<(DetectedProviderId, String), CredentialReference>,
}

fn scan_inventory(context: &DiscoveryContext, now_ms: u64) -> Inventory {
    let scanned_at =
        iso_from_epoch_ms(now_ms).unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string());
    let mut providers = Vec::new();
    let mut credentials = BTreeMap::new();
    for provider in DetectedProviderId::ALL {
        let mut candidates = candidate_paths(provider, context);
        candidates.extend(profile_candidates(provider, context.home.as_deref()));
        let mut seen = BTreeSet::new();
        candidates.retain(|entry| seen.insert(entry.path.clone()));
        let mut installed = executable_present(provider, context);
        let mut accounts = BTreeMap::<String, DetectedAccount>::new();
        let mut sources = Vec::new();
        for candidate in candidates {
            if safe_path_present(&candidate.path) {
                installed = true;
            }
            if candidate.kind == CandidateKind::Credential {
                sources.push(CredentialSource::File(candidate.path));
            }
        }
        if provider == DetectedProviderId::Antigravity && context.read_native_credentials {
            sources.push(CredentialSource::AntigravityKeyring);
        }
        for source in sources {
            for parsed in parse_credential_source(provider, &source) {
                let account_id = opaque_account_id(provider, &parsed.identity_material);
                let stale = parsed.expires_at_ms.is_some_and(|expiry| expiry <= now_ms);
                let auth_state = if stale {
                    DetectedAuthState::Stale
                } else if parsed.expires_at_ms.is_some() {
                    DetectedAuthState::Ready
                } else {
                    DetectedAuthState::ExpiryUnknown
                };
                let public = DetectedAccount {
                    account_id: account_id.clone(),
                    label: account_label(provider, parsed.email.as_deref(), &account_id),
                    auth_state,
                    collection_state: DetectedCollectionState::Waiting,
                    identity_quality: parsed.identity_quality,
                    automatic_collection: provider.supports_automatic_collection(),
                    expires_at: parsed.expires_at_ms.and_then(iso_from_epoch_ms),
                    recovery: stale.then_some(RecoveryAction::ReopenCli),
                    message: stale.then(|| {
                        format!("Reopen {} to refresh this login.", provider.display_name())
                    }),
                };
                let key = (provider, account_id.clone());
                if !accounts.contains_key(&account_id) {
                    accounts.insert(account_id.clone(), public);
                    credentials.insert(
                        key,
                        CredentialReference {
                            provider,
                            account_id,
                            source: source.clone(),
                        },
                    );
                }
                drop(parsed.token);
            }
        }
        let accounts: Vec<DetectedAccount> = accounts.into_values().collect();
        let state = if !accounts.is_empty() {
            ProviderPresence::Present
        } else if installed {
            ProviderPresence::InstalledLoggedOut
        } else {
            ProviderPresence::Absent
        };
        providers.push(ProviderDetection {
            provider_id: provider,
            state,
            accounts,
            connection_mode: connection_mode(provider),
            manual_entry_available: true,
            recovery: provider_recovery(provider, state),
            message: provider_message(provider, state),
        });
    }
    Inventory {
        report: DetectionReport {
            version: 1,
            scanned_at,
            providers,
        },
        credentials,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DetectedCredentialError {
    NotFound,
    Stale,
    Unreadable,
}

pub struct DetectedSecret {
    pub access_token: Zeroizing<String>,
    #[cfg_attr(not(test), allow(dead_code))]
    pub provider_account_id: Option<String>,
    pub credential_revision: String,
}

pub struct DetectionStore {
    context: DiscoveryContext,
    inventory: RwLock<Inventory>,
}

impl DetectionStore {
    pub fn scan() -> Self {
        let context = DiscoveryContext::current();
        let inventory = scan_inventory(&context, crate::connections::now_epoch_ms());
        Self {
            context,
            inventory: RwLock::new(inventory),
        }
    }

    pub fn report(&self) -> DetectionReport {
        self.inventory
            .read()
            .map(|inventory| inventory.report.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().report.clone())
    }

    pub fn rescan(&self) -> DetectionReport {
        let next = scan_inventory(&self.context, crate::connections::now_epoch_ms());
        let report = next.report.clone();
        match self.inventory.write() {
            Ok(mut inventory) => *inventory = next,
            Err(poisoned) => *poisoned.into_inner() = next,
        }
        report
    }

    pub fn account_ids(&self, provider: DetectedProviderId) -> Vec<String> {
        self.inventory
            .read()
            .map(|inventory| {
                inventory
                    .credentials
                    .keys()
                    .filter(|(found, _)| *found == provider)
                    .map(|(_, account)| account.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn read_credential(
        &self,
        provider: DetectedProviderId,
        account_id: &str,
    ) -> Result<DetectedSecret, DetectedCredentialError> {
        let reference = self
            .inventory
            .read()
            .map_err(|_| DetectedCredentialError::Unreadable)?
            .credentials
            .get(&(provider, account_id.to_string()))
            .cloned()
            .ok_or(DetectedCredentialError::NotFound)?;
        if reference.provider != provider || reference.account_id != account_id {
            return Err(DetectedCredentialError::NotFound);
        }
        for parsed in parse_credential_source(provider, &reference.source) {
            if opaque_account_id(provider, &parsed.identity_material) != account_id {
                continue;
            }
            if parsed
                .expires_at_ms
                .is_some_and(|expiry| expiry <= crate::connections::now_epoch_ms())
            {
                return Err(DetectedCredentialError::Stale);
            }
            return Ok(DetectedSecret {
                credential_revision: token_digest(&parsed.token),
                access_token: parsed.token,
                provider_account_id: parsed.provider_account_id,
            });
        }
        Err(DetectedCredentialError::Unreadable)
    }

    pub fn mark_stale(&self, provider: DetectedProviderId, account_id: &str) {
        let Ok(mut inventory) = self.inventory.write() else {
            return;
        };
        let Some(found) = inventory
            .report
            .providers
            .iter_mut()
            .find(|entry| entry.provider_id == provider)
        else {
            return;
        };
        let Some(account) = found
            .accounts
            .iter_mut()
            .find(|entry| entry.account_id == account_id)
        else {
            return;
        };
        account.auth_state = DetectedAuthState::Stale;
        account.collection_state = DetectedCollectionState::Fallback;
        account.recovery = Some(RecoveryAction::ReopenCli);
        account.message = Some(format!(
            "Reopen {} to refresh this login.",
            provider.display_name()
        ));
    }

    pub fn mark_ready(&self, provider: DetectedProviderId, account_id: &str) {
        self.update_collection(
            provider,
            account_id,
            DetectedCollectionState::Ready,
            None,
            None,
        );
    }

    pub fn mark_fallback(&self, provider: DetectedProviderId, account_id: &str) {
        self.update_collection(
            provider,
            account_id,
            DetectedCollectionState::Fallback,
            Some(RecoveryAction::ManualEntry),
            Some("Automatic usage is unavailable. Statusline and manual entry remain available."),
        );
    }

    fn update_collection(
        &self,
        provider: DetectedProviderId,
        account_id: &str,
        state: DetectedCollectionState,
        recovery: Option<RecoveryAction>,
        message: Option<&str>,
    ) {
        let Ok(mut inventory) = self.inventory.write() else {
            return;
        };
        let Some(account) = inventory
            .report
            .providers
            .iter_mut()
            .find(|entry| entry.provider_id == provider)
            .and_then(|entry| {
                entry
                    .accounts
                    .iter_mut()
                    .find(|account| account.account_id == account_id)
            })
        else {
            return;
        };
        account.collection_state = state;
        account.recovery = recovery;
        account.message = message.map(str::to_string);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn context(platform: DiscoveryPlatform, home: &Path) -> DiscoveryContext {
        DiscoveryContext {
            platform,
            read_native_credentials: false,
            home: Some(home.to_path_buf()),
            roaming: Some(home.join("roaming")),
            local: Some(home.join("local")),
            application_support: Some(home.join("Library").join("Application Support")),
            xdg_config: Some(home.join("config")),
            xdg_data: Some(home.join("data")),
            codex_home: Some(home.join("codex-home")),
            grok_home: Some(home.join("grok-home")),
            kimi_code_home: Some(home.join("kimi-code-home")),
            kimi_share_dir: Some(home.join("kimi-share")),
            path_entries: vec![home.join("bin")],
        }
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("directory");
        fs::write(path, text).expect("write");
    }

    fn provider<'a>(report: &'a DetectionReport, id: DetectedProviderId) -> &'a ProviderDetection {
        report
            .providers
            .iter()
            .find(|entry| entry.provider_id == id)
            .expect("provider")
    }

    fn base64url(input: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut output = String::new();
        for chunk in input.chunks(3) {
            let first = u32::from(chunk[0]);
            let second = chunk.get(1).copied().map(u32::from).unwrap_or(0);
            let third = chunk.get(2).copied().map(u32::from).unwrap_or(0);
            let value = (first << 16) | (second << 8) | third;
            output.push(ALPHABET[((value >> 18) & 63) as usize] as char);
            output.push(ALPHABET[((value >> 12) & 63) as usize] as char);
            if chunk.len() > 1 {
                output.push(ALPHABET[((value >> 6) & 63) as usize] as char);
            }
            if chunk.len() > 2 {
                output.push(ALPHABET[(value & 63) as usize] as char);
            }
        }
        output
    }

    fn jwt(payload: &str) -> String {
        format!(
            "{}.{}.signature",
            base64url(br#"{"alg":"none"}"#),
            base64url(payload.as_bytes())
        )
    }

    #[test]
    fn file_candidates_are_unique_and_antigravity_uses_the_native_vault() {
        let dir = TempDir::new();
        for platform in [
            DiscoveryPlatform::Windows,
            DiscoveryPlatform::Macos,
            DiscoveryPlatform::Linux,
        ] {
            let context = context(platform, dir.path());
            for provider in DetectedProviderId::ALL {
                let candidates = candidate_paths(provider, &context);
                if provider == DetectedProviderId::Antigravity {
                    assert!(candidates
                        .iter()
                        .all(|entry| entry.kind != CandidateKind::Credential));
                } else {
                    assert!(candidates
                        .iter()
                        .any(|entry| entry.kind == CandidateKind::Credential));
                }
                let unique: BTreeSet<_> = candidates.iter().map(|entry| &entry.path).collect();
                assert_eq!(unique.len(), candidates.len());
            }
        }
    }

    #[test]
    fn only_wired_zero_setup_readers_claim_automatic_collection() {
        for provider in [
            DetectedProviderId::Claude,
            DetectedProviderId::Codex,
            DetectedProviderId::Antigravity,
            DetectedProviderId::Grok,
            DetectedProviderId::Kimi,
        ] {
            assert!(provider.supports_automatic_collection());
        }
        for provider in [DetectedProviderId::Opencode, DetectedProviderId::Openrouter] {
            assert!(!provider.supports_automatic_collection());
        }
    }

    #[test]
    fn product_truth_distinguishes_manual_opencode_from_key_based_openrouter() {
        let dir = TempDir::new();
        write(
            &dir.path().join("data").join("opencode").join("auth.json"),
            r#"{"opencode-go":{"type":"api","key":"fixture-opencode-api-key"}}"#,
        );
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Linux, dir.path()),
            1_800_000_000_000,
        );

        let opencode = provider(&inventory.report, DetectedProviderId::Opencode);
        assert_eq!(opencode.state, ProviderPresence::InstalledLoggedOut);
        assert!(opencode.accounts.is_empty());
        assert_eq!(opencode.connection_mode, ConnectionMode::ManualEntry);
        assert_eq!(opencode.recovery, Some(RecoveryAction::ManualEntry));
        assert!(opencode
            .message
            .as_deref()
            .is_some_and(|message| message.contains("no zero setup subscription quota")));

        let openrouter = provider(&inventory.report, DetectedProviderId::Openrouter);
        assert_eq!(openrouter.state, ProviderPresence::Absent);
        assert_eq!(openrouter.connection_mode, ConnectionMode::ApiKey);
        assert_eq!(openrouter.recovery, Some(RecoveryAction::ConnectApiKey));
        assert!(openrouter
            .message
            .as_deref()
            .is_some_and(|message| message.contains("OpenRouter API key")));

        let wire = serde_json::to_string(&inventory.report).expect("wire");
        assert!(wire.contains(r#""connection_mode":"manual_entry""#));
        assert!(wire.contains(r#""connection_mode":"api_key""#));
        assert!(!wire.contains("fixture-opencode-api-key"));
    }

    #[test]
    fn no_marker_and_no_executable_is_absent() {
        let dir = TempDir::new();
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Linux, dir.path()),
            1_800_000_000_000,
        );
        assert!(inventory
            .report
            .providers
            .iter()
            .all(|entry| entry.state == ProviderPresence::Absent));
    }

    #[test]
    fn an_executable_without_a_login_is_installed_logged_out() {
        let dir = TempDir::new();
        let executable = dir.path().join("bin").join("claude");
        write(&executable, "binary marker");
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Linux, dir.path()),
            1_800_000_000_000,
        );
        let claude = provider(&inventory.report, DetectedProviderId::Claude);
        assert_eq!(claude.state, ProviderPresence::InstalledLoggedOut);
        assert_eq!(claude.recovery, Some(RecoveryAction::SignInToCli));
    }

    #[test]
    fn claude_uses_account_metadata_and_never_serializes_a_token_or_path() {
        let dir = TempDir::new();
        let token = "claude-secret-value-that-must-never-cross-ipc";
        write(
            &dir.path().join(".claude").join(".credentials.json"),
            &format!(
                r#"{{"claudeAiOauth":{{"accessToken":"{token}","expiresAt":1900000000000}}}}"#
            ),
        );
        write(
            &dir.path().join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"account-one","emailAddress":"person@example.com"}}"#,
        );
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Windows, dir.path()),
            1_800_000_000_000,
        );
        let claude = provider(&inventory.report, DetectedProviderId::Claude);
        assert_eq!(claude.state, ProviderPresence::Present);
        assert_eq!(claude.accounts.len(), 1);
        assert_eq!(claude.accounts[0].auth_state, DetectedAuthState::Ready);
        assert_eq!(
            claude.accounts[0].identity_quality,
            IdentityQuality::ProviderAccount
        );
        assert_eq!(claude.accounts[0].label, "p***@example.com");
        let wire = serde_json::to_string(&inventory.report).expect("wire");
        assert!(!wire.contains(token));
        assert!(!wire.contains(".credentials.json"));
        assert!(!wire.contains("account-one"));
    }

    #[test]
    fn two_codex_profiles_are_two_accounts() {
        let dir = TempDir::new();
        let first = jwt(r#"{"sub":"user-one","exp":1900000000}"#);
        let second = jwt(r#"{"sub":"user-two","exp":1900000000}"#);
        write(
            &dir.path().join(".codex").join("auth.json"),
            &format!(r#"{{"tokens":{{"access_token":"{first}"}}}}"#),
        );
        write(
            &dir.path().join(".codex-work").join("auth.json"),
            &format!(r#"{{"tokens":{{"access_token":"{second}"}}}}"#),
        );
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Linux, dir.path()),
            1_800_000_000_000,
        );
        let codex = provider(&inventory.report, DetectedProviderId::Codex);
        assert_eq!(codex.state, ProviderPresence::Present);
        assert_eq!(codex.accounts.len(), 2);
        assert_ne!(codex.accounts[0].account_id, codex.accounts[1].account_id);
        assert!(codex
            .accounts
            .iter()
            .all(|entry| entry.identity_quality == IdentityQuality::JwtSubject));
    }

    #[test]
    fn the_same_codex_account_in_two_profile_paths_is_one_account() {
        let dir = TempDir::new();
        write(
            &dir.path().join(".codex").join("auth.json"),
            r#"{"tokens":{"access_token":"first-codex-token","account_id":"same-provider-account"}}"#,
        );
        write(
            &dir.path().join(".codex-work").join("auth.json"),
            r#"{"tokens":{"access_token":"rotated-codex-token","account_id":"same-provider-account"}}"#,
        );
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Linux, dir.path()),
            1_800_000_000_000,
        );
        let codex = provider(&inventory.report, DetectedProviderId::Codex);

        assert_eq!(codex.accounts.len(), 1);
        assert_eq!(
            codex.accounts[0].identity_quality,
            IdentityQuality::ProviderAccount
        );
        assert_eq!(
            inventory
                .credentials
                .keys()
                .filter(|(provider, _)| *provider == DetectedProviderId::Codex)
                .count(),
            1
        );
    }

    #[test]
    fn grok_scope_entries_resolve_and_dedupe_by_user_identity() {
        let dir = TempDir::new();
        let first = jwt(r#"{"sub":"grok-user-one","exp":1900000000}"#);
        let second = jwt(r#"{"sub":"grok-user-one","exp":1900000000}"#);
        write(
            &dir.path().join(".grok").join("auth.json"),
            &format!(
                r#"{{"user:read":{{"key":"{first}","user_id":"grok-user-one","expires_at":1900000000}}}}"#
            ),
        );
        write(
            &dir.path().join("grok-home").join("auth.json"),
            &format!(
                r#"{{"user:read":{{"key":"{second}","user_id":"grok-user-one","expires_at":1900000000}}}}"#
            ),
        );
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Windows, dir.path()),
            1_800_000_000_000,
        );
        let grok = provider(&inventory.report, DetectedProviderId::Grok);
        assert_eq!(grok.state, ProviderPresence::Present);
        assert_eq!(grok.accounts.len(), 1);
        assert_eq!(
            grok.accounts[0].identity_quality,
            IdentityQuality::ProviderAccount
        );
        assert!(grok.accounts[0].automatic_collection);
    }

    #[test]
    fn current_and_legacy_kimi_paths_dedupe_by_jwt_user_identity() {
        let dir = TempDir::new();
        let token = jwt(r#"{"user_id":"kimi-user-one","exp":1900000000}"#);
        let body = format!(
            r#"{{"access_token":"{token}","refresh_token":"stable-refresh","expires_at":1900000000.0}}"#
        );
        write(
            &dir.path()
                .join(".kimi-code")
                .join("credentials")
                .join("kimi-code.json"),
            &body,
        );
        write(
            &dir.path()
                .join(".kimi")
                .join("credentials")
                .join("kimi-code.json"),
            &body,
        );
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Linux, dir.path()),
            1_800_000_000_000,
        );
        let kimi = provider(&inventory.report, DetectedProviderId::Kimi);
        assert_eq!(kimi.state, ProviderPresence::Present);
        assert_eq!(kimi.accounts.len(), 1);
        assert_eq!(
            kimi.accounts[0].identity_quality,
            IdentityQuality::JwtSubject
        );
        assert!(kimi.accounts[0].automatic_collection);
    }

    #[test]
    fn new_provider_executables_without_credentials_are_logged_out() {
        let dir = TempDir::new();
        write(&dir.path().join("bin").join("grok"), "binary marker");
        write(&dir.path().join("bin").join("kimi"), "binary marker");
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Linux, dir.path()),
            1_800_000_000_000,
        );
        for id in [DetectedProviderId::Grok, DetectedProviderId::Kimi] {
            let found = provider(&inventory.report, id);
            assert_eq!(found.state, ProviderPresence::InstalledLoggedOut);
            assert_eq!(found.recovery, Some(RecoveryAction::SignInToCli));
        }
    }

    #[test]
    fn a_refresh_token_resolves_rotated_antigravity_files_to_one_identity() {
        let dir = TempDir::new();
        let first_path = dir.path().join("first-antigravity.json");
        let second_path = dir.path().join("second-antigravity.json");
        write(
            &first_path,
            r#"{"token":{"access_token":"first-access-token","refresh_token":"stable-refresh-token"}}"#,
        );
        write(
            &second_path,
            r#"{"token":{"access_token":"second-access-token","refresh_token":"stable-refresh-token"}}"#,
        );
        let first = parse_credential_file(DetectedProviderId::Antigravity, &first_path);
        let second = parse_credential_file(DetectedProviderId::Antigravity, &second_path);

        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_eq!(first[0].identity_material, second[0].identity_material);
        assert_ne!(first[0].token.as_str(), second[0].token.as_str());
    }

    #[test]
    fn stale_credentials_name_the_cli_recovery() {
        let dir = TempDir::new();
        write(
            &dir.path().join(".claude").join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"stale-claude-token-value","expiresAt":1700000000000}}"#,
        );
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Windows, dir.path()),
            1_800_000_000_000,
        );
        let account = &provider(&inventory.report, DetectedProviderId::Claude).accounts[0];
        assert_eq!(account.auth_state, DetectedAuthState::Stale);
        assert_eq!(account.recovery, Some(RecoveryAction::ReopenCli));
    }

    #[test]
    fn a_detected_secret_is_read_again_from_its_own_file() {
        let dir = TempDir::new();
        let token = "codex-access-token-for-one-profile";
        write(
            &dir.path().join(".codex").join("auth.json"),
            &format!(
                r#"{{"tokens":{{"access_token":"{token}","account_id":"provider-account"}}}}"#
            ),
        );
        let context = context(DiscoveryPlatform::Windows, dir.path());
        let inventory = scan_inventory(&context, 1_800_000_000_000);
        let account_id = provider(&inventory.report, DetectedProviderId::Codex).accounts[0]
            .account_id
            .clone();
        let store = DetectionStore {
            context,
            inventory: RwLock::new(inventory),
        };
        let secret = store
            .read_credential(DetectedProviderId::Codex, &account_id)
            .expect("credential");
        assert_eq!(secret.access_token.as_str(), token);
        assert_eq!(
            secret.provider_account_id.as_deref(),
            Some("provider-account")
        );
    }

    #[test]
    fn malformed_credentials_are_not_present() {
        let dir = TempDir::new();
        write(&dir.path().join(".codex").join("auth.json"), "not json");
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Windows, dir.path()),
            1_800_000_000_000,
        );
        let codex = provider(&inventory.report, DetectedProviderId::Codex);
        assert_eq!(codex.state, ProviderPresence::InstalledLoggedOut);
        assert!(codex.accounts.is_empty());
    }
}
