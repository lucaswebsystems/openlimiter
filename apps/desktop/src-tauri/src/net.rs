use std::fmt;
use std::future::Future;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::credentials::{valid_codex_account_id, valid_codex_token};
use crate::reader_registry::AuthApplication;

/// The network layer, closed by construction.
///
/// There is no command that fetches a URL. There is an enum of provider
/// endpoints, each carrying one constant address, and a fetch that accepts
/// only the enum, so the whole reachable internet is the list below and
/// nothing a webview says can widen it. The webview itself gains no network:
/// its content security policy and capabilities are untouched, and every
/// request here leaves from the Rust process.
///
/// Failures are closed enums with no payload, so a header, a URL, a response
/// body, or a secret cannot appear in an error no matter who formats it. The
/// body of a response outside the 200 range is dropped without being read.
/// One request's total budget, connect to last body byte.
pub const NETWORK_TIMEOUT_SECONDS: u64 = 15;

/// Largest response body accepted, the same bound every state file uses,
/// mirroring `MAX_JSON_FILE_BYTES` in `packages/core/src/cache.ts:23`.
pub const MAX_RESPONSE_BYTES: usize = 1_048_576;

/// The OpenRouter inference key report: limit, remaining, and usage.
pub const OPENROUTER_KEY_URL: &str = "https://openrouter.ai/api/v1/key";

/// The OpenRouter management credits report.
pub const OPENROUTER_CREDITS_URL: &str = "https://openrouter.ai/api/v1/credits";

/// The Claude account usage report read with Claude Code's existing OAuth token.
pub const CLAUDE_OAUTH_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// The Codex usage report, read with the session the Codex client holds.
///
/// Evidence, recorded 2026-08-07 from a working reader and restated in
/// `provider_specs/openai/codex.yaml`: `GET`, bearer authorization, a product
/// user agent, and `Accept: application/json`. OpenAI publishes no consumer
/// quota API, so this is an internal endpoint and every surface says so.
pub const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

/// The Grok Build billing report used by the official Grok CLI.
pub const GROK_USAGE_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

/// The Kimi Code usage report used by the official Kimi CLI.
pub const KIMI_USAGE_URL: &str = "https://api.kimi.com/coding/v1/usages";

/// The Antigravity account bootstrap, used to resolve the server managed
/// Cloud Code project before a quota read.
pub const ANTIGRAVITY_BOOTSTRAP_URL: &str =
    "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";

/// The Antigravity quota summary, on Google's metadata plane.
///
/// Evidence, recorded 2026-08-19 against agy 1.1.15: the same unexpired
/// keyring token produced a 403 when this endpoint received `{}` and produced
/// a 200 response with two groups and four buckets after `loadCodeAssist`
/// resolved the companion project and that project was sent in the body.
pub const ANTIGRAVITY_QUOTA_URL: &str =
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

/// The first of the two constant addresses the OpenCode reader uses: the
/// authenticated entry point, whose redirect names the workspace.
///
/// OpenCode publishes no usage interface at all. The plan percentages exist
/// only on the logged in workspace page, which is why this provider is
/// permanently labelled an authenticated scrape with a high automation risk.
pub const OPENCODE_AUTH_URL: &str = "https://opencode.ai/auth";

/// The prefix of the second constant address, before the workspace handle.
pub const OPENCODE_WORKSPACE_URL_PREFIX: &str = "https://opencode.ai/workspace/";

/// The suffix of the second constant address, after the workspace handle.
pub const OPENCODE_WORKSPACE_URL_SUFFIX: &str = "/go";

/// Every address this process may speak to. Adding a provider means adding a
/// variant here, in code, in review; nothing at runtime can.
///
/// DECISION, ratified 2026-08-10, and settled: do not reopen it.
///
/// One variant is not necessarily one request. `OpencodeUsage` owns two
/// constant addresses because its entry point names the workspace carrying
/// the meters. `AntigravityQuota` also owns two constant addresses because
/// its bootstrap resolves the server managed project required by the quota
/// request body.
///
/// The rejected alternative was a sixth enum variant for the entry point. It
/// was rejected because the endpoint vocabulary is the frozen contract shared
/// with the registry and the webview, and widening it there to describe an
/// implementation detail of one reader would have leaked a hop into a
/// vocabulary that names DESTINATIONS. One reader, one variant; how many
/// requests that reader takes is this file's business.
///
/// The closure property is unchanged and is what makes the concession safe.
/// Both addresses are built here, from constants here. The workspace handle
/// between them is a `WorkspaceHandle`, whose only constructor refuses anything
/// that is not the provider's own opaque token, and which is obtained by
/// parsing a redirect target rather than by following it. Nothing outside this
/// file, and in particular nothing arriving over IPC, from YAML, or from a
/// provider response body, can widen or redirect either address.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderEndpoint {
    OpenrouterKey,
    OpenrouterCredits,
    CodexUsage,
    AntigravityQuota,
    OpencodeUsage,
    ClaudeOauthUsage,
    GrokUsage,
    KimiUsage,
}

impl ProviderEndpoint {
    /// The whole allowlist, for the tests that prove it closed. The product
    /// itself never needs the list, only a variant at a time.
    #[cfg_attr(not(test), allow(dead_code))]
    pub const ALL: [ProviderEndpoint; 8] = [
        ProviderEndpoint::OpenrouterKey,
        ProviderEndpoint::OpenrouterCredits,
        ProviderEndpoint::CodexUsage,
        ProviderEndpoint::AntigravityQuota,
        ProviderEndpoint::OpencodeUsage,
        ProviderEndpoint::ClaudeOauthUsage,
        ProviderEndpoint::GrokUsage,
        ProviderEndpoint::KimiUsage,
    ];

