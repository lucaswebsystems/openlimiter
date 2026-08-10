use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroizing;

use crate::cache_write::{CacheWriteBegin, CacheWriteError, CacheWriter, MAX_JSON_FILE_BYTES};
use crate::claude_detect::{self, LocalToolDetection};
use crate::connections::{
    now_epoch_ms, valid_alias, validate_record, ConnectionRecord, ConnectionsStore, StoreError,
    CONNECTION_STATES, MAX_ID_CHARS,
};
use crate::credentials::{mask_label, CredentialError, KeyringStore, SecretStore};
use crate::net::{
    fetch_endpoint, EndpointOutcome, NetError, ProviderEndpoint, ReqwestTransport, Transport,
};

/// The connection command surface: one Tauri command per verb, serde structs
/// in and out, and one closed failure enum whose `Display` is a fixed
/// sentence per variant, so nothing dynamic can ride an error into the
/// webview or a log.
///
/// A secret is accepted by exactly one command, `connect_provider`, and is
/// zeroized after it lands in the operating system credential store. No
/// command returns a secret, so no readback path exists.
///
/// No policy lives here. Backoff, due times, state transitions, and merge
/// semantics belong to `packages/core` in the webview; these commands move
/// bytes, stamp facts, and enforce bounds.
/// The event the metronome emits to wake the webview's collector.
pub const COLLECTOR_TICK_EVENT: &str = "collector-tick";

/// How often the metronome ticks. The tick carries no policy: the webview
/// decides what, if anything, is due.
pub const COLLECTOR_TICK_INTERVAL_SECONDS: u64 = 60;

/// What a tick carries: a sequence number, so the webview can observe a
/// stalled or restarted metronome. Nothing else.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct CollectorTick {
    pub seq: u64,
}

/// Start the metronome: a tokio interval task that emits `collector-tick` to
/// the webview for as long as the process runs. Rust owns the clock because
/// hidden webview timers are throttled by the operating system; the webview
/// owns every decision about what a tick means.
pub fn spawn_collector_metronome(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval =
            tokio::time::interval(Duration::from_secs(COLLECTOR_TICK_INTERVAL_SECONDS));
        /* A machine waking from sleep gets one prompt tick, not a burst of
        every tick it slept through. */
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut seq: u64 = 0;
        loop {
            interval.tick().await;
            seq = seq.wrapping_add(1);
            let _ = app.emit(COLLECTOR_TICK_EVENT, CollectorTick { seq });
        }
    });
}

/// Every way a connection command can fail, closed and payload free. The
/// serialized form is `{"kind":"..."}` so the webview can match on it, and
/// the `Display` sentence is a constant per variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CommandFailure {
    InvalidInput,
    NotFound,
    Full,
    Corrupt,
    Storage,
    CredentialStore,
    Timeout,
    Connect,
    Protocol,
    TooLarge,
    Busy,
    StaleGeneration,
    NotJson,
}

impl CommandFailure {
    /// Every variant, for the redaction test that formats them all. The
    /// product itself never needs the list.
    #[cfg(test)]
    pub const ALL: [CommandFailure; 13] = [
        CommandFailure::InvalidInput,
        CommandFailure::NotFound,
        CommandFailure::Full,
        CommandFailure::Corrupt,
        CommandFailure::Storage,
        CommandFailure::CredentialStore,
        CommandFailure::Timeout,
        CommandFailure::Connect,
        CommandFailure::Protocol,
        CommandFailure::TooLarge,
        CommandFailure::Busy,
        CommandFailure::StaleGeneration,
        CommandFailure::NotJson,
    ];
}

