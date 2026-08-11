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
    MAX_ATTEMPT_GENERATION, MAX_CONSECUTIVE_FAILURES, MAX_ID_CHARS,
};
use crate::credentials::{mask_label, CredentialError, KeyringStore, SecretStore};
use crate::net::{fetch_endpoint, NetError, ReqwestTransport, Transport};
use crate::reader_registry::{reader_route, CredentialKind, ProviderId, ReaderId, RouteError};

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
    /// The stored credential does not belong to the stored provider, so no
    /// address exists for it. Unreachable through the connect path, which
    /// refuses the pairing before anything is stored; reachable only by a
    /// tampered file, and even then nothing is fetched.
    RouteRefused,
}

impl CommandFailure {
    /// Every variant, for the redaction test that formats them all. The
    /// product itself never needs the list.
    #[cfg(test)]
    pub const ALL: [CommandFailure; 14] = [
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
        CommandFailure::RouteRefused,
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
            CommandFailure::RouteRefused => {
                "this connection pairs a credential with a provider it does not belong to"
            }
        };
        formatter.write_str(sentence)
    }
}

impl From<NetError> for CommandFailure {
    fn from(error: NetError) -> Self {
        match error {
            NetError::Timeout => CommandFailure::Timeout,
            NetError::Connect | NetError::Tls => CommandFailure::Connect,
            NetError::Protocol => CommandFailure::Protocol,
            NetError::TooLarge => CommandFailure::TooLarge,
        }
    }
}

impl From<RouteError> for CommandFailure {
    fn from(error: RouteError) -> Self {
        match error {
            RouteError::CredentialProviderMismatch => CommandFailure::RouteRefused,
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

/// The status a connection is in the moment its secret lands in the operating
/// system credential store.
///
/// Derived here rather than accepted from the caller. The webview used to state
/// it, which meant a window could declare a connection CONNECTED before
/// anything had ever been read. A stored credential proves exactly one thing:
/// the connection is ready to be turned on.
pub const STATUS_AFTER_CREDENTIAL_STORED: &str = "READY_TO_ENABLE";

/// The status of a connection with an attempt open.
pub const STATUS_ATTEMPT_OPEN: &str = "CONNECTING";
/// The status of a connection whose read completed all the way through.
pub const STATUS_COMPLETED: &str = "CONNECTED";
/// The status of a connection whose credential the provider rejected.
pub const STATUS_AUTH_EXPIRED: &str = "AUTH_EXPIRED";
/// The status of a connection that failed in a way retrying may fix.
pub const STATUS_DEGRADED: &str = "DEGRADED";
/// The status of a connection that failed in a way retrying will not fix.
pub const STATUS_ERROR: &str = "ERROR";

/// How many consecutive failures turn a degraded connection into a broken one,
/// mirroring `NETWORK_FAILURE_ERROR_THRESHOLD` in
/// `packages/core/src/connection-state.ts`. One timeout is a bad moment.
pub const FAILURE_ERROR_THRESHOLD: u32 = 3;

/// What `connect_provider` accepts.
///
/// The secret enters Rust here and nowhere else. The caller names a provider
/// and a kind of credential, both from closed vocabularies, and nothing else:
/// no endpoint, no URL, no header, and no starting status. Which address that
/// pairing reaches is decided by `reader_route`, and the starting status is
/// derived from the fact that a credential was stored.
#[derive(Deserialize)]
pub struct ConnectProviderInput {
    pub provider_id: ProviderId,
    pub credential_kind: CredentialKind,
    pub account_alias: String,
    pub secret: String,
}

/// What a probe accepts: one connection, and nothing about where to go.
///
/// This is the shape the audit's confused deputy finding turned on. The old
/// input carried an `endpoint`, so a webview could pair any stored secret with
/// any address in the allowlist. There is no such field now, and a payload that
/// carries one is simply ignored by serde, so an old caller cannot influence
/// routing even by accident.
#[derive(Deserialize)]
pub struct ProbeInput {
    pub connection_id: String,
}

#[derive(Deserialize)]
pub struct DisconnectInput {
    pub connection_id: String,
}

/// What `update_connection` accepts: the account alias, and only that.
///
/// The status input is gone. A connection's state is a consequence of what a
/// read achieved, which Rust observes and stamps, so a window that could write
/// it could claim a connection was working while nothing had been read.
#[derive(Deserialize)]
pub struct UpdateConnectionInput {
    pub connection_id: String,
    #[serde(default)]
    pub account_alias: Option<String>,
}

#[derive(Deserialize)]
pub struct CacheCommitInput {
    pub text: String,
    pub generation: u64,
}

/// Why a transport never reached the provider. Closed, payload free, and
/// distinct from a status, because "no answer" and "an answer we did not like"
/// are different facts about a connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeFailure {
    Timeout,
    Connect,
    Tls,
    Oversize,
    InvalidUtf8,
}

/// What one probe reports.
///
/// A tagged union, so the webview matches on `kind` and can never read a body
/// out of a failure or a failure out of a response. Every arm carries the
/// connection, the reader that was used, and the attempt generation, so the
/// completion that follows is bound to this exact attempt: a completion
/// presenting any other generation is refused.
///
/// `reader_id` is how the TypeScript side selects a parser. It comes from the
/// stored record through `reader_route`, never from the caller, so a body can
/// only ever be handed to the parser written for the reader that fetched it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProbeOutcome {
    Response {
        connection_id: String,
        reader_id: ReaderId,
        attempt_generation: u64,
        status: u16,
        /// Present only for a status in the 200 range. Every other body is
        /// dropped by the transport without being read.
        body: Option<String>,
        retry_after_seconds: Option<u64>,
    },
    TransportFailure {
        connection_id: String,
        reader_id: ReaderId,
        attempt_generation: u64,
        failure: ProbeFailure,
    },
}

/// How an attempt ended, in the TypeScript side's own terms.
///
/// A `2xx` is not a success. These four are the only ways an attempt may be
/// closed, and each one has exactly one consequence for the record:
///
///   `parsed_test`     a connector understood the body. The credential works.
///   `cache_committed` the parsed rows reached the cache under the lock.
///   `drift`           the body was well formed and no longer means what it
///                     meant. The provider changed; nothing is believed.
///   `cache_failure`   parsing worked and the write did not, so no refresh
///                     completed and no success may be claimed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptDisposition {
    ParsedTest,
    CacheCommitted,
    Drift,
    CacheFailure,
}

