use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::fsx;
use crate::native_snapshot::{epoch_ms_from_rfc3339, iso_from_epoch_ms};

const MAX_PROFILE_DIRECTORIES: usize = 32;
const MAX_MANAGED_CODEX_ACCOUNTS: usize = 32;
const MAX_ACCOUNTS_PER_FILE: usize = 16;
const MAX_TOKEN_BYTES: usize = 4_096;
const MAX_IDENTITY_BYTES: usize = 512;

/* Windows: the Antigravity probe's application roots plus the npm global bin
below the roaming profile are the only user install locations accepted for
these command line clients. */
const CODEX_INSTALL_ROOTS_WINDOWS: &[&str] = &[
    "home/bin",
    "home/Applications",
    "roaming/npm",
    "local/Programs",
];
const CLAUDE_INSTALL_ROOTS_WINDOWS: &[&str] = CODEX_INSTALL_ROOTS_WINDOWS;
const GEMINI_INSTALL_ROOTS_WINDOWS: &[&str] = CODEX_INSTALL_ROOTS_WINDOWS;
const GROK_INSTALL_ROOTS_WINDOWS: &[&str] = CODEX_INSTALL_ROOTS_WINDOWS;
const KIMI_INSTALL_ROOTS_WINDOWS: &[&str] = &[
    "home/bin",
    "home/Applications",
    "roaming/npm",
    "local/Programs",
    "home/kimi-code",
    "home/kimi_code",
    "home/kimicode",
    "home/kimi-cli",
];

/* macOS: npm and standalone installs are bounded by the same home and system
roots the Antigravity probe trusts. */
const CODEX_INSTALL_ROOTS_MACOS: &[&str] =
    &["home/Applications", "home/bin", "home/.local", "home/.nvm"];
const CLAUDE_INSTALL_ROOTS_MACOS: &[&str] = CODEX_INSTALL_ROOTS_MACOS;
const GEMINI_INSTALL_ROOTS_MACOS: &[&str] = CODEX_INSTALL_ROOTS_MACOS;
const GROK_INSTALL_ROOTS_MACOS: &[&str] = CODEX_INSTALL_ROOTS_MACOS;
const KIMI_INSTALL_ROOTS_MACOS: &[&str] = &[
    "home/Applications",
    "home/bin",
    "home/.local",
    "home/.nvm",
    "home/kimi-code",
    "home/kimi_code",
    "home/kimicode",
    "home/kimi-cli",
];

