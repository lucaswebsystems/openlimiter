//! Local consumer of the frozen NotificationSubmission and channel preferences.
use super::{
    contract::{identifier, instant},
    engine::NotificationSubmission,
    runtime,
    storage::Directory,
};
use serde::{Deserialize, Serialize};
use std::{io, path::Path};

const FILE: &str = "activity-notifications-v1.json";
const PROVIDERS: &[&str] = &[
    "CLAUDE",
    "CODEX",
    "MUSE",
    "GEMINI_CLI",
    "CURSOR",
    "KIMI",
    "GROK",
    "ANTIGRAVITY",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuietHours {
    pub start_minute: u16,
    pub end_minute: u16,
    pub utc_offset_minutes: i16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Channel {
    pub enabled: bool,
    pub quiet_hours: Option<QuietHours>,
    pub snoozed_until: Option<String>,
    pub muted_providers: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub local: Channel,
    pub sound: Sound,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Sound {
    Silent,
    Default,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            local: Channel {
                enabled: true,
                quiet_hours: None,
                snoozed_until: None,
                muted_providers: vec![],
            },
            sound: Sound::Default,
        }
    }
}
impl Preferences {
    fn valid(&self) -> bool {
        self.local.muted_providers.len() <= PROVIDERS.len()
            && self
                .local
                .muted_providers
                .iter()
                .all(|p| PROVIDERS.contains(&p.as_str()))
            && self
                .local
                .snoozed_until
                .as_deref()
                .is_none_or(|s| instant(s).is_some())
            && self.local.quiet_hours.as_ref().is_none_or(|q| {
                q.start_minute < 1440
                    && q.end_minute < 1440
                    && (-840..=840).contains(&q.utc_offset_minutes)
            })
    }
}

fn load_at(root: &Path) -> io::Result<Preferences> {
    let directory = match Directory::root(root) {
        Ok(directory) => directory,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Preferences::default()),
        Err(e) => return Err(e),
    };
    match directory.read(FILE, 8192) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Preferences::default()),
        Err(e) => Err(e),
        Ok(bytes) => {
            let value: Preferences =
                serde_json::from_slice(&bytes).map_err(|_| super::storage::unsafe_path())?;
            if !value.valid() {
                return Err(super::storage::unsafe_path());
            }
            Ok(value)
        }
    }
}
pub fn load() -> io::Result<Preferences> {
    load_at(&runtime::state_root().ok_or_else(super::storage::unsafe_path)?)
}
pub fn save(value: &Preferences) -> io::Result<()> {
    save_at(
        &runtime::state_root().ok_or_else(super::storage::unsafe_path)?,
        value,
    )
}

fn save_at(root: &Path, value: &Preferences) -> io::Result<()> {
    if !value.valid() {
        return Err(super::storage::unsafe_path());
    }
    Directory::create_root(root)?.write(FILE, &serde_json::to_vec(value)?)
}

fn permits(s: &NotificationSubmission, p: &Preferences, now: i64) -> bool {
    if !p.valid()
        || !p.local.enabled
        || s.local_channel != "popup"
        || !PROVIDERS.contains(&s.provider.as_str())
        || p.local.muted_providers.contains(&s.provider)
        || s.account.as_deref().is_some_and(|a| !identifier(a))
        || !["agent_waiting", "agent_done"].contains(&s.kind.as_str())
        || p.local
            .snoozed_until
            .as_deref()
            .and_then(instant)
            .is_some_and(|until| now < until)
    {
        return false;
    }
    let Some(parts) = s
        .dedupe_key
        .strip_prefix("activity:")
        .and_then(|key| serde_json::from_str::<serde_json::Value>(key).ok())
    else {
        return false;
    };
    let Some(parts) = parts.as_array() else {
        return false;
    };
    if parts.len() != 5
        || parts[0] != s.provider
        || parts[1] != serde_json::json!(s.account)
        || !parts[2].as_str().is_some_and(identifier)
        || !parts[3]
            .as_u64()
            .is_some_and(|n| n <= super::contract::SAFE_INTEGER)
        || parts[4] != s.kind
        || s.dedupe_key != format!("activity:{}", serde_json::json!(parts))
    {
        return false;
    }
    let Some(q) = &p.local.quiet_hours else {
        return true;
    };
    let minute = (now.div_euclid(60_000) + i64::from(q.utc_offset_minutes)).rem_euclid(1440) as u16;
    !(if q.start_minute < q.end_minute {
        minute >= q.start_minute && minute < q.end_minute
    } else if q.start_minute > q.end_minute {
        minute >= q.start_minute || minute < q.end_minute
    } else {
        false
    })
}

