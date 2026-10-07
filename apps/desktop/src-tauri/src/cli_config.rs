use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use tauri::Manager;
use uuid::Uuid;

const CONFIG_FILE_NAME: &str = "openlimiter-config.json";
const LOCK_DIR_NAME: &str = "openlimiter.lock";
const MAX_LOCK_AGE: Duration = Duration::from_secs(60);

fn config_path(directory: &Path) -> PathBuf { directory.join(CONFIG_FILE_NAME) }
fn lock_path(directory: &Path) -> PathBuf { directory.join(LOCK_DIR_NAME) }

fn skeleton() -> Value {
    serde_json::json!({
        "version": 1,
        "connectors": [],
        "statusline": { "order": [], "meters": "worst", "width": 120, "rows": 1, "bars": true, "color": "auto", "style": "bar", "captions": "short", "show": [], "hosts": {} },
        "providers": { "claude": { "poll": false, "recorded": false } }
    })
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(object.iter().map(|(key, value)| (key.clone(), canonical(value))).collect::<BTreeMap<_, _>>().into_iter().collect()),
        Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
        value => value.clone(),
    }
}

fn canonical_json(value: &Value) -> Result<String, String> {
    serde_json::to_string(&canonical(value)).map_err(|_| "config_write_failed".to_string())
}

fn private_directory(directory: &Path) -> Result<(), String> {
    crate::fsx::ensure_private_dir(directory).map_err(|_| "config_write_failed".to_string())
}

fn read_document(directory: &Path) -> Result<Value, String> {
    let path = config_path(directory);
    match crate::fsx::bounded_read_result(&path, crate::fsx::MAX_STATE_FILE_BYTES) {
        Err(crate::fsx::ReadFailure::Missing) => Ok(skeleton()),
        Err(_) => Err("config_refused".to_string()),
        Ok(text) => {
            let value: Value = serde_json::from_str(&text).map_err(|_| "config_refused".to_string())?;
            if value.get("version") != Some(&Value::from(1)) || !value.is_object() {
                return Err("config_refused".to_string());
            }
            Ok(value)
        }
    }
}

fn owner_stamp(token: &str) -> Value {
    let started_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    serde_json::json!({ "pid": std::process::id(), "startedAt": started_at, "token": token })
}

fn stale_lock(path: &Path) -> bool {
    let owner = read_owner(path);
    let now = SystemTime::now();
    let stale_by_age = owner
        .as_ref()
        .map(|(_, started, _)| {
            let current = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
            current.saturating_sub(*started) >= MAX_LOCK_AGE.as_millis() as u64
        })
        .unwrap_or_else(|| {
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_none_or(|age| age > MAX_LOCK_AGE)
        });
    stale_by_age || owner.as_ref().map(|(pid, _, _)| !pid_alive(*pid)).unwrap_or(false)
}

fn read_owner(path: &Path) -> Option<(u64, u64, String)> {
    fs::read_to_string(path.join("owner.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| Some((
            value.get("pid").and_then(Value::as_u64)?,
            value.get("startedAt").and_then(Value::as_u64)?,
            value.get("token").and_then(Value::as_str)?.to_string(),
        )))
}

fn pid_alive(pid: u64) -> bool {
    if pid == 0 { return false; }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        return result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    }
    #[cfg(windows)]
    {
        return std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}")]).output().map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())).unwrap_or(false);
    }
    #[allow(unreachable_code)]
    true
}

struct ConfigLock { path: PathBuf, token: String }

