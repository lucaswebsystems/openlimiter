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