impl fmt::Display for CommandFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sentence = match self {
            CommandFailure::InvalidInput => "the request is missing or over a bound",
            CommandFailure::NotFound => "no connection carries this id",
            CommandFailure::Full => "the connections file is at its bound",
            CommandFailure::Corrupt => "a state file is not readable as written",
            CommandFailure::Storage => "a state file could not be read or written",
            CommandFailure::CredentialStore => "the system credential store refused the operation",
            CommandFailure::Timeout => "the provider did not answer within the time allowed",
            CommandFailure::Connect => "the provider could not be reached",
            CommandFailure::Protocol => {
                "the provider answered in a way this application does not speak"
            }
            CommandFailure::TooLarge => "a document is over the bound every reader enforces",
            CommandFailure::Busy => "the cache lock stayed busy through every attempt",
            CommandFailure::StaleGeneration => {
                "this write session is no longer current and was refused"
            }
            CommandFailure::NotJson => "the cache text is not a JSON document",
        };
        formatter.write_str(sentence)
    }
}

impl From<NetError> for CommandFailure {
    fn from(error: NetError) -> Self {
        match error {
            NetError::Timeout => CommandFailure::Timeout,
            NetError::Connect => CommandFailure::Connect,
            NetError::Protocol => CommandFailure::Protocol,
            NetError::TooLarge => CommandFailure::TooLarge,
        }
    }
}

impl From<CredentialError> for CommandFailure {
    fn from(error: CredentialError) -> Self {
        match error {
            CredentialError::NotFound => CommandFailure::NotFound,
            CredentialError::Store => CommandFailure::CredentialStore,
        }
    }
}

impl From<StoreError> for CommandFailure {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::NoStateDirectory | StoreError::Io => CommandFailure::Storage,
            StoreError::NotFound => CommandFailure::NotFound,
            StoreError::Corrupt => CommandFailure::Corrupt,
            StoreError::Full => CommandFailure::Full,
            StoreError::InvalidField => CommandFailure::InvalidInput,
        }
    }
}

impl From<CacheWriteError> for CommandFailure {
    fn from(error: CacheWriteError) -> Self {
        match error {
            CacheWriteError::NoStateDirectory | CacheWriteError::Io => CommandFailure::Storage,
            CacheWriteError::Busy => CommandFailure::Busy,
            CacheWriteError::StaleGeneration => CommandFailure::StaleGeneration,
            CacheWriteError::TooLarge => CommandFailure::TooLarge,
            CacheWriteError::NotJson => CommandFailure::NotJson,
        }
    }
}

/// Largest secret `connect_provider` will accept, in bytes. Real provider
/// keys are under two hundred bytes; four kibibytes is generosity, not need.
pub const MAX_SECRET_BYTES: usize = 4_096;

/// Why explicit caps sit at the top of every core function although Tauri
/// carries the request first: Tauri's IPC deserializes the whole payload
/// before a command body ever runs, and its transport ceiling is large,
/// version dependent, and not a contract. So the first allocation is the
/// framework's and beyond reach; what these caps bound is everything AFTER
/// the boundary. Nothing oversized is cloned, masked, written to a state
/// file, handed to the credential store, or allowed near the cache lock.
fn capped_connection_id(connection_id: &str) -> Result<(), CommandFailure> {
    if connection_id.chars().count() > MAX_ID_CHARS {
        return Err(CommandFailure::InvalidInput);
    }
    Ok(())
}

/// What `connect_provider` accepts. The secret enters Rust here and nowhere
/// else, and the caller states the record's starting status because the state
/// vocabulary belongs to `packages/core/src/connection-state.ts`, not here.
#[derive(Deserialize)]
pub struct ConnectProviderInput {
    pub provider_id: String,
    pub account_alias: String,
    pub key_kind: String,
    pub status: String,
    pub secret: String,
}

#[derive(Deserialize)]
pub struct ProbeInput {
    pub connection_id: String,
    pub endpoint: ProviderEndpoint,
}

#[derive(Deserialize)]
pub struct DisconnectInput {
    pub connection_id: String,
}

#[derive(Deserialize)]
pub struct UpdateConnectionInput {
    pub connection_id: String,
    #[serde(default)]
    pub account_alias: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Deserialize)]
