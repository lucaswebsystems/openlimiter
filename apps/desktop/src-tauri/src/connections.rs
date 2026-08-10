use std::fmt;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::fsx;

/// Connection records, owned solely by desktop Rust.
///
/// `connections.json` lives beside the snapshot cache in the state directory
/// and no other process writes it: the CLI owns the cache, this file is ours.
/// A record carries everything about a connection except its secret, which
/// lives in the operating system credential store under the record's id and
/// appears here only as a masked label. The record type has no secret field,
/// so the secret cannot be written to disk by construction.
///
/// Writes are read, modify, replace under one in process mutex, and the
/// replace is atomic through a flushed temporary file and a rename, so a
/// crash leaves the previous document rather than half of a new one.
pub const CONNECTIONS_FILE_NAME: &str = "connections.json";

/// Version of the document, for a future reader that must tell shapes apart.
pub const CONNECTIONS_DOCUMENT_VERSION: u64 = 1;

/// More connections than any person holds subscriptions; a bound, not a goal.
pub const MAX_CONNECTIONS: usize = 100;

/// Longest an id may be, mirroring `ACCOUNT_ID_PATTERN` in
/// `packages/core/src/types.ts:117`: `/^[a-z0-9][a-z0-9-]{0,63}$/u`.
pub const MAX_ID_CHARS: usize = 64;

/// Longest an account alias may be, in characters.
pub const MAX_ALIAS_CHARS: usize = 80;

/// Providers this subsystem can hold a connection for: the record level
/// counterpart of the endpoint allowlist in `net.rs`, spelled exactly as
/// `PROVIDER_CODES` spells it in `packages/core/src/types.ts:1-8`. Adding a
/// provider means adding it here, in code, in review.
pub const PROVIDER_IDS: [&str; 1] = ["OPENROUTER"];

/// The credential kinds the design names for OpenRouter: the inference key
/// path and the management key path.
pub const KEY_KINDS: [&str; 2] = ["inference", "management"];

/// The connection state vocabulary, mirroring `CONNECTION_STATES` in
/// `packages/core/src/connection-state.ts:12-26`. The state machine itself
/// lives in the webview; this list only refuses a status no surface could
/// ever have produced.
pub const CONNECTION_STATES: [&str; 13] = [
    "NOT_CONFIGURED",
    "DETECTED",
    "NEEDS_AUTH",
    "READY_TO_ENABLE",
    "CONNECTING",
    "CONNECTED",
    "DEGRADED",
    "STALE",
    "AUTH_EXPIRED",
    "IMPORT_ONLY",
    "MANUAL",
    "UNSUPPORTED",
    "ERROR",
];

/// Latest instant a stored timestamp may claim: the year 2100 in epoch
/// milliseconds. A bound against tampering, not a prophecy.
pub const MAX_TIMESTAMP_EPOCH_MS: u64 = 4_102_444_800_000;

/// One connection, exactly the fields the design names. Timestamps are unix
/// epoch milliseconds, the representation the engine's own clock uses, so no
/// date arithmetic exists on this side of the boundary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionRecord {
    pub id: String,
    pub provider_id: String,
    pub account_alias: String,
    pub key_kind: String,
    pub masked_label: String,
    pub created_at: u64,
    #[serde(default)]
    pub last_test_at: Option<u64>,
    #[serde(default)]
    pub last_refresh_at: Option<u64>,
    pub status: String,
}

#[derive(Serialize, Deserialize)]
struct ConnectionsDocument {
    version: u64,
    connections: Vec<ConnectionRecord>,
}

/// Storage failure with everything identifying removed. Payload free, fixed
/// sentences.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreError {
    /// No state directory could be resolved on this machine.
    NoStateDirectory,
    /// No record carries the requested id.
    NotFound,
    /// The document on disk is not one this build understands. Nothing is
    /// repaired and nothing is overwritten while this is true.
    Corrupt,
    /// The document is already at its bounds.
    Full,
    /// A field is missing, empty where it may not be, or over its bound.
    InvalidField,
    /// The operating system refused a read or a write.
    Io,
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sentence = match self {
            StoreError::NoStateDirectory => "no state directory exists on this machine",
            StoreError::NotFound => "no connection carries this id",
            StoreError::Corrupt => "the connections file is not readable as written",
            StoreError::Full => "the connections file is at its bound",
            StoreError::InvalidField => "a connection field is empty or over its bound",
            StoreError::Io => "the connections file could not be read or written",
        };
        formatter.write_str(sentence)
    }
}