#[derive(Deserialize)]
pub struct CompleteAttemptInput {
    pub connection_id: String,
    pub attempt_generation: u64,
    pub disposition: AttemptDisposition,
}

pub(crate) fn connect_core(
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    input: ConnectProviderInput,
) -> Result<ConnectionRecord, CommandFailure> {
    let ConnectProviderInput {
        provider_id,
        credential_kind,
        account_alias,
        secret,
    } = input;
    /* Routing first: a credential that does not belong to this provider has no
    address, so the request is refused before the secret is even wrapped. */
    let route = reader_route(provider_id, credential_kind)?;
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
        reader_id: route.reader_id,
        credential_kind,
        account_alias,
        masked_label: mask_label(trimmed),
        created_at: now_epoch_ms(),
        last_attempt_at: None,
        last_success_at: None,
        attempt_generation: 0,
        ever_connected: false,
        consecutive_failures: 0,
        /* Derived, never accepted. A stored credential means ready to enable
        and nothing more: no read has happened yet. */
        status: STATUS_AFTER_CREDENTIAL_STORED.to_string(),
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

/// The status a non `2xx` answer puts a connection in, and whether it counts
/// as a consecutive failure.
///
/// Rust owns this because none of it needs a parser: an authentication status
/// is an authentication status whatever the body said. The strategy's rule is
/// that Rust handles transport failures, authentication statuses, rate limiting
/// and server errors without waiting for TypeScript, and this is that table.
fn status_verdict(status: u16, failures_after: u32) -> (&'static str, bool) {
    match status {
        200..=299 => (STATUS_ATTEMPT_OPEN, false),
        /* The provider says the credential is no longer good. Retrying cannot
        fix it, so it never becomes a failure count: it needs a person. */
        401 | 403 => (STATUS_AUTH_EXPIRED, false),
        /* Rate limited and server side faults are both worth retrying, so they
        degrade and escalate on repetition like any other failure. */
        _ => (escalated(failures_after), true),
    }
}

/// Degraded until the failures pile up, then broken.
fn escalated(failures_after: u32) -> &'static str {
    if failures_after >= FAILURE_ERROR_THRESHOLD {
        STATUS_ERROR
    } else {
        STATUS_DEGRADED
    }
}