    /// The address the first request of this endpoint goes to.
    pub const fn url(self) -> &'static str {
        match self {
            ProviderEndpoint::OpenrouterKey => OPENROUTER_KEY_URL,
            ProviderEndpoint::OpenrouterCredits => OPENROUTER_CREDITS_URL,
            ProviderEndpoint::CodexUsage => CODEX_USAGE_URL,
            ProviderEndpoint::AntigravityQuota => ANTIGRAVITY_BOOTSTRAP_URL,
            ProviderEndpoint::OpencodeUsage => OPENCODE_AUTH_URL,
            ProviderEndpoint::ClaudeOauthUsage => CLAUDE_OAUTH_USAGE_URL,
            ProviderEndpoint::GrokUsage => GROK_USAGE_URL,
            ProviderEndpoint::KimiUsage => KIMI_USAGE_URL,
        }
    }

    /// Whether this endpoint's read takes a second hop through a workspace.
    pub const fn needs_workspace(self) -> bool {
        matches!(self, ProviderEndpoint::OpencodeUsage)
    }

    /// The HTTP verb this endpoint answers. A constant per variant, never a
    /// parameter: a caller that could choose the method could turn a read into
    /// a write.
    pub const fn method(self) -> HttpMethod {
        match self {
            ProviderEndpoint::OpenrouterKey
            | ProviderEndpoint::OpenrouterCredits
            | ProviderEndpoint::CodexUsage
            | ProviderEndpoint::OpencodeUsage
            | ProviderEndpoint::ClaudeOauthUsage
            | ProviderEndpoint::GrokUsage
            | ProviderEndpoint::KimiUsage => HttpMethod::Get,
            ProviderEndpoint::AntigravityQuota => HttpMethod::Post,
        }
    }

    /// The first request body, when the endpoint demands one. The second
    /// Antigravity body is constructed only from a validated project returned
    /// by the first request.
    pub const fn body(self) -> Option<&'static str> {
        match self {
            ProviderEndpoint::AntigravityQuota => Some(ANTIGRAVITY_BOOTSTRAP_BODY),
            ProviderEndpoint::OpenrouterKey
            | ProviderEndpoint::OpenrouterCredits
            | ProviderEndpoint::CodexUsage
            | ProviderEndpoint::OpencodeUsage
            | ProviderEndpoint::ClaudeOauthUsage
            | ProviderEndpoint::GrokUsage
            | ProviderEndpoint::KimiUsage => None,
        }
    }
}

/// The exact bootstrap metadata emitted by the current agy client.
pub const ANTIGRAVITY_BOOTSTRAP_BODY: &str = r#"{"metadata":{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}}"#;

/// The default identity carried by provider requests that accept third party
/// clients. Antigravity is the exception documented below.
pub const OPENLIMITER_USER_AGENT: &str = "OpenLimiter/0.4.0 (+https://openlimiter.com)";

/// The user agent the Codex usage endpoint is addressed with.
pub const CODEX_USER_AGENT: &str = OPENLIMITER_USER_AGENT;

/// The account header the ChatGPT backend reads alongside the bearer token.
///
/// The account identifier is imported beside the access token from the Codex
/// session envelope. It is never accepted as a caller supplied request field.
pub const CODEX_ACCOUNT_HEADER: &str = "chatgpt-account-id";

/// The account identity the Grok billing service requires beside the token.
pub const GROK_ACCOUNT_HEADER: &str = "x-userid";

/// The fixed token authentication mode published by the official Grok CLI.
pub const GROK_TOKEN_AUTH_HEADER: &str = "x-xai-token-auth";

/// The fixed value paired with `GROK_TOKEN_AUTH_HEADER`.
pub const GROK_TOKEN_AUTH_VALUE: &str = "xai-grok-cli";

/// The beta contract Claude Code sends when it asks for OAuth account usage.
pub const CLAUDE_OAUTH_BETA_HEADER: &str = "anthropic-beta";

/// The beta contract value observed with the OAuth usage route.
pub const CLAUDE_OAUTH_BETA_VALUE: &str = "oauth-2025-04-20";

/// An honest product identity for the private usage request.
pub const CLAUDE_OAUTH_USER_AGENT: &str = OPENLIMITER_USER_AGENT;

/// The client identity required by Antigravity's private metadata plane.
///
/// This is deliberately pinned to the agy release whose live request contract
/// was verified. The endpoint returned an incomplete bootstrap to the same
/// valid session when addressed as OpenLimiter, then returned the companion
/// project and quota when addressed with agy's client identity.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub const ANTIGRAVITY_USER_AGENT: &str = "antigravity/cli/1.1.15 windows/amd64";
#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
pub const ANTIGRAVITY_USER_AGENT: &str = "antigravity/cli/1.1.15 windows/arm64";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub const ANTIGRAVITY_USER_AGENT: &str = "antigravity/cli/1.1.15 linux/amd64";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
pub const ANTIGRAVITY_USER_AGENT: &str = "antigravity/cli/1.1.15 linux/arm64";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
pub const ANTIGRAVITY_USER_AGENT: &str = "antigravity/cli/1.1.15 darwin/amd64";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub const ANTIGRAVITY_USER_AGENT: &str = "antigravity/cli/1.1.15 darwin/arm64";
#[cfg(not(any(
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "windows", target_arch = "aarch64"),
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64")
)))]
pub const ANTIGRAVITY_USER_AGENT: &str = "antigravity/cli/1.1.15 unknown/unknown";

/// The user agent the OpenCode workspace page is addressed with.
pub const OPENCODE_USER_AGENT: &str = OPENLIMITER_USER_AGENT;

/// The path segment that precedes a workspace handle in a redirect target.
const WORKSPACE_PATH_MARKER: &str = "/workspace/";

/// The status this reader reports when OpenCode's entry point leads anywhere
/// that is not a workspace.
///
/// DECISION, ratified 2026-08-10, and settled: do not reopen it.
///
/// The entry point answers a redirect to the workspace when the session is
/// alive, and a login page or a redirect to the auth host when it is not.
/// Neither of those carries a status that means "your session is dead" on its
/// own, and the transport failure vocabulary is closed at five kinds, so there
/// is no sixth to invent for this. 401 is reported because 401 is what the
/// situation IS: unauthenticated. The alternatives were all worse. Reporting
/// the raw first hop status would call a dead session a redirect and land the
/// connection in DEGRADED, where the scheduler would retry a session that can
/// only be fixed by a person. Reporting a transport failure would claim the
/// network broke when it plainly did not.
///
/// The consequence is deliberate: the connection lands in AUTH_EXPIRED, which
/// is the one state whose sentence tells a person to paste the session again.
pub const OPENCODE_SESSION_DEAD_STATUS: u16 = 401;

/// The two verbs the allowlist uses, closed so no third can be requested.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HttpMethod {
    Get,
    Post,
}

/// Longest a workspace handle may be, in characters.
const MAX_WORKSPACE_HANDLE_CHARS: usize = 64;

/// The provider's own opaque handle for one workspace, validated on the way in.
///
/// This is the only value in the network layer that is not a compile time
/// constant, and it exists because OpenCode's meters live behind a per
/// workspace path. It is therefore the narrowest possible type: it can only be
/// built from text matching `wrk_` followed by ASCII alphanumerics, so a path
/// traversal, a host, a query string, or a scheme cannot survive construction,
/// and the value can only be joined between two constants by `workspace_url`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceHandle(String);

