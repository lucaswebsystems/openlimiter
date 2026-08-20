use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::Path;
use std::sync::Arc;
use tauri::State;
use zeroize::Zeroizing;

use crate::cache_write::{CacheWriteBegin, CacheWriteError, CacheWriter, MAX_JSON_FILE_BYTES};
use crate::claude_connect::{self, ClaudeConnectInput, ClaudePreflightVerdict};
use crate::claude_detect::{self, LocalToolDetection};
use crate::claude_oauth::{
    self, ClaudeOauthOutcome, ClaudeOauthRuntime, RefreshDetectedClaudeInput,
};
use crate::connections::{
    now_epoch_ms, valid_alias, validate_record, ConnectionRecord, ConnectionsStore, StoreError,
    MAX_ATTEMPT_GENERATION, MAX_CONSECUTIVE_FAILURES, MAX_ID_CHARS,
};
use crate::credentials::{
    mask_label, parse_codex_session_v1, read_codex_cli_secret_in_home, valid_codex_account_id,
    valid_codex_token, CodexCredentialError, CredentialError, KeyringStore, SecretStore, MASK_DOTS,
};
use crate::net::{fetch_endpoint, NetError, ReqwestTransport, Transport};
use crate::provider_detection::{DetectionReport, DetectionStore};
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
/// Scheduling and cache policy live in the native collector. These commands
/// keep the IPC boundary small, stamp facts, and enforce bounds.
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
    /// The attempt being completed never delivered a body to the webview, so
    /// there is nothing it could have parsed and nothing to complete.
    NoDeliveredBody,
    /// Completions are arriving faster than the floor allows.
    TooSoon,
    NotJson,
    /// The stored credential does not belong to the stored provider, so no
    /// address exists for it. Unreachable through the connect path, which
    /// refuses the pairing before anything is stored; reachable only by a
    /// tampered file, and even then nothing is fetched.
    RouteRefused,
    /// The Codex CLI login file is missing, unsafe, or incomplete.
    CodexLoginRequired,
}