impl From<fsx::FsFailure> for StoreError {
    fn from(_: fsx::FsFailure) -> Self {
        StoreError::Io
    }
}

/// The present moment as unix epoch milliseconds. A clock before 1970 is a
/// broken clock and reads as zero rather than as an invented instant.
pub fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

pub struct ConnectionsStore {
    directory: Option<PathBuf>,
    guard: Mutex<()>,
}

impl ConnectionsStore {
    /// The store at the application's real state directory.
    pub fn at_state_directory() -> Self {
        Self::at(crate::state::state_directory())
    }

    /// The store at an explicit directory, which is what tests use.
    pub fn at(directory: Option<PathBuf>) -> Self {
        Self {
            directory,
            guard: Mutex::new(()),
        }
    }

    fn file(&self) -> Result<PathBuf, StoreError> {
        self.directory
            .as_ref()
            .map(|directory| directory.join(CONNECTIONS_FILE_NAME))
            .ok_or(StoreError::NoStateDirectory)
    }

    fn load(&self) -> Result<Vec<ConnectionRecord>, StoreError> {
        let file = self.file()?;
        let Some(text) = fsx::bounded_read(&file) else {
            /* Missing is an empty store; unreadable and oversized also land
            here, and the write path below re reads before writing, so a
            document we cannot read is never silently replaced by an empty
            one: parsing what exists is attempted first. */
            return match std::fs::symlink_metadata(&file) {
                Ok(_) => Err(StoreError::Corrupt),
                Err(_) => Ok(Vec::new()),
            };
        };
        let document: ConnectionsDocument =
            serde_json::from_str(&text).map_err(|_| StoreError::Corrupt)?;
        /* A version this build does not know is a document it must not touch:
        accepting it would rewrite it as version 1 on the next save, a silent
        downgrade of a future shape. Corrupt blocks reads AND writes here. */
        if document.version != CONNECTIONS_DOCUMENT_VERSION {
            return Err(StoreError::Corrupt);
        }
        if document.connections.len() > MAX_CONNECTIONS {
            return Err(StoreError::Corrupt);
        }
        /* The file is input, not truth. Every record is validated on the way
        in, exactly as it is on the way out, so a tampered document is a typed
        corrupt error that blocks writes and never reaches the credential
        store or the webview as trusted data. */
        for record in &document.connections {
            if validate_record(record).is_err() {
                return Err(StoreError::Corrupt);
            }
        }
        let mut seen: Vec<&str> = Vec::with_capacity(document.connections.len());
        for record in &document.connections {
            if seen.contains(&record.id.as_str()) {
                return Err(StoreError::Corrupt);
            }
            seen.push(&record.id);
        }
        Ok(document.connections)
    }