/* Linux: the probe's local bin, home bin, application and package manager
roots are shared, with named Kimi install folders added explicitly. */
const CODEX_INSTALL_ROOTS_LINUX: &[&str] = &[
    "home/.local/bin",
    "home/bin",
    "home/Applications",
    "home/.local",
    "home/.nvm",
];
const CLAUDE_INSTALL_ROOTS_LINUX: &[&str] = CODEX_INSTALL_ROOTS_LINUX;
const GEMINI_INSTALL_ROOTS_LINUX: &[&str] = CODEX_INSTALL_ROOTS_LINUX;
const GROK_INSTALL_ROOTS_LINUX: &[&str] = CODEX_INSTALL_ROOTS_LINUX;
const KIMI_INSTALL_ROOTS_LINUX: &[&str] = &[
    "home/.local/bin",
    "home/bin",
    "home/Applications",
    "home/.local",
    "home/.nvm",
    "home/kimi-code",
    "home/kimi_code",
    "home/kimicode",
    "home/kimi-cli",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectedProviderId {
    Claude,
    Codex,
    Antigravity,
    GeminiCli,
    Opencode,
    Openrouter,
    Grok,
    Kimi,
}

impl DetectedProviderId {
    pub const ALL: [Self; 8] = [
        Self::Claude,
        Self::Codex,
        Self::Antigravity,
        Self::GeminiCli,
        Self::Opencode,
        Self::Openrouter,
        Self::Grok,
        Self::Kimi,
    ];

    pub(crate) const fn slug(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Antigravity => "antigravity",
            Self::GeminiCli => "gemini-cli",
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
            Self::GeminiCli => "Gemini CLI",
            Self::Opencode => "OpenCode",
            Self::Openrouter => "OpenRouter",
            Self::Grok => "Grok",
            Self::Kimi => "Kimi",
        }
    }

    const fn supports_automatic_collection(self) -> bool {
        matches!(
            self,
            Self::Claude
                | Self::Codex
                | Self::Antigravity
                | Self::GeminiCli
                | Self::Grok
                | Self::Kimi
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
    ProviderSingleton,
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
        | DetectedProviderId::GeminiCli
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
        | DetectedProviderId::GeminiCli
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub antigravity_running: Option<bool>,
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
    managed_codex_root: Option<PathBuf>,
    grok_home: Option<PathBuf>,
    kimi_code_home: Option<PathBuf>,
    kimi_share_dir: Option<PathBuf>,
    program_files: Vec<PathBuf>,
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
        let program_files = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
            .into_iter()
            .filter_map(non_empty_path)
            .collect();
        let managed_codex_root =
            crate::state::state_directory().map(|value| value.join("accounts").join("codex"));
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
            managed_codex_root,
            grok_home: non_empty_path("GROK_HOME"),
            kimi_code_home: non_empty_path("KIMI_CODE_HOME"),
            kimi_share_dir: non_empty_path("KIMI_SHARE_DIR"),
            program_files,
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
            paths.extend(managed_codex_candidates(
                context.managed_codex_root.as_deref(),
            ));
        }
        DetectedProviderId::Antigravity => {
            push_candidate(
                &mut paths,
                home,
                &[".gemini", "antigravity-cli", "settings.json"],
                Marker,
            );
        }
        DetectedProviderId::GeminiCli => {
            push_candidate(
                &mut paths,
                home,
                &[".gemini", "oauth_creds.json"],
                Credential,
            );
            push_candidate(&mut paths, home, &[".gemini", "settings.json"], Marker);
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
                DetectedProviderId::GeminiCli => {}
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
            match provider {
                DetectedProviderId::Antigravity => push_candidate(
                    &mut paths,
                    support,
                    &["Antigravity", "User", "globalStorage"],
                    Marker,
                ),
                DetectedProviderId::GeminiCli
                | DetectedProviderId::Grok
                | DetectedProviderId::Kimi => {}
                DetectedProviderId::Claude
                | DetectedProviderId::Codex
                | DetectedProviderId::Opencode
                | DetectedProviderId::Openrouter => {
                    let directory = match provider {
                        DetectedProviderId::Claude => "Claude Code",
                        DetectedProviderId::Codex => "Codex",
                        DetectedProviderId::Opencode => "opencode",
                        DetectedProviderId::Openrouter => "OpenRouter",
                        DetectedProviderId::Antigravity
                        | DetectedProviderId::GeminiCli
                        | DetectedProviderId::Grok
                        | DetectedProviderId::Kimi => {
                            unreachable!()
                        }
                    };
                    let file = match provider {
                        DetectedProviderId::Claude => ".credentials.json",
                        DetectedProviderId::Codex | DetectedProviderId::Opencode => "auth.json",
                        DetectedProviderId::Openrouter => "config.json",
                        DetectedProviderId::Antigravity
                        | DetectedProviderId::GeminiCli
                        | DetectedProviderId::Grok
                        | DetectedProviderId::Kimi => {
                            unreachable!()
                        }
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
        }
        DiscoveryPlatform::Linux => {
            if !matches!(
                provider,
                DetectedProviderId::Antigravity
                    | DetectedProviderId::GeminiCli
                    | DetectedProviderId::Grok
                    | DetectedProviderId::Kimi
            ) {
                let directory = provider.slug();
                let file = match provider {
                    DetectedProviderId::Claude => "credentials.json",
                    DetectedProviderId::Codex | DetectedProviderId::Opencode => "auth.json",
                    DetectedProviderId::Antigravity | DetectedProviderId::GeminiCli => {
                        unreachable!()
                    }
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

/// Managed device logins use `CODEX_HOME` itself as the configuration folder,
/// so their credential is directly under `accounts/codex/<session>`. Keep the
/// registration bounded and accept only a real child directory of the managed
/// root. A package or a symlink planted beside it must not become an account.
fn managed_codex_candidates(root: Option<&Path>) -> Vec<CandidatePath> {
    let Some(root) = root else {
        return Vec::new();
    };
    let Ok(resolved_root) = fs::canonicalize(root) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten().take(MAX_MANAGED_CODEX_ACCOUNTS * 2) {
        if found.len() >= MAX_MANAGED_CODEX_ACCOUNTS {
            break;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let Ok(resolved) = fs::canonicalize(&path) else {
            continue;
        };
        if resolved.parent() != Some(resolved_root.as_path()) {
            continue;
        }
        found.push(CandidatePath {
            path: path.join("auth.json"),
            kind: CandidateKind::Credential,
        });
    }
    found.sort_by(|left, right| left.path.cmp(&right.path));
    found
}

fn profile_prefix(provider: DetectedProviderId) -> Option<(&'static str, &'static str)> {
    match provider {
        DetectedProviderId::Claude => Some((".claude", ".credentials.json")),
        DetectedProviderId::Codex => Some((".codex", "auth.json")),
        DetectedProviderId::Antigravity
        | DetectedProviderId::GeminiCli
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

fn install_root_specs(
    provider: DetectedProviderId,
    platform: DiscoveryPlatform,
) -> &'static [&'static str] {
    match provider {
        DetectedProviderId::Codex => match platform {
            DiscoveryPlatform::Windows => CODEX_INSTALL_ROOTS_WINDOWS,
            DiscoveryPlatform::Macos => CODEX_INSTALL_ROOTS_MACOS,
            DiscoveryPlatform::Linux => CODEX_INSTALL_ROOTS_LINUX,
        },
        DetectedProviderId::Claude => match platform {
            DiscoveryPlatform::Windows => CLAUDE_INSTALL_ROOTS_WINDOWS,
            DiscoveryPlatform::Macos => CLAUDE_INSTALL_ROOTS_MACOS,
            DiscoveryPlatform::Linux => CLAUDE_INSTALL_ROOTS_LINUX,
        },
        DetectedProviderId::GeminiCli => match platform {
            DiscoveryPlatform::Windows => GEMINI_INSTALL_ROOTS_WINDOWS,
            DiscoveryPlatform::Macos => GEMINI_INSTALL_ROOTS_MACOS,
            DiscoveryPlatform::Linux => GEMINI_INSTALL_ROOTS_LINUX,
        },
        DetectedProviderId::Grok => match platform {
            DiscoveryPlatform::Windows => GROK_INSTALL_ROOTS_WINDOWS,
            DiscoveryPlatform::Macos => GROK_INSTALL_ROOTS_MACOS,
            DiscoveryPlatform::Linux => GROK_INSTALL_ROOTS_LINUX,
        },
        DetectedProviderId::Kimi => match platform {
            DiscoveryPlatform::Windows => KIMI_INSTALL_ROOTS_WINDOWS,
            DiscoveryPlatform::Macos => KIMI_INSTALL_ROOTS_MACOS,
            DiscoveryPlatform::Linux => KIMI_INSTALL_ROOTS_LINUX,
        },
        DetectedProviderId::Antigravity
        | DetectedProviderId::Opencode
        | DetectedProviderId::Openrouter => &[],
    }
}

fn antigravity_roots(context: &DiscoveryContext) -> Vec<PathBuf> {
    let platform = match context.platform {
        DiscoveryPlatform::Windows => crate::antigravity_local::TargetPlatform::Windows,
        DiscoveryPlatform::Macos => crate::antigravity_local::TargetPlatform::Macos,
        DiscoveryPlatform::Linux => crate::antigravity_local::TargetPlatform::Linux,
    };
    let program_files = context
        .program_files
        .iter()
        .map(PathBuf::as_path)
        .map(Some)
        .collect::<Vec<_>>();
    crate::antigravity_local::roots_for_platform(
        platform,
        context.home.as_deref(),
        context.local.as_deref(),
        context.roaming.as_deref(),
        &program_files,
    )
}

fn provider_install_roots(
    provider: DetectedProviderId,
    context: &DiscoveryContext,
) -> Vec<PathBuf> {
    let mut roots = antigravity_roots(context);
    for spec in install_root_specs(provider, context.platform) {
        let (base, relative) = spec.split_once('/').unwrap_or((spec, ""));
        let Some(base_path) = (match base {
            "home" => context.home.as_deref(),
            "roaming" => context.roaming.as_deref(),
            "local" => context.local.as_deref(),
            _ => None,
        }) else {
            continue;
        };
        let mut root = base_path.to_path_buf();
        for component in Path::new(relative).components() {
            if let Component::Normal(value) = component {
                root.push(value);
            }
        }
        roots.push(root);
    }
    roots
}

#[cfg(windows)]
fn is_reparse_point(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

#[cfg(not(windows))]
fn is_reparse_point(_path: &Path) -> bool {
    false
}

fn path_components_are_real_directory(path: &Path) -> bool {
    let mut current = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir) {
            return false;
        }
        current.push(component.as_os_str());
        if matches!(component, Component::Normal(_)) {
            let Ok(metadata) = fs::symlink_metadata(&current) else {
                return false;
            };
            if metadata.file_type().is_symlink() || is_reparse_point(&current) || !metadata.is_dir()
            {
                return false;
            }
        }
    }
    true
}

/// Resolve an executable launcher before accepting it. POSIX package managers
/// conventionally put a symbolic link in `bin/`; its target is accepted only
/// when canonicalization keeps it inside a trusted vendor install root. The
/// canonical target is returned, so a later process start does not follow the
/// launcher path again. A launcher outside those roots is never run and never
/// used for metadata.
fn validated_launcher(
    provider: DetectedProviderId,
    context: &DiscoveryContext,
    path: &Path,
) -> Option<PathBuf> {
    if !(path.is_absolute() || path.has_root())
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return None;
    }
    let metadata = fs::symlink_metadata(path).ok()?;
    if is_reparse_point(path) {
        return None;
    }
    if !metadata.is_file() && !metadata.file_type().is_symlink() {
        return None;
    }
    let resolved = fs::canonicalize(path).ok()?;
    if !fs::metadata(&resolved).is_ok_and(|metadata| metadata.is_file()) {
        return None;
    }
    provider_install_roots(provider, context)
        .into_iter()
        .filter(|root| path_components_are_real_directory(root))
        .filter_map(|root| fs::canonicalize(root).ok())
        .any(|root| resolved.starts_with(root))
        .then_some(resolved)
}

fn executable_names(provider: DetectedProviderId, platform: DiscoveryPlatform) -> Vec<String> {
    let base = match provider {
        DetectedProviderId::Claude => "claude",
        DetectedProviderId::Codex => "codex",
        DetectedProviderId::Antigravity => "antigravity",
        DetectedProviderId::GeminiCli => "gemini",
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

/// The directory names a Kimi Code installation is unpacked under.
///
/// The npm package, the standalone install and the shim all put the binary
/// inside a directory that carries the product's own name, which is what
/// separates it from another product that named its binary `kimi`.
///
/// `kimi-cli` is here because a `uv tool install` names the tool directory
/// after the distribution rather than the product, and `kimi code` because an
/// installer that unpacks into a folder a human named writes the words with a
/// space. The comparison is lower cased, so the capitalisation does not matter.
const KIMI_CODE_DIRECTORY_NAMES: [&str; 5] = [
    "kimi-code",
    "kimi_code",
    "kimicode",
    "kimi-cli",
    "kimi code",
];

/// Whether this directory sits inside a Kimi Code installation.
fn inside_kimi_code_installation(directory: &Path) -> bool {
    directory.components().any(|component| {
        let name = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        KIMI_CODE_DIRECTORY_NAMES.contains(&name.as_str())
    })
}

/// Whether Kimi Code has written its own profile on this machine.
///
/// The profile is written on first run, before any sign in, so it corroborates
/// an installed but logged out CLI as well as a signed in one. `~/.kimi` is
/// deliberately NOT here: it is the legacy directory, its name is the one
/// another product can share, and the legacy credential file inside it is
/// already a candidate path in its own right.
fn kimi_code_profile_present(context: &DiscoveryContext) -> bool {
    [
        context.kimi_code_home.clone(),
        context.kimi_share_dir.clone(),
        context.home.as_deref().map(|home| home.join(".kimi-code")),
    ]
    .into_iter()
    .flatten()
    .any(|path| safe_path_present(&path))
}

/// Whether this provider's own command line client is on the PATH.
///
/// FINDING F-205. A name is not an identity. Every provider here was accepted
/// on the NAME of a binary in a PATH directory, and `kimi` on this machine is
/// Hermes Agent, an unrelated product that happens to share the word. Kimi
/// Code was therefore reported installed, with a sign in offered for a CLI
/// that had never been there, and the account list said the login was the
/// missing part rather than the product.
///
/// So the name of the Kimi binary now has to be corroborated: it either sits
/// inside an installation named after the product, or the product's own
/// profile exists on this machine. Nothing is executed and no version is
/// asked for, because running a stranger's binary to find out whose it is
/// costs more than the question is worth. Every other provider keeps the name
/// rule, which their own names have not collided under.
fn executable_present(provider: DetectedProviderId, context: &DiscoveryContext) -> bool {
    let names = executable_names(provider, context.platform);
    let corroborated = provider != DetectedProviderId::Kimi || kimi_code_profile_present(context);
    context.path_entries.iter().any(|directory| {
        names
            .iter()
            .any(|name| validated_launcher(provider, context, &directory.join(name)).is_some())
            && (corroborated || inside_kimi_code_installation(directory))
    })
}

/// Where a client's own package metadata sits, relative to the directory its
/// executable was found in.
///
/// A shim in `bin/` with the manifest one level up is the npm layout, and a
/// manifest beside the binary is the flat one. Nothing deeper is walked: this
/// is a lookup for a version a client already published about itself, not a
/// search of the filesystem.
const CLIENT_MANIFEST_PATHS: [&[&str]; 2] = [&["package.json"], &["..", "package.json"]];

/// Longest version string accepted, matching `valid_client_version` in
/// `net.rs`, which is the boundary that decides whether one may be sent.
const MAX_CLIENT_VERSION_BYTES: usize = 32;

/// The version of a provider's installed client, when the installation states
/// one, and nothing when it does not.
///
/// Read from the package metadata the client ships beside its own executable,
/// never by RUNNING it: the same rule finding F-205 settled, since executing
/// a binary to ask whose it is costs more than the question is worth. Absent,
/// unreadable, or malformed metadata is `None`, and a caller that wanted to
/// state a version omits the claim instead of inventing one.
fn installed_client_version(
    provider: DetectedProviderId,
    context: &DiscoveryContext,
) -> Option<String> {
    let names = executable_names(provider, context.platform);
    for directory in &context.path_entries {
        let launcher = names
            .iter()
            .find_map(|name| validated_launcher(provider, context, &directory.join(name)));
        let Some(launcher) = launcher else {
            continue;
        };
        for manifest in client_manifest_candidates(provider, directory, &launcher) {
            if let Some(version) = manifest_version(provider, &manifest) {
                return Some(version);
            }
        }
    }
    None
}

/// Where a provider's installed client actually is, when it is installed.
///
/// The first entry on the search path that holds one. A symbolic launcher is
/// returned as its canonical regular target, which is the same rule every
/// other read in this module applies. A caller never supplies a path: an
/// executable this product runs is one it found itself.
fn installed_executable(
    provider: DetectedProviderId,
    context: &DiscoveryContext,
) -> Option<PathBuf> {
    let names = executable_names(provider, context.platform);
    for directory in &context.path_entries {
        for name in &names {
            let candidate = directory.join(name);
            if let Some(resolved) = validated_launcher(provider, context, &candidate) {
                return Some(resolved);
            }
        }
    }
    None
}

fn package_name(provider: DetectedProviderId) -> Option<&'static str> {
    match provider {
        DetectedProviderId::Claude => Some("@anthropic-ai/claude-code"),
        DetectedProviderId::Codex => Some("@openai/codex"),
        DetectedProviderId::GeminiCli => Some("@google/gemini-cli"),
        DetectedProviderId::Opencode => Some("opencode-ai"),
        DetectedProviderId::Grok => Some("@xai-official/grok"),
        DetectedProviderId::Kimi => Some("@moonshot-ai/kimi-code"),
        DetectedProviderId::Antigravity | DetectedProviderId::Openrouter => None,
    }
}

/// Find the package manifest for both common npm layouts. The resolved POSIX
/// target lets the search walk up from a package's `bin` directory, while the
/// explicit `node_modules` candidates cover Windows command shims whose text
/// launcher does not expose a filesystem target to Rust.
fn client_manifest_candidates(
    provider: DetectedProviderId,
    directory: &Path,
    launcher: &Path,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for relative in CLIENT_MANIFEST_PATHS {
        let mut manifest = directory.to_path_buf();
        for part in relative {
            manifest.push(part);
        }
        candidates.push(manifest);
    }

    let mut roots = vec![directory.to_path_buf()];
    if let Some(parent) = launcher.parent() {
        if !roots.iter().any(|root| root == parent) {
            roots.push(parent.to_path_buf());
        }
    }
    if let Some(parent) = launcher
        .canonicalize()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
    {
        if !roots.iter().any(|root| root == &parent) {
            roots.push(parent);
        }
    }

    let package = package_name(provider);
    for mut root in roots {
        for _ in 0..=6 {
            if let Some(package) = package {
                candidates.push(root.join("node_modules").join(package).join("package.json"));
            }
            candidates.push(root.join("package.json"));
            let Some(parent) = root.parent() else {
                break;
            };
            if parent == root {
                break;
            }
            root = parent.to_path_buf();
        }
    }

    let mut unique = BTreeSet::new();
    candidates.retain(|path| unique.insert(path.clone()));
    candidates
}

fn manifest_version(provider: DetectedProviderId, path: &Path) -> Option<String> {
    let raw = fsx::bounded_read(path)?;
    let manifest = serde_json::from_str::<Value>(&raw).ok()?;
    let package = package_name(provider)?;
    if manifest.get("name")?.as_str()? != package {
        return None;
    }
    let version = manifest.get("version")?.as_str()?.trim().to_string();
    let shaped = !version.is_empty()
        && version.len() <= MAX_CLIENT_VERSION_BYTES
        && version
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'+'));
    shaped.then_some(version)
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
    [
        "expiresAt",
        "expires_at",
        "expiry_date",
        "expires",
        "expiration",
    ]
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
        DetectedProviderId::GeminiCli => &["oauth", "tokens", "credentials"],
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
        DetectedProviderId::GeminiCli => &["access_token", "accessToken"],
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
) -> Option<String> {
    let claims = jwt_claims(credential)?;
    let (material, _) = claim_identity(&claims)?;
    Some(opaque_account_id(provider, material))
}

const PROVIDER_SINGLETON_MATERIAL: &str = "one-active-account-without-stable-identity";

pub(crate) fn provider_singleton_account_id(provider: DetectedProviderId) -> String {
    opaque_account_id(provider, PROVIDER_SINGLETON_MATERIAL)
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
        if provider == DetectedProviderId::GeminiCli
            && explicit_id.or(hinted).is_none()
            && claim.is_none()
        {
            /* A refreshed access token is not an account identity. Refusing a
            Gemini login whose ID token has no stable subject prevents one
            account from becoming a new poll target after every refresh. */
            continue;
        }
        let (identity_material, identity_quality) = if let Some(value) = explicit_id.or(hinted) {
            (value.to_string(), IdentityQuality::ProviderAccount)
        } else if let Some((value, quality)) = claim {
            (value.to_string(), quality)
        } else {
            (
                PROVIDER_SINGLETON_MATERIAL.to_string(),
                IdentityQuality::ProviderSingleton,
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
                identity_material: PROVIDER_SINGLETON_MATERIAL.to_string(),
                email: None,
                expires_at_ms: credential.expires_at_ms,
                identity_quality: IdentityQuality::ProviderSingleton,
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
            antigravity_running: None,
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

    /// Validate one device login home, rescan the owned account root, and
    /// return the opaque account id that the automatic Codex collector uses.
    /// The home must be a direct child of the state directory this process
    /// owns, and the vendor file must contain exactly one readable account.
    pub fn register_managed_account(&self, home: &Path) -> Option<String> {
        let root = self.context.managed_codex_root.as_deref()?;
        if !path_components_are_real_directory(root) || !path_components_are_real_directory(home) {
            return None;
        }
        let resolved_root = fs::canonicalize(root).ok()?;
        let resolved_home = fs::canonicalize(home).ok()?;
        if resolved_home.parent() != Some(resolved_root.as_path()) {
            return None;
        }
        let _opened_home = fs::read_dir(&resolved_home).ok()?;
        let name = resolved_home.file_name()?.to_string_lossy();
        if name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        {
            return None;
        }
        let mut parsed =
            parse_credential_file(DetectedProviderId::Codex, &resolved_home.join("auth.json"));
        if parsed.len() != 1 {
            return None;
        }
        let account_id = opaque_account_id(DetectedProviderId::Codex, &parsed[0].identity_material);
        drop(parsed.pop());
        /* Keep the whole registration pass on the canonical root captured
        above. A later scan through the original path could observe a
        parent replacement and read a different account tree. */
        let mut context = self.context.clone();
        context.managed_codex_root = Some(resolved_root);
        let next = scan_inventory(&context, crate::connections::now_epoch_ms());
        let report = next.report.clone();
        match self.inventory.write() {
            Ok(mut inventory) => *inventory = next,
            Err(poisoned) => *poisoned.into_inner() = next,
        }
        report
            .providers
            .iter()
            .find(|provider| provider.provider_id == DetectedProviderId::Codex)
            .is_some_and(|provider| {
                provider
                    .accounts
                    .iter()
                    .any(|account| account.account_id == account_id)
            })
            .then_some(account_id)
    }

    /// The version of this provider's installed client, when the installation
    /// states one on disk.
    ///
    /// This used to answer "which build am I standing in for", for a request
    /// that copied another client's contract. Decision D5 ended that: no
    /// request states a client version any more. What it answers now is
    /// whether an action may be offered at all, because a subcommand that
    /// arrived in a particular release cannot be offered to an older one.
    /// Nothing is executed to find out, and a machine that states no version
    /// gets `None`, which reads as too old rather than as new enough.
    pub fn client_version(&self, provider: DetectedProviderId) -> Option<String> {
        installed_client_version(provider, &self.context)
    }

    /// Where this provider's installed client is, when it is installed.
    pub fn client_executable(&self, provider: DetectedProviderId) -> Option<PathBuf> {
        installed_executable(provider, &self.context)
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

    #[cfg(test)]
    pub(crate) fn for_test_home(home: &Path, now_ms: u64) -> Self {
        let context = DiscoveryContext {
            platform: DiscoveryPlatform::Linux,
            read_native_credentials: false,
            home: Some(home.to_path_buf()),
            roaming: None,
            local: None,
            application_support: None,
            xdg_config: Some(home.join(".config")),
            xdg_data: Some(home.join(".local").join("share")),
            codex_home: None,
            managed_codex_root: Some(home.join("accounts").join("codex")),
            grok_home: None,
            kimi_code_home: None,
            kimi_share_dir: None,
            program_files: Vec::new(),
            path_entries: vec![home.join("bin")],
        };
        let inventory = scan_inventory(&context, now_ms);
        Self {
            context,
            inventory: RwLock::new(inventory),
        }
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
            managed_codex_root: Some(home.join("managed-codex")),
            grok_home: Some(home.join("grok-home")),
            kimi_code_home: Some(home.join("kimi-code-home")),
            kimi_share_dir: Some(home.join("kimi-share")),
            program_files: Vec::new(),
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
            DetectedProviderId::GeminiCli,
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
    fn an_empty_home_is_absent_on_every_platform() {
        for platform in [
            DiscoveryPlatform::Windows,
            DiscoveryPlatform::Macos,
            DiscoveryPlatform::Linux,
        ] {
            let dir = TempDir::new();
            let inventory = scan_inventory(&context(platform, dir.path()), 1_800_000_000_000);
            assert!(
                inventory
                    .report
                    .providers
                    .iter()
                    .all(|entry| entry.state == ProviderPresence::Absent),
                "an empty home reported a provider on {platform:?}"
            );
        }
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
    fn gemini_has_distinct_absent_and_installed_logged_out_states() {
        let dir = TempDir::new();
        let empty = scan_inventory(
            &context(DiscoveryPlatform::Linux, dir.path()),
            1_800_000_000_000,
        );
        assert_eq!(
            provider(&empty.report, DetectedProviderId::GeminiCli).state,
            ProviderPresence::Absent
        );

        write(&dir.path().join("bin").join("gemini"), "binary marker");
        let installed = scan_inventory(
            &context(DiscoveryPlatform::Linux, dir.path()),
            1_800_000_000_000,
        );
        let gemini = provider(&installed.report, DetectedProviderId::GeminiCli);
        assert_eq!(gemini.state, ProviderPresence::InstalledLoggedOut);
        assert_eq!(gemini.recovery, Some(RecoveryAction::SignInToCli));
        assert!(gemini.accounts.is_empty());
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

    /// Grok is still found by its name alone. Kimi is not, and the three tests
    /// below say why.
    #[test]
    fn new_provider_executables_without_credentials_are_logged_out() {
        let dir = TempDir::new();
        write(&dir.path().join("bin").join("grok"), "binary marker");
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Linux, dir.path()),
            1_800_000_000_000,
        );
        let found = provider(&inventory.report, DetectedProviderId::Grok);
        assert_eq!(found.state, ProviderPresence::InstalledLoggedOut);
        assert_eq!(found.recovery, Some(RecoveryAction::SignInToCli));
    }

    /// Finding F-205: a name is not an identity.
    ///
    /// `kimi` on this machine's PATH is Hermes Agent, an unrelated product
    /// that happens to share the word, and it was enough to report Kimi Code
    /// installed and to offer a sign in for a CLI that was never there. The
    /// executable now has to be corroborated by the installation it sits in or
    /// by the profile Kimi Code writes.
    #[test]
    fn an_executable_named_kimi_is_not_kimi_code_on_its_own() {
        let dir = TempDir::new();
        write(
            &dir.path().join("bin").join("kimi"),
            "an unrelated agent that shares the name",
        );
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Linux, dir.path()),
            1_800_000_000_000,
        );
        let kimi = provider(&inventory.report, DetectedProviderId::Kimi);
        assert_eq!(kimi.state, ProviderPresence::Absent);
        assert_eq!(kimi.recovery, Some(RecoveryAction::ManualEntry));
    }

    #[test]
    fn kimi_code_installed_under_its_own_directory_is_found() {
        let dir = TempDir::new();
        let installed = dir.path().join("kimi-code").join("bin");
        write(&installed.join("kimi"), "binary marker");
        let mut discovery = context(DiscoveryPlatform::Linux, dir.path());
        discovery.path_entries = vec![installed];
        let inventory = scan_inventory(&discovery, 1_800_000_000_000);
        let kimi = provider(&inventory.report, DetectedProviderId::Kimi);
        assert_eq!(kimi.state, ProviderPresence::InstalledLoggedOut);
        assert_eq!(kimi.recovery, Some(RecoveryAction::SignInToCli));
    }

    #[test]
    fn kimi_code_with_its_own_profile_is_found_wherever_it_sits_on_path() {
        let dir = TempDir::new();
        write(&dir.path().join("bin").join("kimi"), "binary marker");
        write(
            &dir.path().join(".kimi-code").join("settings.json"),
            "{\"theme\":\"dark\"}",
        );
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Linux, dir.path()),
            1_800_000_000_000,
        );
        let kimi = provider(&inventory.report, DetectedProviderId::Kimi);
        assert_eq!(kimi.state, ProviderPresence::InstalledLoggedOut);
        assert_eq!(kimi.recovery, Some(RecoveryAction::SignInToCli));
    }

    /// A `uv tool install` names the tool directory after the distribution,
    /// `kimi-cli`, rather than after the product, so an installation that is
    /// unmistakably Kimi Code sits in a directory the first version of this
    /// rule did not recognise.
    #[test]
    fn kimi_code_installed_by_uv_tool_is_found() {
        let dir = TempDir::new();
        let installed = dir
            .path()
            .join(".local")
            .join("share")
            .join("uv")
            .join("tools")
            .join("kimi-cli")
            .join("bin");
        write(&installed.join("kimi"), "binary marker");
        let mut discovery = context(DiscoveryPlatform::Linux, dir.path());
        discovery.path_entries = vec![installed];
        let inventory = scan_inventory(&discovery, 1_800_000_000_000);
        let kimi = provider(&inventory.report, DetectedProviderId::Kimi);
        assert_eq!(kimi.state, ProviderPresence::InstalledLoggedOut);
        assert_eq!(kimi.recovery, Some(RecoveryAction::SignInToCli));
    }

    #[test]
    fn a_managed_codex_device_login_is_discovered_from_its_owned_home() {
        let dir = TempDir::new();
        let root = dir.path().join("managed-codex");
        let session = root.join("abc123");
        let token = jwt(r#"{"account_id":"managed-account","exp":1900000000}"#);
        write(
            &session.join("auth.json"),
            &format!(r#"{{"tokens":{{"access_token":"{token}"}}}}"#),
        );
        let mut discovery = context(DiscoveryPlatform::Linux, dir.path());
        discovery.managed_codex_root = Some(root);
        let inventory = scan_inventory(&discovery, 1_800_000_000_000);
        let codex = provider(&inventory.report, DetectedProviderId::Codex);
        assert_eq!(codex.state, ProviderPresence::Present);
        assert_eq!(codex.accounts.len(), 1);
        assert!(inventory.credentials.contains_key(&(
            DetectedProviderId::Codex,
            codex.accounts[0].account_id.clone()
        )));
    }

    #[test]
    fn registering_a_managed_home_validates_then_rescans_it() {
        let dir = TempDir::new();
        let detection = DetectionStore::for_test_home(dir.path(), 1_800_000_000_000);
        let session = dir.path().join("accounts").join("codex").join("abc123");
        let token = jwt(r#"{"account_id":"managed-account","exp":1900000000}"#);
        write(
            &session.join("auth.json"),
            &format!(r#"{{"tokens":{{"access_token":"{token}"}}}}"#),
        );
        let account_id = detection
            .register_managed_account(&session)
            .expect("managed account");
        assert!(detection
            .account_ids(DetectedProviderId::Codex)
            .contains(&account_id));
    }

    #[cfg(unix)]
    #[test]
    fn a_posix_package_launcher_symlink_is_resolved_and_accepted() {
        use std::os::unix::fs::symlink;

        let dir = TempDir::new();
        // Use a real home root even when the OS temp directory is an alias,
        // as /var is on macOS. The launcher itself is the link under test.
        let home = fs::canonicalize(dir.path()).expect("canonical home");
        let bin = home.join("bin");
        let package_bin = home
            .join(".nvm")
            .join("node_modules")
            .join("grok")
            .join("bin");
        write(&package_bin.join("grok.js"), "javascript marker");
        fs::create_dir_all(&bin).expect("bin directory");
        symlink(package_bin.join("grok.js"), bin.join("grok")).expect("launcher symlink");
        let mut discovery = context(DiscoveryPlatform::Linux, &home);
        discovery.path_entries = vec![bin.clone()];
        assert_eq!(
            installed_executable(DetectedProviderId::Grok, &discovery),
            Some(fs::canonicalize(package_bin.join("grok.js")).expect("canonical target"))
        );
        assert_eq!(
            provider(
                &scan_inventory(&discovery, 1_800_000_000_000).report,
                DetectedProviderId::Grok
            )
            .state,
            ProviderPresence::InstalledLoggedOut
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_launcher_linked_outside_the_vendor_root_is_refused() {
        use std::os::unix::fs::symlink;

        let dir = TempDir::new();
        let outside = TempDir::new();
        let home = fs::canonicalize(dir.path()).expect("canonical home");
        let bin = home.join("bin");
        write(&outside.path().join("grok"), "untrusted binary");
        fs::create_dir_all(&bin).expect("bin directory");
        symlink(outside.path().join("grok"), bin.join("grok")).expect("launcher symlink");
        let mut discovery = context(DiscoveryPlatform::Linux, &home);
        discovery.path_entries = vec![bin];
        assert_eq!(
            installed_executable(DetectedProviderId::Grok, &discovery),
            None
        );
        assert_eq!(
            provider(
                &scan_inventory(&discovery, 1_800_000_000_000).report,
                DetectedProviderId::Grok
            )
            .state,
            ProviderPresence::Absent
        );
    }

    /// A reader that borrows another client's request contract may state that
    /// client's version, and only a version the installation published itself.
    #[test]
    fn a_client_version_comes_from_the_installation_or_not_at_all() {
        let dir = TempDir::new();
        let bin = dir.path().join("bin");
        write(&bin.join("grok"), "binary marker");
        let mut discovery = context(DiscoveryPlatform::Linux, dir.path());
        discovery.path_entries = vec![bin.clone()];

        /* An installation that publishes nothing about itself yields nothing,
        which is what keeps the request silent rather than inventive. */
        assert_eq!(
            installed_client_version(DetectedProviderId::Grok, &discovery),
            None
        );

        /* A Windows npm shim lives beside the prefix, while its scoped
        package manifest lives below the prefix's node_modules directory. */
        let npm_bin = dir.path().join("bin");
        write(&npm_bin.join("codex.cmd"), "@echo off");
        write(
            &npm_bin
                .join("node_modules")
                .join("@openai")
                .join("codex")
                .join("package.json"),
            r#"{"name":"@openai/codex","version":"0.153.3"}"#,
        );
        let mut windows = context(DiscoveryPlatform::Windows, dir.path());
        windows.path_entries = vec![npm_bin];
        assert_eq!(
            installed_client_version(DetectedProviderId::Codex, &windows),
            Some("0.153.3".to_string())
        );

        /* The npm layout: a shim in bin/, the manifest one level up. */
        /* A manifest for another package is not evidence about this binary,
        even when it carries a well shaped version. */
        write(
            &dir.path().join("package.json"),
            r#"{"name":"grok-build","version":"1.4.2"}"#,
        );
        assert_eq!(
            installed_client_version(DetectedProviderId::Grok, &discovery),
            None
        );
        write(
            &dir.path().join("package.json"),
            r#"{"name":"@xai-official/grok","version":"1.4.2"}"#,
        );
        assert_eq!(
            installed_client_version(DetectedProviderId::Grok, &discovery),
            Some("1.4.2".to_string())
        );
    }

    #[test]
    fn credential_only_antigravity_paths_use_one_provider_singleton() {
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
        assert_eq!(
            first[0].identity_quality,
            IdentityQuality::ProviderSingleton
        );
        assert_eq!(
            second[0].identity_quality,
            IdentityQuality::ProviderSingleton
        );
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

    #[test]
    fn gemini_uses_the_id_token_subject_and_millisecond_expiry() {
        let dir = TempDir::new();
        let id_token = jwt(r#"{"sub":"google-user-one","email":"person@example.com"}"#);
        write(
            &dir.path().join(".gemini").join("oauth_creds.json"),
            &format!(
                r#"{{"access_token":"gemini-access-token-for-tests","id_token":"{id_token}","expiry_date":1900000000000}}"#
            ),
        );
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Windows, dir.path()),
            1_800_000_000_000,
        );
        let gemini = provider(&inventory.report, DetectedProviderId::GeminiCli);
        assert_eq!(gemini.state, ProviderPresence::Present);
        assert_eq!(gemini.accounts.len(), 1);
        assert_eq!(gemini.accounts[0].auth_state, DetectedAuthState::Ready);
        assert_eq!(
            gemini.accounts[0].identity_quality,
            IdentityQuality::JwtSubject
        );
        assert_eq!(gemini.accounts[0].label, "p***@example.com");
        assert!(gemini.accounts[0].automatic_collection);
    }

    #[test]
    fn gemini_identity_deduplicates_across_credential_paths() {
        let dir = TempDir::new();
        let id_token = jwt(r#"{"sub":"same-google-user"}"#);
        let first = dir.path().join("first.json");
        let second = dir.path().join("nested").join("second.json");
        write(
            &first,
            &format!(r#"{{"access_token":"first-gemini-token","id_token":"{id_token}"}}"#),
        );
        write(
            &second,
            &format!(r#"{{"access_token":"second-gemini-token","id_token":"{id_token}"}}"#),
        );
        let first = parse_credential_file(DetectedProviderId::GeminiCli, &first);
        let second = parse_credential_file(DetectedProviderId::GeminiCli, &second);
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_eq!(
            opaque_account_id(DetectedProviderId::GeminiCli, &first[0].identity_material),
            opaque_account_id(DetectedProviderId::GeminiCli, &second[0].identity_material)
        );
    }

    #[test]
    fn gemini_refuses_an_access_token_as_an_account_identity() {
        let dir = TempDir::new();
        write(
            &dir.path().join(".gemini").join("oauth_creds.json"),
            r#"{"access_token":"rotating-token-with-no-id-token"}"#,
        );
        let inventory = scan_inventory(
            &context(DiscoveryPlatform::Linux, dir.path()),
            1_800_000_000_000,
        );
        let gemini = provider(&inventory.report, DetectedProviderId::GeminiCli);
        assert_eq!(gemini.state, ProviderPresence::InstalledLoggedOut);
        assert!(gemini.accounts.is_empty());
    }
}
