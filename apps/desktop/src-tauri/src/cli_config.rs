use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use tauri::Manager;

const CONFIG_FILE_NAME: &str = "openlimiter-config.json";
const LOCK_DIR_NAME: &str = "openlimiter-config.lock";
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

fn owner_stamp() -> Value {
    let started_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    serde_json::json!({ "pid": std::process::id(), "started_at": started_at })
}

fn stale_lock(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path.join("owner.json")) else { return true; };
    let Ok(owner) = serde_json::from_str::<Value>(&text) else { return true; };
    let started = owner.get("started_at").and_then(Value::as_u64).unwrap_or(0);
    let age = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    u128::from(age.saturating_sub(started)) > MAX_LOCK_AGE.as_millis() || !pid_alive(owner.get("pid").and_then(Value::as_u64).unwrap_or(0))
}

fn pid_alive(pid: u64) -> bool {
    if pid == 0 { return false; }
    #[cfg(unix)]
    {
        return std::process::Command::new("kill").args(["-0", &pid.to_string()]).status().map(|status| status.success()).unwrap_or(false);
    }
    #[cfg(windows)]
    {
        return std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}")]).output().map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())).unwrap_or(false);
    }
    #[allow(unreachable_code)]
    true
}

struct ConfigLock { path: PathBuf }

impl Drop for ConfigLock {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.path); }
}

fn lock(directory: &Path) -> Result<ConfigLock, String> {
    private_directory(directory)?;
    let path = lock_path(directory);
    for _ in 0..120 {
        match fs::create_dir(&path) {
            Ok(()) => {
                crate::fsx::atomic_write(&path.join("owner.json"), &canonical_json(&owner_stamp())?).map_err(|_| "config_write_failed".to_string())?;
                return Ok(ConfigLock { path });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if stale_lock(&path) { let _ = fs::remove_dir_all(&path); }
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return Err("config_write_failed".to_string()),
        }
    }
    Err("config_busy".to_string())
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

#[tauri::command]
pub fn terminal_captions() -> Result<Value, String> {
    let directory = crate::state::state_directory().ok_or_else(|| "config_refused".to_string())?;
    Ok(serde_json::json!({ "captions": read_captions(&directory)? }))
}

#[tauri::command]
pub fn set_terminal_captions(captions: String, app: tauri::AppHandle) -> Result<Value, String> {
    if captions == "tagged" && !crate::pro::theme_preset_enabled(&*app.state::<crate::credentials::KeyringStore>()) {
        return Err("entitlement_required".to_string());
    }
    let directory = crate::state::state_directory().ok_or_else(|| "config_refused".to_string())?;
    write_captions(&directory, &captions)?;
    Ok(serde_json::json!({ "captions": captions }))
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
    fn lock_is_reclaimed_after_the_owner_is_dead_or_old() {
        let dir = TempDir::new();
        private_directory(dir.path()).unwrap();
        let path = lock_path(dir.path());
        fs::create_dir(&path).unwrap();
        fs::write(path.join("owner.json"), r#"{"pid":0,"started_at":0}"#).unwrap();
        write_captions(dir.path(), "short").unwrap();
        assert!(!path.exists());
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
