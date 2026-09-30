use std::env;
use std::path::PathBuf;

/// Where OpenLimiter keeps its state, and how to read the snapshot cache.
///
/// This module deliberately does no thinking about quota. It resolves one path
/// and reads one file, and everything about what the bytes mean, whether a
/// reading is still fresh, and what advice comes out of it, is decided by the
/// same TypeScript engine the command line tool uses, running in the webview.
/// One implementation of the rules, in one language, is the whole point.
///
/// The path convention below mirrors `resolveStateDirectory` in
/// `packages/core/src/cache.ts`. If that ever changes, this changes with it.
/// The cache file name is `openlimiter-cache.json`, from the same module.
const CACHE_FILE_NAME: &str = "openlimiter-cache.json";

/// The manual quota document, from `packages/connectors/src/manual.ts`.
const MANUAL_FILE_NAME: &str = "manual.json";

#[cfg(not(test))]
pub(crate) fn home() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[cfg(test)]
pub(crate) fn home() -> Option<PathBuf> {
    state_directory()
}

pub(crate) fn non_empty(name: &str) -> Option<PathBuf> {
    match env::var_os(name) {
        Some(value) if !value.is_empty() => Some(PathBuf::from(value)),
        _ => None,
    }
}

// The state directory for this operating system.
#[cfg(test)]
thread_local! {
    // Every test thread gets an owned root even when a legacy test forgot injection.
    static TEST_ROOT: crate::test_support::TempDir = crate::test_support::TempDir::new();
}

#[cfg(test)]
pub fn state_directory() -> Option<PathBuf> {
    Some(TEST_ROOT.with(|root| root.path().to_path_buf()))
}

#[cfg(not(test))]
pub fn state_directory() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        let base = non_empty("LOCALAPPDATA").or_else(home)?;
        return Some(base.join("openlimiter"));
    }
    if cfg!(target_os = "macos") {
        return Some(
            home()?
                .join("Library")
                .join("Application Support")
                .join("openlimiter"),
        );
    }
    let base = non_empty("XDG_STATE_HOME")
        .or_else(|| home().map(|path| path.join(".local").join("state")))?;
    Some(base.join("openlimiter"))
}

/// Read the snapshot cache as text, or nothing at all.
///
/// A missing file, an unreadable file, an oversized file, and a path that is
/// not a regular file all come back the same way: no cache. Nothing is
/// repaired here and nothing is invented, because a reading that cannot be
/// trusted has to reach the engine as an absence, never as a zero.
pub fn read_cache() -> Option<String> {
    read_state_file(CACHE_FILE_NAME)
}

/// Read the snapshot cache for the window, telling a cache that is not there
/// from one that is there but cannot be used right now.
///
/// `Ok(None)` is a cache that does not exist yet, which is ordinary: the window
/// is often opened before anything has written one. A cache that exists but
/// cannot be read or parsed is an error. On Windows that happens whenever the
/// collector or the terminal status line replaces the file during a read (a
/// sharing violation), and the window must then keep the readings it holds
/// rather than draw an empty cache.
pub fn read_cache_document() -> Result<Option<String>, String> {
    const UNREADABLE: &str = "The saved readings could not be read.";
    let Some(directory) = state_directory() else {
        return Ok(None);
    };
    let file = directory.join(CACHE_FILE_NAME);
    let Some(text) = crate::fsx::bounded_read(&file) else {
        // Absent only when the path names nothing at all: a link, a folder, a
        // file too large and a file another process holds all exist.
        return match std::fs::symlink_metadata(&file) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            _ => Err(UNREADABLE.into()),
        };
    };
    // A torn or foreign document is a failed read, never an empty cache.
    serde_json::from_str::<serde_json::Value>(&text).map_err(|_| UNREADABLE.to_string())?;
    Ok(Some(text))
}

/// Read the manual quota document as text, or nothing at all.
///
/// This is the one connector whose input lives on disk and needs no network,
/// so it is the one connector the window can run for itself. The parsing and
/// the validation happen in the engine, exactly as they do in the command line
/// tool. This function only hands over bytes.
pub fn read_manual() -> Option<String> {
    read_state_file(MANUAL_FILE_NAME)
}

fn read_state_file(name: &str) -> Option<String> {
    /* One bounded, link refusing, handle first read exists in this crate,
    in `fsx`, and every state file goes through it. */
    let file = state_directory()?.join(name);
    crate::fsx::bounded_read(&file)
}

#[cfg(test)]
mod tests {
    const DOCUMENT: &str = r#"{"version":2,"snapshots":[]}"#;

    #[test]
    fn an_absent_cache_reads_as_empty_and_an_unusable_one_as_an_error() {
        let cache = super::state_directory().unwrap().join(super::CACHE_FILE_NAME);
        assert_eq!(super::read_cache_document(), Ok(None), "nothing written yet");
        std::fs::write(&cache, DOCUMENT).unwrap();
        assert_eq!(super::read_cache_document(), Ok(Some(DOCUMENT.to_string())));
        // Caught half written: there, but not a document.
        std::fs::write(&cache, &DOCUMENT[..12]).unwrap();
        assert!(super::read_cache_document().is_err());
        // Something that is not a file where the cache belongs.
        std::fs::remove_file(&cache).unwrap();
        std::fs::create_dir(&cache).unwrap();
        assert!(super::read_cache_document().is_err());
        std::fs::remove_dir(&cache).unwrap();
        assert_eq!(super::read_cache_document(), Ok(None));
    }

    /// What a reader meets while another process replaces the cache on
    /// Windows: the file is there and opening it is a sharing violation.
    #[cfg(windows)]
    #[test]
    fn a_cache_another_process_holds_is_an_error_until_it_lets_go() {
        use std::os::windows::fs::OpenOptionsExt;
        let cache = super::state_directory().unwrap().join(super::CACHE_FILE_NAME);
        std::fs::write(&cache, DOCUMENT).unwrap();
        let held = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&cache)
            .unwrap();
        assert!(super::read_cache_document().is_err());
        drop(held);
        assert_eq!(super::read_cache_document(), Ok(Some(DOCUMENT.to_string())));
        std::fs::remove_file(&cache).unwrap();
    }

    #[test]
    fn real_state_directory_is_never_resolved_by_tests() {
        let state = super::state_directory().unwrap();
        assert!(state
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("openlimiter-desktop-test-"));
        let account = state.join("accounts/codex/guardfixture");
        assert!(account.starts_with(&state));
        assert_eq!(std::fs::read_dir(&state).unwrap().count(), 0);
        assert_ne!(
            Some(state),
            super::home().map(|home| home.join(".local/state/openlimiter"))
        );
    }
}