pub struct CacheCommitInput {
    pub text: String,
    pub generation: u64,
}

/// Which fact a successful probe stamps onto the record.
#[derive(Clone, Copy)]
enum ProbeStamp {
    Test,
    Refresh,
}

pub(crate) fn connect_core(
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    input: ConnectProviderInput,
) -> Result<ConnectionRecord, CommandFailure> {
    let ConnectProviderInput {
        provider_id,
        account_alias,
        key_kind,
        status,
        secret,
    } = input;
    /* The secret is moved into a zeroizing wrapper before anything can fail,
    so every return path below scrubs it, including the rejections. */
    let secret = Zeroizing::new(secret);
    /* Caps first, before anything is cloned, masked, or stored: see the
    boundary note at `capped_connection_id`. */
    if secret.len() > MAX_SECRET_BYTES {
        return Err(CommandFailure::InvalidInput);
    }
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return Err(CommandFailure::InvalidInput);
    }
    let record = ConnectionRecord {
        id: uuid::Uuid::new_v4().to_string(),
        provider_id,
        account_alias,
        key_kind,
        masked_label: mask_label(trimmed),
        created_at: now_epoch_ms(),
        last_test_at: None,
        last_refresh_at: None,
        status,
    };
    /* The whole record is validated BEFORE the secret touches the credential
    store, so a request with a foreign provider, an unknown kind, an unknown
    status, or an oversized alias stores nothing anywhere. */
    validate_record(&record)?;
    secrets.store_secret(&record.id, trimmed)?;
    if let Err(error) = connections.insert(record.clone()) {
        /* The record never landed, so the stored secret would be an orphan
        nothing can ever reach. Best effort removal, then the real error. */
        let _ = secrets.delete_secret(&record.id);
        return Err(error.into());
    }
    Ok(record)
}

async fn probe_core<T: Transport>(
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    transport: &T,
    input: ProbeInput,
    stamp: ProbeStamp,
) -> Result<EndpointOutcome, CommandFailure> {
    capped_connection_id(&input.connection_id)?;
    let record = connections.get(&input.connection_id)?;
    /* The secret is read inside this privileged call, used for one request,
    and dropped. It is never part of the return value. */
    let secret = secrets.read_secret(&record.id)?;
    let outcome = fetch_endpoint(transport, input.endpoint, &secret).await?;
    if (200..=299).contains(&outcome.status) {
        let at = now_epoch_ms();
        connections.update(&record.id, |it| match stamp {
            ProbeStamp::Test => it.last_test_at = Some(at),
            ProbeStamp::Refresh => it.last_refresh_at = Some(at),
        })?;
    }
    Ok(outcome)
}

pub(crate) async fn test_core<T: Transport>(
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    transport: &T,
    input: ProbeInput,
) -> Result<EndpointOutcome, CommandFailure> {
    probe_core(connections, secrets, transport, input, ProbeStamp::Test).await
}

pub(crate) async fn refresh_core<T: Transport>(
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    transport: &T,
    input: ProbeInput,
) -> Result<EndpointOutcome, CommandFailure> {
    probe_core(connections, secrets, transport, input, ProbeStamp::Refresh).await
}

pub(crate) fn disconnect_core(
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    input: DisconnectInput,
) -> Result<(), CommandFailure> {
    capped_connection_id(&input.connection_id)?;
    /* The secret goes first: a record without a secret is a reconnect away
    from working, a secret without a record is unreachable forever. A secret
    already gone is fine; anything else stops before the record is touched. */
    match secrets.delete_secret(&input.connection_id) {
        Ok(()) | Err(CredentialError::NotFound) => {}
        Err(error) => return Err(error.into()),
    }
    connections.remove(&input.connection_id)?;
    Ok(())
}