    fn save(&self, connections: Vec<ConnectionRecord>) -> Result<(), StoreError> {
        let directory = self
            .directory
            .as_ref()
            .ok_or(StoreError::NoStateDirectory)?;
        fsx::ensure_private_dir(directory)?;
        let document = ConnectionsDocument {
            version: CONNECTIONS_DOCUMENT_VERSION,
            connections,
        };
        let text = serde_json::to_string(&document).map_err(|_| StoreError::Io)?;
        fsx::atomic_write(&self.file()?, &text)?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<ConnectionRecord>, StoreError> {
        let _held = self.guard.lock().map_err(|_| StoreError::Io)?;
        self.load()
    }

    pub fn get(&self, id: &str) -> Result<ConnectionRecord, StoreError> {
        let _held = self.guard.lock().map_err(|_| StoreError::Io)?;
        self.load()?
            .into_iter()
            .find(|record| record.id == id)
            .ok_or(StoreError::NotFound)
    }

    pub fn insert(&self, record: ConnectionRecord) -> Result<(), StoreError> {
        validate_record(&record)?;
        let _held = self.guard.lock().map_err(|_| StoreError::Io)?;
        let mut connections = self.load()?;
        if connections.len() >= MAX_CONNECTIONS {
            return Err(StoreError::Full);
        }
        if connections.iter().any(|existing| existing.id == record.id) {
            return Err(StoreError::InvalidField);
        }
        connections.push(record);
        self.save(connections)
    }

    pub fn remove(&self, id: &str) -> Result<(), StoreError> {
        let _held = self.guard.lock().map_err(|_| StoreError::Io)?;
        let mut connections = self.load()?;
        let before = connections.len();
        connections.retain(|record| record.id != id);
        if connections.len() == before {
            return Err(StoreError::NotFound);
        }
        self.save(connections)
    }

    /// Change one record in place and persist the whole document. The changed
    /// record is revalidated before anything touches the disk.
    pub fn update<F>(&self, id: &str, mutate: F) -> Result<ConnectionRecord, StoreError>
    where
        F: FnOnce(&mut ConnectionRecord),
    {
        let _held = self.guard.lock().map_err(|_| StoreError::Io)?;
        let mut connections = self.load()?;
        let record = connections
            .iter_mut()
            .find(|record| record.id == id)
            .ok_or(StoreError::NotFound)?;
        mutate(record);
        let identity_kept = record.id == id;
        let changed = record.clone();
        validate_record(&changed)?;
        if !identity_kept {
            return Err(StoreError::InvalidField);
        }
        self.save(connections)?;
        Ok(changed)
    }
}

/// Whether this id satisfies the core account id rule, mirroring
/// `ACCOUNT_ID_PATTERN` in `packages/core/src/types.ts:117`:
/// `/^[a-z0-9][a-z0-9-]{0,63}$/u`. Every id this subsystem mints, a
/// lowercase hyphenated UUID, satisfies it.
pub(crate) fn valid_id(id: &str) -> bool {
    let mut characters = id.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    let mut count = 1usize;
    for character in characters {
        count += 1;
        if count > MAX_ID_CHARS {
            return false;
        }
        let allowed =
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-';
        if !allowed {
            return false;
        }
    }
    true
}

/// Whether this alias is bounded, printable text: no control characters and
/// at most the alias cap. Empty is allowed; an alias is optional color.
pub(crate) fn valid_alias(alias: &str) -> bool {
    alias.chars().count() <= MAX_ALIAS_CHARS && !alias.chars().any(char::is_control)
}

/// Whether this label could have come out of `mask_label`: it must carry the
/// fixed dots and fit the mask's own maximum, so a connections file cannot
/// smuggle arbitrary text, or a whole secret, into the webview as a label.
pub(crate) fn valid_masked_label(label: &str) -> bool {
    label.contains(crate::credentials::MASK_DOTS)
        && label.chars().count() <= crate::credentials::MASK_LABEL_MAX_CHARS
        && !label.chars().any(char::is_control)
}

fn valid_timestamp(value: u64) -> bool {
    value > 0 && value <= MAX_TIMESTAMP_EPOCH_MS
}

pub(crate) fn validate_record(record: &ConnectionRecord) -> Result<(), StoreError> {
    let valid = valid_id(&record.id)
        && PROVIDER_IDS.contains(&record.provider_id.as_str())
        && KEY_KINDS.contains(&record.key_kind.as_str())
        && CONNECTION_STATES.contains(&record.status.as_str())
        && valid_alias(&record.account_alias)
        && valid_masked_label(&record.masked_label)
        && valid_timestamp(record.created_at)
        && record.last_test_at.is_none_or(valid_timestamp)
        && record.last_refresh_at.is_none_or(valid_timestamp);
    if valid {
        Ok(())
    } else {
        Err(StoreError::InvalidField)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn record(id: &str) -> ConnectionRecord {
        ConnectionRecord {
            id: id.to_string(),
            provider_id: "OPENROUTER".to_string(),
            account_alias: "personal".to_string(),
            key_kind: "inference".to_string(),
            masked_label: "sk-········cdef".to_string(),
            created_at: 1_770_000_000_000,
            last_test_at: None,
            last_refresh_at: None,
            status: "READY_TO_ENABLE".to_string(),
        }
    }

    fn record_json(id: &str, alias: &str, kind: &str) -> String {
        format!(
            concat!(
                r#"{{"id":"{}","provider_id":"OPENROUTER","account_alias":"{}","#,
                r#""key_kind":"{}","masked_label":"sk-········cdef","#,
                r#""created_at":1770000000000,"status":"CONNECTED"}}"#
            ),
            id, alias, kind
        )
    }

    fn write_document(dir: &TempDir, records: &[String]) {
        let text = format!(r#"{{"version":1,"connections":[{}]}}"#, records.join(","));
        std::fs::write(dir.path().join(CONNECTIONS_FILE_NAME), text).expect("write");
    }

    #[test]
    fn crud_roundtrip() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        assert_eq!(store.list().expect("list"), Vec::new());
        store.insert(record("one")).expect("insert");
        store.insert(record("two")).expect("insert");
        assert_eq!(store.list().expect("list").len(), 2);
        assert_eq!(store.get("one").expect("get").provider_id, "OPENROUTER");
        let updated = store
            .update("one", |it| {
                it.status = "CONNECTED".to_string();
                it.last_refresh_at = Some(1_770_000_100_000);
            })
            .expect("update");
        assert_eq!(updated.status, "CONNECTED");
        store.remove("one").expect("remove");
        assert_eq!(store.list().expect("list").len(), 1);
        assert_eq!(store.get("one"), Err(StoreError::NotFound));
    }

    #[test]
    fn duplicate_id_is_refused() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        store.insert(record("one")).expect("insert");
        assert_eq!(store.insert(record("one")), Err(StoreError::InvalidField));
    }

    #[test]
    fn corrupt_document_blocks_writes_instead_of_wiping() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        std::fs::write(dir.path().join(CONNECTIONS_FILE_NAME), "not json").expect("write");
        assert_eq!(store.list(), Err(StoreError::Corrupt));
        assert_eq!(store.insert(record("one")), Err(StoreError::Corrupt));
        let text = std::fs::read_to_string(dir.path().join(CONNECTIONS_FILE_NAME)).expect("read");
        assert_eq!(text, "not json");
    }

