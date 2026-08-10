use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Filesystem primitives shared by the connection subsystem.
///
/// Everything here mirrors the discipline of `packages/core/src/cache.ts`: a
/// bounded read that refuses symbolic links, and an atomic replace that goes
/// through a flushed temporary file and a rename, retried past the transient
/// sharing violations Windows reports. The mirror is deliberate. The cache on
/// disk has exactly one protocol, written down once in the core, and this
/// module reimplements its letter rather than inventing a second one.
/// Largest file any of this will read or write, mirroring
/// `MAX_JSON_FILE_BYTES` in `packages/core/src/cache.ts:23`.
pub const MAX_STATE_FILE_BYTES: u64 = 1_048_576;

/// A failure with everything identifying removed.
///
/// No variant carries a payload, so a path, a filename, or file content can
/// never ride along into a log or an error shown to the webview.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FsFailure {
    /// The path or its parent is a symbolic link, which state files never are.
    Symlink,
    /// The operating system refused a read, a write, or a rename.
    Io,
}

/// Refuse a path that exists as a symbolic link, mirroring `rejectSymlink` in
/// `packages/core/src/cache.ts:63-70`. A missing path is fine.
pub fn reject_symlink(path: &Path) -> Result<(), FsFailure> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(FsFailure::Symlink),
        _ => Ok(()),
    }
}

/// Create the directory privately, mirroring `prepareStateDirectory` in
/// `packages/core/src/cache.ts:72-77`: refuse a symbolic link, create with
/// owner only permissions, and check again after creating.
pub fn ensure_private_dir(directory: &Path) -> Result<(), FsFailure> {
    reject_symlink(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)
            .map_err(|_| FsFailure::Io)?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(directory).map_err(|_| FsFailure::Io)?;
    reject_symlink(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| FsFailure::Io)?;
    }
    Ok(())
}

/// Open for reading without following a link, so every later check can run
/// against the opened object instead of the path.
fn open_no_follow(file: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        /* FILE_FLAG_OPEN_REPARSE_POINT: a symbolic link or junction opens as
        itself rather than being followed, and the handle's own metadata then
        reveals it below. */
        options.custom_flags(0x0020_0000);
    }
    options.open(file)
}

/// Read a file as text, or nothing at all.
///
/// The handle is opened FIRST and every check runs against that handle, so a
/// path swapped between a check and the read cannot redirect the bytes that
/// come back. This mirrors `readJsonFileSafely` in
/// `packages/core/src/cache.ts:91-99`: checks against the descriptor, and on
/// platforms without a no follow open, the path is compared with the open
/// object by device and inode, which rejects a link and a file replaced mid
/// read (`cache.ts:116-120`). A missing file, a link, a non file, and an
/// oversized file all come back as `None`. Nothing is repaired or invented.
pub fn bounded_read(file: &Path) -> Option<String> {
    let handle = open_no_follow(file).ok()?;
    let opened = handle.metadata().ok()?;
    if opened.file_type().is_symlink() || !opened.is_file() {
        return None;
    }
    if opened.len() > MAX_STATE_FILE_BYTES {
        return None;
    }
    #[cfg(unix)]
    {
        /* No O_NOFOLLOW without a platform crate, so the core's identity
        comparison carries the check: the opened object must be exactly the
        object the path names right now. */
        use std::os::unix::fs::MetadataExt;
        let on_path = fs::symlink_metadata(file).ok()?;
        if on_path.dev() != opened.dev() || on_path.ino() != opened.ino() {
            return None;
        }
    }
    let mut text = String::new();
    handle
        .take(MAX_STATE_FILE_BYTES)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

/// How many times a rename is retried, mirroring `RENAME_ATTEMPT_LIMIT` in
/// `packages/core/src/cache.ts:174`.
const RENAME_ATTEMPT_LIMIT: u32 = 12;

/// The delay before another attempt, mirroring `backoffMilliseconds` in
/// `packages/core/src/cache.ts:169-172`: growth of `4 + attempt * 2` capped at
/// 25 milliseconds, plus up to 4 milliseconds of jitter.
pub fn backoff_delay(attempt: u32) -> Duration {
    let growth = (4 + u64::from(attempt) * 2).min(25);
    Duration::from_millis(growth + jitter_milliseconds())
}

/// A small random count of milliseconds from the clock's own noise. The core
/// uses `Math.random` here; the purpose is only to spread retries apart, so
/// sub second clock noise is entropy enough.
fn jitter_milliseconds() -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or(0);
    u64::from(nanos) % 5
}