impl CommandFailure {
    /// Every variant, for the redaction test that formats them all. The
    /// product itself never needs the list.
    #[cfg(test)]
    pub const ALL: [CommandFailure; 17] = [
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
        CommandFailure::NoDeliveredBody,
        CommandFailure::TooSoon,
        CommandFailure::NotJson,
        CommandFailure::RouteRefused,
        CommandFailure::CodexLoginRequired,
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
            CommandFailure::NoDeliveredBody => {
                "this attempt never received a provider body, so it cannot be completed"
            }
            CommandFailure::TooSoon => "completions are arriving faster than allowed",
            CommandFailure::NotJson => "the cache text is not a JSON document",
            CommandFailure::RouteRefused => {
                "this connection pairs a credential with a provider it does not belong to"
            }
            CommandFailure::CodexLoginRequired => "Codex needs a current login. Run codex login.",
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

impl From<CodexCredentialError> for CommandFailure {
    fn from(error: CodexCredentialError) -> Self {
        match error {
            CodexCredentialError::LoginRequired => CommandFailure::CodexLoginRequired,
            CodexCredentialError::InvalidEnvelope => CommandFailure::Protocol,
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

/* How large a secret may be is no longer one number. The bound belongs to the
credential KIND and lives beside the kinds themselves, in
`CredentialKind::max_secret_bytes`: a key and a whole Cookie header are not the
same shape of thing, and one bound for both either refuses real sessions or
gives keys slack they have no use for. */

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
/// Codex authentication is repaired by the vendor login command.
pub const STATUS_NEEDS_AUTH: &str = "NEEDS_AUTH";
/// The status of a connection that failed in a way retrying may fix.
pub const STATUS_DEGRADED: &str = "DEGRADED";
/// The status of a connection that failed in a way retrying will not fix.
pub const STATUS_ERROR: &str = "ERROR";

/// Shortest gap between two accepted completions on one connection.
///
/// A completion already costs a real network round trip, because it is refused
/// unless Rust watched that exact attempt return a body. This floor is the
/// second bound: it stops a webview looping probe and complete as fast as the
/// provider will answer, churning the connections file and the success stamp.
/// Short enough that a person pressing Test and then Refresh never notices.
pub const MIN_COMPLETION_INTERVAL_MS: u64 = 250;

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
/// derived from the fact that a credential was stored. Anything else in the
/// payload is refused, not ignored.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
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
/// any address in the allowlist.
///
/// There is no such field now, and `deny_unknown_fields` means a payload that
/// carries one is REFUSED rather than quietly ignored. Ignoring it was safe in
/// the narrow sense, since nothing read it, but a caller sending an endpoint is
/// a caller that believes it can choose one, and the honest answer to that
/// belief is an error rather than silent success. It also keeps the acceptance
/// requirement literally true: IPC rejects endpoint, URL, header and caller
/// supplied status fields.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProbeInput {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisconnectInput {
    pub connection_id: String,
}

/// What `update_connection` accepts: the account alias, and only that.
///
/// The status input is gone, and a payload still carrying one is refused rather
/// than ignored. A connection's state is a consequence of what a read achieved,
/// which Rust observes and stamps, so a window that could write it could claim
/// a connection was working while nothing had been read.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateConnectionInput {
    pub connection_id: String,
    #[serde(default)]
    pub account_alias: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
    /* The secret is moved into a zeroizing wrapper before anything can fail,
    so every return path below scrubs it, including the rejections. */
    let secret = Zeroizing::new(secret);
    if credential_kind == CredentialKind::CodexSession {
        let session = parse_codex_session_v1(&secret)?;
        return connect_with_secret(
            connections,
            secrets,
            provider_id,
            credential_kind,
            account_alias,
            session.access_token,
            Some(session.account_id),
        );
    }
    connect_with_secret(
        connections,
        secrets,
        provider_id,
        credential_kind,
        account_alias,
        &secret,
        None,
    )
}

fn connect_with_secret(
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    provider_id: ProviderId,
    credential_kind: CredentialKind,
    account_alias: String,
    secret: &str,
    codex_account_id: Option<&str>,
) -> Result<ConnectionRecord, CommandFailure> {
    let route = reader_route(provider_id, credential_kind)?;
    /* Caps first, before anything is cloned, masked, or stored: see the
    boundary note at `capped_connection_id`. */
    /* The bound belongs to the credential KIND, so a cookie is not held to a
    key's size and a key is not given a cookie's slack. Over the bound is
    refused whole; nothing is ever truncated, because half a credential fails
    authentication in a way nobody can debug. */
    if secret.len() > credential_kind.max_secret_bytes() {
        return Err(CommandFailure::InvalidInput);
    }
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return Err(CommandFailure::InvalidInput);
    }
    if credential_kind == CredentialKind::CodexSession {
        if !valid_codex_token(trimmed) || !codex_account_id.is_some_and(valid_codex_account_id) {
            return Err(CommandFailure::Protocol);
        }
    } else if codex_account_id.is_some() {
        return Err(CommandFailure::InvalidInput);
    }
    let record = ConnectionRecord {
        id: uuid::Uuid::new_v4().to_string(),
        provider_id,
        reader_id: route.reader_id,
        credential_kind,
        account_alias,
        codex_account_id: codex_account_id.map(str::to_string),
        /* Codex tokens stay fully masked so no token edge enters the record. */
        masked_label: if credential_kind == CredentialKind::CodexSession {
            MASK_DOTS.to_string()
        } else {
            mask_label(trimmed)
        },
        created_at: now_epoch_ms(),
        base_seconds: route.reader_id.base_seconds(),
        next_refresh_at: None,
        last_attempt_at: None,
        last_success_at: None,
        attempt_generation: 0,
        body_delivered_generation: None,
        last_completion_at: None,
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

/// The real connect boundary. Codex ignores any webview supplied secret and
/// imports both fields from the bounded vendor login file instead, then sends
/// each field to its own persistent store.
pub(crate) fn connect_from_home_core(
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    input: ConnectProviderInput,
    home: Option<&Path>,
) -> Result<ConnectionRecord, CommandFailure> {
    if input.provider_id != ProviderId::Codex
        || input.credential_kind != CredentialKind::CodexSession
    {
        return connect_core(connections, secrets, input);
    }
    let ConnectProviderInput {
        provider_id,
        credential_kind,
        account_alias,
        secret,
    } = input;
    let _discarded_webview_secret = Zeroizing::new(secret);
    let home = home.ok_or(CommandFailure::CodexLoginRequired)?;
    let imported = read_codex_cli_secret_in_home(home)?;
    connect_with_secret(
        connections,
        secrets,
        provider_id,
        credential_kind,
        account_alias,
        &imported.access_token,
        Some(&imported.account_id),
    )
}

/// The status a non `2xx` answer puts a connection in, and whether it counts
/// as a consecutive failure.
///
/// Rust owns this because none of it needs a parser: an authentication status
/// is an authentication status whatever the body said. The strategy's rule is
/// that Rust handles transport failures, authentication statuses, rate limiting
/// and server errors without waiting for TypeScript, and this is that table.
fn status_verdict(status: u16, failures_after: u32, reader_id: ReaderId) -> (&'static str, bool) {
    match status {
        200..=299 => (STATUS_ATTEMPT_OPEN, false),
        /* The provider says the credential is no longer good. Retrying cannot
        fix it, so it never becomes a failure count: it needs a person. */
        401 | 403 if reader_id == ReaderId::CodexUsage => (STATUS_NEEDS_AUTH, false),
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

/// Split a legacy v1 Codex envelope exactly once. The connection update lands
/// first; if the smaller token write fails, the new field is rolled back so
/// the old envelope remains a complete retryable source.
fn migrate_codex_credential_if_needed(
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    record: &mut ConnectionRecord,
    stored: &str,
) -> Result<Option<Zeroizing<String>>, CommandFailure> {
    if record.credential_kind != CredentialKind::CodexSession {
        return Ok(None);
    }
    let Ok(legacy) = parse_codex_session_v1(stored) else {
        if valid_codex_token(stored)
            && record
                .codex_account_id
                .as_deref()
                .is_some_and(valid_codex_account_id)
        {
            return Ok(None);
        }
        return Err(CommandFailure::Protocol);
    };
    if record
        .codex_account_id
        .as_deref()
        .is_some_and(|account_id| account_id != legacy.account_id)
    {
        return Err(CommandFailure::Protocol);
    }
    let token = Zeroizing::new(legacy.access_token.to_string());
    let account_id = legacy.account_id.to_string();
    let added_account_id = record.codex_account_id.is_none();
    if added_account_id {
        *record = connections.update(&record.id, |it| {
            it.codex_account_id = Some(account_id.clone());
        })?;
    }
    if let Err(error) = secrets.store_secret(&record.id, &token) {
        if added_account_id {
            let _ = connections.update(&record.id, |it| it.codex_account_id = None);
            record.codex_account_id = None;
        }
        return Err(error.into());
    }
    Ok(Some(token))
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
        it.attempt_generation = it
            .attempt_generation
            .saturating_add(1)
            .min(MAX_ATTEMPT_GENERATION);
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
    delivered_body: bool,
    generation: u64,
) -> Result<(), CommandFailure> {
    connections.update(id, |it| {
        let failures_after = it
            .consecutive_failures
            .saturating_add(1)
            .min(MAX_CONSECUTIVE_FAILURES);
        /* The witness. Set only when THIS process watched this attempt come
        back in the 200 range carrying a body, and cleared otherwise, so a
        witness can never outlive the attempt that earned it. Everything the
        completion path is allowed to believe rests on this line. */
        it.body_delivered_generation = if delivered_body {
            Some(generation)
        } else {
            None
        };
        match status {
            Some(status) => {
                let (next, counted) = status_verdict(status, failures_after, it.reader_id);
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

pub(crate) async fn probe_core<T: Transport>(
    connections: &ConnectionsStore,
    secrets: &impl SecretStore,
    transport: &T,
    input: ProbeInput,
) -> Result<ProbeOutcome, CommandFailure> {
    capped_connection_id(&input.connection_id)?;
    let mut record = connections.get(&input.connection_id)?;
    /* The address comes from the record's own provider and credential kind,
    through the one routing function, and from nowhere else. A tampered record
    whose pairing has no route is refused here, before the secret is read. */
    let route = reader_route(record.provider_id, record.credential_kind)?;
    /* The secret is read inside this privileged call, used for one request,
    and dropped. It is never part of the return value. */
    let secret = secrets.read_secret(&record.id)?;
    let migrated = migrate_codex_credential_if_needed(connections, secrets, &mut record, &secret)?;
    let request_secret = migrated.as_deref().unwrap_or(&secret);
    let opened = open_attempt(connections, &record.id)?;
    let attempt_generation = opened.attempt_generation;
    let fetched = fetch_endpoint(
        transport,
        route.endpoint,
        route.auth,
        request_secret,
        record.codex_account_id.as_deref(),
    )
    .await;
    match fetched {
        Ok(outcome) => {
            /* A 2xx with no body is not a delivered body, and neither is a 2xx
            with an EMPTY one: no parser in the product can read a meter out of
            zero bytes, so allowing it would leave a forgery surface for nothing
            in return. The transport drops every non 2xx body unread, so this is
            exactly "the webview received something it could have parsed". */
            let delivered = (200..=299).contains(&outcome.status)
                && outcome.body.as_deref().is_some_and(|body| !body.is_empty());
            settle_request(
                connections,
                &record.id,
                Some(outcome.status),
                delivered,
                attempt_generation,
            )?;
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
            settle_request(connections, &record.id, None, false, attempt_generation)?;
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

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn test_core<T: Transport>(
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
///
/// All of it happens inside ONE locked compare and mutate. It used to read the
/// record, decide, and then write in a second locked operation, and the window
/// between the two was wide enough to lose the whole guarantee: two concurrent
/// completions could both read an unspent witness and both pass, so one real
/// provider response would stamp two successes, and a probe arriving in that
/// window could move the generation so a completion was applied to an attempt
/// it had already been superseded by. A check that is not held together with
/// the write it authorises is not a check.
pub(crate) fn complete_attempt_core(
    connections: &ConnectionsStore,
    input: CompleteAttemptInput,
) -> Result<ConnectionRecord, CommandFailure> {
    capped_connection_id(&input.connection_id)?;
    let at = now_epoch_ms();
    connections.compare_and_mutate(&input.connection_id, |record| {
        if record.attempt_generation != input.attempt_generation {
            return Err(CommandFailure::StaleGeneration);
        }
        /*
         * The invariant that makes CONNECTED mean something.
         *
         * A generation on its own is only a number the webview was told.
         * Checking nothing else, a webview could learn it from an attempt that
         * came back 401, or 500, or that never reached the provider at all, and
         * then close that attempt as parsed and be marked CONNECTED with a
         * success timestamp. That is a claim about a read that never happened.
         *
         * So the completion is refused unless RUST watched this exact attempt
         * return a body. Every disposition needs it, not just the successful
         * ones: drift claims a body failed to parse and cache_failure claims
         * one parsed, and neither is possible without a body. When no body
         * arrived there is nothing to complete, and Rust has already settled
         * the status itself.
         */
        if record.body_delivered_generation != Some(input.attempt_generation) {
            return Err(CommandFailure::NoDeliveredBody);
        }
        /* The second bound: a completion already costs a real round trip, and
        this stops a loop of them churning the record. Compared with saturating
        arithmetic so a clock that moved backwards cannot open a window. */
        if let Some(previous) = record.last_completion_at {
            if at.saturating_sub(previous) < MIN_COMPLETION_INTERVAL_MS {
                return Err(CommandFailure::TooSoon);
            }
        }

        /*
         * The invariant that makes CONNECTED mean something.
         *
         * A generation on its own is only a number the webview was told.
         * Checking nothing else, a webview could learn it from an attempt that
         * came back 401, or 500, or that never reached the provider at all, and
         * then close that attempt as parsed and be marked CONNECTED with a
         * success timestamp. That is a claim about a read that never happened.
         *
         * So the completion is refused unless RUST watched this exact attempt
         * return a body. Every disposition needs it, not just the successful
         * ones: drift claims a body failed to parse and cache_failure claims
         * one parsed, and neither is possible without a body. When no body
         * arrived there is nothing to complete, and Rust has already settled
         * the status itself.
         */

        /* The second bound: a completion already costs a real round trip, and
        this stops a loop of them churning the record. Compared with saturating
        arithmetic so a clock that moved backwards cannot open a window. */

        record.last_completion_at = Some(at);
        /* The witness is spent, in the same locked operation that just checked
        it. One attempt, one completion: a second caller that read the same
        witness a moment earlier cannot exist, because there was no moment
        earlier to read it in. */
        record.body_delivered_generation = None;
        match input.disposition {
            /* Both of these are completions: a connector understood the body,
            and for a refresh the rows also reached the cache. Only here does
            last_success_at move. */
            AttemptDisposition::ParsedTest | AttemptDisposition::CacheCommitted => {
                record.last_success_at = Some(at);
                record.ever_connected = true;
                record.consecutive_failures = 0;
                record.status = STATUS_COMPLETED.to_string();
            }
            /* The provider answered well and no longer means what it meant. The
            connection is in error and the success stamp does not move, so
            nothing downstream can read this as a working refresh. */
            AttemptDisposition::Drift | AttemptDisposition::CacheFailure => {
                record.status = STATUS_ERROR.to_string();
            }
        }
        Ok(())
    })
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
    let home = crate::state::home();
    connect_from_home_core(&connections, &*secrets, input, home.as_deref())
}

#[tauri::command]
pub async fn test_provider(
    connections: State<'_, ConnectionsStore>,
    secrets: State<'_, KeyringStore>,
    transport: State<'_, ReqwestTransport>,
    writer: State<'_, Arc<CacheWriter>>,
    runtime: State<'_, crate::collector_runtime::CollectorRuntime>,
    input: ProbeInput,
) -> Result<crate::collector::CollectionOutcome, CommandFailure> {
    let outcome = crate::collector_runtime::run_guarded(
        &runtime,
        &connections,
        &*secrets,
        &*transport,
        Arc::clone(&writer),
        input.connection_id,
        crate::collector::CollectionMode::Test,
    )
    .await?;
    runtime.record_pass(outcome.failure(), true);
    Ok(outcome)
}

#[tauri::command]
pub async fn refresh_provider(
    connections: State<'_, ConnectionsStore>,
    secrets: State<'_, KeyringStore>,
    transport: State<'_, ReqwestTransport>,
    writer: State<'_, Arc<CacheWriter>>,
    runtime: State<'_, crate::collector_runtime::CollectorRuntime>,
    input: ProbeInput,
) -> Result<crate::collector::CollectionOutcome, CommandFailure> {
    let outcome = crate::collector_runtime::run_guarded(
        &runtime,
        &connections,
        &*secrets,
        &*transport,
        Arc::clone(&writer),
        input.connection_id,
        crate::collector::CollectionMode::Refresh,
    )
    .await?;
    runtime.record_pass(outcome.failure(), true);
    Ok(outcome)
}

#[tauri::command]
pub fn collector_status(
    runtime: State<'_, crate::collector_runtime::CollectorRuntime>,
) -> crate::collector_runtime::CollectorStatus {
    runtime.status()
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

/// Legacy completion declaration retained for its boundary tests. It is not
/// registered with Tauri now that native collection owns the transaction.
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
pub fn list_detected_providers(detection: State<'_, DetectionStore>) -> DetectionReport {
    detection.report()
}

#[tauri::command]
pub fn rescan_detected_providers(detection: State<'_, DetectionStore>) -> DetectionReport {
    detection.rescan()
}

#[tauri::command]
pub async fn refresh_detected_claude(
    input: RefreshDetectedClaudeInput,
    detection: State<'_, DetectionStore>,
    runtime: State<'_, ClaudeOauthRuntime>,
    transport: State<'_, ReqwestTransport>,
    writer: State<'_, Arc<CacheWriter>>,
) -> Result<ClaudeOauthOutcome, CommandFailure> {
    Ok(claude_oauth::collect_account(
        &detection,
        &runtime,
        &*transport,
        Arc::clone(&writer),
        input.account_id,
        now_epoch_ms(),
    )
    .await)
}

#[tauri::command]
pub async fn claude_connect_preflight(input: ClaudeConnectInput) -> ClaudePreflightVerdict {
    tauri::async_runtime::spawn_blocking(move || claude_connect::preflight(input))
        .await
        .unwrap_or_else(|_| claude_connect::unavailable_preflight())
}

/// Legacy cache handshake declaration retained for its boundary tests. It is
/// not registered with Tauri now that native collection owns cache writes.
#[tauri::command]
pub async fn cache_begin_write(
    writer: State<'_, Arc<CacheWriter>>,
) -> Result<CacheWriteBegin, CommandFailure> {
    let writer = Arc::clone(&writer);
    let begun = tauri::async_runtime::spawn_blocking(move || writer.begin())
        .await
        .map_err(|_| CommandFailure::Storage)??;
    Ok(begun)
}

/// The commit with its boundary cap in front, testable without a runtime.
#[cfg_attr(not(test), allow(dead_code))]
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

/// Legacy cache handshake declaration retained for its boundary tests. It is
/// not registered with Tauri now that native collection owns cache writes.
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
    use crate::credentials::encode_codex_session_v1;
    use crate::net::{ProviderEndpoint, TransportFailure};
    use crate::reader_registry::{MAX_BROWSER_SESSION_BYTES, MAX_KEY_SECRET_BYTES};
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

    /// Models Windows Credential Manager's 2560 byte UTF 16 blob ceiling.
    struct WindowsCeilingSecrets {
        inner: InMemorySecrets,
    }

    impl WindowsCeilingSecrets {
        fn new() -> Self {
            Self {
                inner: InMemorySecrets::new(),
            }
        }
    }

    impl SecretStore for WindowsCeilingSecrets {
        fn store_secret(&self, connection_id: &str, secret: &str) -> Result<(), CredentialError> {
            if secret.encode_utf16().count() * 2 > 2_560 {
                return Err(CredentialError::Store);
            }
            self.inner.store_secret(connection_id, secret)
        }

        fn read_secret(&self, connection_id: &str) -> Result<Zeroizing<String>, CredentialError> {
            self.inner.read_secret(connection_id)
        }

        fn delete_secret(&self, connection_id: &str) -> Result<(), CredentialError> {
            self.inner.delete_secret(connection_id)
        }
    }

    fn connect_input() -> ConnectProviderInput {
        ConnectProviderInput {
            provider_id: ProviderId::Openrouter,
            credential_kind: CredentialKind::OpenrouterInferenceKey,
            account_alias: "personal".to_string(),
            secret: format!("  {SECRET_MARKER}  "),
        }
    }

    fn codex_test_secret() -> String {
        encode_codex_session_v1("codex-access-token-for-tests", "codex-account-for-tests")
            .expect("fixture envelope")
            .to_string()
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
        input.secret = "x".repeat(MAX_KEY_SECRET_BYTES + 1);
        assert_eq!(
            connect_core(&connections, &secrets, input).map(|_| ()),
            Err(CommandFailure::InvalidInput)
        );
        assert_eq!(secrets.stored_count(), 0, "nothing reached the store");
        assert_eq!(connections.list().expect("list").len(), 0);
    }

    #[test]
    fn a_browser_session_may_be_larger_than_a_key_and_is_still_bounded() {
        /* A real Cookie header is kilobytes. A real key is not. Both bounds are
        exercised at the command boundary, and the oversized case must store
        nothing rather than store a shortened secret. */
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let big = "c".repeat(MAX_KEY_SECRET_BYTES + 1);

        let mut key = connect_input();
        key.secret = big.clone();
        assert_eq!(
            connect_core(&connections, &secrets, key).map(|_| ()),
            Err(CommandFailure::InvalidInput)
        );
        assert_eq!(secrets.stored_count(), 0);

        /* The same length is ordinary for a browser session. */
        let cookie = ConnectProviderInput {
            provider_id: ProviderId::Opencode,
            credential_kind: CredentialKind::OpencodeBrowserSession,
            account_alias: "personal".to_string(),
            secret: big,
        };
        let record = connect_core(&connections, &secrets, cookie).expect("connect");
        assert_eq!(
            record.credential_kind,
            CredentialKind::OpencodeBrowserSession
        );
        assert_eq!(secrets.stored_count(), 1);

        /* And it still has a ceiling of its own. */
        let oversized = ConnectProviderInput {
            provider_id: ProviderId::Opencode,
            credential_kind: CredentialKind::OpencodeBrowserSession,
            account_alias: "personal".to_string(),
            secret: "c".repeat(MAX_BROWSER_SESSION_BYTES + 1),
        };
        assert_eq!(
            connect_core(&connections, &secrets, oversized).map(|_| ()),
            Err(CommandFailure::InvalidInput)
        );
        assert_eq!(secrets.stored_count(), 1, "nothing more reached the store");
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
    fn codex_connect_imports_both_fields_and_ignores_the_webview_secret() {
        const TOKEN: &str = "codex-token-import-canary-123456789";
        const ACCOUNT: &str = "codex-account-import-canary-987654321";
        const WEBVIEW: &str = "webview-secret-must-be-ignored";
        let dir = TempDir::new();
        let codex = dir.path().join(".codex");
        std::fs::create_dir_all(&codex).expect("directory");
        std::fs::write(
            codex.join("auth.json"),
            format!(r#"{{"tokens":{{"access_token":"{TOKEN}","account_id":"{ACCOUNT}"}}}}"#),
        )
        .expect("fixture");
        let (connections, secrets) = stores(&dir);
        let input = ConnectProviderInput {
            provider_id: ProviderId::Codex,
            credential_kind: CredentialKind::CodexSession,
            account_alias: "personal".to_string(),
            secret: WEBVIEW.to_string(),
        };
        let record = connect_from_home_core(&connections, &secrets, input, Some(dir.path()))
            .expect("connect");
        let stored = secrets.read_secret(&record.id).expect("stored token");
        assert_eq!(stored.as_str(), TOKEN);
        assert_eq!(record.codex_account_id.as_deref(), Some(ACCOUNT));
        assert!(!stored.contains(WEBVIEW));
        let wire = serde_json::to_string(&record).expect("record wire");
        for canary in [TOKEN, WEBVIEW] {
            assert!(!wire.contains(canary));
        }
        assert!(wire.contains(ACCOUNT));
        assert!(!format!("{record:?}").contains(ACCOUNT));
        let file =
            std::fs::read_to_string(dir.path().join(crate::connections::CONNECTIONS_FILE_NAME))
                .expect("connections file");
        assert!(file.contains(ACCOUNT));
        assert!(!file.contains(TOKEN));
        assert_eq!(record.masked_label, MASK_DOTS);
    }

    #[test]
    fn realistic_codex_token_fits_the_windows_credential_ceiling() {
        let token = format!("eyJ.{}", "t".repeat(1_196));
        let account_id = format!("acct-{}", "a".repeat(75));
        let legacy = encode_codex_session_v1(&token, &account_id).expect("legacy envelope");
        assert!(legacy.encode_utf16().count() * 2 > 2_560);
        assert!(token.encode_utf16().count() * 2 <= 2_560);

        let dir = TempDir::new();
        let codex = dir.path().join(".codex");
        std::fs::create_dir_all(&codex).expect("directory");
        std::fs::write(
            codex.join("auth.json"),
            format!(r#"{{"tokens":{{"access_token":"{token}","account_id":"{account_id}"}}}}"#),
        )
        .expect("fixture");
        let connections = ConnectionsStore::at(Some(dir.path().to_path_buf()));
        let secrets = WindowsCeilingSecrets::new();
        let input = ConnectProviderInput {
            provider_id: ProviderId::Codex,
            credential_kind: CredentialKind::CodexSession,
            account_alias: "personal".to_string(),
            secret: "ignored".to_string(),
        };
        let record = connect_from_home_core(&connections, &secrets, input, Some(dir.path()))
            .expect("the token only write fits");
        assert_eq!(
            secrets.read_secret(&record.id).expect("stored").as_str(),
            token
        );
        assert_eq!(
            record.codex_account_id.as_deref(),
            Some(account_id.as_str())
        );
    }

    #[test]
    fn missing_codex_login_names_the_vendor_login_command_without_leaking_input() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let input = ConnectProviderInput {
            provider_id: ProviderId::Codex,
            credential_kind: CredentialKind::CodexSession,
            account_alias: "personal".to_string(),
            secret: SECRET_MARKER.to_string(),
        };
        let failure = connect_from_home_core(&connections, &secrets, input, Some(dir.path()))
            .expect_err("login absent");
        assert_eq!(failure, CommandFailure::CodexLoginRequired);
        assert_eq!(
            failure.to_string(),
            "Codex needs a current login. Run codex login."
        );
        assert!(!failure.to_string().contains(SECRET_MARKER));
        assert_eq!(secrets.stored_count(), 0);
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
    fn a_forbidden_field_on_the_wire_is_refused_rather_than_ignored() {
        /* The acceptance requirement is that IPC REJECTS endpoint, URL, header
        and caller supplied status fields. Ignoring them was safe in the narrow
        sense, because nothing read them, but a caller sending an endpoint is a
        caller that believes it can choose one, and silence tells it that it
        can. Every input denies unknown fields, so the belief gets an error. */
        let refused = [
            r#"{"connection_id":"abc-123","endpoint":"openrouter_credits"}"#,
            r#"{"connection_id":"abc-123","url":"https://evil.test/"}"#,
            r#"{"connection_id":"abc-123","headers":{"Authorization":"Bearer x"}}"#,
            r#"{"connection_id":"abc-123","method":"POST"}"#,
            r#"{"connection_id":"abc-123","status":"CONNECTED"}"#,
        ];
        for payload in refused {
            assert!(
                serde_json::from_str::<ProbeInput>(payload).is_err(),
                "a probe payload carrying a forbidden field was accepted"
            );
        }
        /* And the clean shape still parses, so the denial is not simply
        breaking the command. */
        let clean: ProbeInput =
            serde_json::from_str(r#"{"connection_id":"abc-123"}"#).expect("parses");
        assert_eq!(clean.connection_id, "abc-123");
    }

    #[test]
    fn connect_refuses_a_payload_that_states_a_status_or_an_endpoint() {
        let base = concat!(
            r#""provider_id":"openrouter","credential_kind":"openrouter_inference_key","#,
            r#""account_alias":"personal","secret":"x""#
        );
        for extra in [
            r#""status":"CONNECTED""#,
            r#""endpoint":"openrouter_credits""#,
            r#""reader_id":"openrouter_credits""#,
            r#""url":"https://evil.test/""#,
            r#""key_kind":"inference""#,
        ] {
            let payload = format!("{{{base},{extra}}}");
            assert!(
                serde_json::from_str::<ConnectProviderInput>(&payload).is_err(),
                "a connect payload carried a forbidden field and was accepted"
            );
        }
        let clean = format!("{{{base}}}");
        assert_eq!(
            serde_json::from_str::<ConnectProviderInput>(&clean)
                .expect("parses")
                .provider_id,
            ProviderId::Openrouter
        );
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
                if credential == CredentialKind::CodexSession {
                    input.secret = codex_test_secret();
                }
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
        assert_eq!(accepted, 7);
        assert_eq!(
            secrets.stored_count(),
            7,
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
    async fn a_legacy_codex_envelope_is_split_and_rewritten_once() {
        const TOKEN: &str = "codex-migration-token-never-log";
        const ACCOUNT: &str = "codex-migration-account-never-log";
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let legacy = encode_codex_session_v1(TOKEN, ACCOUNT)
            .expect("legacy")
            .to_string();
        let input = ConnectProviderInput {
            provider_id: ProviderId::Codex,
            credential_kind: CredentialKind::CodexSession,
            account_alias: "personal".to_string(),
            secret: legacy.clone(),
        };
        let record = connect_core(&connections, &secrets, input).expect("initial record");
        connections
            .update(&record.id, |it| it.codex_account_id = None)
            .expect("legacy record shape");
        secrets
            .store_secret(&record.id, &legacy)
            .expect("legacy credential shape");

        let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
        let outcome = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("migrated probe");
        assert_eq!(
            secrets.read_secret(&record.id).expect("rewritten").as_str(),
            TOKEN
        );
        let migrated = connections.get(&record.id).expect("migrated record");
        assert_eq!(migrated.codex_account_id.as_deref(), Some(ACCOUNT));
        assert_eq!(transport.recorded_secrets(), vec![TOKEN.to_string()]);
        assert_eq!(
            transport.recorded_codex_account_ids(),
            vec![Some(ACCOUNT.to_string())]
        );
        for rendered in [
            format!("{outcome:?}"),
            format!("{migrated:?}"),
            CommandFailure::Protocol.to_string(),
        ] {
            assert!(!rendered.contains(TOKEN));
            assert!(!rendered.contains(ACCOUNT));
        }
    }

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
        assert_eq!(
            transport.recorded_secrets(),
            vec![SECRET_MARKER.to_string()]
        );
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
            if credential == CredentialKind::CodexSession {
                input.secret = codex_test_secret();
            }
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
    async fn codex_auth_failure_becomes_needs_auth_for_codex_login() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let input = ConnectProviderInput {
            provider_id: ProviderId::Codex,
            credential_kind: CredentialKind::CodexSession,
            account_alias: "personal".to_string(),
            secret: codex_test_secret(),
        };
        let record = connect_core(&connections, &secrets, input).expect("connect");
        let transport = RecordingTransport::replying(401, Vec::new(), None);
        test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        assert_eq!(
            connections.get(&record.id).expect("record").status,
            STATUS_NEEDS_AUTH
        );
        assert_eq!(
            CommandFailure::CodexLoginRequired.to_string(),
            "Codex needs a current login. Run codex login."
        );
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

    /* --------------------------------------------- the forgery, closed */

    /// Complete an attempt whose outcome came back however the case needs, and
    /// report what the backend said.
    async fn complete_after(
        status: u16,
        body: Vec<u8>,
        disposition: AttemptDisposition,
    ) -> (Result<ConnectionRecord, CommandFailure>, ConnectionRecord) {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = RecordingTransport::replying(status, body, None);
        let outcome = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        let attempted = connections.get(&record.id).expect("get");
        let completed = complete_attempt_core(
            &connections,
            CompleteAttemptInput {
                connection_id: record.id.clone(),
                attempt_generation: generation_of(&outcome),
                disposition,
            },
        );
        let after = connections.get(&record.id).expect("get");
        let _ = attempted;
        (completed, after)
    }

    #[tokio::test]
    async fn an_attempt_the_provider_refused_cannot_be_completed_as_a_success() {
        /* THE FORGERY. The webview learns the generation from every outcome,
        including a refusal, so generation equality alone let it close a 401 as
        a parsed success and be marked CONNECTED with a success timestamp: a
        claim about a network read that never happened. */
        for status in [401u16, 403, 429, 500, 503] {
            let (outcome, after) =
                complete_after(status, b"denied".to_vec(), AttemptDisposition::ParsedTest).await;
            assert_eq!(
                outcome.map(|_| ()),
                Err(CommandFailure::NoDeliveredBody),
                "status {status} was completable as a success"
            );
            assert_ne!(after.status, STATUS_COMPLETED);
            assert_eq!(after.last_success_at, None);
            assert!(!after.ever_connected);
        }
    }

    #[tokio::test]
    async fn no_disposition_at_all_survives_a_missing_body() {
        /* Every disposition needs the witness, not only the successful ones:
        drift claims a body failed to parse and cache_failure claims one parsed,
        and neither is possible without a body. */
        for disposition in [
            AttemptDisposition::ParsedTest,
            AttemptDisposition::CacheCommitted,
            AttemptDisposition::Drift,
            AttemptDisposition::CacheFailure,
        ] {
            let (outcome, _) = complete_after(401, b"denied".to_vec(), disposition).await;
            assert_eq!(outcome.map(|_| ()), Err(CommandFailure::NoDeliveredBody));
        }
    }

    #[tokio::test]
    async fn a_transport_failure_cannot_be_completed_at_all() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = FailingTransport::with(TransportFailure::Timeout);
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
        );
        assert_eq!(completed.map(|_| ()), Err(CommandFailure::NoDeliveredBody));
        assert_eq!(
            connections.get(&record.id).expect("get").last_success_at,
            None
        );
    }

    #[tokio::test]
    async fn an_empty_two_hundred_body_is_not_something_to_have_parsed() {
        /* No parser in the product reads a meter out of zero bytes, so allowing
        this would leave a forgery surface and buy nothing. */
        let (outcome, after) =
            complete_after(200, Vec::new(), AttemptDisposition::ParsedTest).await;
        assert_eq!(outcome.map(|_| ()), Err(CommandFailure::NoDeliveredBody));
        assert_eq!(after.last_success_at, None);
    }

    #[tokio::test]
    async fn a_completion_cannot_be_replayed_against_its_own_generation() {
        /* One attempt, one completion. The witness is spent when it is used, so
        a replay of the same generation finds nothing to stand on and cannot
        keep refreshing the success stamp off one real read. */
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = RecordingTransport::replying(200, b"{\"ok\":true}".to_vec(), None);
        let outcome = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        let input = || CompleteAttemptInput {
            connection_id: record.id.clone(),
            attempt_generation: generation_of(&outcome),
            disposition: AttemptDisposition::ParsedTest,
        };
        complete_attempt_core(&connections, input()).expect("the first completion stands");
        assert_eq!(
            complete_attempt_core(&connections, input()).map(|_| ()),
            Err(CommandFailure::NoDeliveredBody)
        );
    }

    #[tokio::test]
    async fn completions_are_rated_even_when_every_one_is_witnessed() {
        /* The second bound. Each completion here is backed by a real attempt
        that really delivered a body, so the witness cannot refuse them; the
        floor is what stops a webview looping probe and complete as fast as a
        provider will answer. */
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = RecordingTransport::replying(200, b"{\"ok\":true}".to_vec(), None);
        let complete = |outcome: &ProbeOutcome| CompleteAttemptInput {
            connection_id: record.id.clone(),
            attempt_generation: generation_of(outcome),
            disposition: AttemptDisposition::CacheCommitted,
        };

        let first = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        complete_attempt_core(&connections, complete(&first)).expect("the first stands");
        let stamped = connections.get(&record.id).expect("get").last_success_at;
        assert!(stamped.is_some());

        let second = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        connections
            .update(&record.id, |current| {
                current.last_completion_at =
                    Some(now_epoch_ms().saturating_add(MIN_COMPLETION_INTERVAL_MS));
            })
            .expect("hold the test inside the completion floor");
        assert_eq!(
            complete_attempt_core(&connections, complete(&second)).map(|_| ()),
            Err(CommandFailure::TooSoon),
            "a second completion inside the floor must be refused"
        );
        /* Refused, and the earlier stamp is left exactly as it was. */
        assert_eq!(
            connections.get(&record.id).expect("get").last_success_at,
            stamped
        );
    }

    #[tokio::test]
    async fn the_witness_does_not_outlive_the_attempt_that_earned_it() {
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let good = RecordingTransport::replying(200, b"{\"ok\":true}".to_vec(), None);
        let first = test_core(&connections, &secrets, &good, probe(&record.id))
            .await
            .expect("probe");
        assert_eq!(
            connections
                .get(&record.id)
                .expect("get")
                .body_delivered_generation,
            Some(generation_of(&first))
        );
        /* A later attempt that delivers nothing clears it, so the earlier
        witness cannot be spent late. */
        let bad = RecordingTransport::replying(401, b"denied".to_vec(), None);
        test_core(&connections, &secrets, &bad, probe(&record.id))
            .await
            .expect("probe");
        assert_eq!(
            connections
                .get(&record.id)
                .expect("get")
                .body_delivered_generation,
            None
        );
    }

    #[test]
    fn a_witness_ahead_of_its_own_attempt_is_a_tampered_document() {
        /* The only way to forge a witness is to edit the file, and a witness for
        a generation that has not happened is refused on the way in. */
        let dir = TempDir::new();
        let (connections, secrets) = stores(&dir);
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let outcome = connections.update(&record.id, |it| {
            it.body_delivered_generation = Some(it.attempt_generation + 1);
        });
        assert_eq!(outcome.map(|_| ()), Err(StoreError::InvalidField));
    }

    /* ------------------------------- the completion is one operation */

    /// A connected connection with an unspent witness, and its generation.
    ///
    /// Returned as an `Arc` so several threads can drive the same store, which
    /// is the only way to exercise a lock window.
    async fn witnessed(
        dir: &TempDir,
    ) -> (
        std::sync::Arc<ConnectionsStore>,
        InMemorySecrets,
        String,
        u64,
    ) {
        let connections = std::sync::Arc::new(ConnectionsStore::at(Some(dir.path().to_path_buf())));
        let secrets = InMemorySecrets::new();
        let record = connect_core(&connections, &secrets, connect_input()).expect("connect");
        let transport = RecordingTransport::replying(200, b"{\"ok\":true}".to_vec(), None);
        let outcome = test_core(&connections, &secrets, &transport, probe(&record.id))
            .await
            .expect("probe");
        let generation = generation_of(&outcome);
        (connections, secrets, record.id, generation)
    }

    #[tokio::test]
    async fn two_concurrent_completions_cannot_share_one_witness() {
        /*
         * THE RACE. The completion used to read and validate the record under
         * one lock, then write under another. Two callers arriving together both
         * read an unspent witness, both passed every check, and both wrote: one
         * real provider response stamping two successes.
         *
         * The barrier is what makes this a test rather than a hope. Spawning
         * threads one after another lets the early ones finish before the late
         * ones start, which is why an earlier version of this test caught the
         * bug about one run in five. Released together, every thread reaches the
         * read before any of them reaches the write, which is precisely the
         * window the finding describes.
         */
        const RACERS: usize = 12;
        for round in 0..24 {
            let dir = TempDir::new();
            let (connections, _secrets, id, generation) = witnessed(&dir).await;
            let gate = std::sync::Arc::new(std::sync::Barrier::new(RACERS));
            let mut threads = Vec::new();
            for racer in 0..RACERS {
                let store = std::sync::Arc::clone(&connections);
                let start = std::sync::Arc::clone(&gate);
                let connection_id = id.clone();
                threads.push(std::thread::spawn(move || {
                    start.wait();
                    /* Staggered by microseconds across the racers and swept
                    across the rounds. Released at exactly the same instant they
                    pile onto the lock and hand off one at a time, which is the
                    one arrangement that does NOT land in the window; offset by a
                    hair, they overlap it. Under the fixed code every offset is
                    safe, so the sweep costs nothing and it is what makes the
                    unfixed code fail. */
                    std::thread::sleep(std::time::Duration::from_micros(
                        (racer as u64) * (round as u64 % 6),
                    ));
                    complete_attempt_core(
                        &store,
                        CompleteAttemptInput {
                            connection_id,
                            attempt_generation: generation,
                            disposition: AttemptDisposition::CacheCommitted,
                        },
                    )
                }));
            }
            let outcomes: Vec<_> = threads
                .into_iter()
                .map(|thread| thread.join().expect("the thread did not panic"))
                .collect();
            let accepted = outcomes.iter().filter(|outcome| outcome.is_ok()).count();
            assert_eq!(
                accepted, 1,
                "round {round}: one witness accepted {accepted} completions"
            );
            /* And every refusal is a typed one, not a storage accident. */
            for outcome in &outcomes {
                if let Err(failure) = outcome {
                    assert!(
                        matches!(
                            failure,
                            CommandFailure::NoDeliveredBody
                                | CommandFailure::TooSoon
                                | CommandFailure::StaleGeneration
                        ),
                        "an unexpected failure came out of the race: {failure:?}"
                    );
                }
            }
            let after = connections.get(&id).expect("get");
            assert_eq!(
                after.body_delivered_generation, None,
                "the witness survived"
            );
            assert!(after.last_completion_at.is_some());
        }
    }

    #[tokio::test]
    async fn a_completion_is_never_applied_to_a_generation_it_did_not_check() {
        /*
         * THE INTERLEAVING. A probe arriving between the check and the write
         * moved the generation, so the completion was applied to an attempt it
         * had already been superseded by.
         *
         * The assertion is exact rather than statistical: a completion returns
         * the record AS MUTATED under the lock, so its generation must equal the
         * one the caller presented. If a probe slipped in between, the returned
         * record carries the newer generation and this fails outright.
         *
         * A barrier releases both sides together, and the probe side is delayed
         * by a sweep of small amounts across rounds, because the window sits a
         * few microseconds after the read and one fixed delay would either
         * always miss it or always land before it. Under the fixed code every
         * one of these timings is safe, so the sweep costs nothing and it is
         * what makes the unfixed code fail.
         */
        for round in 0..40u64 {
            let dir = TempDir::new();
            let (connections, secrets, id, generation) = witnessed(&dir).await;
            let secrets = std::sync::Arc::new(secrets);
            let gate = std::sync::Arc::new(std::sync::Barrier::new(2));

            let completing = {
                let store = std::sync::Arc::clone(&connections);
                let start = std::sync::Arc::clone(&gate);
                let connection_id = id.clone();
                std::thread::spawn(move || {
                    start.wait();
                    complete_attempt_core(
                        &store,
                        CompleteAttemptInput {
                            connection_id,
                            attempt_generation: generation,
                            disposition: AttemptDisposition::CacheCommitted,
                        },
                    )
                })
            };
            let probing = {
                let store = std::sync::Arc::clone(&connections);
                let store_secrets = std::sync::Arc::clone(&secrets);
                let start = std::sync::Arc::clone(&gate);
                let connection_id = id.clone();
                std::thread::spawn(move || {
                    start.wait();
                    std::thread::sleep(std::time::Duration::from_micros(round * 25));
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .build()
                        .expect("a runtime for the probe");
                    let transport =
                        RecordingTransport::replying(200, b"{\"ok\":true}".to_vec(), None);
                    runtime.block_on(test_core(
                        &store,
                        &*store_secrets,
                        &transport,
                        ProbeInput { connection_id },
                    ))
                })
            };

            let completed = completing.join().expect("the completion did not panic");
            probing
                .join()
                .expect("the probe did not panic")
                .expect("the probe itself must succeed");

            match completed {
                Ok(updated) => assert_eq!(
                    updated.attempt_generation, generation,
                    "round {round}: a completion for generation {generation} was applied to a \
                     record already at {}",
                    updated.attempt_generation
                ),
                /* Losing the race is correct: the probe got there first, so the
                completion is about a superseded attempt. */
                Err(failure) => assert!(
                    matches!(
                        failure,
                        CommandFailure::StaleGeneration | CommandFailure::NoDeliveredBody
                    ),
                    "round {round}: an unexpected failure: {failure:?}"
                ),
            }
        }
    }

    #[test]
    fn the_completion_reads_and_writes_under_one_lock() {
        /*
         * The structural half, so the property survives an edit that the
         * scheduler happens not to catch. A `get` inside this function would be
         * a read under a lock the write does not hold.
         */
        let source = include_str!("commands.rs");
        let body = source
            .split("pub(crate) fn complete_attempt_core(")
            .nth(1)
            .and_then(|rest| rest.split("\npub(crate) fn ").next())
            .expect("the completion is declared here");
        assert!(
            body.contains("compare_and_mutate"),
            "the completion must decide and write inside one locked operation"
        );
        assert!(
            !body.contains("connections.get("),
            "the completion must not read the record under a separate lock"
        );
        assert!(
            !body.contains("connections.update("),
            "the completion must not write under a lock that did not make the decision"
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
    fn an_update_payload_that_states_a_status_is_refused() {
        assert!(
            serde_json::from_str::<UpdateConnectionInput>(
                r#"{"connection_id":"abc-123","status":"CONNECTED"}"#
            )
            .is_err(),
            "a caller supplied status was accepted"
        );
        let parsed: UpdateConnectionInput =
            serde_json::from_str(r#"{"connection_id":"abc-123","account_alias":"work"}"#)
                .expect("parses");
        assert_eq!(parsed.connection_id, "abc-123");
        assert_eq!(parsed.account_alias.as_deref(), Some("work"));
    }

    #[test]
    fn every_command_input_denies_unknown_fields() {
        /* Stated against the source, so an input added later cannot quietly
        skip the attribute. */
        let marker = "#[derive(".to_string() + "Deserialize)]";
        let source = include_str!("commands.rs");
        let head = source
            .split("mod tests")
            .next()
            .expect("the module has a body before its tests");
        let inputs: Vec<&str> = head.split(marker.as_str()).skip(1).collect();
        assert!(
            inputs.len() >= 6,
            "the command inputs are still declared here"
        );
        for block in inputs {
            assert!(
                block.starts_with("\n#[serde(deny_unknown_fields)]"),
                "an input does not deny unknown fields"
            );
        }
    }

    #[test]
    fn production_exposes_no_claude_settings_mutation_command() {
        let commands = include_str!("commands.rs")
            .split("mod tests")
            .next()
            .expect("production commands precede tests");
        let sources = [
            commands,
            include_str!("lib.rs"),
            include_str!("../../ui/backend.js"),
            include_str!("../../ui/connections.js"),
        ];
        for source in sources {
            for forbidden in ["claude_connect_apply", "claude_disconnect"] {
                assert!(
                    !source.contains(forbidden),
                    "production still exposes {forbidden}"
                );
            }
        }
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
        assert_eq!(signatures.len(), 15, "the reviewed command surface");
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