impl WorkspaceHandle {
    /// The handle, or nothing at all. Nothing is trimmed, repaired or escaped:
    /// text that is not already a handle is not a handle.
    pub fn parse(text: &str) -> Option<Self> {
        let rest = text.strip_prefix("wrk_")?;
        if rest.is_empty() || text.len() > MAX_WORKSPACE_HANDLE_CHARS {
            return None;
        }
        if !rest.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
            return None;
        }
        Some(Self(text.to_string()))
    }

    /// The workspace page address for this handle: two constants and a handle
    /// that has already been proven to be one.
    pub fn workspace_url(&self) -> String {
        let mut url = String::with_capacity(
            OPENCODE_WORKSPACE_URL_PREFIX.len()
                + self.0.len()
                + OPENCODE_WORKSPACE_URL_SUFFIX.len(),
        );
        url.push_str(OPENCODE_WORKSPACE_URL_PREFIX);
        url.push_str(&self.0);
        url.push_str(OPENCODE_WORKSPACE_URL_SUFFIX);
        url
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The workspace named by a redirect target, if it names one.
    ///
    /// The only thing ever read out of a `Location` header, and the header text
    /// goes no further than this function: what comes back is either a handle
    /// that has already been proven to be one, or nothing. A target pointing at
    /// another host, at a login page, or at a path this does not recognise
    /// yields nothing, which the caller reads as a dead session.
    pub fn from_redirect_target(target: &str) -> Option<Self> {
        let after = target.split_once(WORKSPACE_PATH_MARKER)?.1;
        let candidate = after.split(['/', '?', '#']).next().unwrap_or_default();
        Self::parse(candidate)
    }
}

/// A server resolved Cloud Code project, validated before it can enter the
/// second Antigravity request body.
#[derive(Clone, Debug, PartialEq, Eq)]
struct AntigravityProject(String);

impl AntigravityProject {
    fn parse(text: &str) -> Option<Self> {
        if !(6..=63).contains(&text.len()) {
            return None;
        }
        let mut bytes = text.bytes();
        let first = bytes.next()?;
        if !first.is_ascii_lowercase() {
            return None;
        }
        if !bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-') {
            return None;
        }
        if text.ends_with('-') {
            return None;
        }
        Some(Self(text.to_string()))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Deserialize)]
struct AntigravityBootstrapResponse {
    #[serde(rename = "cloudaicompanionProject")]
    project: String,
}

#[derive(Serialize)]
struct AntigravityQuotaRequest<'a> {
    project: &'a str,
}

/// What a transport hands back. The body is present only for a status in the
/// 200 range; the transport drops every other body without reading it.
pub struct TransportReply {
    pub status: u16,
    pub body: Vec<u8>,
    pub retry_after_seconds: Option<u64>,
    /// The workspace a redirect named, when it named one.
    ///
    /// Deliberately a parsed handle rather than the header text. Redirects stay
    /// disabled, so this is how the OpenCode reader learns where its meters
    /// live without ever following an address the provider chose: it reads one
    /// opaque token out of the target, validates it, and builds the second
    /// address from its own constants.
    pub location_workspace: Option<WorkspaceHandle>,
}

/// Transport failure with everything identifying removed. No payloads, so
/// nothing a provider or a network stack says can leak through `Display` or a
/// debug log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportFailure {
    Timeout,
    Connect,
    /// The transport layer security handshake itself failed, which is a
    /// different fact from a refused connection: a certificate a machine does
    /// not trust is a machine problem, not a provider outage.
    Tls,
    Protocol,
    TooLarge,
}

/// One outbound request, and the only shape the transport can be handed.
///
/// There is no public constructor that takes a caller supplied URL. Every value
/// of this type is built by `fetch_endpoint` below out of a `ProviderEndpoint`,
/// its constant method, its constant body, and at most one `WorkspaceHandle`
/// that the transport itself parsed out of a redirect. `auth` names a scheme
/// rather than carrying a header map, so no caller can decide which header a
/// secret is written into.
pub struct EndpointRequest<'a> {
    pub url: &'a str,
    pub method: HttpMethod,
    pub auth: AuthApplication,
    /// Present only when an endpoint requires an account header.
    pub provider_account_id: Option<&'a str>,
    pub body: Option<&'a str>,
}

/// The one verb the subsystem needs from HTTP, behind a trait so tests inject
/// a recording double and no test ever opens a socket.
pub trait Transport: Send + Sync {
    fn send(
        &self,
        request: &EndpointRequest<'_>,
        secret: &str,
    ) -> impl Future<Output = Result<TransportReply, TransportFailure>> + Send;
}

/// Network failure as the caller sees it. Closed, payload free, fixed
/// sentences: the `Display` of every variant is a constant string, so no
/// header, URL, body, or secret can exist in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetError {
    Timeout,
    Connect,
    Tls,
    Protocol,
    TooLarge,
}

impl fmt::Display for NetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sentence = match self {
            NetError::Timeout => "the provider did not answer within the time allowed",
            NetError::Connect => "the provider could not be reached",
            NetError::Tls => "the secure connection to the provider could not be established",
            NetError::Protocol => "the provider answered in a way this application does not speak",
            NetError::TooLarge => {
                "the provider answered with more data than this application accepts"
            }
        };
        formatter.write_str(sentence)
    }
}

impl From<TransportFailure> for NetError {
    fn from(failure: TransportFailure) -> Self {
        match failure {
            TransportFailure::Timeout => NetError::Timeout,
            TransportFailure::Connect => NetError::Connect,
            TransportFailure::Tls => NetError::Tls,
            TransportFailure::Protocol => NetError::Protocol,
            TransportFailure::TooLarge => NetError::TooLarge,
        }
    }
}

/// What a probe reports to the engine. The body is present only for a status
/// in the 200 range, and Retry-After is passed along as parsed seconds so the
/// schedule policy in `packages/core/src/schedule.ts` can honour it; the raw
/// header text never leaves the transport.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EndpointOutcome {
    pub status: u16,
    pub body: Option<String>,
    pub retry_after_seconds: Option<u64>,
}

/// Ask one allowlisted endpoint one question.
///
/// Policy free: no retries, no backoff, no interpretation of the status. The
/// engine in the webview owns all of that, exactly as the schedule module and
/// the connection state machine in `packages/core` wrote it down.
pub async fn fetch_endpoint<T: Transport>(
    transport: &T,
    endpoint: ProviderEndpoint,
    auth: AuthApplication,
    secret: &str,
    provider_account_id: Option<&str>,
) -> Result<EndpointOutcome, NetError> {
    if endpoint.needs_workspace() {
        return fetch_through_workspace(transport, endpoint, auth, secret).await;
    }
    if endpoint == ProviderEndpoint::AntigravityQuota {
        if auth != AuthApplication::AntigravitySessionBearer || provider_account_id.is_some() {
            return Err(NetError::Protocol);
        }
        return fetch_antigravity_quota(transport, secret).await;
    }
    if matches!(
        auth,
        AuthApplication::CodexSessionBearer | AuthApplication::GrokSessionBearer
    ) {
        let account_id = provider_account_id
            .filter(|value| valid_codex_account_id(value))
            .ok_or(NetError::Protocol)?;
        if !valid_codex_token(secret) {
            return Err(NetError::Protocol);
        }
        let request = EndpointRequest {
            url: endpoint.url(),
            method: endpoint.method(),
            auth,
            provider_account_id: Some(account_id),
            body: endpoint.body(),
        };
        let reply = transport
            .send(&request, secret)
            .await
            .map_err(NetError::from)?;
        return outcome_of(reply);
    }
    if provider_account_id.is_some() {
        return Err(NetError::Protocol);
    }
    let request = EndpointRequest {
        url: endpoint.url(),
        method: endpoint.method(),
        auth,
        provider_account_id: None,
        body: endpoint.body(),
    };
    let reply = transport
        .send(&request, secret)
        .await
        .map_err(NetError::from)?;
    outcome_of(reply)
}

