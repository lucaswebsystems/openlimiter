use std::env;
use std::fs;
use std::io::Read;
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
/// Largest cache file this will read. The core writes far less than this, and
/// a bound means a replaced or corrupted file cannot exhaust memory.
const MAX_CACHE_BYTES: u64 = 1_048_576;

const CACHE_FILE_NAME: &str = "openlimiter-cache.json";

/// The manual quota document, from `packages/connectors/src/manual.ts`.
const MANUAL_FILE_NAME: &str = "manual.json";

fn home() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn non_empty(name: &str) -> Option<PathBuf> {
    match env::var_os(name) {
        Some(value) if !value.is_empty() => Some(PathBuf::from(value)),
        _ => None,
    }
}

/// The state directory for this operating system.
pub fn state_directory() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        let base = non_empty("LOCALAPPDATA").or_else(home)?;
        return Some(base.join("openlimiter"));
    }
    if cfg!(target_os = "macos") {
        return Some(home()?.join("Library").join("Application Support").join("openlimiter"));
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
    let file = state_directory()?.join(name);
    let metadata = fs::symlink_metadata(&file).ok()?;
    /* A symbolic link in the state directory is refused rather than followed,
    which is the same rule the core applies when it reads this file. */
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return None;
    }
    if metadata.len() > MAX_CACHE_BYTES {
        return None;
    }
    let mut handle = fs::File::open(&file).ok()?;
    let mut text = String::new();
    handle.take(MAX_CACHE_BYTES).read_to_string(&mut text).ok()?;
    Some(text)
}