fn title(s: &NotificationSubmission) -> String {
    let agent = match s.provider.as_str() {
        "CLAUDE" => "Claude",
        "CODEX" => "Codex",
        "MUSE" => "Muse",
        "GEMINI_CLI" => "Gemini CLI",
        "CURSOR" => "Cursor",
        "KIMI" => "Kimi",
        "GROK" => "Grok",
        "ANTIGRAVITY" => "Antigravity",
        _ => "Agent",
    };
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("../../../ui/agents.en.json"))
            .expect("bundled English catalog");
    let key = if s.kind == "agent_waiting" {
        "agents.toast.waiting"
    } else {
        "agents.toast.done"
    };
    catalog[key]
        .as_str()
        .expect("bundled toast key")
        .replace("{agent}", agent)
}

pub fn submit<R: tauri::Runtime>(app: &tauri::AppHandle<R>, submission: &NotificationSubmission) {
    let Ok(mut preferences) = load() else {
        return;
    };
    // The frozen policy takes the caller's offset at now, including DST.
    if let Some(quiet) = &mut preferences.local.quiet_hours {
        quiet.utc_offset_minutes = (chrono::Local::now().offset().local_minus_utc() / 60) as i16;
    }
    if permits(
        submission,
        &preferences,
        chrono::Utc::now().timestamp_millis(),
    ) {
        deliver(app, &title(submission), preferences.sound);
    }
}

#[cfg(not(test))]
fn deliver<R: tauri::Runtime>(app: &tauri::AppHandle<R>, title: &str, sound: Sound) {
    use tauri_plugin_notification::NotificationExt;
    let mut toast = app.notification().builder().title(title);
    if matches!(sound, Sound::Default) {
        toast = toast.sound("Default");
    }
    let _ = toast.show();
}
#[cfg(test)]
fn deliver<R: tauri::Runtime>(_: &tauri::AppHandle<R>, _: &str, _: Sound) {}

#[cfg(test)]
mod tests {
    use super::*;
    fn submission() -> NotificationSubmission {
        NotificationSubmission {
            kind: "agent_waiting".into(),
            provider: "CLAUDE".into(),
            account: None,
            dedupe_key: "activity:[\"CLAUDE\",null,\"session\",1,\"agent_waiting\"]".into(),
            local_channel: "popup",
            remote_channel: false,
        }
    }
    #[test]
    fn free_local_submission_honors_channel_mute_snooze_and_sound() {
        let s = submission();
        let mut p = Preferences::default();
        assert!(permits(&s, &p, 0));
        p.sound = Sound::Silent;
        assert!(permits(&s, &p, 0));
        p.local.enabled = false;
        assert!(!permits(&s, &p, 0));
        p.local.enabled = true;
        p.local.muted_providers.push("CLAUDE".into());
        assert!(!permits(&s, &p, 0));
        p.local.muted_providers.clear();
        p.local.snoozed_until = Some("2026-09-28T12:00:00.000Z".into());
        assert!(!permits(&s, &p, 0));
        assert_eq!(title(&s), "Claude needs you");
    }
    #[test]
    fn quiet_hours_wrap_offset_and_equal_endpoints() {
        let s = submission();
        let mut p = Preferences::default();
        p.local.quiet_hours = Some(QuietHours {
            start_minute: 1320,
            end_minute: 420,
            utc_offset_minutes: -180,
        });
        assert!(!permits(&s, &p, 60_000 * 60)); // 22:00 local
        assert!(permits(&s, &p, 60_000 * 600)); // 07:00 local
        p.local.quiet_hours.as_mut().unwrap().end_minute = 1320;
        assert!(permits(&s, &p, 60_000 * 60));
    }
    #[test]
    fn malformed_submission_and_preferences_fail_closed() {
        let mut s = submission();
        let mut p = Preferences::default();
        s.dedupe_key.push(' ');
        assert!(!permits(&s, &p, 0));
        s = submission();
        p.local.snoozed_until = Some("bad".into());
        assert!(!permits(&s, &p, 0));
    }

