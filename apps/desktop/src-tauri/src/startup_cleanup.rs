//! Delete only bounded, proven artifacts in the app's own canonical state root.
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
use tauri::Manager;

const MAX_ENTRIES: usize = 4096;
const STUB: &[u8] = b"{\"stub\":true}";

fn real(path: &Path) -> bool {
    let mut prefix = PathBuf::new();
    for part in path.components() {
        prefix.push(part);
        if matches!(part, std::path::Component::Prefix(_)) {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&prefix) else {
            return false;
        };
        if meta.file_type().is_symlink() {
            return false;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return false;
            }
        }
    }
    true
}

#[derive(Default, Debug)]
pub struct Counts {
    pub folders: usize,
    pub temporary_files: usize,
}

pub fn cleanup(root: &Path, references: &[PathBuf], now: SystemTime) -> Counts {
    let mut counts = Counts::default();
    if !real(root) {
        return counts;
    }
    let Ok(root) = fs::canonicalize(root) else {
        return counts;
    };
    // Missing references are still exclusions. Unresolvable existing references abort deletion.
    let mut protected = BTreeSet::new();
    for reference in references {
        match fs::canonicalize(reference) {
            Ok(path) => {
                protected.insert(path);
            }
            Err(_) => {
                if reference.exists() {
                    return counts;
                }
                protected.insert(reference.clone());
            }
        }
    }
    let accounts = root.join("accounts").join("codex");
    if real(&accounts) {
        if let Ok(entries) = fs::read_dir(&accounts) {
            for entry in entries.take(MAX_ENTRIES).flatten() {
                let path = entry.path();
                if !real(&path) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    continue;
                }
                let Ok(path) = fs::canonicalize(&path) else {
                    continue;
                };
                if path.parent() != Some(accounts.as_path())
                    || protected
                        .iter()
                        .any(|used| used.starts_with(&path) || path.starts_with(used))
                {
                    continue;
                }
                let Ok(children) = fs::read_dir(&path)
                    .and_then(|entries| entries.take(2).collect::<Result<Vec<_>, _>>())
                else {
                    continue;
                };
                if children.is_empty() {
                    if real(&path) && fs::remove_dir(&path).is_ok() {
                        counts.folders += 1;
                    }
                } else if children.len() == 1 {
                    let file = children[0].path();
                    let Ok(meta) = fs::symlink_metadata(&file) else {
                        continue;
                    };
                    if !real(&file) || !meta.is_file() || meta.len() != STUB.len() as u64 {
                        continue;
                    }
                    if crate::fsx::bounded_read(&file)
                        .as_deref()
                        .map(str::as_bytes)
                        != Some(STUB)
                    {
                        continue;
                    }
                    // Recheck immediately before unlinking. Never recurse, and never delete a real auth document.
                    if real(&path)
                        && real(&file)
                        && crate::fsx::bounded_read(&file)
                            .as_deref()
                            .map(str::as_bytes)
                            == Some(STUB)
                        && fs::remove_file(&file).is_ok()
                        && fs::remove_dir(&path).is_ok()
                    {
                        counts.folders += 1;
                    }
                }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.take(MAX_ENTRIES).flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !["openlimiter-cache.json.", "openlimiter-agent-context.json."]
                .iter()
                .any(|prefix| {
                    name.starts_with(prefix)
                        && name.len() > prefix.len() + 4
                        && name.ends_with(".tmp")
                })
            {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !real(&path) || !meta.is_file() || meta.len() > crate::fsx::MAX_STATE_FILE_BYTES {
                continue;
            }
            if meta
                .modified()
                .ok()
                .and_then(|at| now.duration_since(at).ok())
                .is_some_and(|age| age > Duration::from_secs(3600))
                && fs::remove_file(&path).is_ok()
            {
                counts.temporary_files += 1;
            }
        }
    }
    counts
}

pub fn run(app: &tauri::AppHandle) {
    let Some(root) = crate::state::state_directory() else {
        return;
    };
    if !real(&root) {
        return;
    }
    let mut references = app
        .state::<crate::provider_detection::DetectionStore>()
        .referenced_paths();
    references.extend(
        app.state::<crate::codex_device_login::OpenDeviceLogin>()
            .referenced_paths(),
    );
    // The CLI's selected managed login must survive even if its credential cannot be parsed.
    let registry = root.join("openlimiter-codex-account.json");
    if registry.exists() {
        let id = crate::fsx::bounded_read(&registry)
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|value| value["sessionId"].as_str().map(str::to_string));
        let Some(home) = id
            .as_deref()
            .and_then(crate::codex_device_login::managed_home)
        else {
            return;
        };
        references.push(home);
    }
    // Connection records contain no filesystem roots. Retain any named managed folder as a conservative exclusion.
    let Ok(connections) = app.state::<crate::connections::ConnectionsStore>().list() else {
        return;
    };
    for connection in connections {
        for id in [
            Some(connection.id),
            Some(connection.account_alias),
            connection.codex_account_id,
        ]
        .into_iter()
        .flatten()
        {
            if let Some(home) = crate::codex_device_login::managed_home(&id) {
                references.push(home);
            }
        }
    }
    let counts = cleanup(&root, &references, SystemTime::now());
    let writer = app.state::<std::sync::Arc<crate::cache_write::CacheWriter>>();
    let pruned = crate::native_snapshot::prune_cache(&writer, crate::connections::now_epoch_ms())
        .unwrap_or(0);
    eprintln!(
        "OpenLimiter startup cleanup: folders={}, temporary_files={}, cache_rows={}",
        counts.folders, counts.temporary_files, pruned
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_exact_stubs_and_empty_unreferenced_folders_are_removed() {
        let root = crate::test_support::TempDir::new();
        let accounts = root.path().join("accounts/codex");
        for name in ["empty", "stub", "real", "extra", "live", "almost"] {
            fs::create_dir_all(accounts.join(name)).unwrap();
        }
        fs::write(accounts.join("stub/auth.json"), STUB).unwrap();
        fs::write(
            accounts.join("real/auth.json"),
            br#"{"tokens":{"access_token":"synthetic"}}"#,
        )
        .unwrap();
        fs::write(accounts.join("extra/auth.json"), STUB).unwrap();
        fs::write(accounts.join("extra/other"), "keep").unwrap();
        fs::write(accounts.join("almost/auth.json"), b"{\"stub\":true}\n").unwrap();
        let counts = cleanup(root.path(), &[accounts.join("live")], SystemTime::now());
        assert_eq!(counts.folders, 2);
        for name in ["real", "extra", "live", "almost"] {
            assert!(accounts.join(name).exists());
        }
    }

    #[test]
    fn temporary_cleanup_is_age_name_and_size_bounded() {
        let root = crate::test_support::TempDir::new();
        let now = SystemTime::now();
        let cases = [
            ("openlimiter-cache.json.old.tmp", 3601, true),
            ("openlimiter-agent-context.json.old.tmp", 3601, true),
            ("openlimiter-cache.json.equal.tmp", 3600, false),
            ("openlimiter-cache.json.new.tmp", 59, false),
            ("other.json.old.tmp", 7200, false),
        ];
        for (name, age, _) in cases {
            let file = fs::File::create(root.path().join(name)).unwrap();
            file.set_times(fs::FileTimes::new().set_modified(now - Duration::from_secs(age)))
                .unwrap();
        }
        assert_eq!(cleanup(root.path(), &[], now).temporary_files, 2);
        for (name, _, removed) in cases {
            assert_eq!(root.path().join(name).exists(), !removed);
        }
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_never_follows_directory_or_file_links() {
        let root = crate::test_support::TempDir::new();
        let outside = crate::test_support::TempDir::new();
        let accounts = root.path().join("accounts/codex");
        fs::create_dir_all(accounts.join("filelink")).unwrap();
        fs::write(outside.path().join("auth.json"), STUB).unwrap();
        std::os::unix::fs::symlink(outside.path(), accounts.join("dirlink")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("auth.json"),
            accounts.join("filelink/auth.json"),
        )
        .unwrap();
        assert_eq!(cleanup(root.path(), &[], SystemTime::now()).folders, 0);
        assert!(outside.path().join("auth.json").exists());
    }
}
