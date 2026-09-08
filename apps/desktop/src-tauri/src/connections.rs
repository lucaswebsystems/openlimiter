use std::fmt;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::fsx;
use crate::reader_registry::{reader_route, CredentialKind, ProviderId, ReaderId};

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

/// Version of the document this build writes.
///
/// Version 3 adds the one time Free account cap migration and durable pause
/// state. The migration ledger is internal and cannot be supplied by IPC.
pub const CONNECTIONS_DOCUMENT_VERSION: u64 = 3;

/// The version this build still reads, and migrates, and never writes.
pub const CONNECTIONS_DOCUMENT_VERSION_LEGACY: u64 = 1;
pub const CONNECTIONS_DOCUMENT_VERSION_PRE_CAP: u64 = 2;
const CAP_MIGRATION_VERSION: u8 = 1;

/// More connections than any person holds subscriptions; a bound, not a goal.
pub const MAX_CONNECTIONS: usize = 100;

/// Longest an id may be, mirroring `ACCOUNT_ID_PATTERN` in
/// `packages/core/src/types.ts:117`: `/^[a-z0-9][a-z0-9-]{0,63}$/u`.
pub const MAX_ID_CHARS: usize = 64;

/// Longest an account alias may be, in characters.
pub const MAX_ALIAS_CHARS: usize = 80;

/// The version 1 provider vocabulary, kept only so a legacy document can be
/// migrated. Version 2 records carry a `ProviderId`, which no string can widen.
const LEGACY_PROVIDER_IDS: [&str; 1] = ["OPENROUTER"];

/// The version 1 credential vocabulary, kept only for the migration below.
const LEGACY_KEY_KINDS: [&str; 2] = ["inference", "management"];

/// Highest consecutive failure count a stored record may claim. A counter, not
/// a clock: anything above this is a tampered document, not a bad week.
pub const MAX_CONSECUTIVE_FAILURES: u32 = 1_000_000;

/// Highest attempt generation a stored record may claim. One probe per second
/// for three hundred years would not reach it; a document that does was edited.
pub const MAX_ATTEMPT_GENERATION: u64 = 10_000_000_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PauseReason {
    PausedByPlan,
    PausedByUser,
    CredentialInvalid,
    ProviderUnavailable,
}

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
///
/// Three fields carry the attempt protocol. `attempt_generation` is bumped by
/// Rust before every request, so a completion that arrives from a webview that
/// has moved on is refused rather than believed. `last_attempt_at` says when we
/// last asked; `last_success_at` says when a read last completed all the way
/// through parsing, and for a refresh through the cache commit. A `2xx` moves
/// the first and never the second, which is the whole point of having two.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionRecord {
    pub id: String,
    pub provider_id: ProviderId,
    pub reader_id: ReaderId,
    pub credential_kind: CredentialKind,
    pub account_alias: String,
    /// The Codex account header value. It identifies an account but grants no
    /// access, so it belongs in this record rather than the credential store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_account_id: Option<String>,
    pub masked_label: String,
    pub created_at: u64,
    /// Rust owned base collection cadence. Zero means schedule exempt.
    /// Recomputed from `reader_id` on every read, so disk and IPC cannot lower
    /// it or turn a missing legacy field into one second polling.
    #[serde(default)]
    pub base_seconds: u64,
    /// Durable native schedule. Absent means immediately due for interval
    /// readers and means no schedule at all for event or explicit only sources.
    #[serde(default)]
    pub next_refresh_at: Option<u64>,
    #[serde(default)]
    pub last_attempt_at: Option<u64>,
    #[serde(default)]
    pub last_success_at: Option<u64>,
    #[serde(default)]
    pub attempt_generation: u64,
    /// The generation of the most recent attempt that Rust itself watched
    /// return a `2xx` WITH A BODY, and handed to the webview.
    ///
    /// This is the witness that makes a completion checkable. Without it, an
    /// attempt generation is only a number the webview was told, so a webview
    /// could learn it from an attempt that returned 401, or from one that
    /// returned nothing at all, and then close that attempt as a success. With
    /// it, Rust can answer the only question that matters: was there ever a
    /// body for the webview to have parsed?
    ///
    /// Cleared whenever an attempt does not deliver a body, so a witness can
    /// never outlive the attempt it belongs to.
    #[serde(default)]
    pub body_delivered_generation: Option<u64>,
    /// When a completion was last accepted, so the transition can be rated.
    #[serde(default)]
    pub last_completion_at: Option<u64>,
    #[serde(default)]
    pub ever_connected: bool,
    #[serde(default)]
    pub consecutive_failures: u32,
    pub status: String,
    #[serde(default)]
    pub legacy_grandfathered: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_reason: Option<PauseReason>,
}

impl ConnectionRecord {
    pub fn is_active(&self) -> bool {
        self.pause_reason.is_none()
    }
}

/// Account identifiers are intentionally absent from debug output because a
/// debug rendering can become a log line even though the field is not secret.
impl fmt::Debug for ConnectionRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let codex_account_id = self.codex_account_id.as_ref().map(|_| "[redacted]");
        formatter
            .debug_struct("ConnectionRecord")
            .field("id", &self.id)
            .field("provider_id", &self.provider_id)
            .field("reader_id", &self.reader_id)
            .field("credential_kind", &self.credential_kind)
            .field("account_alias", &self.account_alias)
            .field("codex_account_id", &codex_account_id)
            .field("masked_label", &self.masked_label)
            .field("created_at", &self.created_at)
            .field("base_seconds", &self.base_seconds)
            .field("next_refresh_at", &self.next_refresh_at)
            .field("last_attempt_at", &self.last_attempt_at)
            .field("last_success_at", &self.last_success_at)
            .field("attempt_generation", &self.attempt_generation)
            .field("body_delivered_generation", &self.body_delivered_generation)
            .field("last_completion_at", &self.last_completion_at)
            .field("ever_connected", &self.ever_connected)
            .field("consecutive_failures", &self.consecutive_failures)
            .field("status", &self.status)
            .field("legacy_grandfathered", &self.legacy_grandfathered)
            .field("pause_reason", &self.pause_reason)
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ConsumedLegacy {
    provider_id: ProviderId,
    stable_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CapMigrationV1 {
    version: u8,
    completed_at: u64,
    grandfathered_ids: Vec<String>,
    #[serde(default)]
    consumed: Vec<ConsumedLegacy>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectionsDocument {
    version: u64,
    connections: Vec<ConnectionRecord>,
    cap_migration_v1: CapMigrationV1,
}

#[derive(Deserialize)]
struct ConnectionsDocumentV2 {
    connections: Vec<ConnectionRecord>,
}

/// Just enough of any document to learn which shape the rest of it is.
///
/// Read first and separately, so a version this build does not know is refused
/// before its records are parsed as anything. `deny_unknown_fields` is
/// deliberately absent: the probe is meant to succeed on a document whose other
/// fields it has no opinion about.
#[derive(Deserialize)]
struct DocumentVersionProbe {
    version: u64,
}

/// One version 1 record, exactly as version 1 wrote it.
///
/// This shape exists only to be migrated. It is never constructed by this
/// build, never written, and every field of it is validated on the way through
/// the migration below, so a hand edited legacy document cannot smuggle a
/// provider, a credential kind, or a status past the enums.
#[derive(Deserialize)]
struct LegacyConnectionRecord {
    id: String,
    provider_id: String,
    account_alias: String,
    key_kind: String,
    masked_label: String,
    created_at: u64,
    #[serde(default)]
    last_test_at: Option<u64>,
    #[serde(default)]
    last_refresh_at: Option<u64>,
    status: String,
}

#[derive(Deserialize)]
struct LegacyConnectionsDocument {
    connections: Vec<LegacyConnectionRecord>,
}

/// The later of two optional instants, or whichever one exists, or neither.
fn later_of(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(only), None) | (None, Some(only)) => Some(only),
        (None, None) => None,
    }
}