/// Whether this rename failure clears on its own, mirroring
/// `transientRenameCodes` in `packages/core/src/cache.ts:175`: EPERM, EACCES
/// and EBUSY, which on Windows arrive as access denied and sharing or lock
/// violations while a reader or a virus scanner holds the destination open.
fn transient_rename_error(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        return true;
    }
    match error.raw_os_error() {
        // Windows: ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION.
        #[cfg(windows)]
        Some(32) | Some(33) => true,
        // Unix: EBUSY.
        #[cfg(unix)]
        Some(16) => true,
        _ => false,
    }
}

/// Replace the destination, retrying the transient failures Windows reports,
/// mirroring `renameWithRetry` in `packages/core/src/cache.ts:185-200`.
fn rename_with_retry(from: &Path, to: &Path) -> Result<(), FsFailure> {
    for attempt in 0..=RENAME_ATTEMPT_LIMIT {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => {
                if attempt >= RENAME_ATTEMPT_LIMIT || !transient_rename_error(&error) {
                    return Err(FsFailure::Io);
                }
                std::thread::sleep(backoff_delay(attempt));
            }
        }
    }
    Err(FsFailure::Io)
}

/// Write a file so a reader sees the old content or the new content and never
/// a half written one, mirroring `writeFileAtomically` in
/// `packages/core/src/cache.ts:209-228`: a temporary sibling named
/// `<target>.<pid>.<uuid>.tmp`, flushed to stable storage, then renamed over
/// the destination.
pub fn atomic_write(target: &Path, contents: &str) -> Result<(), FsFailure> {
    reject_symlink(target)?;
    let mut temp_name = target.as_os_str().to_owned();
    temp_name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let temp_path = PathBuf::from(temp_name);
    let written =
        write_flushed(&temp_path, contents).and_then(|()| rename_with_retry(&temp_path, target));
    if written.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    written
}

fn write_flushed(temp_path: &Path, contents: &str) -> Result<(), FsFailure> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut handle = options.open(temp_path).map_err(|_| FsFailure::Io)?;
    handle
        .write_all(contents.as_bytes())
        .and_then(|()| handle.sync_all())
        .map_err(|_| FsFailure::Io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn atomic_write_replaces_and_leaves_no_temporaries() {
        let dir = TempDir::new();
        let target = dir.path().join("document.json");
        atomic_write(&target, "{\"first\":true}").expect("first write");
        atomic_write(&target, "{\"second\":true}").expect("second write");
        assert_eq!(
            fs::read_to_string(&target).expect("readable"),
            "{\"second\":true}"
        );
        let leftovers = fs::read_dir(dir.path())
            .expect("listable")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn bounded_read_refuses_oversize() {
        let dir = TempDir::new();
        let target = dir.path().join("big.json");
        let oversized = "x".repeat((MAX_STATE_FILE_BYTES + 1) as usize);
        fs::write(&target, oversized).expect("writable");
        assert_eq!(bounded_read(&target), None);
    }

    #[test]
    fn bounded_read_missing_is_none() {
        let dir = TempDir::new();
        assert_eq!(bounded_read(&dir.path().join("absent.json")), None);
    }

    #[test]
    fn bounded_read_refuses_a_directory() {
        let dir = TempDir::new();
        let inner = dir.path().join("a-directory");
        fs::create_dir_all(&inner).expect("dir");
        assert_eq!(bounded_read(&inner), None);
    }

    #[cfg(unix)]
    #[test]
    fn bounded_read_refuses_a_symlink() {
        let dir = TempDir::new();
        let target = dir.path().join("real.json");
        fs::write(&target, "{}").expect("write");
        let link = dir.path().join("link.json");
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        assert_eq!(bounded_read(&link), None);
        assert_eq!(bounded_read(&target).as_deref(), Some("{}"));
    }

    #[cfg(windows)]
    #[test]
    fn bounded_read_refuses_a_symlink_where_creatable() {
        let dir = TempDir::new();
        let target = dir.path().join("real.json");
        fs::write(&target, "{}").expect("write");
        let link = dir.path().join("link.json");
        /* Creating a file symlink needs a privilege or developer mode; where
        the environment refuses, there is nothing to assert. */
        if std::os::windows::fs::symlink_file(&target, &link).is_err() {
            return;
        }
        assert_eq!(bounded_read(&link), None);
        assert_eq!(bounded_read(&target).as_deref(), Some("{}"));
    }
}