pub(crate) fn update_core(
    connections: &ConnectionsStore,
    input: UpdateConnectionInput,
) -> Result<ConnectionRecord, CommandFailure> {
    /* Caps and vocabulary first, before the store is even opened: see the
    boundary note at `capped_connection_id`. */
    capped_connection_id(&input.connection_id)?;
    if let Some(account_alias) = &input.account_alias {
        if !valid_alias(account_alias) {
            return Err(CommandFailure::InvalidInput);
        }
    }
    if let Some(status) = &input.status {
        if !CONNECTION_STATES.contains(&status.as_str()) {
            return Err(CommandFailure::InvalidInput);
        }
    }
    let updated = connections.update(&input.connection_id, |it| {
        if let Some(account_alias) = input.account_alias {
            it.account_alias = account_alias;
        }
        if let Some(status) = input.status {
            it.status = status;
        }
    })?;
    Ok(updated)
}

#[tauri::command]
pub async fn connect_provider(
    connections: State<'_, ConnectionsStore>,
    secrets: State<'_, KeyringStore>,
    input: ConnectProviderInput,
) -> Result<ConnectionRecord, CommandFailure> {
    connect_core(&connections, &*secrets, input)
}

#[tauri::command]
pub async fn test_provider(
    connections: State<'_, ConnectionsStore>,
    secrets: State<'_, KeyringStore>,
    transport: State<'_, ReqwestTransport>,
    input: ProbeInput,
) -> Result<EndpointOutcome, CommandFailure> {
    test_core(&connections, &*secrets, &*transport, input).await
}

#[tauri::command]
pub async fn refresh_provider(
    connections: State<'_, ConnectionsStore>,
    secrets: State<'_, KeyringStore>,
    transport: State<'_, ReqwestTransport>,
    input: ProbeInput,
) -> Result<EndpointOutcome, CommandFailure> {
    refresh_core(&connections, &*secrets, &*transport, input).await
}

#[tauri::command]
pub async fn disconnect_provider(
    connections: State<'_, ConnectionsStore>,
    secrets: State<'_, KeyringStore>,
    input: DisconnectInput,
) -> Result<(), CommandFailure> {
    disconnect_core(&connections, &*secrets, input)
}

#[tauri::command]
pub async fn list_connections(
    connections: State<'_, ConnectionsStore>,
) -> Result<Vec<ConnectionRecord>, CommandFailure> {
    Ok(connections.list()?)
}

#[tauri::command]
pub async fn update_connection(
    connections: State<'_, ConnectionsStore>,
    input: UpdateConnectionInput,
) -> Result<ConnectionRecord, CommandFailure> {
    update_core(&connections, input)
}

#[tauri::command]
pub fn detect_local_tools() -> LocalToolDetection {
    claude_detect::detect()
}

#[tauri::command]
pub async fn cache_begin_write(
    writer: State<'_, Arc<CacheWriter>>,
) -> Result<CacheWriteBegin, CommandFailure> {
    let writer = Arc::clone(&writer);
    /* The lock protocol can sleep through its bounded backoff, so it runs on
    the blocking pool rather than on the event loop. */
    let begun = tauri::async_runtime::spawn_blocking(move || writer.begin())
        .await
        .map_err(|_| CommandFailure::Storage)??;
    Ok(begun)
}

/// The commit with its boundary cap in front, testable without a runtime.
pub(crate) fn cache_commit_core(
    writer: &CacheWriter,
    text: &str,
    generation: u64,
) -> Result<(), CommandFailure> {
    /* Cap before the handshake: an oversized text is refused before any lock
    work, session lookup, or disk write. See the boundary note at
    `capped_connection_id` for why this exists although Tauri has already
    carried the payload once. */
    if text.len() as u64 > MAX_JSON_FILE_BYTES {
        return Err(CommandFailure::TooLarge);
    }
    writer.commit(text, generation)?;
    Ok(())
}