/// Resolve the server managed project and then ask for quota. Both addresses,
/// methods, bodies and the authentication scheme stay closed inside this
/// module; the caller can supply only the credential already assigned to the
/// Antigravity reader.
async fn fetch_antigravity_quota<T: Transport>(
    transport: &T,
    secret: &str,
) -> Result<EndpointOutcome, NetError> {
    let bootstrap = EndpointRequest {
        url: ANTIGRAVITY_BOOTSTRAP_URL,
        method: HttpMethod::Post,
        auth: AuthApplication::AntigravitySessionBearer,
        provider_account_id: None,
        body: Some(ANTIGRAVITY_BOOTSTRAP_BODY),
    };
    let bootstrap = outcome_of(
        transport
            .send(&bootstrap, secret)
            .await
            .map_err(NetError::from)?,
    )?;
    if !(200..=299).contains(&bootstrap.status) {
        return Ok(bootstrap);
    }
    let parsed: AntigravityBootstrapResponse =
        serde_json::from_str(bootstrap.body.as_deref().ok_or(NetError::Protocol)?)
            .map_err(|_| NetError::Protocol)?;
    let project = AntigravityProject::parse(&parsed.project).ok_or(NetError::Protocol)?;
    let body = serde_json::to_string(&AntigravityQuotaRequest {
        project: project.as_str(),
    })
    .map_err(|_| NetError::Protocol)?;
    let quota = EndpointRequest {
        url: ANTIGRAVITY_QUOTA_URL,
        method: HttpMethod::Post,
        auth: AuthApplication::AntigravitySessionBearer,
        provider_account_id: None,
        body: Some(&body),
    };
    let reply = transport
        .send(&quota, secret)
        .await
        .map_err(NetError::from)?;
    outcome_of(reply)
}

/// The two hop read, for the one provider that publishes no interface at all.
///
/// OpenCode's meters live only on a logged in workspace page, and the workspace
/// is per account, so one constant address cannot reach them. This is the whole
/// concession, and it is kept as narrow as it can be:
///
///   both addresses are built here, from constants here;
///   redirects stay disabled, so the entry point cannot forward the session
///     cookie anywhere; instead the redirect TARGET is read for one opaque
///     token and discarded;
///   the token must satisfy `WorkspaceHandle`, so a host, a scheme, a query or
///     a traversal cannot survive into the second address;
///   an entry point that names no workspace is a dead session, reported as an
///     authentication status rather than as a successful read of nothing.
async fn fetch_through_workspace<T: Transport>(
    transport: &T,
    endpoint: ProviderEndpoint,
    auth: AuthApplication,
    secret: &str,
) -> Result<EndpointOutcome, NetError> {
    let discovery = EndpointRequest {
        url: endpoint.url(),
        method: endpoint.method(),
        auth,
        provider_account_id: None,
        body: None,
    };
    let found = transport
        .send(&discovery, secret)
        .await
        .map_err(NetError::from)?;
    let Some(workspace) = found.location_workspace.clone() else {
        return Ok(EndpointOutcome {
            status: OPENCODE_SESSION_DEAD_STATUS,
            body: None,
            retry_after_seconds: found.retry_after_seconds,
        });
    };
    let url = workspace.workspace_url();
    let request = EndpointRequest {
        url: &url,
        method: endpoint.method(),
        auth,
        provider_account_id: None,
        body: None,
    };
    let reply = transport
        .send(&request, secret)
        .await
        .map_err(NetError::from)?;
    outcome_of(reply)
}

/// One transport reply as an outcome, with the same rules for every endpoint.
fn outcome_of(reply: TransportReply) -> Result<EndpointOutcome, NetError> {
    let success = (200..=299).contains(&reply.status);
    if !success {
        /* The body of a failed response is dropped, never parsed, never
        stored, never shown. Only the status and the parsed Retry-After
        seconds travel onward. */
        return Ok(EndpointOutcome {
            status: reply.status,
            body: None,
            retry_after_seconds: reply.retry_after_seconds,
        });
    }
    if reply.body.len() > MAX_RESPONSE_BYTES {
        return Err(NetError::TooLarge);
    }
    let text = String::from_utf8(reply.body).map_err(|_| NetError::Protocol)?;
    Ok(EndpointOutcome {
        status: reply.status,
        body: Some(text),
        retry_after_seconds: reply.retry_after_seconds,
    })
}

/// The real transport: reqwest over rustls with the ring provider.
///
/// Redirects are disabled entirely, so an allowlisted address cannot forward
/// the request, and the Authorization header with it, anywhere else. The
/// client speaks HTTPS only and enforces the total timeout above.
///
/// Construction never fails, so a machine where the TLS stack cannot come up
/// still opens the application; its probes fail as typed errors instead.
pub struct ReqwestTransport {
    client: Option<reqwest::Client>,
}

impl ReqwestTransport {
    pub fn new() -> Self {
        /* The provider install fails only when one is already installed,
        which is exactly the state this client needs. */
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(NETWORK_TIMEOUT_SECONDS))
            .redirect(reqwest::redirect::Policy::none())
            .https_only(true)
            .build()
            .ok();
        Self { client }
    }
}

impl Default for ReqwestTransport {
    fn default() -> Self {
        Self::new()
    }
}

/// Classify a reqwest failure by its booleans alone. The error itself is
/// never formatted, because reqwest errors carry URLs.
fn classify(error: &reqwest::Error) -> TransportFailure {
    if error.is_timeout() {
        return TransportFailure::Timeout;
    }
    /* Checked before the connect test, because reqwest reports a failed
    handshake as a connect failure too and the narrower fact is the useful
    one. The error is never formatted: reqwest errors carry URLs. */
    if is_tls(error) {
        return TransportFailure::Tls;
    }
    if error.is_connect() {
        return TransportFailure::Connect;
    }
    TransportFailure::Protocol
}

/// Whether anything in this error's chain came from the TLS stack.
///
/// Matched on the source chain's type name rather than on its message, so no
/// provider or platform text is ever read, formatted, or compared.
fn is_tls(error: &reqwest::Error) -> bool {
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(error);
    while let Some(current) = source {
        if current.downcast_ref::<rustls::Error>().is_some() {
            return true;
        }
        source = current.source();
    }
    false
}