    #[test]
    fn done_submission_uses_keyed_copy_and_other_channels_never_deliver() {
        let mut s = submission();
        s.provider = "CODEX".into();
        s.kind = "agent_done".into();
        s.dedupe_key = "activity:[\"CODEX\",null,\"session\",2,\"agent_done\"]".into();
        assert!(permits(&s, &Preferences::default(), 0));
        assert_eq!(title(&s), "Codex finished");
        s.local_channel = "none";
        assert!(!permits(&s, &Preferences::default(), 0));
    }

    #[test]
    fn preferences_survive_restart_and_corruption_fails_closed() {
        let root =
            std::env::temp_dir().join(format!("activity-preferences-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let mut p = Preferences::default();
        p.sound = Sound::Silent;
        p.local.muted_providers.push("CODEX".into());
        p.local.quiet_hours = Some(QuietHours {
            start_minute: 1320,
            end_minute: 420,
            utc_offset_minutes: -180,
        });
        save_at(&root, &p).unwrap();
        assert_eq!(
            serde_json::to_value(load_at(&root).unwrap()).unwrap(),
            serde_json::to_value(p).unwrap()
        );
        Directory::root(&root).unwrap().write(FILE, b"{}").unwrap();
        assert!(load_at(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fresh_install_defaults_and_private_root_save() {
        let root = std::env::temp_dir().join(format!("activity-fresh-{}", uuid::Uuid::new_v4()));
        assert_eq!(
            serde_json::to_value(load_at(&root).unwrap()).unwrap(),
            serde_json::to_value(Preferences::default()).unwrap()
        );
        assert!(!root.exists(), "loading defaults must not create storage");
        let p = Preferences::default();
        let saved = save_at(&root, &p);
        assert_private_root(&root);
        saved.expect("save preferences inside a newly created owner only root");
        assert_eq!(
            serde_json::to_value(load_at(&root).unwrap()).unwrap(),
            serde_json::to_value(p).unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn private_state_root_is_owner_only_at_creation() {
        let root =
            std::env::temp_dir().join(format!("activity-private-root-{}", uuid::Uuid::new_v4()));
        drop(Directory::create_root(&root).expect("create owner only root"));
        assert_private_root(&root);
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn invalid_preference_roots_fail_closed_without_writes() {
        let root =
            std::env::temp_dir().join(format!("activity-invalid-root-{}", uuid::Uuid::new_v4()));
        std::fs::write(&root, b"unchanged").unwrap();
        assert!(load_at(&root).is_err());
        assert!(save_at(&root, &Preferences::default()).is_err());
        assert_eq!(std::fs::read(&root).unwrap(), b"unchanged");
        std::fs::remove_file(root).unwrap();
        assert!(load_at(Path::new("relative-root")).is_err());
        assert!(save_at(Path::new("relative-root"), &Preferences::default()).is_err());
    }

    fn assert_private_root(root: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let meta = std::fs::metadata(&root).unwrap();
            assert_eq!(meta.mode() & 0o777, 0o700);
            assert_eq!(meta.uid(), unsafe { libc::geteuid() });
        }
        #[cfg(windows)]
        {
            use std::{os::windows::process::CommandExt, process::Command};
            let script = "$a = Get-Acl -LiteralPath $env:ACTIVITY_TEST_ROOT; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $allowed = @($sid,'S-1-5-18','S-1-5-32-544'); $r = @($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); $bad = @($r | Where-Object {$allowed -notcontains $_.IdentityReference.Value -or $_.IsInherited -or $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl'}); if (!$a.AreAccessRulesProtected -or $r.Count -ne 3 -or @($r | Where-Object {$_.IdentityReference.Value -eq $sid}).Count -ne 1 -or $bad.Count -ne 0 -or $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) { exit 2 }";
            assert!(Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .env("ACTIVITY_TEST_ROOT", &root)
                .env_remove("PSModulePath")
                .creation_flags(0x0800_0000)
                .status()
                .unwrap()
                .success());
        }
    }
}