/// Turn one version 1 record into a version 2 record, deterministically.
///
/// Deterministic means the same legacy record always produces the same version
/// 2 record, with no clock read and no invented value:
///
///   1. `id`, provider, alias, mask and creation time are preserved, and `id`
///      is the credential store's lookup key, so the secret stays reachable.
///   2. `key_kind` becomes the OpenRouter credential enum, and the reader that
///      credential routes to comes from `reader_route`, not from a guess.
///   3. `last_refresh_at` becomes `last_success_at`, because that field only
///      ever advanced on a refresh that came back in the 200 range.
///   4. `last_attempt_at` becomes the later of the old test and refresh stamps.
///   5. `ever_connected` is set when either old stamp exists.
///   6. `attempt_generation` and `consecutive_failures` start at zero: no
///      legacy document recorded either, and inventing a count would be worse
///      than starting a real one.
///
/// Anything outside the legacy vocabulary returns `Corrupt`, which blocks the
/// write path, so the file survives untouched instead of being rewritten as a
/// version 2 document that quietly dropped a record.
fn migrate_legacy_record(legacy: LegacyConnectionRecord) -> Result<ConnectionRecord, StoreError> {
    if !LEGACY_PROVIDER_IDS.contains(&legacy.provider_id.as_str()) {
        return Err(StoreError::Corrupt);
    }
    if !LEGACY_KEY_KINDS.contains(&legacy.key_kind.as_str()) {
        return Err(StoreError::Corrupt);
    }
    let provider_id = ProviderId::Openrouter;
    let credential_kind = match legacy.key_kind.as_str() {
        "inference" => CredentialKind::OpenrouterInferenceKey,
        "management" => CredentialKind::OpenrouterManagementKey,
        /* Unreachable: the vocabulary was checked above. Stated rather than
        unwrapped, because a panic here would take the whole store down. */
        _ => return Err(StoreError::Corrupt),
    };
    let route = reader_route(provider_id, credential_kind).map_err(|_| StoreError::Corrupt)?;
    let record = ConnectionRecord {
        id: legacy.id,
        provider_id,
        reader_id: route.reader_id,
        credential_kind,
        account_alias: legacy.account_alias,
        codex_account_id: None,
        masked_label: legacy.masked_label,
        created_at: legacy.created_at,
        base_seconds: route.reader_id.base_seconds(),
        next_refresh_at: None,
        last_attempt_at: later_of(legacy.last_test_at, legacy.last_refresh_at),
        last_success_at: legacy.last_refresh_at,
        attempt_generation: 0,
        /* No legacy document recorded either, and a witness cannot be invented:
        the first completion after a migration needs a real attempt. */
        body_delivered_generation: None,
        last_completion_at: None,
        ever_connected: legacy.last_test_at.is_some() || legacy.last_refresh_at.is_some(),
        consecutive_failures: 0,
        status: legacy.status,
        legacy_grandfathered: false,
        pause_reason: None,
    };
    validate_record(&record).map_err(|_| StoreError::Corrupt)?;
    Ok(record)
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
    /// Free already has the active account allowed for this provider.
    PlanCap,
    /// The connection is preserved but cannot perform work while paused.
    Paused,
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
            StoreError::PlanCap => "Pro unlocks more accounts. Free reads one per provider",
            StoreError::Paused => "the connection is paused and cannot perform work",
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

fn empty_document() -> ConnectionsDocument {
    ConnectionsDocument {
        version: CONNECTIONS_DOCUMENT_VERSION,
        connections: Vec::new(),
        cap_migration_v1: CapMigrationV1 {
            version: CAP_MIGRATION_VERSION,
            completed_at: now_epoch_ms().max(1),
            grandfathered_ids: Vec::new(),
            consumed: Vec::new(),
        },
    }
}

fn migrate_cap_document(
    mut connections: Vec<ConnectionRecord>,
) -> Result<ConnectionsDocument, StoreError> {
    if connections.len() > MAX_CONNECTIONS {
        return Err(StoreError::Corrupt);
    }
    let mut grandfathered_ids = Vec::with_capacity(connections.len());
    for record in &mut connections {
        record.base_seconds = record.reader_id.base_seconds();
        validate_record(record).map_err(|_| StoreError::Corrupt)?;
        if grandfathered_ids.contains(&record.id) {
            return Err(StoreError::Corrupt);
        }
        record.legacy_grandfathered = true;
        grandfathered_ids.push(record.id.clone());
    }
    grandfathered_ids.sort();
    let document = ConnectionsDocument {
        version: CONNECTIONS_DOCUMENT_VERSION,
        connections,
        cap_migration_v1: CapMigrationV1 {
            version: CAP_MIGRATION_VERSION,
            completed_at: now_epoch_ms().max(1),
            grandfathered_ids,
            consumed: Vec::new(),
        },
    };
    validate_document(&document)?;
    Ok(document)
}

fn validate_document(document: &ConnectionsDocument) -> Result<(), StoreError> {
    if document.version != CONNECTIONS_DOCUMENT_VERSION
        || document.cap_migration_v1.version != CAP_MIGRATION_VERSION
        || !valid_timestamp(document.cap_migration_v1.completed_at)
        || document.connections.len() > MAX_CONNECTIONS
        || document.cap_migration_v1.grandfathered_ids.len() > MAX_CONNECTIONS
        || document.cap_migration_v1.consumed.len() > MAX_CONNECTIONS
    {
        return Err(StoreError::Corrupt);
    }
    let mut connection_ids: Vec<&str> = Vec::with_capacity(document.connections.len());
    for record in &document.connections {
        validate_record(record).map_err(|_| StoreError::Corrupt)?;
        if connection_ids.contains(&record.id.as_str()) {
            return Err(StoreError::Corrupt);
        }
        connection_ids.push(&record.id);
        let in_ledger = document
            .cap_migration_v1
            .grandfathered_ids
            .contains(&record.id);
        let consumed = document
            .cap_migration_v1
            .consumed
            .iter()
            .any(|entry| entry.stable_id == record.id);
        if record.legacy_grandfathered != (in_ledger && !consumed) {
            return Err(StoreError::Corrupt);
        }
    }
    let mut ledger_ids: Vec<&str> = Vec::new();
    for id in &document.cap_migration_v1.grandfathered_ids {
        if !valid_id(id) || ledger_ids.contains(&id.as_str()) {
            return Err(StoreError::Corrupt);
        }
        ledger_ids.push(id);
    }
    let mut consumed_ids: Vec<&str> = Vec::new();
    for consumed in &document.cap_migration_v1.consumed {
        if !valid_id(&consumed.stable_id)
            || !document
                .cap_migration_v1
                .grandfathered_ids
                .contains(&consumed.stable_id)
            || consumed_ids.contains(&consumed.stable_id.as_str())
        {
            return Err(StoreError::Corrupt);
        }
        consumed_ids.push(&consumed.stable_id);
    }
    Ok(())
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

    fn load(&self) -> Result<ConnectionsDocument, StoreError> {
        let file = self.file()?;
        let Some(text) = fsx::bounded_read(&file) else {
            /* Missing is an empty store; unreadable and oversized also land
            here, and the write path below re reads before writing, so a
            document we cannot read is never silently replaced by an empty
            one: parsing what exists is attempted first. */
            return match std::fs::symlink_metadata(&file) {
                Ok(_) => Err(StoreError::Corrupt),
                Err(_) => Ok(empty_document()),
            };
        };
        /* The version is read first and on its own, so a shape this build does
        not know is refused before any record of it is parsed. A future version
        must NOT be accepted: saving it back would rewrite it as version 2, a
        silent downgrade of a shape written by a later build. Corrupt blocks
        reads AND writes, so the file survives. */
        let probe: DocumentVersionProbe =
            serde_json::from_str(&text).map_err(|_| StoreError::Corrupt)?;
        let mut document = match probe.version {
            CONNECTIONS_DOCUMENT_VERSION => {
                let document: ConnectionsDocument =
                    serde_json::from_str(&text).map_err(|_| StoreError::Corrupt)?;
                document
            }
            CONNECTIONS_DOCUMENT_VERSION_PRE_CAP => {
                let document: ConnectionsDocumentV2 =
                    serde_json::from_str(&text).map_err(|_| StoreError::Corrupt)?;
                migrate_cap_document(document.connections)?
            }
            CONNECTIONS_DOCUMENT_VERSION_LEGACY => {
                /* Migrated in memory only. Nothing is written here: version 2
                reaches the disk on the next successful mutation, so a person
                who opens the application and changes nothing still has the
                document their previous build wrote. */
                let document: LegacyConnectionsDocument =
                    serde_json::from_str(&text).map_err(|_| StoreError::Corrupt)?;
                if document.connections.len() > MAX_CONNECTIONS {
                    return Err(StoreError::Corrupt);
                }
                let mut migrated = Vec::with_capacity(document.connections.len());
                for legacy in document.connections {
                    migrated.push(migrate_legacy_record(legacy)?);
                }
                migrate_cap_document(migrated)?
            }
            _ => return Err(StoreError::Corrupt),
        };
        /* Cadence is policy, not stored input. This also hydrates every version
        2 record written before the field existed. */
        for record in &mut document.connections {
            record.base_seconds = record.reader_id.base_seconds();
        }
        validate_document(&document)?;
        if probe.version != CONNECTIONS_DOCUMENT_VERSION {
            self.save_document(&document)?;
            let reopened = fsx::bounded_read(&file).ok_or(StoreError::Io)?;
            let verified: ConnectionsDocument =
                serde_json::from_str(&reopened).map_err(|_| StoreError::Io)?;
            validate_document(&verified)?;
            return Ok(verified);
        }
        Ok(document)
    }

    fn save_document(&self, document: &ConnectionsDocument) -> Result<(), StoreError> {
        let directory = self
            .directory
            .as_ref()
            .ok_or(StoreError::NoStateDirectory)?;
        fsx::ensure_private_dir(directory)?;
        validate_document(document)?;
        let text = serde_json::to_string(document).map_err(|_| StoreError::Io)?;
        let round_trip: ConnectionsDocument =
            serde_json::from_str(&text).map_err(|_| StoreError::Io)?;
        validate_document(&round_trip)?;
        fsx::atomic_write(&self.file()?, &text)?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<ConnectionRecord>, StoreError> {
        let _held = self.guard.lock().map_err(|_| StoreError::Io)?;
        Ok(self.load()?.connections)
    }

    pub fn get(&self, id: &str) -> Result<ConnectionRecord, StoreError> {
        let _held = self.guard.lock().map_err(|_| StoreError::Io)?;
        self.load()?
            .connections
            .into_iter()
            .find(|record| record.id == id)
            .ok_or(StoreError::NotFound)
    }

    pub fn insert(&self, record: ConnectionRecord) -> Result<(), StoreError> {
        self.insert_for_plan(record, true).map(|_| ())
    }

    pub fn insert_for_plan(
        &self,
        mut record: ConnectionRecord,
        multi_account: bool,
    ) -> Result<ConnectionRecord, StoreError> {
        validate_record(&record)?;
        if record.legacy_grandfathered || record.pause_reason.is_some() {
            return Err(StoreError::InvalidField);
        }
        let _held = self.guard.lock().map_err(|_| StoreError::Io)?;
        let mut document = self.load()?;
        if document.connections.len() >= MAX_CONNECTIONS {
            return Err(StoreError::Full);
        }
        if document
            .connections
            .iter()
            .any(|existing| existing.id == record.id)
            || document
                .cap_migration_v1
                .grandfathered_ids
                .contains(&record.id)
        {
            return Err(StoreError::InvalidField);
        }
        if !multi_account {
            let active_same_provider = document
                .connections
                .iter()
                .any(|existing| existing.provider_id == record.provider_id && existing.is_active());
            /* Free is one ACTIVE account per provider, and a second one is
            refused rather than stored asleep. Storing it would leave a person
            holding a credential OpenLimiter will never read, in a row that
            explains itself as a plan pause, which reads as a punishment for
            something they were never told they could not do. Refusing says
            the same thing once, before anything is written, and leaves the
            keyring exactly as it was. Extras that already exist keep their
            paused row: those were added while the plan allowed them. */
            if active_same_provider {
                return Err(StoreError::PlanCap);
            }
        }
        document.connections.push(record.clone());
        self.save_document(&document)?;
        Ok(record)
    }

    pub fn remove(&self, id: &str) -> Result<(), StoreError> {
        let _held = self.guard.lock().map_err(|_| StoreError::Io)?;
        let mut document = self.load()?;
        let index = document
            .connections
            .iter()
            .position(|record| record.id == id)
            .ok_or(StoreError::NotFound)?;
        let removed = document.connections.remove(index);
        if removed.legacy_grandfathered
            && !document
                .cap_migration_v1
                .consumed
                .iter()
                .any(|entry| entry.stable_id == removed.id)
        {
            document.cap_migration_v1.consumed.push(ConsumedLegacy {
                provider_id: removed.provider_id,
                stable_id: removed.id,
            });
        }
        self.save_document(&document)
    }

    pub fn apply_plan(
        &self,
        multi_account: bool,
        keeper_ids: &[String],
    ) -> Result<Vec<ConnectionRecord>, StoreError> {
        if keeper_ids.len() > ProviderId::ALL.len() || keeper_ids.iter().any(|id| !valid_id(id)) {
            return Err(StoreError::InvalidField);
        }
        let _held = self.guard.lock().map_err(|_| StoreError::Io)?;
        let mut document = self.load()?;
        if !multi_account {
            let mut selected_providers = Vec::new();
            for keeper_id in keeper_ids {
                let keeper = document
                    .connections
                    .iter()
                    .find(|record| &record.id == keeper_id)
                    .filter(|record| {
                        !record.legacy_grandfathered
                            && matches!(record.pause_reason, None | Some(PauseReason::PausedByPlan))
                    })
                    .ok_or(StoreError::InvalidField)?;
                if selected_providers.contains(&keeper.provider_id) {
                    return Err(StoreError::InvalidField);
                }
                selected_providers.push(keeper.provider_id);
            }
        }
        let before = document.connections.clone();
        for provider in ProviderId::ALL {
            if multi_account {
                for record in document
                    .connections
                    .iter_mut()
                    .filter(|record| record.provider_id == provider)
                {
                    if record.pause_reason == Some(PauseReason::PausedByPlan) {
                        record.pause_reason = None;
                    }
                }
                continue;
            }
            let active_legacy = document.connections.iter().any(|record| {
                record.provider_id == provider && record.legacy_grandfathered && record.is_active()
            });
            let keeper = if active_legacy {
                None
            } else {
                keeper_ids
                    .iter()
                    .find(|id| {
                        document.connections.iter().any(|record| {
                            &record.id == *id
                                && record.provider_id == provider
                                && !record.legacy_grandfathered
                                && matches!(
                                    record.pause_reason,
                                    None | Some(PauseReason::PausedByPlan)
                                )
                        })
                    })
                    .cloned()
                    .or_else(|| {
                        let active = document
                            .connections
                            .iter()
                            .filter(|record| {
                                record.provider_id == provider
                                    && !record.legacy_grandfathered
                                    && record.is_active()
                            })
                            .collect::<Vec<_>>();
                        (active.len() == 1).then(|| active[0].id.clone())
                    })
                    .or_else(|| {
                        document
                            .connections
                            .iter()
                            .filter(|record| {
                                record.provider_id == provider
                                    && !record.legacy_grandfathered
                                    && matches!(
                                        record.pause_reason,
                                        None | Some(PauseReason::PausedByPlan)
                                    )
                            })
                            .min_by(|left, right| {
                                left.created_at
                                    .cmp(&right.created_at)
                                    .then_with(|| left.id.cmp(&right.id))
                            })
                            .map(|record| record.id.clone())
                    })
            };
            for record in document
                .connections
                .iter_mut()
                .filter(|record| record.provider_id == provider && !record.legacy_grandfathered)
            {
                if !matches!(record.pause_reason, None | Some(PauseReason::PausedByPlan)) {
                    continue;
                }
                record.pause_reason = if keeper.as_deref() == Some(record.id.as_str()) {
                    None
                } else {
                    Some(PauseReason::PausedByPlan)
                };
            }
        }
        if document.connections != before {
            self.save_document(&document)?;
        }
        Ok(document.connections)
    }

    pub fn set_user_paused(
        &self,
        id: &str,
        paused: bool,
        multi_account: bool,
    ) -> Result<ConnectionRecord, StoreError> {
        let _held = self.guard.lock().map_err(|_| StoreError::Io)?;
        let mut document = self.load()?;
        let index = document
            .connections
            .iter()
            .position(|record| record.id == id)
            .ok_or(StoreError::NotFound)?;
        if paused {
            document.connections[index].pause_reason = Some(PauseReason::PausedByUser);
        } else {
            if !matches!(
                document.connections[index].pause_reason,
                Some(PauseReason::PausedByUser) | Some(PauseReason::PausedByPlan)
            ) {
                return Err(StoreError::InvalidField);
            }
            if !multi_account {
                let provider = document.connections[index].provider_id;
                let another_active =
                    document
                        .connections
                        .iter()
                        .enumerate()
                        .any(|(other, record)| {
                            other != index && record.provider_id == provider && record.is_active()
                        });
                if another_active {
                    return Err(StoreError::PlanCap);
                }
            }
            document.connections[index].pause_reason = None;
        }
        let changed = document.connections[index].clone();
        self.save_document(&document)?;
        Ok(changed)
    }

    /// Decide and change one record inside a single held lock.
    ///
    /// `update` below takes a closure that cannot refuse, which forces any
    /// caller that must CHECK the record before writing it to read first. That
    /// is two lock acquisitions with a window between them, and in that window
    /// another caller can read the same record and reach the same decision, or
    /// a different operation can move the very field that was just checked.
    ///
    /// This takes a closure that can refuse. The check and the write happen
    /// under one lock, so a decision made about a record is applied to the
    /// record it was made about, or not at all. A refusal writes nothing: the
    /// document is only saved once the closure has said yes.
    ///
    /// `E` carries the caller's own failure vocabulary and must be able to
    /// represent a storage failure, so the caller sees one error type rather
    /// than a nest of them.
    pub fn compare_and_mutate<F, E>(&self, id: &str, decide: F) -> Result<ConnectionRecord, E>
    where
        F: FnOnce(&mut ConnectionRecord) -> Result<(), E>,
        E: From<StoreError>,
    {
        let _held = self.guard.lock().map_err(|_| E::from(StoreError::Io))?;
        let mut document = self.load().map_err(E::from)?;
        let record = document
            .connections
            .iter_mut()
            .find(|record| record.id == id)
            .ok_or_else(|| E::from(StoreError::NotFound))?;
        /* The decision, taken with the lock still held and the record in hand.
        A refusal returns before anything is validated or saved. */
        decide(record)?;
        let identity_kept = record.id == id;
        let changed = record.clone();
        validate_record(&changed).map_err(E::from)?;
        if !identity_kept {
            return Err(E::from(StoreError::InvalidField));
        }
        self.save_document(&document).map_err(E::from)?;
        Ok(changed)
    }

    /// Change one record in place and persist the whole document. The changed
    /// record is revalidated before anything touches the disk.
    ///
    /// For a mutation that needs no decision. Anything that must read the
    /// record before deciding whether to write it belongs in
    /// `compare_and_mutate` above, or it will read under one lock and write
    /// under another.
    pub fn update<F>(&self, id: &str, mutate: F) -> Result<ConnectionRecord, StoreError>
    where
        F: FnOnce(&mut ConnectionRecord),
    {
        let _held = self.guard.lock().map_err(|_| StoreError::Io)?;
        let mut document = self.load()?;
        let record = document
            .connections
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
        self.save_document(&document)?;
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

/// Whether this record's three closed identifiers agree with each other.
///
/// The enums alone stop a foreign word. They do not stop a CODEX record filed
/// with an OpenRouter management key, which is the confused deputy the audit
/// named: it would pair one provider's secret with another provider's address.
/// So the pairing is checked against the one routing function, and the record's
/// stored reader must be the reader that pairing actually routes to.
fn routing_agrees(record: &ConnectionRecord) -> bool {
    match reader_route(record.provider_id, record.credential_kind) {
        Ok(route) => route.reader_id == record.reader_id,
        Err(_) => false,
    }
}

pub(crate) fn validate_record(record: &ConnectionRecord) -> Result<(), StoreError> {
    let codex_account_id_valid = match record.provider_id {
        ProviderId::Codex => record
            .codex_account_id
            .as_deref()
            .is_none_or(crate::credentials::valid_codex_account_id),
        _ => record.codex_account_id.is_none(),
    };
    let valid = valid_id(&record.id)
        && routing_agrees(record)
        && codex_account_id_valid
        && CONNECTION_STATES.contains(&record.status.as_str())
        && valid_alias(&record.account_alias)
        && valid_masked_label(&record.masked_label)
        && valid_timestamp(record.created_at)
        && record.base_seconds == record.reader_id.base_seconds()
        && record.next_refresh_at.is_none_or(valid_timestamp)
        && record.last_attempt_at.is_none_or(valid_timestamp)
        && record.last_success_at.is_none_or(valid_timestamp)
        && record.attempt_generation <= MAX_ATTEMPT_GENERATION
        && record.consecutive_failures <= MAX_CONSECUTIVE_FAILURES
        && record.last_completion_at.is_none_or(valid_timestamp)
        /* A witness for a generation that has not happened yet is a tampered
        document, not a state this build can reach. */
        && record
            .body_delivered_generation
            .is_none_or(|generation| generation <= record.attempt_generation);
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
            provider_id: ProviderId::Openrouter,
            reader_id: ReaderId::OpenrouterKey,
            credential_kind: CredentialKind::OpenrouterInferenceKey,
            account_alias: "personal".to_string(),
            codex_account_id: None,
            masked_label: "sk-········cdef".to_string(),
            created_at: 1_770_000_000_000,
            base_seconds: ReaderId::OpenrouterKey.base_seconds(),
            next_refresh_at: None,
            last_attempt_at: None,
            last_success_at: None,
            attempt_generation: 0,
            body_delivered_generation: None,
            last_completion_at: None,
            ever_connected: false,
            consecutive_failures: 0,
            status: "READY_TO_ENABLE".to_string(),
            legacy_grandfathered: false,
            pause_reason: None,
        }
    }

    /// One version 2 record as JSON, for the tampering tests.
    fn record_json(id: &str, alias: &str, credential_kind: &str) -> String {
        let reader = if credential_kind == "openrouter_management_key" {
            "openrouter_credits"
        } else {
            "openrouter_key"
        };
        format!(
            concat!(
                r#"{{"id":"{}","provider_id":"openrouter","reader_id":"{}","#,
                r#""credential_kind":"{}","account_alias":"{}","#,
                r#""masked_label":"sk-········cdef","#,
                r#""created_at":1770000000000,"status":"CONNECTED"}}"#
            ),
            id, reader, credential_kind, alias
        )
    }

    /// One version 1 record as version 1 wrote it, for the migration tests.
    fn legacy_record_json(id: &str, kind: &str, test_at: &str, refresh_at: &str) -> String {
        format!(
            concat!(
                r#"{{"id":"{}","provider_id":"OPENROUTER","account_alias":"personal","#,
                r#""key_kind":"{}","masked_label":"sk-········cdef","#,
                r#""created_at":1770000000000,"last_test_at":{},"last_refresh_at":{},"#,
                r#""status":"CONNECTED"}}"#
            ),
            id, kind, test_at, refresh_at
        )
    }

    fn write_document(dir: &TempDir, records: &[String]) {
        let text = format!(
            r#"{{"version":{},"connections":[{}]}}"#,
            CONNECTIONS_DOCUMENT_VERSION_PRE_CAP,
            records.join(",")
        );
        std::fs::write(dir.path().join(CONNECTIONS_FILE_NAME), text).expect("write");
    }

    fn write_legacy_document(dir: &TempDir, records: &[String]) {
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
        assert_eq!(
            store.get("one").expect("get").provider_id,
            ProviderId::Openrouter
        );
        let updated = store
            .update("one", |it| {
                it.status = "CONNECTED".to_string();
                it.last_success_at = Some(1_770_000_100_000);
            })
            .expect("update");
        assert_eq!(updated.status, "CONNECTED");
        store.remove("one").expect("remove");
        assert_eq!(store.list().expect("list").len(), 1);
        assert_eq!(store.get("one"), Err(StoreError::NotFound));
    }

    #[test]
    fn connected_list_records_always_serialize_a_finite_trusted_base() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        let mut connected = record("connected");
        connected.status = "CONNECTED".to_string();
        store.insert(connected).expect("insert");
        let listed = store.list().expect("list");
        let wire = serde_json::to_value(&listed).expect("serializable");
        let base = wire[0]["base_seconds"]
            .as_u64()
            .expect("finite integer base");
        assert_eq!(base, 300);
        assert_ne!(base, 1);
    }

    #[test]
    fn a_version_two_record_without_cadence_gets_its_reader_default_on_read() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        write_document(
            &dir,
            &[record_json(
                "legacy-v2",
                "personal",
                "openrouter_inference_key",
            )],
        );
        let listed = store.list().expect("legacy version two remains readable");
        assert_eq!(listed[0].status, "CONNECTED");
        assert_eq!(listed[0].base_seconds, 300);
        assert_ne!(listed[0].base_seconds, 1);
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
        let mut oversized = record("two");
        oversized.account_alias = "a".repeat(MAX_ALIAS_CHARS + 1);
        assert_eq!(store.insert(oversized), Err(StoreError::InvalidField));
        let mut foreign_status = record("four");
        foreign_status.status = "TOTALLY_FINE".to_string();
        assert_eq!(store.insert(foreign_status), Err(StoreError::InvalidField));
        let mut naked_label = record("five");
        naked_label.masked_label = "sk-or-v1-full-secret".to_string();
        assert_eq!(store.insert(naked_label), Err(StoreError::InvalidField));
        let mut wild_generation = record("six");
        wild_generation.attempt_generation = MAX_ATTEMPT_GENERATION + 1;
        assert_eq!(store.insert(wild_generation), Err(StoreError::InvalidField));
        let mut wild_failures = record("seven");
        wild_failures.consecutive_failures = MAX_CONSECUTIVE_FAILURES + 1;
        assert_eq!(store.insert(wild_failures), Err(StoreError::InvalidField));
    }

    #[test]
    fn every_wrong_provider_and_credential_pairing_is_refused() {
        /* The endpoint confusion matrix at the record level: every provider
        paired with every credential kind, and only the five real pairings may
        be stored at all. A record that could be stored with a foreign
        credential is a record whose secret could be sent to a foreign host. */
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        let mut stored = 0usize;
        for (index, provider) in ProviderId::ALL.into_iter().enumerate() {
            for (inner, credential) in CredentialKind::ALL.into_iter().enumerate() {
                let id = format!("pair-{index}-{inner}");
                let route = reader_route(provider, credential);
                let mut candidate = record(&id);
                candidate.provider_id = provider;
                candidate.credential_kind = credential;
                candidate.reader_id = match route {
                    Ok(route) => route.reader_id,
                    /* A wrong pairing has no reader, so the record carries the
                    provider's own reader and is still refused: the refusal is
                    the pairing, not a mismatched third field. */
                    Err(_) => ReaderId::OpenrouterKey,
                };
                candidate.base_seconds = candidate.reader_id.base_seconds();
                let outcome = store.insert(candidate);
                if route.is_ok() {
                    assert!(outcome.is_ok(), "a real pairing must be storable");
                    stored += 1;
                } else {
                    assert_eq!(
                        outcome,
                        Err(StoreError::InvalidField),
                        "a foreign credential must never be storable"
                    );
                }
            }
        }
        assert_eq!(stored, 7);
        assert_eq!(store.list().expect("list").len(), 7);
    }

    #[test]
    fn a_record_whose_reader_does_not_match_its_route_is_refused() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        let mut crossed = record("one");
        /* An inference key filed against the credits reader: both identifiers
        are real, and the pairing is not. */
        crossed.reader_id = ReaderId::OpenrouterCredits;
        assert_eq!(store.insert(crossed), Err(StoreError::InvalidField));
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
            &[record_json(
                "abc-123",
                &oversized_alias,
                "openrouter_inference_key",
            )],
        );
        assert_eq!(store.list(), Err(StoreError::Corrupt));
        assert_eq!(store.insert(record("z9")), Err(StoreError::Corrupt));
    }

    #[test]
    fn tampered_hostile_id_is_corrupt_and_blocks_writes() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        write_document(
            &dir,
            &[record_json(
                "../../evil",
                "personal",
                "openrouter_inference_key",
            )],
        );
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
            &[record_json(
                "abc-123",
                "personal",
                "opencode_browser_session",
            )],
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
                record_json("abc-123", "personal", "openrouter_inference_key"),
                record_json("abc-123", "work", "openrouter_management_key"),
            ],
        );
        assert_eq!(store.list(), Err(StoreError::Corrupt));
    }

    #[test]
    fn a_valid_handwritten_document_loads() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        write_document(
            &dir,
            &[record_json(
                "abc-123",
                "personal",
                "openrouter_inference_key",
            )],
        );
        let listed = store.list().expect("valid document loads");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].provider_id, ProviderId::Openrouter);
        assert_eq!(listed[0].reader_id, ReaderId::OpenrouterKey);
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
                StoreError::PlanCap,
                "Pro unlocks more accounts. Free reads one per provider",
            ),
            (
                StoreError::Paused,
                "the connection is paused and cannot perform work",
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
            r#"{{"version":4,"connections":[{}]}}"#,
            record_json("one", "personal", "openrouter_inference_key")
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
        assert!(text.contains("\"version\":3"));
        assert!(text.contains("\"cap_migration_v1\""));
        assert!(!text.contains("secret"));
    }

    /* ------------------------------------------------ version 1 migration */

    #[test]
    fn version_one_migrates_without_changing_the_credential_lookup_id() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        write_legacy_document(
            &dir,
            &[
                legacy_record_json("abc-123", "inference", "1770000050000", "1770000090000"),
                legacy_record_json("def-456", "management", "null", "null"),
            ],
        );
        let listed = store.list().expect("a version 1 document is readable");
        assert_eq!(listed.len(), 2);

        let inference = &listed[0];
        /* The id is the credential store's key. It must be byte identical, or
        the secret becomes unreachable and the connection silently dies. */
        assert_eq!(inference.id, "abc-123");
        assert_eq!(inference.provider_id, ProviderId::Openrouter);
        assert_eq!(
            inference.credential_kind,
            CredentialKind::OpenrouterInferenceKey
        );
        assert_eq!(inference.reader_id, ReaderId::OpenrouterKey);
        assert_eq!(inference.masked_label, "sk-········cdef");
        assert_eq!(inference.created_at, 1_770_000_000_000);
        /* last_refresh_at became last_success_at, and last_attempt_at became
        the later of the two old stamps. */
        assert_eq!(inference.last_success_at, Some(1_770_000_090_000));
        assert_eq!(inference.last_attempt_at, Some(1_770_000_090_000));
        assert!(inference.ever_connected);
        assert_eq!(inference.attempt_generation, 0);
        assert_eq!(inference.consecutive_failures, 0);
        assert_eq!(inference.status, "CONNECTED");
        assert!(inference.legacy_grandfathered);

        let management = &listed[1];
        assert_eq!(
            management.credential_kind,
            CredentialKind::OpenrouterManagementKey
        );
        assert_eq!(management.reader_id, ReaderId::OpenrouterCredits);
        /* Neither old stamp existed, so nothing is invented and nothing claims
        this connection ever worked. */
        assert_eq!(management.last_success_at, None);
        assert_eq!(management.last_attempt_at, None);
        assert!(!management.ever_connected);
    }

    #[test]
    fn a_test_only_legacy_record_counts_as_ever_connected_but_not_as_a_success() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        write_legacy_document(
            &dir,
            &[legacy_record_json(
                "abc-123",
                "inference",
                "1770000050000",
                "null",
            )],
        );
        let listed = store.list().expect("list");
        assert_eq!(listed[0].last_attempt_at, Some(1_770_000_050_000));
        assert_eq!(listed[0].last_success_at, None);
        assert!(listed[0].ever_connected);
    }

    #[test]
    fn reading_a_version_one_document_commits_the_cap_migration() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        write_legacy_document(
            &dir,
            &[legacy_record_json("abc-123", "inference", "null", "null")],
        );
        store.list().expect("list");
        store.get("abc-123").expect("get");
        let after = std::fs::read_to_string(dir.path().join(CONNECTIONS_FILE_NAME)).expect("read");
        assert!(after.contains("\"version\":3"));
        assert!(after.contains("\"legacy_grandfathered\":true"));
        assert!(after.contains("\"grandfathered_ids\":[\"abc-123\"]"));
    }

    #[test]
    fn a_successful_mutation_keeps_version_three() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        write_legacy_document(
            &dir,
            &[legacy_record_json("abc-123", "inference", "null", "null")],
        );
        store
            .update("abc-123", |it| it.status = "CONNECTED".to_string())
            .expect("update");
        let text = std::fs::read_to_string(dir.path().join(CONNECTIONS_FILE_NAME)).expect("read");
        assert!(text.contains("\"version\":3"));
        assert!(text.contains("\"credential_kind\":\"openrouter_inference_key\""));
        assert!(text.contains("\"reader_id\":\"openrouter_key\""));
        assert!(!text.contains("key_kind"));
        /* And the id, which is the secret's lookup key, is untouched. */
        assert!(text.contains("\"id\":\"abc-123\""));
    }

    #[test]
    fn a_legacy_document_with_an_unknown_enum_value_is_corrupt_and_survives() {
        for hostile in [
            legacy_record_json("abc-123", "browser_cookie", "null", "null"),
            legacy_record_json("abc-123", "inference", "null", "null")
                .replace("OPENROUTER", "EVILCORP"),
            legacy_record_json("abc-123", "inference", "null", "null")
                .replace("CONNECTED", "TOTALLY_FINE"),
        ] {
            let dir = TempDir::new();
            let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
            write_legacy_document(&dir, &[hostile]);
            let before =
                std::fs::read_to_string(dir.path().join(CONNECTIONS_FILE_NAME)).expect("read");
            assert_eq!(store.list(), Err(StoreError::Corrupt));
            assert_eq!(store.insert(record("z9")), Err(StoreError::Corrupt));
            let after =
                std::fs::read_to_string(dir.path().join(CONNECTIONS_FILE_NAME)).expect("read");
            assert_eq!(after, before, "a refused document must survive untouched");
        }
    }

    #[test]
    fn a_version_two_record_with_legacy_fields_only_is_refused() {
        /* A version 2 header over version 1 records: the shape and the version
        disagree, which is corrupt rather than something to reconcile. */
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        let text = format!(
            r#"{{"version":2,"connections":[{}]}}"#,
            legacy_record_json("abc-123", "inference", "null", "null")
        );
        std::fs::write(dir.path().join(CONNECTIONS_FILE_NAME), &text).expect("write");
        assert_eq!(store.list(), Err(StoreError::Corrupt));
    }

    #[test]
    fn compare_and_mutate_holds_one_lock_across_the_decision_and_the_write() {
        /*
         * What this proves, exactly, and what it does not.
         *
         * It proves the PRIMITIVE really holds one lock across the decision and
         * the write: while the closure runs, another thread's read of the same
         * store cannot complete. That is the property `complete_attempt_core`
         * relies on, and without it the structural test that merely checks the
         * caller uses this function would be cosmetic.
         *
         * It does not catch the original bug on its own, because the bug lived
         * in the CALLER, which read through `get` and wrote through `update`.
         * The two together are what make the guarantee deterministic: this test
         * says the primitive is atomic, and the structural test in commands.rs
         * says the completion goes through it and never through a separate read.
         */
        let dir = TempDir::new();
        let store = std::sync::Arc::new(ConnectionsStore::at(Some(dir.path().to_path_buf())));
        store.insert(record("abc-123")).expect("insert");

        let reader_finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader_started = std::sync::Arc::new(std::sync::Barrier::new(2));

        let observed_inside: std::sync::Arc<std::sync::atomic::AtomicBool> =
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

        let outcome = {
            let store_for_reader = std::sync::Arc::clone(&store);
            let finished = std::sync::Arc::clone(&reader_finished);
            let started = std::sync::Arc::clone(&reader_started);
            let inside = std::sync::Arc::clone(&observed_inside);
            let reader = std::thread::spawn(move || {
                started.wait();
                let _ = store_for_reader.get("abc-123");
                finished.store(true, std::sync::atomic::Ordering::SeqCst);
            });
            let result = store.compare_and_mutate::<_, StoreError>("abc-123", |record| {
                /* Release the reader and give it every chance to finish. */
                reader_started.wait();
                std::thread::sleep(std::time::Duration::from_millis(150));
                inside.store(
                    !reader_finished.load(std::sync::atomic::Ordering::SeqCst),
                    std::sync::atomic::Ordering::SeqCst,
                );
                record.status = "CONNECTED".to_string();
                Ok(())
            });
            reader.join().expect("the reader did not panic");
            result
        };

        assert!(outcome.is_ok());
        assert!(
            observed_inside.load(std::sync::atomic::Ordering::SeqCst),
            "another reader completed while the decision was still being made, so the \
             decision and the write it authorises do not share one lock"
        );
        assert_eq!(store.get("abc-123").expect("get").status, "CONNECTED");
    }

    #[test]
    fn a_refused_decision_writes_nothing() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        store.insert(record("abc-123")).expect("insert");
        let outcome = store.compare_and_mutate::<_, StoreError>("abc-123", |record| {
            record.status = "CONNECTED".to_string();
            Err(StoreError::NotFound)
        });
        assert_eq!(outcome.map(|_| ()), Err(StoreError::NotFound));
        assert_eq!(
            store.get("abc-123").expect("get").status,
            "READY_TO_ENABLE",
            "a refusal must leave the record exactly as it was"
        );
    }

    #[test]
    fn free_insertion_refuses_a_second_account_and_stores_nothing() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        let first = store
            .insert_for_plan(record("first"), false)
            .expect("first account");
        assert!(first.is_active());
        assert_eq!(
            store.insert_for_plan(record("second"), false).map(|_| ()),
            Err(StoreError::PlanCap)
        );
        assert_eq!(store.list().expect("the stored list").len(), 1);
        assert_eq!(store.get("second"), Err(StoreError::NotFound));
    }

    #[test]
    fn a_second_account_lands_active_while_the_plan_allows_it() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        store
            .insert_for_plan(record("first"), true)
            .expect("first account");
        let second = store
            .insert_for_plan(record("second"), true)
            .expect("second account");
        assert!(second.is_active());
        /* And when the entitlement lapses, that extra is paused rather than
        removed: nothing a person connected is ever deleted by a plan. */
        store.apply_plan(false, &[]).expect("the downgrade");
        assert!(store.get("first").expect("first").is_active());
        assert_eq!(
            store.get("second").expect("second").pause_reason,
            Some(PauseReason::PausedByPlan)
        );
    }

    #[test]
    fn a_grandfathered_account_survives_the_downgrade_beside_the_keeper() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        let mut legacy = record("legacy-one");
        legacy.created_at = 1_770_000_000_000;
        let mut also_legacy = record("legacy-two");
        also_legacy.created_at = 1_770_000_000_100;
        let migrated = migrate_cap_document(vec![legacy, also_legacy]).expect("the one time flag");
        store
            .save_document(&migrated)
            .expect("the migrated document");

        store.apply_plan(false, &[]).expect("the downgrade");
        assert!(store.get("legacy-one").expect("legacy one").is_active());
        assert!(store.get("legacy-two").expect("legacy two").is_active());
        assert!(
            store
                .get("legacy-two")
                .expect("legacy two")
                .legacy_grandfathered
        );

        /* Grandfathering covers what was already there, never a new account.
        A third one on the same provider is refused like any other second. */
        assert_eq!(
            store.insert_for_plan(record("new-one"), false).map(|_| ()),
            Err(StoreError::PlanCap)
        );
    }

    #[test]
    fn downgrade_uses_oldest_then_stable_id_and_never_deletes() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        let mut newer = record("z-account");
        newer.created_at = 1_770_000_000_100;
        let mut oldest_b = record("b-account");
        oldest_b.created_at = 1_770_000_000_000;
        let mut oldest_a = record("a-account");
        oldest_a.created_at = 1_770_000_000_000;
        store.insert_for_plan(newer, true).unwrap();
        store.insert_for_plan(oldest_b, true).unwrap();
        store.insert_for_plan(oldest_a, true).unwrap();
        let changed = store.apply_plan(false, &[]).unwrap();
        assert_eq!(changed.len(), 3);
        assert!(changed
            .iter()
            .find(|record| record.id == "a-account")
            .unwrap()
            .is_active());
        assert!(changed
            .iter()
            .filter(|record| record.id != "a-account")
            .all(|record| record.pause_reason == Some(PauseReason::PausedByPlan)));
    }

    #[test]
    fn a_chosen_keeper_survives_later_automatic_reconciliation() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        let mut oldest = record("oldest");
        oldest.created_at = 1_700_000_000_000;
        let mut chosen = record("chosen");
        chosen.created_at = 1_800_000_000_000;
        store.insert_for_plan(oldest, true).unwrap();
        store.insert_for_plan(chosen, true).unwrap();

        store
            .apply_plan(false, &["chosen".to_string()])
            .expect("explicit keeper");
        store
            .apply_plan(false, &[])
            .expect("automatic reconciliation");
        assert!(store.get("chosen").unwrap().is_active());
        assert_eq!(
            store.get("oldest").unwrap().pause_reason,
            Some(PauseReason::PausedByPlan)
        );
    }

    #[test]
    fn downgrade_refuses_two_keepers_for_one_provider() {
        let dir = TempDir::new();
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        store.insert_for_plan(record("first"), true).unwrap();
        store.insert_for_plan(record("second"), true).unwrap();

        assert_eq!(
            store.apply_plan(false, &["first".to_string(), "second".to_string()]),
            Err(StoreError::InvalidField)
        );
        assert!(store.get("first").unwrap().is_active());
        assert!(store.get("second").unwrap().is_active());
    }

    #[test]
    fn deleting_a_legacy_record_consumes_its_exception() {
        let dir = TempDir::new();
        write_legacy_document(
            &dir,
            &[legacy_record_json("abc-123", "inference", "null", "null")],
        );
        let store = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        assert!(store.get("abc-123").unwrap().legacy_grandfathered);
        store.remove("abc-123").unwrap();
        let mut replacement = record("abc-123");
        replacement.legacy_grandfathered = true;
        assert_eq!(
            store.insert_for_plan(replacement, true),
            Err(StoreError::InvalidField)
        );
        let text = std::fs::read_to_string(dir.path().join(CONNECTIONS_FILE_NAME)).unwrap();
        assert!(text.contains("\"stable_id\":\"abc-123\""));
    }

    #[test]
    fn later_of_picks_the_later_instant_or_the_only_one() {
        assert_eq!(later_of(Some(2), Some(1)), Some(2));
        assert_eq!(later_of(Some(1), Some(2)), Some(2));
        assert_eq!(later_of(Some(7), None), Some(7));
        assert_eq!(later_of(None, Some(7)), Some(7));
        assert_eq!(later_of(None, None), None);
    }
}