/// Parse a Retry-After header value that is a plain count of seconds. The
/// HTTP date form is rare on rate limit responses and is ignored rather than
/// interpreted; the header text itself goes no further than this function.
fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    trimmed.parse::<u64>().ok()
}

/// The workspace a response's `Location` header names, if it names one.
///
/// The header value is read here and nowhere else, and only a validated handle
/// leaves this function. A header that is not valid text, or that points at
/// anything other than a workspace path, yields nothing.
fn location_workspace(headers: &reqwest::header::HeaderMap) -> Option<WorkspaceHandle> {
    let value = headers.get(reqwest::header::LOCATION)?.to_str().ok()?;
    WorkspaceHandle::from_redirect_target(value)
}

/// Build the authenticated request without sending it. Keeping construction
/// separate lets tests inspect header presence while no socket is opened.
fn authenticated_builder(
    client: &reqwest::Client,
    request: &EndpointRequest<'_>,
    secret: &str,
) -> Result<reqwest::RequestBuilder, TransportFailure> {
    let mut builder = match request.method {
        HttpMethod::Get => client.get(request.url),
        HttpMethod::Post => client.post(request.url),
    };
    let mut credential = Zeroizing::new(String::with_capacity("Bearer ".len() + secret.len()));
    match request.auth {
        AuthApplication::BearerAuthorization
        | AuthApplication::ClaudeOauthBearer
        | AuthApplication::CodexSessionBearer
        | AuthApplication::AntigravitySessionBearer
        | AuthApplication::GrokSessionBearer
        | AuthApplication::KimiSessionBearer => {
            credential.push_str("Bearer ");
            credential.push_str(secret);
        }
        AuthApplication::BrowserSessionCookie => credential.push_str(secret),
    }
    let mut header_value = reqwest::header::HeaderValue::from_str(&credential)
        .map_err(|_| TransportFailure::Protocol)?;
    header_value.set_sensitive(true);
    builder = match request.auth {
        AuthApplication::BearerAuthorization => builder
            .header(reqwest::header::AUTHORIZATION, header_value)
            .header(reqwest::header::USER_AGENT, OPENLIMITER_USER_AGENT)
            .header(reqwest::header::ACCEPT, "application/json"),
        AuthApplication::ClaudeOauthBearer => builder
            .header(reqwest::header::AUTHORIZATION, header_value)
            .header(reqwest::header::USER_AGENT, CLAUDE_OAUTH_USER_AGENT)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(CLAUDE_OAUTH_BETA_HEADER, CLAUDE_OAUTH_BETA_VALUE),
        AuthApplication::CodexSessionBearer => {
            let account_id = request
                .provider_account_id
                .ok_or(TransportFailure::Protocol)?;
            let mut account_header = reqwest::header::HeaderValue::from_str(account_id)
                .map_err(|_| TransportFailure::Protocol)?;
            account_header.set_sensitive(true);
            builder
                .header(reqwest::header::AUTHORIZATION, header_value)
                .header(reqwest::header::USER_AGENT, CODEX_USER_AGENT)
                .header(reqwest::header::ACCEPT, "application/json")
                .header(CODEX_ACCOUNT_HEADER, account_header)
        }
        AuthApplication::GrokSessionBearer => {
            let account_id = request
                .provider_account_id
                .ok_or(TransportFailure::Protocol)?;
            let mut account_header = reqwest::header::HeaderValue::from_str(account_id)
                .map_err(|_| TransportFailure::Protocol)?;
            account_header.set_sensitive(true);
            builder
                .header(reqwest::header::AUTHORIZATION, header_value)
                .header(reqwest::header::USER_AGENT, OPENLIMITER_USER_AGENT)
                .header(reqwest::header::ACCEPT, "application/json")
                .header(GROK_ACCOUNT_HEADER, account_header)
                .header(GROK_TOKEN_AUTH_HEADER, GROK_TOKEN_AUTH_VALUE)
        }
        AuthApplication::KimiSessionBearer => builder
            .header(reqwest::header::AUTHORIZATION, header_value)
            .header(reqwest::header::USER_AGENT, OPENLIMITER_USER_AGENT)
            .header(reqwest::header::ACCEPT, "application/json"),
        AuthApplication::AntigravitySessionBearer => builder
            .header(reqwest::header::AUTHORIZATION, header_value)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::USER_AGENT, ANTIGRAVITY_USER_AGENT)
            .header(reqwest::header::ACCEPT, "application/json"),
        AuthApplication::BrowserSessionCookie => builder
            .header(reqwest::header::COOKIE, header_value)
            .header(reqwest::header::USER_AGENT, OPENCODE_USER_AGENT)
            .header(reqwest::header::ACCEPT, "text/html"),
    };
    if let Some(body) = request.body {
        builder = builder.body(body.to_string());
    }
    Ok(builder)
}