/// Open one attempt: bump the generation, stamp the attempt time, and hand back
/// the record as it now stands.
///
/// The bump happens BEFORE the request, which is what makes a completion
/// verifiable: the webview learns the generation from the outcome, and a
/// completion carrying any other generation belonged to an attempt that has
/// already been superseded and is refused.
fn open_attempt(
    connections: &ConnectionsStore,
    id: &str,
) -> Result<ConnectionRecord, CommandFailure> {
    let at = now_epoch_ms();
    let updated = connections.update(id, |it| {
        it.attempt_generation = it.attempt_generation.saturating_add(1).min(MAX_ATTEMPT_GENERATION);
        it.last_attempt_at = Some(at);
        it.status = STATUS_ATTEMPT_OPEN.to_string();
    })?;
    Ok(updated)
}

/// Record what a finished request did to the connection, without deciding
/// anything a parser has to decide.
fn settle_request(
    connections: &ConnectionsStore,
    id: &str,
    status: Option<u16>,
) -> Result<(), CommandFailure> {
    connections.update(id, |it| {
        let failures_after = it.consecutive_failures.saturating_add(1).min(MAX_CONSECUTIVE_FAILURES);
        match status {
            Some(status) => {
                let (next, counted) = status_verdict(status, failures_after);
                if counted {
                    it.consecutive_failures = failures_after;
                }
                it.status = next.to_string();
            }
            /* Nothing reached the provider, which is the plainest failure
            there is. */
            None => {
                it.consecutive_failures = failures_after;
                it.status = escalated(failures_after).to_string();
            }
        }
    })?;
    Ok(())
}

async fn probe_core<T: Transport>(
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    transport: &T,
    input: ProbeInput,
) -> Result<ProbeOutcome, CommandFailure> {
    capped_connection_id(&input.connection_id)?;
    let record = connections.get(&input.connection_id)?;
    /* The address comes from the record's own provider and credential kind,
    through the one routing function, and from nowhere else. A tampered record
    whose pairing has no route is refused here, before the secret is read. */
    let route = reader_route(record.provider_id, record.credential_kind)?;
    let opened = open_attempt(connections, &record.id)?;
    let attempt_generation = opened.attempt_generation;
    /* The secret is read inside this privileged call, used for one request,
    and dropped. It is never part of the return value. */
    let secret = secrets.read_secret(&record.id)?;
    let fetched = fetch_endpoint(transport, route.endpoint, route.auth, &secret).await;
    match fetched {
        Ok(outcome) => {
            settle_request(connections, &record.id, Some(outcome.status))?;
            Ok(ProbeOutcome::Response {
                connection_id: record.id,
                reader_id: route.reader_id,
                attempt_generation,
                status: outcome.status,
                body: outcome.body,
                retry_after_seconds: outcome.retry_after_seconds,
            })
        }
        Err(error) => {
            settle_request(connections, &record.id, None)?;
            Ok(ProbeOutcome::TransportFailure {
                connection_id: record.id,
                reader_id: route.reader_id,
                attempt_generation,
                failure: match error {
                    NetError::Timeout => ProbeFailure::Timeout,
                    NetError::Connect => ProbeFailure::Connect,
                    NetError::Tls => ProbeFailure::Tls,
                    NetError::TooLarge => ProbeFailure::Oversize,
                    NetError::Protocol => ProbeFailure::InvalidUtf8,
                },
            })
        }
    }
}

pub(crate) async fn test_core<T: Transport>(
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    transport: &T,
    input: ProbeInput,
) -> Result<ProbeOutcome, CommandFailure> {
    probe_core(connections, secrets, transport, input).await
}

pub(crate) async fn refresh_core<T: Transport>(
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    transport: &T,
    input: ProbeInput,
) -> Result<ProbeOutcome, CommandFailure> {
    probe_core(connections, secrets, transport, input).await
}

