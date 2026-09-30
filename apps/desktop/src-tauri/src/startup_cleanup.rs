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

fn real(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut prefix = root.to_path_buf();
    for part in relative.components() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return false;
        }
        prefix.push(part);
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

// References to missing files still protect their account directory. Resolve
// the existing ancestor so exclusions use the same canonical path spelling as
// candidates, including Windows verbatim prefixes and macOS /var aliases.
fn resolved_reference(path: &Path) -> Option<PathBuf> {
    if path
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return None;
    }
    match fs::canonicalize(path) {
        Ok(path) => Some(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // A dangling link is not a missing file and must abort cleanup.
            if !fs::symlink_metadata(path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            {
                return None;
            }
            Some(resolved_reference(path.parent()?)?.join(path.file_name()?))
        }
        Err(_) => None,
    }
}

#[derive(Default, Debug)]
pub struct Counts {
    pub folders: usize,
    pub temporary_files: usize,
}

pub fn cleanup(root: &Path, references: &[PathBuf], now: SystemTime) -> Counts {
    let mut counts = Counts::default();
    if root
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return counts;
    }
    let Ok(root) = fs::canonicalize(root) else {
        return counts;
    };
    // Missing references are still exclusions. Unresolvable existing references abort deletion.
    let mut protected = BTreeSet::new();
    for reference in references {
        let Some(path) = resolved_reference(reference) else {
            return counts;
        };
        protected.insert(path);
    }
    let accounts = root.join("accounts").join("codex");
    if real(&root, &accounts) {
        let Ok(accounts) = fs::canonicalize(&accounts) else {
            return counts;
        };
        if let Ok(entries) = fs::read_dir(&accounts) {
            for entry in entries.take(MAX_ENTRIES).flatten() {
                let path = entry.path();
                if !real(&root, &path) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
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
                    if real(&root, &path) && fs::remove_dir(&path).is_ok() {
                        counts.folders += 1;
                    }
                } else if children.len() == 1 {
                    let file = children[0].path();
                    let Ok(meta) = fs::symlink_metadata(&file) else {
                        continue;
                    };
                    if !real(&root, &file) || !meta.is_file() || meta.len() != STUB.len() as u64 {
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
                    if real(&root, &path)
                        && real(&root, &file)
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
            if !real(&root, &path)
                || !meta.is_file()
                || meta.len() > crate::fsx::MAX_STATE_FILE_BYTES
            {
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
    if root
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return;
    }
    let Ok(root) = fs::canonicalize(root) else {
        return;
    };
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
    fn a_missing_credential_reference_still_protects_its_home() {
        let root = crate::test_support::TempDir::new();
        // Use the original temp spelling to exercise canonical Windows paths.
        let state = std::env::temp_dir().join(root.path().file_name().unwrap());
        let accounts = state.join("accounts/codex");
        fs::create_dir_all(accounts.join("live")).unwrap();
        fs::create_dir_all(accounts.join("empty")).unwrap();
        let reference = accounts.join("live/missing/auth.json");
        assert_eq!(cleanup(&state, &[reference], SystemTime::now()).folders, 1);
        assert!(accounts.join("live").is_dir());
        assert!(!accounts.join("empty").exists());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_trusts_linked_state_ancestors_but_refuses_managed_links() {
        use std::os::unix::fs::symlink;

        let dir = crate::test_support::TempDir::new();
        let ancestor = dir.path().join("real");
        let alias = dir.path().join("alias");
        fs::create_dir(&ancestor).unwrap();
        symlink(&ancestor, &alias).unwrap();
        let state = alias.join("state");
        let accounts = state.join("accounts/codex");
        fs::create_dir_all(accounts.join("empty")).unwrap();
        fs::create_dir_all(accounts.join("live")).unwrap();
        let outside = crate::test_support::TempDir::new();
        fs::write(outside.path().join("auth.json"), STUB).unwrap();
        symlink(outside.path(), accounts.join("planted")).unwrap();
        assert_eq!(
            cleanup(
                &state,
                &[accounts.join("live/auth.json")],
                SystemTime::now()
            )
            .folders,
            1
        );
        assert!(accounts.join("live").is_dir());
        assert!(fs::symlink_metadata(accounts.join("planted"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(outside.path().join("auth.json").exists());

        for relative in ["accounts", "accounts/codex"] {
            let state = dir.path().join(relative.replace('/', "_"));
            let link = state.join(relative);
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            symlink(outside.path(), &link).unwrap();
            assert_eq!(cleanup(&state, &[], SystemTime::now()).folders, 0);
            assert!(outside.path().join("auth.json").exists());
        }
    }

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