impl Transport for ReqwestTransport {
    async fn send(
        &self,
        request: &EndpointRequest<'_>,
        secret: &str,
    ) -> Result<TransportReply, TransportFailure> {
        let Some(client) = &self.client else {
            return Err(TransportFailure::Protocol);
        };
        let builder = authenticated_builder(client, request, secret)?;
        let response = builder.send().await.map_err(|error| classify(&error))?;
        let status = response.status().as_u16();
        let retry_after_seconds = parse_retry_after(response.headers());
        let discovered = location_workspace(response.headers());
        if !(200..=299).contains(&status) {
            /* Dropped unread: the connection is closed with the body still on
            the wire. The redirect target is not a body, and only one validated
            token of it survives. */
            return Ok(TransportReply {
                status,
                body: Vec::new(),
                retry_after_seconds,
                location_workspace: discovered,
            });
        }
        let mut body = Vec::new();
        let mut streaming = response;
        while let Some(chunk) = streaming.chunk().await.map_err(|error| classify(&error))? {
            if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(TransportFailure::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(TransportReply {
            status,
            body,
            retry_after_seconds,
            location_workspace: discovered,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reader_registry::{reader_route, CredentialKind, ProviderId};
    use crate::test_support::RecordingTransport;

    /// The authentication scheme each endpoint is really reached with, taken
    /// from the routing function rather than restated, so a test can never
    /// disagree with the product about which scheme an endpoint uses.
    fn auth_for(endpoint: ProviderEndpoint) -> AuthApplication {
        if endpoint == ProviderEndpoint::ClaudeOauthUsage {
            return AuthApplication::ClaudeOauthBearer;
        }
        for provider in ProviderId::ALL {
            for credential in CredentialKind::ALL {
                if let Ok(route) = reader_route(provider, credential) {
                    if route.endpoint == endpoint {
                        return route.auth;
                    }
                }
            }
        }
        panic!("every endpoint is reachable through a route");
    }

    fn secret_for(endpoint: ProviderEndpoint) -> String {
        if endpoint == ProviderEndpoint::CodexUsage {
            return "fake-codex-access-token".to_string();
        }
        "fake-secret-for-tests-only".to_string()
    }

    fn account_for(endpoint: ProviderEndpoint) -> Option<&'static str> {
        matches!(
            endpoint,
            ProviderEndpoint::CodexUsage | ProviderEndpoint::GrokUsage
        )
        .then_some("fake-account-id")
    }

    fn transport_for(
        endpoint: ProviderEndpoint,
        status: u16,
        body: Vec<u8>,
        retry_after_seconds: Option<u64>,
    ) -> RecordingTransport {
        if endpoint == ProviderEndpoint::AntigravityQuota && (200..=299).contains(&status) {
            RecordingTransport::scripted(vec![
                (
                    200,
                    br#"{"cloudaicompanionProject":"fixture-project-123"}"#.to_vec(),
                    None,
                ),
                (status, body, retry_after_seconds),
            ])
        } else {
            RecordingTransport::replying(status, body, retry_after_seconds)
        }
    }

    /* ------------------------------------------------------- the allowlist */

    #[tokio::test]
    async fn the_transport_double_sees_only_addresses_this_file_built() {
        let mut recorded_urls = Vec::new();
        for endpoint in ProviderEndpoint::ALL {
            let transport = transport_for(endpoint, 200, b"{}".to_vec(), None);
            let secret = secret_for(endpoint);
            fetch_endpoint(
                &transport,
                endpoint,
                auth_for(endpoint),
                &secret,
                account_for(endpoint),
            )
            .await
            .expect("fetch");
            recorded_urls.extend(transport.recorded_urls());
        }
        assert_eq!(
            recorded_urls,
            vec![
                OPENROUTER_KEY_URL.to_string(),
                OPENROUTER_CREDITS_URL.to_string(),
                CODEX_USAGE_URL.to_string(),
                ANTIGRAVITY_BOOTSTRAP_URL.to_string(),
                ANTIGRAVITY_QUOTA_URL.to_string(),
                /* Two hops, both built here from constants and one validated
                handle. */
                OPENCODE_AUTH_URL.to_string(),
                "https://opencode.ai/workspace/wrk_testworkspace/go".to_string(),
                CLAUDE_OAUTH_USAGE_URL.to_string(),
                GROK_USAGE_URL.to_string(),
                KIMI_USAGE_URL.to_string(),
            ]
        );
    }

    #[test]
    fn every_allowlisted_address_is_https() {
        /* Every address the process can reach, including the one built from a
        workspace handle, and none of them may be plain HTTP. */
        for endpoint in ProviderEndpoint::ALL {
            assert!(endpoint.url().starts_with("https://"));
        }
        let handle = WorkspaceHandle::parse("wrk_abc123").expect("a handle");
        assert!(handle
            .workspace_url()
            .starts_with("https://opencode.ai/workspace/"));
        assert!(handle.workspace_url().ends_with("/go"));
    }

    #[test]
    fn only_the_antigravity_reader_posts_and_its_first_body_is_fixed() {
        for endpoint in ProviderEndpoint::ALL {
            let expected_post = endpoint == ProviderEndpoint::AntigravityQuota;
            assert_eq!(endpoint.method() == HttpMethod::Post, expected_post);
            assert_eq!(endpoint.body().is_some(), expected_post);
        }
        assert_eq!(
            ProviderEndpoint::AntigravityQuota.body(),
            Some(ANTIGRAVITY_BOOTSTRAP_BODY)
        );
    }

    #[test]
    fn only_opencode_needs_a_second_hop() {
        for endpoint in ProviderEndpoint::ALL {
            assert_eq!(
                endpoint.needs_workspace(),
                endpoint == ProviderEndpoint::OpencodeUsage
            );
        }
    }

    #[tokio::test]
    async fn every_endpoint_is_reached_with_its_own_scheme_method_and_body() {
        for endpoint in ProviderEndpoint::ALL {
            let transport = transport_for(endpoint, 200, b"{}".to_vec(), None);
            let auth = auth_for(endpoint);
            let secret = secret_for(endpoint);
            fetch_endpoint(&transport, endpoint, auth, &secret, account_for(endpoint))
                .await
                .expect("fetch");
            for observed in transport.recorded_auths() {
                assert_eq!(
                    observed, auth,
                    "an endpoint was reached with another scheme"
                );
            }
            for observed in transport.recorded_methods() {
                assert_eq!(observed, endpoint.method());
            }
            let bodies = transport.recorded_bodies();
            if endpoint == ProviderEndpoint::AntigravityQuota {
                assert_eq!(bodies.len(), 2);
                assert_eq!(bodies[0].as_deref(), Some(ANTIGRAVITY_BOOTSTRAP_BODY));
                assert_eq!(
                    bodies[1].as_deref(),
                    Some(r#"{"project":"fixture-project-123"}"#)
                );
            } else {
                assert!(bodies.iter().all(Option::is_none));
            }
        }
    }

    #[tokio::test]
    async fn every_endpoint_is_handed_only_its_outbound_credential() {
        for endpoint in ProviderEndpoint::ALL {
            let transport = transport_for(endpoint, 200, b"{}".to_vec(), None);
            let stored = "the-stored-secret";
            fetch_endpoint(
                &transport,
                endpoint,
                auth_for(endpoint),
                stored,
                account_for(endpoint),
            )
            .await
            .expect("fetch");
            for observed in transport.recorded_secrets() {
                assert_eq!(observed, "the-stored-secret");
            }
        }
    }

    #[tokio::test]
    async fn codex_carries_the_real_account_id_beside_the_access_token() {
        let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
        fetch_endpoint(
            &transport,
            ProviderEndpoint::CodexUsage,
            AuthApplication::CodexSessionBearer,
            "access-token-canary",
            Some("account-id-canary"),
        )
        .await
        .expect("fetch");
        assert_eq!(transport.recorded_secrets(), vec!["access-token-canary"]);
        assert_eq!(
            transport.recorded_codex_account_ids(),
            vec![Some("account-id-canary".to_string())]
        );
    }

    #[test]
    fn the_codex_request_has_every_required_header_with_the_real_account_id() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::new();
        let request = EndpointRequest {
            url: CODEX_USAGE_URL,
            method: HttpMethod::Get,
            auth: AuthApplication::CodexSessionBearer,
            provider_account_id: Some("account-id-canary"),
            body: None,
        };
        let built = authenticated_builder(&client, &request, "access-token-canary")
            .expect("headers")
            .build()
            .expect("request");
        let headers = built.headers();
        assert_eq!(headers[CODEX_ACCOUNT_HEADER], "account-id-canary");
        assert_eq!(
            headers[reqwest::header::AUTHORIZATION],
            "Bearer access-token-canary"
        );
        assert_eq!(headers[reqwest::header::USER_AGENT], CODEX_USER_AGENT);
        assert_eq!(CODEX_USER_AGENT, OPENLIMITER_USER_AGENT);
        assert_eq!(headers[reqwest::header::ACCEPT], "application/json");
        assert!(headers[CODEX_ACCOUNT_HEADER].is_sensitive());
        assert!(headers[reqwest::header::AUTHORIZATION].is_sensitive());
    }

    #[test]
    fn the_grok_request_carries_only_the_fixed_contract_and_resolved_identity() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::new();
        let request = EndpointRequest {
            url: GROK_USAGE_URL,
            method: HttpMethod::Get,
            auth: AuthApplication::GrokSessionBearer,
            provider_account_id: Some("grok-user-canary"),
            body: None,
        };
        let built = authenticated_builder(&client, &request, "grok-token-canary")
            .expect("headers")
            .build()
            .expect("request");
        let headers = built.headers();
        assert_eq!(headers[GROK_ACCOUNT_HEADER], "grok-user-canary");
        assert_eq!(headers[GROK_TOKEN_AUTH_HEADER], GROK_TOKEN_AUTH_VALUE);
        assert_eq!(headers[reqwest::header::USER_AGENT], OPENLIMITER_USER_AGENT);
        assert!(headers[GROK_ACCOUNT_HEADER].is_sensitive());
    }

    #[test]
    fn the_claude_request_identifies_itself_and_states_the_oauth_contract() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::new();
        let request = EndpointRequest {
            url: CLAUDE_OAUTH_USAGE_URL,
            method: HttpMethod::Get,
            auth: AuthApplication::ClaudeOauthBearer,
            provider_account_id: None,
            body: None,
        };
        let built = authenticated_builder(&client, &request, "oauth-token-canary")
            .expect("headers")
            .build()
            .expect("request");
        let headers = built.headers();
        assert_eq!(
            headers[reqwest::header::AUTHORIZATION],
            "Bearer oauth-token-canary"
        );
        assert_eq!(
            headers[reqwest::header::USER_AGENT],
            CLAUDE_OAUTH_USER_AGENT
        );
        assert_eq!(headers[reqwest::header::ACCEPT], "application/json");
        assert_eq!(headers[CLAUDE_OAUTH_BETA_HEADER], CLAUDE_OAUTH_BETA_VALUE);
        assert!(headers[reqwest::header::AUTHORIZATION].is_sensitive());
    }

    #[test]
    fn every_third_party_request_identifies_openlimiter() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::new();
        for (auth, account) in [
            (AuthApplication::BearerAuthorization, None),
            (AuthApplication::ClaudeOauthBearer, None),
            (
                AuthApplication::CodexSessionBearer,
                Some("account-id-canary"),
            ),
            (AuthApplication::BrowserSessionCookie, None),
        ] {
            let request = EndpointRequest {
                url: OPENROUTER_KEY_URL,
                method: HttpMethod::Get,
                auth,
                provider_account_id: account,
                body: None,
            };
            let built = authenticated_builder(&client, &request, "credential-canary")
                .expect("headers")
                .build()
                .expect("request");
            assert_eq!(
                built.headers()[reqwest::header::USER_AGENT],
                OPENLIMITER_USER_AGENT,
                "{auth:?} did not identify OpenLimiter"
            );
        }
    }

    #[test]
    fn antigravity_requests_use_the_verified_client_identity() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::new();
        let request = EndpointRequest {
            url: ANTIGRAVITY_BOOTSTRAP_URL,
            method: HttpMethod::Post,
            auth: AuthApplication::AntigravitySessionBearer,
            codex_account_id: None,
            body: Some(ANTIGRAVITY_BOOTSTRAP_BODY),
        };
        let built = authenticated_builder(&client, &request, "credential-canary")
            .expect("headers")
            .build()
            .expect("request");
        assert_eq!(
            built.headers()[reqwest::header::USER_AGENT],
            ANTIGRAVITY_USER_AGENT
        );
        assert_eq!(
            built.headers()[reqwest::header::AUTHORIZATION],
            "Bearer credential-canary"
        );
        assert_eq!(
            built.body().and_then(reqwest::Body::as_bytes),
            Some(ANTIGRAVITY_BOOTSTRAP_BODY.as_bytes())
        );
    }