impl Drop for ConfigLock {
    fn drop(&mut self) {
        let owned = fs::read_to_string(self.path.join("owner.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.get("token").and_then(Value::as_str).map(str::to_owned))
            .is_some_and(|token| token == self.token);
        if owned { let _ = fs::remove_dir_all(&self.path); }
    }
}

fn lock(directory: &Path) -> Result<ConfigLock, String> {
    private_directory(directory)?;
    let path = lock_path(directory);
    crate::fsx::reject_symlink(&path).map_err(|_| "config_refused".to_string())?;
    let token = Uuid::new_v4().to_string();
    loop {
        match fs::create_dir(&path) {
            Ok(()) => {
                let stamp = canonical_json(&owner_stamp(&token))?;
                if crate::fsx::atomic_write(&path.join("owner.json"), &stamp).is_err() {
                    let _ = fs::remove_dir_all(&path);
                    return Err("config_write_failed".to_string());
                }
                return Ok(ConfigLock { path, token });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let observed_owner = read_owner(&path);
                if stale_lock(&path) {
                    let displaced = path.with_file_name(format!("{LOCK_DIR_NAME}.reclaim.{}", Uuid::new_v4()));
                    if fs::rename(&path, &displaced).is_ok() {
                        let still_observed = match observed_owner {
                            Some((_, _, token)) => read_owner(&displaced).is_some_and(|(_, _, observed)| observed == token),
                            None => !displaced.join("owner.json").exists(),
                        };
                        if still_observed { let _ = fs::remove_dir_all(displaced); }
                    }
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return Err("config_write_failed".to_string()),
        }
    }
}

fn write_document(directory: &Path, value: &Value) -> Result<(), String> {
    crate::fsx::atomic_write(&config_path(directory), &canonical_json(value)?).map_err(|_| "config_write_failed".to_string())
}

pub fn write_captions(directory: &Path, captions: &str) -> Result<(), String> {
    if captions != "short" && captions != "tagged" { return Err("invalid_input".to_string()); }
    let _held = lock(directory)?;
    let mut document = read_document(directory)?;
    let object = document.as_object_mut().ok_or_else(|| "config_refused".to_string())?;
    let statusline = object.entry("statusline").or_insert_with(|| Value::Object(Map::new()));
    let statusline = statusline.as_object_mut().ok_or_else(|| "config_refused".to_string())?;
    statusline.insert("captions".to_string(), Value::String(captions.to_string()));
    write_document(directory, &document)
}

fn read_captions(directory: &Path) -> Result<String, String> {
    let document = read_document(directory)?;
    Ok(document.get("statusline").and_then(Value::as_object).and_then(|statusline| statusline.get("captions")).and_then(Value::as_str).filter(|value| *value == "short" || *value == "tagged").unwrap_or("short").to_string())
}

fn caption_request_allowed(captions: &str, theme_preset: bool) -> Result<(), String> {
    if captions != "short" && captions != "tagged" { return Err("invalid_input".to_string()); }
    if captions == "tagged" && !theme_preset { return Err("entitlement_required".to_string()); }
    Ok(())
}

#[tauri::command]
pub fn terminal_captions() -> Result<Value, String> {
    let directory = crate::state::state_directory().ok_or_else(|| "config_refused".to_string())?;
    Ok(serde_json::json!({ "captions": read_captions(&directory)? }))
}

#[tauri::command]
pub fn set_terminal_captions(captions: String, app: tauri::AppHandle) -> Result<Value, String> {
    caption_request_allowed(&captions, crate::pro::theme_preset_enabled(&*app.state::<crate::credentials::KeyringStore>()))?;
    let directory = crate::state::state_directory().ok_or_else(|| "config_refused".to_string())?;
    write_captions(&directory, &captions)?;
    Ok(serde_json::json!({ "captions": captions }))
}

#[tauri::command]
pub fn terminal_runtime_status() -> Result<Value, String> {
    let directory = crate::state::state_directory().ok_or_else(|| "config_refused".to_string())?;
    let stamp = directory.join("terminal-runtime").join(".openlimiter-runtime.json");
    let version = match crate::fsx::bounded_read_result(&stamp, crate::fsx::MAX_STATE_FILE_BYTES) {
        Err(crate::fsx::ReadFailure::Missing) => None,
        Err(_) => return Err("config_refused".to_string()),
        Ok(text) => {
            let value: Value = serde_json::from_str(&text).map_err(|_| "config_refused".to_string())?;
            value.get("version").and_then(Value::as_str).map(str::to_owned)
        }
    };
    Ok(serde_json::json!({ "version": version, "app_version": env!("CARGO_PKG_VERSION") }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn missing_config_gets_a_version_one_skeleton_and_round_trips() {
        let dir = TempDir::new();
        write_captions(dir.path(), "short").unwrap();
        assert_eq!(read_captions(dir.path()).unwrap(), "short");
        let value: Value = serde_json::from_str(&fs::read_to_string(config_path(dir.path())).unwrap()).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["statusline"]["captions"], "short");
    }

    #[test]
    fn corrupt_and_wrong_version_documents_are_refused_without_replacement() {
        let dir = TempDir::new();
        fs::write(config_path(dir.path()), "not json").unwrap();
        assert_eq!(write_captions(dir.path(), "short"), Err("config_refused".to_string()));
        fs::write(config_path(dir.path()), r#"{"version":2}"#).unwrap();
        assert_eq!(write_captions(dir.path(), "short"), Err("config_refused".to_string()));
    }

    #[test]
    fn concurrent_caption_writes_preserve_claude_poll_consent() {
        let dir = TempDir::new();
        private_directory(dir.path()).unwrap();
        let mut document = skeleton();
        document["providers"]["claude"]["poll"] = Value::Bool(true);
        fs::write(config_path(dir.path()), canonical_json(&document).unwrap()).unwrap();
        let path = dir.path().to_path_buf();
        let first = path.clone();
        let left = std::thread::spawn(move || write_captions(&first, "short"));
        let second = path.clone();
        let right = std::thread::spawn(move || write_captions(&second, "tagged"));
        assert!(left.join().unwrap().is_ok());
        assert!(right.join().unwrap().is_ok());
        let saved: Value = serde_json::from_str(&fs::read_to_string(config_path(dir.path())).unwrap()).unwrap();
        assert_eq!(saved["providers"]["claude"]["poll"], true);
        assert!(saved["statusline"]["captions"] == "short" || saved["statusline"]["captions"] == "tagged");
    }

    #[test]
    fn caption_command_distinguishes_free_and_theme_preset_entitlements() {
        assert_eq!(caption_request_allowed("short", false), Ok(()));
        assert_eq!(caption_request_allowed("tagged", false), Err("entitlement_required".to_string()));
        assert_eq!(caption_request_allowed("tagged", true), Ok(()));
        assert_eq!(caption_request_allowed("other", true), Err("invalid_input".to_string()));
    }

    #[test]
    fn lock_is_reclaimed_after_the_owner_is_dead_or_old() {
        let dir = TempDir::new();
        private_directory(dir.path()).unwrap();
        let path = lock_path(dir.path());
        fs::create_dir(&path).unwrap();
        fs::write(path.join("owner.json"), r#"{"pid":0,"startedAt":0,"token":"stale"}"#).unwrap();
        write_captions(dir.path(), "short").unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn lock_owner_stamp_uses_the_shared_protocol_fields() {
        let dir = TempDir::new();
        let held = lock(dir.path()).unwrap();
        let stamp: Value = serde_json::from_str(&fs::read_to_string(held.path.join("owner.json")).unwrap()).unwrap();
        assert!(stamp["pid"].as_u64().unwrap() > 0);
        assert!(stamp["startedAt"].as_u64().unwrap() > 0);
        assert!(stamp["token"].as_str().unwrap().len() > 0);
        assert!(stamp.get("started_at").is_none());
    }

    #[test]
    fn symlink_is_refused() {
        let dir = TempDir::new();
        let target = TempDir::new();
        fs::write(config_path(target.path()), r#"{"version":1}"#).unwrap();
        #[cfg(unix)] std::os::unix::fs::symlink(config_path(target.path()), config_path(dir.path())).unwrap();
        #[cfg(windows)] if std::os::windows::fs::symlink_file(config_path(target.path()), config_path(dir.path())).is_err() { return; }
        assert_eq!(write_captions(dir.path(), "short"), Err("config_refused".to_string()));
    }
}