/// Close one attempt, and stamp success only if one actually happened.
///
/// The generation check is the whole point: a completion is a claim about one
/// specific request, and a claim about a request that has been superseded is
/// refused rather than applied to the newer one.
pub(crate) fn complete_attempt_core(
    connections: &ConnectionsStore,
    input: CompleteAttemptInput,
) -> Result<ConnectionRecord, CommandFailure> {
    capped_connection_id(&input.connection_id)?;
    let record = connections.get(&input.connection_id)?;
    if record.attempt_generation != input.attempt_generation {
        return Err(CommandFailure::StaleGeneration);
    }
    let at = now_epoch_ms();
    let updated = connections.update(&record.id, |it| match input.disposition {
        /* Both of these are completions: a connector understood the body, and
        for a refresh the rows also reached the cache. Only here does
        last_success_at move. */
        AttemptDisposition::ParsedTest | AttemptDisposition::CacheCommitted => {
            it.last_success_at = Some(at);
            it.ever_connected = true;
            it.consecutive_failures = 0;
            it.status = STATUS_COMPLETED.to_string();
        }
        /* The provider answered well and no longer means what it meant. The
        connection is in error and the success stamp does not move, so nothing
        downstream can read this as a working refresh. */
        AttemptDisposition::Drift | AttemptDisposition::CacheFailure => {
            it.status = STATUS_ERROR.to_string();
        }
    })?;
    Ok(updated)
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
    let updated = connections.update(&input.connection_id, |it| {
        if let Some(account_alias) = input.account_alias {
            it.account_alias = account_alias;
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
) -> Result<ProbeOutcome, CommandFailure> {
    test_core(&connections, &*secrets, &*transport, input).await
}

#[tauri::command]
pub async fn refresh_provider(
    connections: State<'_, ConnectionsStore>,
    secrets: State<'_, KeyringStore>,
    transport: State<'_, ReqwestTransport>,
    input: ProbeInput,
) -> Result<ProbeOutcome, CommandFailure> {
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

/// Close the attempt this outcome opened, with what the parser and the cache
/// write actually achieved.
#[tauri::command]
pub async fn complete_attempt(
    connections: State<'_, ConnectionsStore>,
    input: CompleteAttemptInput,
) -> Result<ConnectionRecord, CommandFailure> {
    complete_attempt_core(&connections, input)
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
    use crate::net::{ProviderEndpoint, TransportFailure};
    use crate::test_support::{FailingTransport, InMemorySecrets, RecordingTransport, TempDir};

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
            provider_id: ProviderId::Openrouter,
            credential_kind: CredentialKind::OpenrouterInferenceKey,
            account_alias: "personal".to_string(),
            secret: format!("  {SECRET_MARKER}  "),
        }
    }

    fn probe(connection_id: &str) -> ProbeInput {
        ProbeInput {
            connection_id: connection_id.to_string(),
        }
    }

    /// The generation an outcome carries, whichever arm it is.
    fn generation_of(outcome: &ProbeOutcome) -> u64 {
        match outcome {
            ProbeOutcome::Response {
                attempt_generation, ..
            }
            | ProbeOutcome::TransportFailure {
                attempt_generation, ..
            } => *attempt_generation,
        }
    }

    fn reader_of(outcome: &ProbeOutcome) -> ReaderId {
        match outcome {
            ProbeOutcome::Response { reader_id, .. }
            | ProbeOutcome::TransportFailure { reader_id, .. } => *reader_id,
        }
    }

    /* ------------------------------------------------------------ bounds */

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

    #[tokio::test]
    async fn oversized_connection_id_is_rejected_before_lookup() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
        let outcome = test_core(
            &connections,
            &secrets,
            &transport,
            probe(&"a".repeat(crate::connections::MAX_ID_CHARS + 1)),
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

    /* ----------------------------------------------------------- connect */

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
    fn connect_derives_the_status_and_the_reader_rather_than_accepting_them() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let mut input = connect_input();
        input.credential_kind = CredentialKind::OpenrouterManagementKey;
        let record = connect_core(&connections, &secrets, input).expect("connect");
        assert_eq!(record.status, STATUS_AFTER_CREDENTIAL_STORED);
        assert_eq!(record.status, "READY_TO_ENABLE");
        /* The reader came from the routing function, not from the caller. */
        assert_eq!(record.reader_id, ReaderId::OpenrouterCredits);
        assert_eq!(record.attempt_generation, 0);
        assert!(!record.ever_connected);
        assert_eq!(record.last_success_at, None);
        assert_eq!(record.last_attempt_at, None);
    }

    #[test]
    fn connect_input_carries_no_endpoint_status_url_or_header_field() {
        /* The IPC surface, checked against the source: a payload naming an
        endpoint, a URL, a header or a starting status must have nowhere to
        land. Serde ignores unknown fields, so the proof is that no such field
        is declared at all. */
        let source = include_str!("commands.rs");
        let declaration = source
            .split("pub struct ConnectProviderInput {")
            .nth(1)
            .and_then(|rest| rest.split('}').next())
            .expect("the input struct is declared");
        for forbidden in ["endpoint", "url", "header", "status", "reader_id"] {
            assert!(
                !declaration.contains(forbidden),
                "the connect input must not name {forbidden}"
            );
        }
        let probe_declaration = source
            .split("pub struct ProbeInput {")
            .nth(1)
            .and_then(|rest| rest.split('}').next())
            .expect("the probe input is declared");
        for forbidden in ["endpoint", "url", "header", "status"] {
            assert!(
                !probe_declaration.contains(forbidden),
                "the probe input must not name {forbidden}"
            );
        }
        let update_declaration = source
            .split("pub struct UpdateConnectionInput {")
            .nth(1)
            .and_then(|rest| rest.split('}').next())
            .expect("the update input is declared");
        assert!(
            !update_declaration.contains("status"),
            "the update input must not carry a status"
        );
    }

    #[test]
    fn an_endpoint_field_on_the_wire_changes_nothing() {
        /* Belt and braces for the field removal: a payload from an older
        window still carries `endpoint`, and it must be inert rather than
        honoured. */
        let payload = r#"{"connection_id":"abc-123","endpoint":"openrouter_credits"}"#;
        let parsed: ProbeInput = serde_json::from_str(payload).expect("parses");
        assert_eq!(parsed.connection_id, "abc-123");
        let connect_payload = concat!(
            r#"{"provider_id":"openrouter","credential_kind":"openrouter_inference_key","#,
            r#""account_alias":"personal","secret":"x","status":"CONNECTED"}"#
        );
        let parsed: ConnectProviderInput = serde_json::from_str(connect_payload).expect("parses");
        assert_eq!(parsed.provider_id, ProviderId::Openrouter);
    }

    #[test]
    fn connect_refuses_a_credential_that_belongs_to_another_provider() {
        /* Every wrong provider and credential pairing, refused before the
        secret can reach the operating system credential store. */
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let mut accepted = 0usize;
        for provider in ProviderId::ALL {
            for credential in CredentialKind::ALL {
                let mut input = connect_input();
                input.provider_id = provider;
                input.credential_kind = credential;
                let outcome = connect_core(&connections, &secrets, input);
                if reader_route(provider, credential).is_ok() {
                    assert!(outcome.is_ok());
                    accepted += 1;
                } else {
                    assert_eq!(
                        outcome.map(|_| ()),
                        Err(CommandFailure::RouteRefused),
                        "a foreign credential must be refused"
                    );
                }
            }
        }
        assert_eq!(accepted, 5);
        assert_eq!(
            secrets.stored_count(),
            5,
            "only the real pairings ever stored a secret"
        );
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

    /* ------------------------------------------------------------- probe */

    #[tokio::test]
    async fn a_probe_routes_from_the_record_and_never_from_the_caller() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let mut input = connect_input();
        input.credential_kind = CredentialKind::OpenrouterManagementKey;
        let record = connect_core(&connections, &secrets, input).expect("connect");
        let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
        let outcome = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        assert_eq!(reader_of(&outcome), ReaderId::OpenrouterCredits);
        /* The management key reached the credits endpoint and could not have
        reached any other, because nothing but the record decided it. */
        assert_eq!(
            transport.recorded_urls(),
            vec![crate::net::OPENROUTER_CREDITS_URL]
        );
        assert_eq!(transport.recorded_secrets(), vec![SECRET_MARKER.to_string()]);
    }

    #[tokio::test]
    async fn every_provider_reaches_only_its_own_address() {
        /* The endpoint confusion matrix, end to end: each of the five real
        pairings is connected and probed, and each one must touch exactly one
        address, its own. */
        let expected = [
            (
                ProviderId::Openrouter,
                CredentialKind::OpenrouterInferenceKey,
                ProviderEndpoint::OpenrouterKey,
            ),
            (
                ProviderId::Openrouter,
                CredentialKind::OpenrouterManagementKey,
                ProviderEndpoint::OpenrouterCredits,
            ),
            (
                ProviderId::Codex,
                CredentialKind::CodexSession,
                ProviderEndpoint::CodexUsage,
            ),
            (
                ProviderId::Antigravity,
                CredentialKind::AntigravitySession,
                ProviderEndpoint::AntigravityQuota,
            ),
            (
                ProviderId::Opencode,
                CredentialKind::OpencodeBrowserSession,
                ProviderEndpoint::OpencodeUsage,
            ),
        ];
        for (provider, credential, endpoint) in expected {
            let dir = TempDir::new();
            let (connections, secrets) = stores(&dir);
            let mut input = connect_input();
            input.provider_id = provider;
            input.credential_kind = credential;
            let record = connect_core(&connections, &secrets, input).expect("connect");
            let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
            test_core(&connections, &secrets, &transport, probe(&record.id))
                .await
                .expect("probe");
            /* OpenCode is two hops, both inside its own origin: the entry point
               names the workspace and the workspace page carries the meters.
               Every other provider is one address exactly. */
            let expected: Vec<String> = if endpoint.needs_workspace() {
                vec![
                    endpoint.url().to_string(),
                    "https://opencode.ai/workspace/wrk_testworkspace/go".to_string(),
                ]
            } else {
                vec![endpoint.url().to_string()]
            };
            assert_eq!(
                transport.recorded_urls(),
                expected,
                "a provider reached an address that is not its own"
            );
        }
    }

    #[tokio::test]
    async fn a_probe_opens_a_generation_before_the_request() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        assert_eq!(record.attempt_generation, 0);
        let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
        let first = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        assert_eq!(generation_of(&first), 1);
        let second = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        assert_eq!(generation_of(&second), 2);
        assert_eq!(
            connections.get(&record.id).expect("get").attempt_generation,
            2
        );
    }

    #[tokio::test]
    async fn a_two_hundred_stamps_an_attempt_and_never_a_success() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
        test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        let after = connections.get(&record.id).expect("get");
        assert!(after.last_attempt_at.is_some());
        assert_eq!(
            after.last_success_at, None,
            "a 2xx is not a success until something parsed it"
        );
        assert!(!after.ever_connected);
        assert_eq!(after.status, STATUS_ATTEMPT_OPEN);
    }

    #[tokio::test]
    async fn a_failed_probe_drops_the_body_and_stamps_no_success() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = RecordingTransport::replying(401, BODY_MARKER.as_bytes().to_vec(), None);
        let outcome = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe completes with a status");
        match &outcome {
            ProbeOutcome::Response { status, body, .. } => {
                assert_eq!(*status, 401);
                assert_eq!(body.as_deref(), None, "a failed body is dropped");
            }
            other => panic!("expected a response, got {other:?}"),
        }
        let serialized = serde_json::to_string(&outcome).expect("serializable");
        assert!(!serialized.contains(BODY_MARKER));
        let after = connections.get(&record.id).expect("get");
        assert_eq!(after.last_success_at, None);
        assert_eq!(after.status, STATUS_AUTH_EXPIRED);
    }

    #[tokio::test]
    async fn rust_answers_every_authentication_rate_limit_and_server_status_alone() {
        /* No parser is consulted for any of these: the status alone decides. */
        let cases = [
            (401, STATUS_AUTH_EXPIRED, 0u32),
            (403, STATUS_AUTH_EXPIRED, 0),
            (429, STATUS_DEGRADED, 1),
            (500, STATUS_DEGRADED, 1),
            (503, STATUS_DEGRADED, 1),
        ];
        for (status, expected, failures) in cases {
            let dir = TempDir::new();
            let (connections, secrets) = stores(&dir);
            let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
            let transport = RecordingTransport::replying(status, Vec::new(), None);
            test_core(&connections, &secrets, &transport, probe(&record.id))
                .await
                .expect("probe");
            let after = connections.get(&record.id).expect("get");
            assert_eq!(after.status, expected, "status {status} settled wrongly");
            assert_eq!(after.consecutive_failures, failures);
            assert_eq!(after.last_success_at, None);
        }
    }

    #[tokio::test]
    async fn repeated_failures_escalate_from_degraded_to_error() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = RecordingTransport::replying(500, Vec::new(), None);
        for expected in [STATUS_DEGRADED, STATUS_DEGRADED, STATUS_ERROR] {
            test_core(&connections, &secrets, &transport, probe(&record.id))
                .await
                .expect("probe");
            assert_eq!(connections.get(&record.id).expect("get").status, expected);
        }
        assert_eq!(
            connections
                .get(&record.id)
                .expect("get")
                .consecutive_failures,
            FAILURE_ERROR_THRESHOLD
        );
    }

    #[tokio::test]
    async fn a_transport_failure_is_its_own_arm_with_no_body_and_no_status() {
        let cases = [
            (TransportFailure::Timeout, ProbeFailure::Timeout),
            (TransportFailure::Connect, ProbeFailure::Connect),
            (TransportFailure::Tls, ProbeFailure::Tls),
            (TransportFailure::TooLarge, ProbeFailure::Oversize),
        ];
        for (transport_failure, expected) in cases {
            let dir = TempDir::new();
            let (connections, secrets) = stores(&dir);
            let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
            let transport = FailingTransport::with(transport_failure);
            let outcome = test_core(&connections, &secrets, &transport, probe(&record.id))
                .await
                .expect("probe");
            match outcome {
                ProbeOutcome::TransportFailure { failure, .. } => assert_eq!(failure, expected),
                other => panic!("expected a transport failure, got {other:?}"),
            }
            let after = connections.get(&record.id).expect("get");
            assert_eq!(after.consecutive_failures, 1);
            assert_eq!(after.last_success_at, None);
        }
    }

    #[tokio::test]
    async fn a_non_utf8_body_is_reported_as_invalid_utf8() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = RecordingTransport::replying(200, vec![0xff, 0xfe, 0x00], None);
        let outcome = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        match outcome {
            ProbeOutcome::TransportFailure { failure, .. } => {
                assert_eq!(failure, ProbeFailure::InvalidUtf8)
            }
            other => panic!("expected a transport failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn probe_for_a_missing_connection_is_not_found() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
        let outcome = test_core(&connections, &secrets, &transport, probe("missing")).await;
        assert_eq!(outcome.map(|_| ()), Err(CommandFailure::NotFound));
        assert_eq!(transport.recorded_urls().len(), 0, "nothing was fetched");
    }

    /* ------------------------------------------------------- completion */

    #[tokio::test]
    async fn a_parsed_test_completes_the_attempt_and_stamps_success() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
        let outcome = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        let completed = complete_attempt_core(
            &connections,
            CompleteAttemptInput {
                connection_id: record.id.clone(),
                attempt_generation: generation_of(&outcome),
                disposition: AttemptDisposition::ParsedTest,
            },
        )
        .expect("complete");
        assert_eq!(completed.status, STATUS_COMPLETED);
        assert!(completed.last_success_at.is_some());
        assert!(completed.ever_connected);
        assert_eq!(completed.consecutive_failures, 0);
    }

    #[tokio::test]
    async fn a_cache_failure_after_a_two_hundred_never_stamps_success() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
        let outcome = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        let completed = complete_attempt_core(
            &connections,
            CompleteAttemptInput {
                connection_id: record.id.clone(),
                attempt_generation: generation_of(&outcome),
                disposition: AttemptDisposition::CacheFailure,
            },
        )
        .expect("complete");
        assert_eq!(completed.status, STATUS_ERROR);
        assert_eq!(
            completed.last_success_at, None,
            "a 2xx followed by a cache failure is not a refresh"
        );
        assert!(!completed.ever_connected);
    }

    #[tokio::test]
    async fn drift_puts_the_connection_in_error_and_stamps_no_success() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
        let outcome = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        let completed = complete_attempt_core(
            &connections,
            CompleteAttemptInput {
                connection_id: record.id.clone(),
                attempt_generation: generation_of(&outcome),
                disposition: AttemptDisposition::Drift,
            },
        )
        .expect("complete");
        assert_eq!(completed.status, STATUS_ERROR);
        assert_eq!(completed.last_success_at, None);
    }

    #[tokio::test]
    async fn a_completion_with_a_stale_generation_is_refused() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
        let first = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        /* A second probe supersedes the first, so the first completion is a
        claim about a request that no longer matters. */
        test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        let outcome = complete_attempt_core(
            &connections,
            CompleteAttemptInput {
                connection_id: record.id.clone(),
                attempt_generation: generation_of(&first),
                disposition: AttemptDisposition::CacheCommitted,
            },
        );
        assert_eq!(outcome.map(|_| ()), Err(CommandFailure::StaleGeneration));
        assert_eq!(
            connections.get(&record.id).expect("get").last_success_at,
            None
        );
    }

    /* -------------------------------------------------- remaining verbs */

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
    fn update_changes_the_alias_and_nothing_else() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let updated = update_core(
            &connections,
            UpdateConnectionInput {
                connection_id: record.id.clone(),
                account_alias: Some("work".to_string()),
            },
        )
        .expect("update");
        assert_eq!(updated.account_alias, "work");
        /* The status is untouched, because no caller can write it. */
        assert_eq!(updated.status, record.status);
        assert_eq!(updated.masked_label, record.masked_label);
        assert_eq!(updated.created_at, record.created_at);
        assert_eq!(updated.reader_id, record.reader_id);
    }

    #[test]
    fn a_status_field_on_an_update_payload_changes_nothing() {
        let payload = r#"{"connection_id":"abc-123","status":"CONNECTED"}"#;
        let parsed: UpdateConnectionInput = serde_json::from_str(payload).expect("parses");
        assert_eq!(parsed.connection_id, "abc-123");
        assert_eq!(parsed.account_alias, None);
    }

    /* -------------------------------------------------------- redaction */

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

    #[tokio::test]
    async fn a_sentinel_secret_appears_nowhere_outside_the_secret_store() {
        /* One planted secret, followed everywhere it could surface: the
        record, the outcome, the completed record, the connections file, and
        every debug rendering along the way. */
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = RecordingTransport::replying(200, b"{\"ok\":true}".to_vec(), None);
        let outcome = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        let completed = complete_attempt_core(
            &connections,
            CompleteAttemptInput {
                connection_id: record.id.clone(),
                attempt_generation: generation_of(&outcome),
                disposition: AttemptDisposition::CacheCommitted,
            },
        )
        .expect("complete");
        let listed = connections.list().expect("list");
        let haystacks = [
            serde_json::to_string(&record).expect("record"),
            serde_json::to_string(&outcome).expect("outcome"),
            serde_json::to_string(&completed).expect("completed"),
            serde_json::to_string(&listed).expect("listed"),
            std::fs::read_to_string(dir.path().join(crate::connections::CONNECTIONS_FILE_NAME))
                .expect("file"),
            format!("{record:?}{outcome:?}{completed:?}"),
        ];
        for haystack in haystacks {
            assert!(
                !haystack.contains(SECRET_MARKER),
                "the sentinel secret escaped the credential store"
            );
        }
        /* And it is still exactly where it belongs. */
        assert_eq!(
            secrets.read_secret(&record.id).expect("stored").as_str(),
            SECRET_MARKER
        );
    }

    #[test]
    fn net_and_credential_and_store_errors_stay_redacted_through_conversion() {
        let converted: Vec<CommandFailure> = vec![
            NetError::Timeout.into(),
            NetError::Connect.into(),
            NetError::Tls.into(),
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
            RouteError::CredentialProviderMismatch.into(),
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
            10,
            "ten commands, exactly the design's verbs"
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