    /* -------------------------------------------------- the workspace hop */

    #[test]
    fn a_workspace_handle_refuses_everything_that_is_not_one() {
        /* The one non constant part of any address, so the hostile cases are
        stated rather than assumed: traversal, a host, a query, a scheme, an
        empty handle, a wrong prefix, and anything over the bound. */
        for hostile in [
            "",
            "wrk_",
            "workspace",
            "wrk-abc",
            "wrk_abc/../../evil",
            "wrk_abc?x=1",
            "wrk_abc#frag",
            "wrk_abc def",
            "https://evil.test/wrk_abc",
            "wrk_\u{e9}vil",
            "../wrk_abc",
        ] {
            assert!(
                WorkspaceHandle::parse(hostile).is_none(),
                "a hostile workspace handle was accepted"
            );
        }
        assert!(WorkspaceHandle::parse(&("wrk_".to_string() + &"a".repeat(61))).is_none());
        assert!(WorkspaceHandle::parse(&("wrk_".to_string() + &"a".repeat(60))).is_some());
        let handle = WorkspaceHandle::parse("wrk_Abc123").expect("a handle");
        assert_eq!(handle.as_str(), "wrk_Abc123");
    }

    #[test]
    fn a_redirect_target_yields_a_handle_or_nothing_at_all() {
        /* What the reader may learn from a redirect: one opaque token, and only
        when the target actually names a workspace. Everything else is a dead
        session, not a new address. */
        let accepted = [
            ("/workspace/wrk_abc123", "wrk_abc123"),
            ("/workspace/wrk_abc123/go", "wrk_abc123"),
            ("https://opencode.ai/workspace/wrk_abc123/go", "wrk_abc123"),
            ("/workspace/wrk_abc123?tab=go", "wrk_abc123"),
        ];
        for (target, expected) in accepted {
            assert_eq!(
                WorkspaceHandle::from_redirect_target(target).map(|it| it.as_str().to_string()),
                Some(expected.to_string())
            );
        }
        for refused in [
            "/auth",
            "https://auth.example.test/authorize?next=/workspace/",
            "/workspace/",
            "/workspace/not-a-handle",
            "/workspace/../../evil",
            "https://evil.test/",
            "",
        ] {
            assert!(
                WorkspaceHandle::from_redirect_target(refused).is_none(),
                "a redirect target named a workspace it should not have"
            );
        }
    }