    #[test]
    fn missing_directory_is_an_empty_store() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().join("never-created")));
        assert_eq!(store.list().expect("list"), Vec::new());
    }

    #[test]
    fn no_state_directory_is_typed() {
        let store = ConnectionsStore::at(None);
        assert_eq!(store.list(), Err(StoreError::NoStateDirectory));
    }

    #[test]
    fn record_bounds_are_enforced() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        let mut empty_provider = record("one");
        empty_provider.provider_id = String::new();
        assert_eq!(store.insert(empty_provider), Err(StoreError::InvalidField));
        let mut oversized = record("two");
        oversized.account_alias = "a".repeat(MAX_ALIAS_CHARS + 1);
        assert_eq!(store.insert(oversized), Err(StoreError::InvalidField));
        let mut foreign_provider = record("three");
        foreign_provider.provider_id = "EVILCORP".to_string();
        assert_eq!(
            store.insert(foreign_provider),
            Err(StoreError::InvalidField)
        );
        let mut foreign_status = record("four");
        foreign_status.status = "TOTALLY_FINE".to_string();
        assert_eq!(store.insert(foreign_status), Err(StoreError::InvalidField));
        let mut naked_label = record("five");
        naked_label.masked_label = "sk-or-v1-full-secret".to_string();
        assert_eq!(store.insert(naked_label), Err(StoreError::InvalidField));
    }

    #[test]
    fn id_rule_mirrors_the_core_pattern() {
        assert!(valid_id("abc-123"));
        assert!(valid_id(&uuid::Uuid::new_v4().to_string()));
        assert!(valid_id(&"a".repeat(MAX_ID_CHARS)));
        assert!(!valid_id(""));
        assert!(!valid_id("Abc"));
        assert!(!valid_id("-abc"));
        assert!(!valid_id("../../evil"));
        assert!(!valid_id(&"a".repeat(MAX_ID_CHARS + 1)));
    }

    #[test]
    fn tampered_oversized_field_is_corrupt_and_blocks_writes() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        let oversized_alias = "a".repeat(MAX_ALIAS_CHARS + 1);
        write_document(
            &dir,
            &[record_json("abc-123", &oversized_alias, "inference")],
        );
        assert_eq!(store.list(), Err(StoreError::Corrupt));
        assert_eq!(store.insert(record("z9")), Err(StoreError::Corrupt));
    }

    #[test]
    fn tampered_hostile_id_is_corrupt_and_blocks_writes() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        write_document(&dir, &[record_json("../../evil", "personal", "inference")]);
        assert_eq!(store.list(), Err(StoreError::Corrupt));
        assert_eq!(store.get("../../evil"), Err(StoreError::Corrupt));
        assert_eq!(store.insert(record("z9")), Err(StoreError::Corrupt));
    }

    #[test]
    fn tampered_unknown_kind_is_corrupt_and_blocks_writes() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        write_document(
            &dir,
            &[record_json("abc-123", "personal", "browser_cookie")],
        );
        assert_eq!(store.list(), Err(StoreError::Corrupt));
        assert_eq!(store.insert(record("z9")), Err(StoreError::Corrupt));
    }

    #[test]
    fn tampered_duplicate_ids_are_corrupt() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        write_document(
            &dir,
            &[
                record_json("abc-123", "personal", "inference"),
                record_json("abc-123", "work", "management"),
            ],
        );
        assert_eq!(store.list(), Err(StoreError::Corrupt));
    }

    #[test]
    fn a_valid_handwritten_document_loads() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        write_document(&dir, &[record_json("abc-123", "personal", "inference")]);
        let listed = store.list().expect("valid document loads");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].provider_id, "OPENROUTER");
    }

    #[test]
    fn update_cannot_change_identity() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        store.insert(record("one")).expect("insert");
        let outcome = store.update("one", |it| {
            it.id = "other".to_string();
        });
        assert_eq!(outcome, Err(StoreError::InvalidField));
        assert!(store.get("one").is_ok());
    }

    #[test]
    fn every_store_error_sentence_is_fixed() {
        /* Payload free variants, proven sentence by sentence: no path, no
        record field, and no document text can exist in any of them. */
        let cases = [
            (
                StoreError::NoStateDirectory,
                "no state directory exists on this machine",
            ),
            (StoreError::NotFound, "no connection carries this id"),
            (
                StoreError::Corrupt,
                "the connections file is not readable as written",
            ),
            (StoreError::Full, "the connections file is at its bound"),
            (
                StoreError::InvalidField,
                "a connection field is empty or over its bound",
            ),
            (
                StoreError::Io,
                "the connections file could not be read or written",
            ),
        ];
        for (error, sentence) in cases {
            assert_eq!(error.to_string(), sentence);
        }
    }

    #[test]
    fn future_document_version_is_corrupt_and_blocks_writes() {
        let dir = TempDir::new();
        let text = format!(
            r#"{{"version":2,"connections":[{}]}}"#,
            record_json("one", "personal", "inference")
        );
        std::fs::write(dir.path().join(CONNECTIONS_FILE_NAME), text.clone()).expect("write");
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        assert_eq!(store.list().unwrap_err(), StoreError::Corrupt);
        assert_eq!(
            store.insert(record("two")).unwrap_err(),
            StoreError::Corrupt
        );
        let after = std::fs::read_to_string(dir.path().join(CONNECTIONS_FILE_NAME)).expect("read");
        assert_eq!(
            after, text,
            "the unknown version document must survive untouched"
        );
    }

    #[test]
    fn document_carries_version_and_no_secret_field() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        store.insert(record("one")).expect("insert");
        let text = std::fs::read_to_string(dir.path().join(CONNECTIONS_FILE_NAME)).expect("read");
        assert!(text.contains("\"version\":1"));
        assert!(!text.contains("secret"));
    }
}
