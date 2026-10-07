use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::fsx;

/// The lock holding handshake over the CLI owned snapshot cache.
///
/// The writer implements the cache's cross process lock protocol. Native
/// collection now uses begin, folds while it owns the generation, and uses
/// commit to replace the file atomically. The handshake methods remain
/// directly testable, but are no longer registered as webview commands.
///
/// Possession is continuous, not checked. `begin` keeps the lock file's
/// handle OPEN from acquisition through commit, exactly as the core's own
/// holder does: `acquireLock` returns an open handle
/// (`packages/core/src/cache.ts:262-279`) that `withCacheLock` holds across
/// the whole mutation and closes only in its finally
/// (`packages/core/src/cache.ts:305-319`). On Windows the handle is opened
/// with share mode none, so while it lives no other process can read, write,
/// rename or delete the lock file: reclaim by a CLI watchdog is physically
/// impossible mid handshake, and the process dying closes the handle so the
/// stale window reclaims naturally. On Unix, where an open handle cannot
/// stop an unlink, commit re proves possession THROUGH the held handle by
/// comparing its device and inode with what the lock path names at that
/// moment; a reclaimed or replaced lock fails the comparison and the commit
/// lands as a typed rejection. The instant between that proof and the rename
/// is the residual the core protocol itself carries in `releaseLock`
/// (`packages/core/src/cache.ts:281-288`); the Windows share mode closes
/// even that.
///
/// The generation stamp closes the ABA race on the session level: a merge
/// superseded by a newer `begin`, or a commit presenting the wrong stamp,
/// is refused before the disk is looked at.
///
/// Every constant below cites the line of `packages/core/src/cache.ts` it
/// mirrors. If the core protocol changes, this module changes with it.
/// Mirrors `CACHE_FILE_NAME`, `packages/core/src/cache.ts:19`.
pub const CACHE_FILE_NAME: &str = "openlimiter-cache.json";
pub const AUTHORITATIVE_CACHE_FILE_NAME: &str = "openlimiter-authoritative.json";

/// Mirrors `CACHE_LOCK_NAME`, `packages/core/src/cache.ts:20`.
pub const CACHE_LOCK_NAME: &str = "openlimiter.lock";

/// Mirrors `MAX_JSON_FILE_BYTES`, `packages/core/src/cache.ts:23`.
pub const MAX_JSON_FILE_BYTES: u64 = 1_048_576;

/// Mirrors `LOCK_STALE_MILLISECONDS`, `packages/core/src/cache.ts:26`.
pub const LOCK_STALE_MILLISECONDS: u64 = 60_000;

/// Mirrors `LOCK_ATTEMPT_LIMIT`, `packages/core/src/cache.ts:28`.
const LOCK_ATTEMPT_LIMIT: u32 = 40;

/// The lock owner stamp, mirroring the token written in `acquireLock`,
/// `packages/core/src/cache.ts:265`: `{"at":<milliseconds>,"pid":<pid>}` in
/// exactly that field order.
#[derive(Serialize)]
struct LockStamp {
    pid: u32,
    #[serde(rename = "startedAt")]
    started_at: u64,
    token: String,
}

/// What `begin` hands to the webview: the cache as it stands, and the stamp a
/// commit must present. `text` is absent when no cache exists yet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CacheWriteBegin {
    pub text: Option<String>,
    pub generation: u64,
}

/// Handshake failure, closed and payload free so `Display` can never carry
/// cache text, a path, or a token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CacheWriteError {
    /// No state directory could be resolved on this machine.
    NoStateDirectory,
    /// Another writer held the lock through every attempt, mirroring the
    /// "Cache lock is busy" failure in `packages/core/src/cache.ts:278`.
    Busy,
    /// The presented generation is not the open session, or the lock was
    /// reclaimed while the webview merged. The commit did not happen.
    StaleGeneration,
    /// The text is over the cache bound and no reader would accept it.
    TooLarge,
    /// The text is not JSON, and the cache file is always JSON.
    NotJson,
    /// The operating system refused a read, a write, or a rename.
    Io,
}

impl fmt::Display for CacheWriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sentence = match self {
            CacheWriteError::NoStateDirectory => "no state directory exists on this machine",
            CacheWriteError::Busy => "the cache lock stayed busy through every attempt",
            CacheWriteError::StaleGeneration => {
                "this write session is no longer current and was refused"
            }
            CacheWriteError::TooLarge => "the cache text is over the bound every reader enforces",
            CacheWriteError::NotJson => "the cache text is not a JSON document",
            CacheWriteError::Io => "the cache could not be read or written",
        };
        formatter.write_str(sentence)
    }
}