    #[tokio::test]
    async fn an_entry_point_naming_no_workspace_is_an_authentication_status() {
        /* A dead OpenCode session: the entry point leads to a login rather than
        to a workspace. Reported as unauthenticated, with no body and with the
        second hop never made. */
        let transport = RecordingTransport::replying(302, b"<html>login</html>".to_vec(), None)
            .without_workspace();
        let outcome = fetch_endpoint(
            &transport,
            ProviderEndpoint::OpencodeUsage,
            auth_for(ProviderEndpoint::OpencodeUsage),
            "fake",
            None,
        )
        .await
        .expect("fetch");
        assert_eq!(outcome.status, OPENCODE_SESSION_DEAD_STATUS);
        assert_eq!(outcome.body, None);
        assert_eq!(
            transport.recorded_urls(),
            vec![OPENCODE_AUTH_URL.to_string()],
            "the second hop must not be made without a workspace"
        );
    }

    /* -------------------------------------------------------- the outcome */

    #[tokio::test]
    async fn success_body_comes_back_as_text() {
        let transport = RecordingTransport::replying(200, b"{\"data\":{}}".to_vec(), None);
        let outcome = fetch_endpoint(
            &transport,
            ProviderEndpoint::OpenrouterKey,
            AuthApplication::BearerAuthorization,
            "fake",
            None,
        )
        .await
        .expect("fetch");
        assert_eq!(outcome.status, 200);
        assert_eq!(outcome.body.as_deref(), Some("{\"data\":{}}"));
    }

    #[tokio::test]
    async fn failure_body_is_dropped_for_every_endpoint() {
        for endpoint in ProviderEndpoint::ALL {
            let transport = transport_for(
                endpoint,
                429,
                b"try later, THE-BODY-MARKER".to_vec(),
                Some(120),
            );
            let secret = secret_for(endpoint);
            let outcome = fetch_endpoint(
                &transport,
                endpoint,
                auth_for(endpoint),
                &secret,
                account_for(endpoint),
            )
            .await
            .expect("fetch");
            assert_eq!(outcome.body, None, "a failed body reached the caller");
            assert_eq!(outcome.retry_after_seconds, Some(120));
        }
    }

    #[tokio::test]
    async fn oversized_body_is_a_typed_rejection_for_every_endpoint() {
        for endpoint in ProviderEndpoint::ALL {
            let transport = transport_for(endpoint, 200, vec![b'x'; MAX_RESPONSE_BYTES + 1], None);
            let secret = secret_for(endpoint);
            let outcome = fetch_endpoint(
                &transport,
                endpoint,
                auth_for(endpoint),
                &secret,
                account_for(endpoint),
            )
            .await;
            assert_eq!(outcome, Err(NetError::TooLarge));
        }
    }

    #[tokio::test]
    async fn non_utf8_body_is_a_typed_rejection_for_every_endpoint() {
        for endpoint in ProviderEndpoint::ALL {
            let transport = transport_for(endpoint, 200, vec![0xff, 0xfe, 0x00], None);
            let secret = secret_for(endpoint);
            let outcome = fetch_endpoint(
                &transport,
                endpoint,
                auth_for(endpoint),
                &secret,
                account_for(endpoint),
            )
            .await;
            assert_eq!(outcome, Err(NetError::Protocol));
        }
    }

    /* ------------------------------------------------------------ hygiene */

    #[test]
    fn redirects_stay_disabled_and_the_client_speaks_https_only() {
        /* The builder's settings cannot be read back off a built client, so the
        guarantee is pinned against the source that sets it. A change here is a
        change to whether an allowlisted address can forward a credential. */
        let source = include_str!("net.rs");
        let head = source
            .split("mod tests")
            .next()
            .expect("the module has a body before its tests");
        assert!(head.contains("redirect(reqwest::redirect::Policy::none())"));
        assert!(head.contains("https_only(true)"));
        assert!(head.contains("timeout(Duration::from_secs(NETWORK_TIMEOUT_SECONDS))"));
    }

    #[test]
    fn no_address_is_assembled_from_anything_but_constants_and_a_handle() {
        /* The closure claim: the only string concatenation that produces a URL
        in this file is workspace_url, and it joins two constants around a
        validated handle. */
        let source = include_str!("net.rs");
        let head = source
            .split("mod tests")
            .next()
            .expect("the module has a body before its tests");
        assert_eq!(
            head.matches("https://").count(),
            11,
            "an address appeared outside the constants"
        );
    }

    #[test]
    fn every_net_error_sentence_is_fixed_and_redacted() {
        /* The variants carry no payload, so a planted secret, header, URL or
        body has nowhere to live; the exact sentences prove it per variant. */
        let cases = [
            (
                NetError::Timeout,
                "the provider did not answer within the time allowed",
            ),
            (NetError::Connect, "the provider could not be reached"),
            (
                NetError::Tls,
                "the secure connection to the provider could not be established",
            ),
            (
                NetError::Protocol,
                "the provider answered in a way this application does not speak",
            ),
            (
                NetError::TooLarge,
                "the provider answered with more data than this application accepts",
            ),
        ];
        for (error, sentence) in cases {
            assert_eq!(error.to_string(), sentence);
            for marker in [
                "SECRET-MARKER-4f9a-do-not-echo-1234",
                "Bearer SECRET-MARKER-4f9a-do-not-echo-1234",
                "THE-BODY-MARKER",
                OPENROUTER_KEY_URL,
                CODEX_USAGE_URL,
                ANTIGRAVITY_QUOTA_URL,
            ] {
                assert!(!error.to_string().contains(marker));
            }
        }
    }

    #[test]
    fn retry_after_parses_only_plain_seconds() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER, "120".parse().unwrap());
        assert_eq!(parse_retry_after(&headers), Some(120));
        headers.insert(
            reqwest::header::RETRY_AFTER,
            "Wed, 21 Oct 2026 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(parse_retry_after(&headers), None);
        headers.insert(reqwest::header::RETRY_AFTER, " 15 ".parse().unwrap());
        assert_eq!(parse_retry_after(&headers), Some(15));
        headers.insert(reqwest::header::RETRY_AFTER, "".parse().unwrap());
        assert_eq!(parse_retry_after(&headers), None);
    }

    #[test]
    fn a_location_header_yields_only_a_handle() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::LOCATION,
            "/workspace/wrk_abc123/go".parse().unwrap(),
        );
        assert_eq!(
            location_workspace(&headers).map(|it| it.as_str().to_string()),
            Some("wrk_abc123".to_string())
        );
        headers.insert(
            reqwest::header::LOCATION,
            "https://auth.example.test/authorize".parse().unwrap(),
        );
        assert_eq!(location_workspace(&headers), None);
        assert_eq!(location_workspace(&reqwest::header::HeaderMap::new()), None);
    }
}