#[tauri::command]
pub async fn cache_commit_write(
    writer: State<'_, Arc<CacheWriter>>,
    input: CacheCommitInput,
) -> Result<(), CommandFailure> {
    let writer = Arc::clone(&writer);
    let CacheCommitInput { text, generation } = input;
    tauri::async_runtime::spawn_blocking(move || cache_commit_core(&writer, &text, generation))
        .await
        .map_err(|_| CommandFailure::Storage)??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{InMemorySecrets, RecordingTransport, TempDir};

    const SECRET_MARKER: &str = "SECRET-MARKER-4f9a-do-not-echo-1234";
    const HEADER_MARKER: &str = "Bearer SECRET-MARKER-4f9a-do-not-echo-1234";
    const BODY_MARKER: &str = "BODY-MARKER-not-for-errors";
    const URL_MARKER: &str = "https://openrouter.ai/api/v1/key";

    fn stores(dir: &TempDir) -> (ConnectionsStore, InMemorySecrets) {
        (
            ConnectionsStore::at(Some(dir.path().to_path_buf())),
            InMemorySecrets::new(),
        )
    }

    fn connect_input() -> ConnectProviderInput {
        ConnectProviderInput {
            provider_id: "OPENROUTER".to_string(),
            account_alias: "personal".to_string(),
            key_kind: "inference".to_string(),
            status: "READY_TO_ENABLE".to_string(),
            secret: format!("  {SECRET_MARKER}  "),
        }
    }

    #[test]
    fn oversized_secret_is_rejected_before_storage() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let mut input = connect_input();
        input.secret = "x".repeat(MAX_SECRET_BYTES + 1);
        assert_eq!(
            connect_core(&connections, &secrets, input).map(|_| ()),
            Err(CommandFailure::InvalidInput)
        );
        assert_eq!(secrets.stored_count(), 0, "nothing reached the store");
        assert_eq!(connections.list().expect("list").len(), 0);
    }

    #[test]
    fn oversized_alias_is_rejected_before_storage() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let mut input = connect_input();
        input.account_alias = "a".repeat(crate::connections::MAX_ALIAS_CHARS + 1);
        assert_eq!(
            connect_core(&connections, &secrets, input).map(|_| ()),
            Err(CommandFailure::InvalidInput)
        );
        assert_eq!(secrets.stored_count(), 0, "nothing reached the store");
    }

    #[test]
    fn foreign_provider_is_rejected_before_storage() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let mut input = connect_input();
        input.provider_id = "EVILCORP".to_string();
        assert_eq!(
            connect_core(&connections, &secrets, input).map(|_| ()),
            Err(CommandFailure::InvalidInput)
        );
        assert_eq!(secrets.stored_count(), 0, "nothing reached the store");
    }

    #[tokio::test]
    async fn oversized_connection_id_is_rejected_before_lookup() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
        let outcome = test_core(
            &connections,
            &secrets,
            &transport,
            ProbeInput {
                connection_id: "a".repeat(crate::connections::MAX_ID_CHARS + 1),
                endpoint: ProviderEndpoint::OpenrouterKey,
            },
        )
        .await;
        assert_eq!(outcome.map(|_| ()), Err(CommandFailure::InvalidInput));
        assert_eq!(transport.recorded_urls().len(), 0, "nothing was fetched");
    }

    #[test]
    fn oversized_cache_text_is_rejected_at_the_boundary() {
        let dir = TempDir::new();
        let writer = CacheWriter::at(Some(dir.path().to_path_buf()));
        let oversized = "x".repeat((MAX_JSON_FILE_BYTES + 1) as usize);
        /* TooLarge rather than StaleGeneration, although no session exists:
        the proof that the cap runs before any session or lock logic. */
        assert_eq!(
            cache_commit_core(&writer, &oversized, 1),
            Err(CommandFailure::TooLarge)
        );
    }

    #[test]
    fn connect_stores_the_secret_and_returns_only_a_mask() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        /* The stored secret is the trimmed paste. */
        assert_eq!(
            secrets.read_secret(&record.id).expect("stored").as_str(),
            SECRET_MARKER
        );
        /* The record carries a mask and never the secret. */
        assert!(!record.masked_label.contains(SECRET_MARKER));
        assert_eq!(record.masked_label, mask_label(SECRET_MARKER));
        /* The file on disk never carries the secret either. */
        let text =
            std::fs::read_to_string(dir.path().join(crate::connections::CONNECTIONS_FILE_NAME))
                .expect("read");
        assert!(!text.contains(SECRET_MARKER));
    }

    #[test]
    fn connect_refuses_an_empty_secret() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let mut input = connect_input();
        input.secret = "   ".to_string();
        assert_eq!(
            connect_core(&connections, &secrets, input).map(|_| ()),
            Err(CommandFailure::InvalidInput)
        );
        assert_eq!(connections.list().expect("list").len(), 0);
    }

    #[test]
    fn connect_rollback_removes_the_orphan_secret() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        /* A corrupt connections file blocks the insert after the secret has
        already been stored; the rollback must remove it again. */
        std::fs::write(
            dir.path().join(crate::connections::CONNECTIONS_FILE_NAME),
            "not json",
        )
        .expect("corrupt");
        assert_eq!(
            connect_core(&connections, &secrets, connect_input()).map(|_| ()),
            Err(CommandFailure::Corrupt)
        );
        assert_eq!(secrets.stored_count(), 0);
    }

    #[tokio::test]
    async fn test_and_refresh_stamp_their_own_facts() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
        test_core(
            &connections,
            &secrets,
            &transport,
            ProbeInput {
                connection_id: record.id.clone(),
                endpoint: ProviderEndpoint::OpenrouterKey,
            },
        )
        .await
        .expect("test");
        let after_test = connections.get(&record.id).expect("get");
        assert!(after_test.last_test_at.is_some());
        assert!(after_test.last_refresh_at.is_none());
        refresh_core(
            &connections,
            &secrets,
            &transport,
            ProbeInput {
                connection_id: record.id.clone(),
                endpoint: ProviderEndpoint::OpenrouterCredits,
            },
        )
        .await
        .expect("refresh");
        let after_refresh = connections.get(&record.id).expect("get");
        assert!(after_refresh.last_refresh_at.is_some());
        /* The transport double saw only the constant urls. */
        assert_eq!(
            transport.recorded_urls(),
            vec![
                crate::net::OPENROUTER_KEY_URL,
                crate::net::OPENROUTER_CREDITS_URL
            ]
        );
        /* And it received the stored secret on both probes, proving each one
        read it from the store rather than from anywhere else. */
        assert_eq!(
            transport.recorded_secrets(),
            vec![SECRET_MARKER.to_string(), SECRET_MARKER.to_string()]
        );
    }

    #[tokio::test]
    async fn a_failed_probe_stamps_nothing() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = RecordingTransport::replying(401, BODY_MARKER.as_bytes().to_vec(), None);
        let outcome = test_core(
            &connections,
            &secrets,
            &transport,
            ProbeInput {
                connection_id: record.id.clone(),
                endpoint: ProviderEndpoint::OpenrouterKey,
            },
        )
        .await
        .expect("probe completes with a status");
        assert_eq!(outcome.status, 401);
        assert_eq!(outcome.body, None, "a failed body is dropped");
        assert!(connections
            .get(&record.id)
            .expect("get")
            .last_test_at
            .is_none());
    }

    #[tokio::test]
    async fn probe_for_a_missing_connection_is_not_found() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
        let outcome = test_core(
            &connections,
            &secrets,
            &transport,
            ProbeInput {
                connection_id: "missing".to_string(),
                endpoint: ProviderEndpoint::OpenrouterKey,
            },
        )
        .await;
        assert_eq!(outcome.map(|_| ()), Err(CommandFailure::NotFound));
        assert_eq!(transport.recorded_urls().len(), 0, "nothing was fetched");
    }

    #[test]
    fn disconnect_removes_the_record_and_the_secret() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        disconnect_core(
            &connections,
            &secrets,
            DisconnectInput {
                connection_id: record.id.clone(),
            },
        )
        .expect("disconnect");
        assert_eq!(connections.list().expect("list").len(), 0);
        assert_eq!(secrets.stored_count(), 0);
        assert_eq!(
            secrets.read_secret(&record.id).map(|_| ()),
            Err(CredentialError::NotFound)
        );
    }

    #[test]
    fn update_changes_alias_and_status_only() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let updated = update_core(
            &connections,
            UpdateConnectionInput {
                connection_id: record.id.clone(),
                account_alias: Some("work".to_string()),
                status: Some("CONNECTED".to_string()),
            },
        )
        .expect("update");
        assert_eq!(updated.account_alias, "work");
        assert_eq!(updated.status, "CONNECTED");
        assert_eq!(updated.masked_label, record.masked_label);
        assert_eq!(updated.created_at, record.created_at);
    }

    #[test]
    fn every_failure_sentence_is_fixed_and_redacted() {
        /* The variants carry no payload, so this holds by construction; the
        test states it against the exact markers a leak would carry. */
        for failure in CommandFailure::ALL {
            let sentence = failure.to_string();
            assert!(!sentence.is_empty());
            for marker in [SECRET_MARKER, HEADER_MARKER, BODY_MARKER, URL_MARKER] {
                assert!(
                    !sentence.contains(marker),
                    "a failure sentence carried a marker"
                );
            }
            let serialized = serde_json::to_string(&failure).expect("serializable");
            for marker in [SECRET_MARKER, HEADER_MARKER, BODY_MARKER, URL_MARKER] {
                assert!(!serialized.contains(marker));
            }
        }
    }

    #[test]
    fn net_and_credential_and_store_errors_stay_redacted_through_conversion() {
        let converted: Vec<CommandFailure> = vec![
            NetError::Timeout.into(),
            NetError::Connect.into(),
            NetError::Protocol.into(),
            NetError::TooLarge.into(),
            CredentialError::NotFound.into(),
            CredentialError::Store.into(),
            StoreError::NoStateDirectory.into(),
            StoreError::NotFound.into(),
            StoreError::Corrupt.into(),
            StoreError::Full.into(),
            StoreError::InvalidField.into(),
            StoreError::Io.into(),
            CacheWriteError::NoStateDirectory.into(),
            CacheWriteError::Busy.into(),
            CacheWriteError::StaleGeneration.into(),
            CacheWriteError::TooLarge.into(),
            CacheWriteError::NotJson.into(),
            CacheWriteError::Io.into(),
        ];
        for failure in converted {
            let sentence = failure.to_string();
            for marker in [SECRET_MARKER, HEADER_MARKER, BODY_MARKER, URL_MARKER] {
                assert!(!sentence.contains(marker));
            }
        }
    }

    #[test]
    fn source_defines_no_secret_readback_command() {
        /* The redaction claim "no readback path exists by construction" is
        checked against the source itself: no Tauri command in this module
        returns a secret type, and the only command accepting one is
        connect_provider. */
        /* The attribute is assembled at runtime so this test's own text can
        never match it, and each block is cut at its body brace so only the
        signatures are judged. */
        let marker = format!("#[tauri::{}]", "command");
        let source = include_str!("commands.rs");
        let signatures: Vec<&str> = source
            .split(marker.as_str())
            .skip(1)
            .map(|block| block.split('{').next().unwrap_or(""))
            .collect();
        assert_eq!(
            signatures.len(),
            9,
            "nine commands, exactly the design's verbs"
        );
        for signature in &signatures {
            assert!(
                !signature.contains("Zeroizing") && !signature.contains("-> String"),
                "a command signature must never return secret material"
            );
        }
        let accepting_secret: Vec<&&str> = signatures
            .iter()
            .filter(|signature| signature.contains("ConnectProviderInput"))
            .collect();
        assert_eq!(accepting_secret.len(), 1);
        assert!(accepting_secret[0].contains("fn connect_provider"));
    }
}