impl From<fsx::FsFailure> for CacheWriteError {
    fn from(_: fsx::FsFailure) -> Self {
        CacheWriteError::Io
    }
}

struct PendingWrite {
    generation: u64,
    token: String,
}

enum AuthoritativeMutation<'a> {
    Rows(&'a [crate::native_snapshot::Snapshot], bool),
    RemoveWeekly {
        provider: &'a str,
        account: Option<&'a str>,
    },
}

struct WriterInner {
    pending: Option<PendingWrite>,
    next_generation: u64,
}

pub struct CacheWriter {
    directory: Option<PathBuf>,
    inner: Mutex<WriterInner>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Read the owner stamp of an existing lock and decide whether it has been
/// abandoned, removing it if so. Mirrors `reclaimStaleLock`,
/// `packages/core/src/cache.ts:237-260`: the `at` stamp inside the lock is
/// the primary signal, the file modification time is the fallback, and a lock
/// younger than the stale window is left alone.
fn reclaim_stale_lock(lock_path: &Path) -> bool {
    let now = now_ms();
    let metadata = match fs::symlink_metadata(lock_path) {
        Ok(metadata) => metadata,
        Err(_) => return true,
    };
    if !metadata.is_dir() {
        return false;
    }
    let owner = fs::read_to_string(lock_path.join("owner.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let started_at = owner.as_ref()
        .and_then(|value| value.get("startedAt").or_else(|| value.get("started_at")))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_else(|| metadata.modified()
            .ok()
            .and_then(|instant| instant.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
            .unwrap_or(now)
            .min(now));
    if now.saturating_sub(started_at) < LOCK_STALE_MILLISECONDS {
        return false;
    }
    let displaced = lock_path.with_extension(format!("reclaim.{}", uuid::Uuid::new_v4()));
    if fs::rename(lock_path, &displaced).is_err() {
        return false;
    }
    let still_observed = if owner.is_none() {
        !displaced.join("owner.json").exists()
    } else {
        fs::read_to_string(displaced.join("owner.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|value| value.get("token").and_then(serde_json::Value::as_str).map(str::to_owned))
            .zip(owner.as_ref().and_then(|value| value.get("token").and_then(serde_json::Value::as_str).map(str::to_owned)))
            .is_some_and(|(observed, expected)| observed == expected)
    };
    if still_observed {
        let _ = fs::remove_dir_all(displaced);
    }
    true
}

/// Open the lock file exclusively, keeping every other process out where the
/// platform can. On Windows, share mode none means no other process can open
/// this file for reading, writing, renaming or deletion while the handle
/// lives, so possession is physical for the whole handshake.
fn open_lock_exclusively(lock_path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    options.open(lock_path)
}

/// Take the cache lock with the core's exact protocol, mirroring
/// `acquireLock`, `packages/core/src/cache.ts:262-279`: create the lock file
/// exclusively, write the owner stamp into it best effort, KEEP the handle
/// open exactly as the core's `withCacheLock` does
/// (`packages/core/src/cache.ts:305-319`), and on collision either reclaim a
/// stale lock or back off with the bounded jittered delay of
/// `backoffMilliseconds`, `packages/core/src/cache.ts:169-172`, for at most
/// `LOCK_ATTEMPT_LIMIT` attempts.
fn acquire_lock(lock_path: &Path, generation: u64) -> Result<PendingWrite, CacheWriteError> {
    let token = uuid::Uuid::new_v4().to_string();
    let stamp = serde_json::to_string(&LockStamp {
        pid: std::process::id(),
        started_at: now_ms(),
        token: token.clone(),
    })
    .map_err(|_| CacheWriteError::Io)?;
    for attempt in 0..LOCK_ATTEMPT_LIMIT {
        match fs::create_dir(lock_path) {
            Ok(()) => {
                fsx::atomic_write(&lock_path.join("owner.json"), &stamp)?;
                return Ok(PendingWrite {
                    generation,
                    token,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if !reclaim_stale_lock(lock_path) {
                    std::thread::sleep(fsx::backoff_delay(attempt));
                }
            }
            Err(_) => return Err(CacheWriteError::Io),
        }
    }
    Err(CacheWriteError::Busy)
}

/// Whether the held lock is still the lock the path names.
///
/// On Windows the share mode makes the question rhetorical: while the handle
/// lives, nothing else could have touched the file, so holding the handle is
/// the proof.
#[cfg(windows)]
fn still_possessed(session: &PendingWrite, lock_path: &Path) -> bool {
    fs::read_to_string(lock_path.join("owner.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get("token").and_then(serde_json::Value::as_str).map(str::to_owned))
        .is_some_and(|token| token == session.token)
}

/// On Unix an open handle cannot stop an unlink, so possession is proved
/// through the handle: the device and inode of the held file must be exactly
/// what the lock path names right now. A watchdog reclaim unlinked our inode,
/// so a reclaimed or replaced lock fails this comparison and the stalled
/// commit is refused with the newer writer's work untouched.
#[cfg(unix)]
fn still_possessed(session: &PendingWrite, lock_path: &Path) -> bool {
    fs::read_to_string(lock_path.join("owner.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get("token").and_then(serde_json::Value::as_str).map(str::to_owned))
        .is_some_and(|token| token == session.token)
}

/// End a session: close the handle, then remove the lock only while it still
/// carries our exact token, mirroring `releaseLock`,
/// `packages/core/src/cache.ts:281-288`. The close must come first because
/// the Windows share mode blocks even our own second open, and the token
/// comparison then keeps a lock that changed hands in that closing instant
/// strictly alone.
fn release_session(lock_path: &Path, session: PendingWrite) {
    if still_possessed(&session, lock_path) {
        let _ = fs::remove_dir_all(lock_path);
    }
}

impl CacheWriter {
    fn replace_authoritative_rows(
        directory: &Path,
        incoming: &[crate::native_snapshot::Snapshot],
    ) -> Result<(), CacheWriteError> {
        let file = directory.join(AUTHORITATIVE_CACHE_FILE_NAME);
        fsx::reject_symlink(&file)?;
        let mut document = fsx::bounded_read(&file)
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .unwrap_or_else(|| serde_json::json!({"version": 3, "snapshots": []}));
        let rows = document
            .get_mut("snapshots")
            .and_then(serde_json::Value::as_array_mut)
            .ok_or(CacheWriteError::NotJson)?;
        for snapshot in incoming {
            let value = serde_json::to_value(snapshot).map_err(|_| CacheWriteError::Io)?;
            let identity = |row: &serde_json::Value| {
                (
                    row.get("provider").and_then(serde_json::Value::as_str).unwrap_or("").to_owned(),
                    row.get("meter").and_then(serde_json::Value::as_str).unwrap_or("").to_owned(),
                    row.get("accountId").and_then(serde_json::Value::as_str).map(str::to_owned),
                )
            };
            let key = identity(&value);
            if let Some(existing) = rows.iter_mut().find(|row| identity(row) == key) {
                let old = existing.get("observedAt").and_then(serde_json::Value::as_str).unwrap_or("");
                let next = value.get("observedAt").and_then(serde_json::Value::as_str).unwrap_or("");
                if next >= old {
                    *existing = value;
                }
            } else {
                rows.push(value);
            }
        }
        document["version"] = serde_json::json!(3);
        fsx::atomic_write(&file, &document.to_string())?;
        Ok(())
    }

    fn authoritative_rows_without(
        directory: &Path,
        provider: &str,
        account_id: Option<&str>,
    ) -> Result<Vec<crate::native_snapshot::Snapshot>, CacheWriteError> {
        let file = directory.join(AUTHORITATIVE_CACHE_FILE_NAME);
        fsx::reject_symlink(&file)?;
        let mut document = fsx::bounded_read(&file)
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .unwrap_or_else(|| serde_json::json!({"version": 3, "snapshots": []}));
        let rows = document
            .get_mut("snapshots")
            .and_then(serde_json::Value::as_array_mut)
            .ok_or(CacheWriteError::NotJson)?;
        rows.retain(|row| {
            let matches_provider = row.get("provider").and_then(serde_json::Value::as_str) == Some(provider);
            let matches_account = account_id.is_none_or(|account| {
                row.get("accountId").and_then(serde_json::Value::as_str) == Some(account)
            });
            !(matches_provider && matches_account && row.get("meter").and_then(serde_json::Value::as_str).is_some_and(|meter| meter.starts_with("SEVEN_DAY")))
        });
        rows.iter()
            .cloned()
            .map(|row| serde_json::from_value(row).map_err(|_| CacheWriteError::NotJson))
            .collect()
    }

    pub(crate) fn record_availability(
        &self,
        provider: &str,
        account: Option<&str>,
        availability: &str,
        retry_at: Option<u64>,
        now: u64,
    ) -> Result<(), CacheWriteError> {
        let begun = self.begin()?;
        let mut document: serde_json::Value = match begun.text.as_deref() {
            Some(text) => match serde_json::from_str(text) {
                Ok(document) => document,
                Err(_) => {
                    self.abort(begun.generation);
                    return Err(CacheWriteError::NotJson);
                }
            },
            None => serde_json::json!({"version": 3, "snapshots": []}),
        };
        let result = (|| {
            let rows = document
                .get_mut("snapshots")
                .and_then(|v| v.as_array_mut())
                .ok_or(CacheWriteError::NotJson)?;
            let matches = |row: &serde_json::Value| {
                row.get("provider").and_then(|v| v.as_str()) == Some(provider)
                    && account.is_none_or(|account| {
                        row.get("accountId").and_then(|v| v.as_str()) == Some(account)
                    })
            };
            if !rows.iter().any(matches) {
                rows.push(serde_json::json!({
                    "provider": provider, "meter": "ACQUISITION", "value": 0, "unit": "PERCENT",
                    "window": {"kind": "unknown"}, "resetAt": null, "source": "internal_payload", "precision": "exact",
                    "observedAt": policy_iso(now), "expiresAt": policy_iso(now.saturating_add(300_000)),
                    "writer": "desktop", "labels": {"credentialOrigin": "official-local-tool", "dataInterfaceStatus": "internal-endpoint", "automationRisk": "high", "verification": "UNVERIFIED"}
                }));
                if let Some(account) = account {
                    rows.last_mut().unwrap()["accountId"] = serde_json::json!(account);
                }
            }
            for row in rows.iter_mut().filter(|row| matches(row)) {
                row["availability"] = serde_json::json!(availability);
                if let Some(retry) = retry_at {
                    row["retryAt"] = serde_json::json!(policy_iso(retry));
                } else if let Some(object) = row.as_object_mut() {
                    object.remove("retryAt");
                }
            }
            self.commit_with_authoritative_account_replacement(
                &document.to_string(), provider, account, begun.generation
            )
        })();
        if result.is_err() {
            self.abort(begun.generation);
        }
        result
    }
    /// Serialize policy changes with cache writes in both desktop and Node.
    pub(crate) fn policy_transaction<R>(
        directory: &Path,
        action: impl FnOnce() -> Result<R, ()>,
    ) -> Result<R, ()> {
        let writer = Self::at(Some(directory.to_path_buf()));
        let session = writer.begin().map_err(|_| ())?;
        let result = action();
        writer.abort(session.generation);
        result
    }
    /// The writer over the application's real state directory.
    pub fn at_state_directory() -> Self {
        Self::at(crate::state::state_directory())
    }

    /// The writer over an explicit directory, which is what tests use.
    pub fn at(directory: Option<PathBuf>) -> Self {
        Self {
            directory,
            inner: Mutex::new(WriterInner {
                pending: None,
                next_generation: 1,
            }),
        }
    }

    pub(crate) fn directory(&self) -> Result<&Path, CacheWriteError> {
        self.directory
            .as_deref()
            .ok_or(CacheWriteError::NoStateDirectory)
    }

    /// Take the lock and hand the current cache text out for merging.
    ///
    /// The lock's handle stays open inside this writer until the session
    /// ends, which is what makes possession continuous. A session left open
    /// by an earlier `begin` is superseded: its lock is released if still
    /// ours and its generation goes stale, because the webview asking to
    /// begin again is the webview abandoning the merge it never committed.
    pub fn begin(&self) -> Result<CacheWriteBegin, CacheWriteError> {
        let directory = self.directory()?;
        let mut inner = self.inner.lock().map_err(|_| CacheWriteError::Io)?;
        let lock_path = directory.join(CACHE_LOCK_NAME);
        if let Some(stale) = inner.pending.take() {
            release_session(&lock_path, stale);
        }
        fsx::ensure_private_dir(directory)?;
        fsx::reject_symlink(&lock_path)?;
        let generation = inner.next_generation;
        let session = acquire_lock(&lock_path, generation)?;
        let text = fsx::bounded_read(&directory.join(CACHE_FILE_NAME));
        inner.next_generation += 1;
        inner.pending = Some(session);
        Ok(CacheWriteBegin { text, generation })
    }

    /// Verify the generation, prove possession through the held handle,
    /// replace the cache atomically, release.
    ///
    /// The write happens only while the presented generation is the open
    /// session and the handle taken at `begin` still owns the lock. A
    /// reclaimed lock, a superseding `begin`, or a wrong generation all land
    /// as `StaleGeneration` with the cache untouched.
    pub fn commit(&self, text: &str, generation: u64) -> Result<(), CacheWriteError> {
        self.commit_with_gap(text, generation, || {})
    }

    pub(crate) fn commit_with_authoritative(
        &self,
        text: &str,
        authoritative: &[crate::native_snapshot::Snapshot],
        generation: u64,
    ) -> Result<(), CacheWriteError> {
        self.commit_parts(
            text,
            generation,
            Some(AuthoritativeMutation::Rows(authoritative, false)),
            || {},
        )
    }

    pub(crate) fn commit_with_authoritative_replacement(
        &self,
        text: &str,
        authoritative: &[crate::native_snapshot::Snapshot],
        generation: u64,
    ) -> Result<(), CacheWriteError> {
        self.commit_parts(
            text,
            generation,
            Some(AuthoritativeMutation::Rows(authoritative, true)),
            || {},
        )
    }

    pub(crate) fn commit_with_authoritative_account_replacement(
        &self,
        text: &str,
        provider: &str,
        account: Option<&str>,
        generation: u64,
    ) -> Result<(), CacheWriteError> {
        self.commit_parts(
            text,
            generation,
            Some(AuthoritativeMutation::RemoveWeekly { provider, account }),
            || {},
        )
    }

    /// End one native mutation without writing, but only when it still owns
    /// the named generation. This keeps a refused cache fold from holding the
    /// shared lock until another writer happens to arrive.
    pub fn abort(&self, generation: u64) {
        let Ok(directory) = self.directory() else {
            return;
        };
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let current = matches!(
            &inner.pending,
            Some(pending) if pending.generation == generation
        );
        if current {
            let session = inner
                .pending
                .take()
                .expect("the generation was just matched");
            release_session(&directory.join(CACHE_LOCK_NAME), session);
        }
    }

    /// The commit with a seam where a test injects the exact adversarial
    /// instant: after the session is verified and before possession is
    /// proved and the rename lands. Production passes a no op.
    fn commit_with_gap(
        &self,
        text: &str,
        generation: u64,
        gap: impl FnOnce(),
    ) -> Result<(), CacheWriteError> {
        self.commit_parts(text, generation, None, gap)
    }

    fn commit_parts(
        &self,
        text: &str,
        generation: u64,
        authoritative: Option<AuthoritativeMutation<'_>>,
        gap: impl FnOnce(),
    ) -> Result<(), CacheWriteError> {
        let directory = self.directory()?;
        let mut inner = self.inner.lock().map_err(|_| CacheWriteError::Io)?;
        let current = matches!(
            &inner.pending,
            Some(pending) if pending.generation == generation
        );
        if !current {
            return Err(CacheWriteError::StaleGeneration);
        }
        /* From here this session ends whatever happens, so it is taken out
        before the first thing that can fail. */
        let session = inner.pending.take().expect("the session was just verified");
        let lock_path = directory.join(CACHE_LOCK_NAME);
        gap();
        if !still_possessed(&session, &lock_path) {
            /* The watchdog reclaimed this lock while the webview merged and
            another writer may already have written. The merge is stale and
            the cache is left exactly as the newer writer made it; the lock
            is not ours to remove. */
            return Err(CacheWriteError::StaleGeneration);
        }
        let outcome = Self::replace_cache(directory, text).and_then(|()| {
            if let Some(mutation) = authoritative {
                match mutation {
                    AuthoritativeMutation::Rows(rows, replace) => {
                        if replace {
                            let file = directory.join(AUTHORITATIVE_CACHE_FILE_NAME);
                            fsx::reject_symlink(&file)?;
                            let document = serde_json::json!({ "version": 3, "snapshots": rows });
                            fsx::atomic_write(&file, &document.to_string())?;
                        } else {
                            Self::replace_authoritative_rows(directory, rows)?;
                        }
                    }
                    AuthoritativeMutation::RemoveWeekly { provider, account } => {
                        let rows = Self::authoritative_rows_without(directory, provider, account)?;
                        let file = directory.join(AUTHORITATIVE_CACHE_FILE_NAME);
                        fsx::reject_symlink(&file)?;
                        let document = serde_json::json!({ "version": 3, "snapshots": rows });
                        fsx::atomic_write(&file, &document.to_string())?;
                    }
                }
            }
            Ok(())
        });
        release_session(&lock_path, session);
        outcome
    }

    fn replace_cache(directory: &Path, text: &str) -> Result<(), CacheWriteError> {
        if text.len() as u64 > MAX_JSON_FILE_BYTES {
            return Err(CacheWriteError::TooLarge);
        }
        let mut document: serde_json::Value =
            serde_json::from_str(text).map_err(|_| CacheWriteError::NotJson)?;
        if let Some(rows) = document.get_mut("snapshots").and_then(|v| v.as_array_mut()) {
            for row in rows {
                let source = row.get("source").and_then(|v| v.as_str()).unwrap_or("");
                if !matches!(
                    source,
                    "native_payload" | "documented_api" | "internal_payload" | "local_file"
                ) {
                    continue;
                }
                if let Some(observed) = row
                    .get("observedAt")
                    .and_then(|v| v.as_str())
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                {
                    let (_, expires, _) = crate::data_rules::freshness_for(
                        row.get("provider").and_then(|v| v.as_str()).unwrap_or(""),
                        row.get("writer").and_then(|v| v.as_str()).unwrap_or(""),
                        source,
                        observed.timestamp_millis(),
                        observed.timestamp_millis(),
                    );
                    row["expiresAt"] = serde_json::json!(policy_iso(expires as u64));
                }
            }
        }
        let file = directory.join(CACHE_FILE_NAME);
        fsx::reject_symlink(&file)?;
        fsx::atomic_write(&file, &document.to_string())?;
        Ok(())
    }
}

pub(crate) fn policy_iso(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) use crate::data_rules::freshness_policy;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn writer(dir: &TempDir) -> CacheWriter {
        CacheWriter::at(Some(dir.path().to_path_buf()))
    }

    fn cache_path(dir: &TempDir) -> PathBuf {
        dir.path().join(CACHE_FILE_NAME)
    }

    fn lock_path(dir: &TempDir) -> PathBuf {
        dir.path().join(CACHE_LOCK_NAME)
    }

    #[test]
    fn lock_protocol_happy_path() {
        let dir = TempDir::new();
        let writer = writer(&dir);
        let begun = writer.begin().expect("begin");
        assert_eq!(begun.text, None);
        assert!(lock_path(&dir).is_dir(), "begin holds the lock");
        let merged = "{\"snapshots\":[],\"version\":1}";
        writer.commit(merged, begun.generation).expect("commit");
        assert_eq!(
            fs::read_to_string(cache_path(&dir)).expect("cache readable"),
            merged
        );
        assert!(!lock_path(&dir).exists(), "commit releases the lock");
    }

    #[test]
    fn begin_returns_the_existing_text() {
        let dir = TempDir::new();
        fs::write(cache_path(&dir), "{\"snapshots\":[]}").expect("seed");
        let writer = writer(&dir);
        let begun = writer.begin().expect("begin");
        assert_eq!(begun.text.as_deref(), Some("{\"snapshots\":[]}"));
        writer
            .commit("{\"snapshots\":[]}", begun.generation)
            .expect("commit");
    }

    #[cfg(unix)]
    #[test]
    fn generation_aba_rejection() {
        let dir = TempDir::new();
        let writer = writer(&dir);
        let begun = writer.begin().expect("begin");
        /* The merge stalls past the stale window. A CLI writer's watchdog
        reclaims the lock directory, takes it with its own stamp, writes the
        cache, and releases. Nothing stops that on POSIX, which is exactly why
        commit must re prove possession through the token in owner.json. */
        fs::remove_dir_all(lock_path(&dir)).expect("watchdog reclaim");
        fs::create_dir(lock_path(&dir)).expect("foreign lock");
        fs::write(lock_path(&dir).join("owner.json"), "{\"pid\":424242,\"started_at\":9999999999999,\"token\":\"foreign\"}").expect("foreign stamp");
        fs::write(cache_path(&dir), "{\"foreign\":true}").expect("foreign write");
        fs::remove_dir_all(lock_path(&dir)).expect("foreign release");
        /* The stalled merge now tries to land. It must be refused, and the
        foreign write must survive untouched. */
        let outcome = writer.commit("{\"stalled\":true}", begun.generation);
        assert_eq!(outcome, Err(CacheWriteError::StaleGeneration));
        assert_eq!(
            fs::read_to_string(cache_path(&dir)).expect("cache readable"),
            "{\"foreign\":true}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn reclaim_in_the_verify_to_rename_gap_rejects_and_foreign_survives() {
        /* Sol's exact scenario, injected into the seam between session
        verification and the rename: the watchdog reclaims, a foreign writer
        lands newer data and releases, and the stalled commit must refuse
        rather than rename over it. */
        let dir = TempDir::new();
        let writer = writer(&dir);
        let begun = writer.begin().expect("begin");
        let lock = lock_path(&dir);
        let cache = cache_path(&dir);
        let outcome = writer.commit_with_gap("{\"stalled\":true}", begun.generation, || {
            fs::remove_dir_all(&lock).expect("watchdog reclaim");
            fs::create_dir(&lock).expect("foreign lock");
            fs::write(lock.join("owner.json"), "{\"pid\":424242,\"started_at\":9999999999999,\"token\":\"foreign\"}").expect("foreign stamp");
            fs::write(&cache, "{\"foreign\":true}").expect("foreign write");
            fs::remove_dir_all(&lock).expect("foreign release");
        });
        assert_eq!(outcome, Err(CacheWriteError::StaleGeneration));
        assert_eq!(
            fs::read_to_string(&cache).expect("cache readable"),
            "{\"foreign\":true}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn held_lock_is_physically_unreclaimable() {
        /* Share mode none: from begin to commit, no other process can open,
        write, rename or delete the lock file, so the reclaim that opens
        Sol's window cannot happen at all on this platform. */
        let dir = TempDir::new();
        let writer = writer(&dir);
        let begun = writer.begin().expect("begin");
        let lock = lock_path(&dir);
        assert!(
            fs::remove_file(&lock).is_err(),
            "a watchdog unlink must bounce off the held handle"
        );
        assert!(
            fs::OpenOptions::new().read(true).open(&lock).is_err(),
            "a foreign read of the lock must bounce off the held handle"
        );
        assert!(
            fs::OpenOptions::new().write(true).open(&lock).is_err(),
            "a foreign write of the lock must bounce off the held handle"
        );
        writer
            .commit("{\"ours\":true}", begun.generation)
            .expect("commit");
        assert_eq!(
            fs::read_to_string(cache_path(&dir)).expect("cache readable"),
            "{\"ours\":true}"
        );
        assert!(!lock.exists(), "commit releases the lock");
    }

    #[cfg(windows)]
    #[test]
    fn reclaim_in_the_verify_to_rename_gap_is_physically_blocked() {
        /* Sol's exact scenario, attempted inside the seam between session
        verification and the rename. On this platform the reclaim itself is
        impossible while the handle lives, so the commit completes with no
        lock honouring writer able to interpose. */
        let dir = TempDir::new();
        let writer = writer(&dir);
        let begun = writer.begin().expect("begin");
        let lock = lock_path(&dir);
        let outcome = writer.commit_with_gap("{\"ours\":true}", begun.generation, || {
            assert!(
                fs::remove_file(&lock).is_err(),
                "the reclaim in the gap must bounce off the held handle"
            );
            assert!(
                fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .open(&lock)
                    .is_err(),
                "a foreign lock take in the gap must bounce off the held handle"
            );
        });
        assert_eq!(outcome, Ok(()));
        assert_eq!(
            fs::read_to_string(cache_path(&dir)).expect("cache readable"),
            "{\"ours\":true}"
        );
    }

    #[test]
    fn wrong_generation_is_refused_and_the_session_survives() {
        let dir = TempDir::new();
        let writer = writer(&dir);
        let begun = writer.begin().expect("begin");
        let outcome = writer.commit("{}", begun.generation + 1);
        assert_eq!(outcome, Err(CacheWriteError::StaleGeneration));
        /* The wrong stamp did not kill the real session. */
        writer.commit("{}", begun.generation).expect("commit");
    }

    #[test]
    fn superseding_begin_stales_the_earlier_session() {
        let dir = TempDir::new();
        let writer = writer(&dir);
        let first = writer.begin().expect("first begin");
        let second = writer.begin().expect("second begin");
        assert_eq!(
            writer.commit("{}", first.generation),
            Err(CacheWriteError::StaleGeneration)
        );
        writer.commit("{}", second.generation).expect("commit");
    }

    #[test]
    fn stale_foreign_lock_is_reclaimed() {
        let dir = TempDir::new();
        fs::create_dir_all(dir.path()).expect("dir");
        fs::create_dir(lock_path(&dir)).expect("stale foreign lock");
        fs::write(
            lock_path(&dir).join("owner.json"),
            "{\"pid\":424242,\"startedAt\":1000,\"token\":\"foreign\"}"
        ).expect("owner");
        let writer = writer(&dir);
        let begun = writer.begin().expect("begin reclaims");
        writer.commit("{}", begun.generation).expect("commit");
    }

    #[test]
    fn fresh_foreign_lock_stays_busy() {
        let dir = TempDir::new();
        fs::create_dir_all(dir.path()).expect("dir");
        fs::create_dir(lock_path(&dir)).expect("fresh foreign lock");
        let stamp = format!(
            "{{\"pid\":{},\"startedAt\":{},\"token\":\"foreign\"}}",
            std::process::id(), now_ms()
        );
        fs::write(lock_path(&dir).join("owner.json"), stamp).expect("fresh foreign lock");
        let writer = writer(&dir);
        assert_eq!(writer.begin().map(|_| ()), Err(CacheWriteError::Busy));
        assert!(lock_path(&dir).is_dir(), "the foreign lock is untouched");
    }

    #[test]
    fn oversized_text_is_refused() {
        let dir = TempDir::new();
        let writer = writer(&dir);
        let begun = writer.begin().expect("begin");
        let oversized = format!(
            "{{\"pad\":\"{}\"}}",
            "x".repeat(MAX_JSON_FILE_BYTES as usize)
        );
        assert_eq!(
            writer.commit(&oversized, begun.generation),
            Err(CacheWriteError::TooLarge)
        );
        assert!(!cache_path(&dir).exists());
        assert!(!lock_path(&dir).exists(), "the refused session released");
    }

    #[test]
    fn non_json_text_is_refused() {
        let dir = TempDir::new();
        let writer = writer(&dir);
        let begun = writer.begin().expect("begin");
        assert_eq!(
            writer.commit("not json at all", begun.generation),
            Err(CacheWriteError::NotJson)
        );
        assert!(!cache_path(&dir).exists());
    }

    #[test]
    fn every_cache_write_error_sentence_is_fixed() {
        /* Payload free variants, proven sentence by sentence: no token, no
        path, and no cache text can exist in any of them. */
        let cases = [
            (
                CacheWriteError::NoStateDirectory,
                "no state directory exists on this machine",
            ),
            (
                CacheWriteError::Busy,
                "the cache lock stayed busy through every attempt",
            ),
            (
                CacheWriteError::StaleGeneration,
                "this write session is no longer current and was refused",
            ),
            (
                CacheWriteError::TooLarge,
                "the cache text is over the bound every reader enforces",
            ),
            (
                CacheWriteError::NotJson,
                "the cache text is not a JSON document",
            ),
            (
                CacheWriteError::Io,
                "the cache could not be read or written",
            ),
        ];
        for (error, sentence) in cases {
            assert_eq!(error.to_string(), sentence);
        }
    }

    #[test]
    fn commit_without_begin_is_stale() {
        let dir = TempDir::new();
        let writer = writer(&dir);
        assert_eq!(
            writer.commit("{}", 1),
            Err(CacheWriteError::StaleGeneration)
        );
    }

    #[test]
    fn abort_releases_a_native_fold_that_writes_nothing() {
        let dir = TempDir::new();
        let writer = writer(&dir);
        let begun = writer.begin().expect("begin");
        assert!(lock_path(&dir).is_dir());
        writer.abort(begun.generation);
        assert!(!lock_path(&dir).exists());
        assert!(
            writer.begin().is_ok(),
            "a later writer may acquire the lock"
        );
    }
}
