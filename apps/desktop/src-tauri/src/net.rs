use std::fmt;
use std::future::Future;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

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

/// The Codex usage report, read with the session the Codex client holds.
///
/// Evidence, recorded 2026-08-07 from a working reader and restated in
/// `provider_specs/openai/codex.yaml`: `GET`, bearer authorization, a product
/// user agent, and `Accept: application/json`. OpenAI publishes no consumer
/// quota API, so this is an internal endpoint and every surface says so.
pub const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

/// The Antigravity quota summary, on Google's metadata plane.
///
/// Evidence, recorded 2026-08-07: `POST` with an empty JSON object as the
/// body, bearer authorization, and a NON EMPTY user agent. The user agent is
/// not decoration: the same valid token answers 403 without one.
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
/// One variant is not one request. `OpencodeUsage` owns two constant addresses
/// because reading that provider takes two hops: the entry point names the
/// workspace, and the workspace page carries the meters. Both addresses are
/// built here, from constants here, and the workspace handle between them is a
/// `WorkspaceHandle`, whose only constructor refuses anything that is not the
/// provider's own opaque token. Nothing outside this file, and in particular
/// nothing arriving over IPC, from YAML, or from a provider response body, can
/// widen or redirect either address.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderEndpoint {
    OpenrouterKey,
    OpenrouterCredits,
    CodexUsage,
    AntigravityQuota,
    OpencodeUsage,
}

impl ProviderEndpoint {
    /// The whole allowlist, for the tests that prove it closed. The product
    /// itself never needs the list, only a variant at a time.
    pub const ALL: [ProviderEndpoint; 5] = [
        ProviderEndpoint::OpenrouterKey,
        ProviderEndpoint::OpenrouterCredits,
        ProviderEndpoint::CodexUsage,
        ProviderEndpoint::AntigravityQuota,
        ProviderEndpoint::OpencodeUsage,
    ];

    /// The address the first request of this endpoint goes to.
    ///
    /// For four of the five that is the whole endpoint. For `OpencodeUsage` it
    /// is the entry point, and `workspace_url` below builds the second hop.
    pub const fn url(self) -> &'static str {
        match self {
            ProviderEndpoint::OpenrouterKey => OPENROUTER_KEY_URL,
            ProviderEndpoint::OpenrouterCredits => OPENROUTER_CREDITS_URL,
            ProviderEndpoint::CodexUsage => CODEX_USAGE_URL,
            ProviderEndpoint::AntigravityQuota => ANTIGRAVITY_QUOTA_URL,
            ProviderEndpoint::OpencodeUsage => OPENCODE_AUTH_URL,
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
            | ProviderEndpoint::OpencodeUsage => HttpMethod::Get,
            ProviderEndpoint::AntigravityQuota => HttpMethod::Post,
        }
    }

    /// The request body, when the endpoint demands one. A constant, so no
    /// caller supplied bytes ever leave this process.
    pub const fn body(self) -> Option<&'static str> {
        match self {
            ProviderEndpoint::AntigravityQuota => Some(ANTIGRAVITY_EMPTY_BODY),
            ProviderEndpoint::OpenrouterKey
            | ProviderEndpoint::OpenrouterCredits
            | ProviderEndpoint::CodexUsage
            | ProviderEndpoint::OpencodeUsage => None,
        }
    }
}

/// The empty JSON object the quota summary expects as its whole request body.
pub const ANTIGRAVITY_EMPTY_BODY: &str = "{}";

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

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What a transport hands back. The body is present only for a status in the
/// 200 range; the transport drops every other body without reading it.
pub struct TransportReply {
    pub status: u16,
    pub body: Vec<u8>,
    pub retry_after_seconds: Option<u64>,
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

/// The one verb the subsystem needs from HTTP, behind a trait so tests inject
/// a recording double and no test ever opens a socket. The URL parameter is
/// `&'static str` on purpose: only the constants above can be handed in.
pub trait Transport: Send + Sync {
    fn get(
        &self,
        url: &'static str,
        bearer_secret: &str,
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
    secret: &str,
) -> Result<EndpointOutcome, NetError> {
    let reply = transport
        .get(endpoint.url(), secret)
        .await
        .map_err(NetError::from)?;
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

impl Transport for ReqwestTransport {
    async fn get(
        &self,
        url: &'static str,
        bearer_secret: &str,
    ) -> Result<TransportReply, TransportFailure> {
        let Some(client) = &self.client else {
            return Err(TransportFailure::Protocol);
        };
        /* The header buffer is built without reallocation and zeroized on
        drop. reqwest's own copy is marked sensitive so it never appears in
        debug output. */
        let mut bearer =
            Zeroizing::new(String::with_capacity("Bearer ".len() + bearer_secret.len()));
        bearer.push_str("Bearer ");
        bearer.push_str(bearer_secret);
        let mut authorization = reqwest::header::HeaderValue::from_str(&bearer)
            .map_err(|_| TransportFailure::Protocol)?;
        authorization.set_sensitive(true);
        let response = client
            .get(url)
            .header(reqwest::header::AUTHORIZATION, authorization)
            .send()
            .await
            .map_err(|error| classify(&error))?;
        let status = response.status().as_u16();
        let retry_after_seconds = parse_retry_after(response.headers());
        if !(200..=299).contains(&status) {
            /* Dropped unread: the connection is closed with the body still on
            the wire. */
            return Ok(TransportReply {
                status,
                body: Vec::new(),
                retry_after_seconds,
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
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::RecordingTransport;

    #[tokio::test]
    async fn transport_double_sees_only_the_constant_urls() {
        let transport = RecordingTransport::replying(200, b"{}".to_vec(), None);
        for endpoint in ProviderEndpoint::ALL {
            fetch_endpoint(&transport, endpoint, "fake-secret-for-tests-only")
                .await
                .expect("fetch");
        }
        assert_eq!(
            transport.recorded_urls(),
            vec![
                OPENROUTER_KEY_URL,
                OPENROUTER_CREDITS_URL,
                CODEX_USAGE_URL,
                ANTIGRAVITY_QUOTA_URL,
                OPENCODE_AUTH_URL
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
        assert!(handle.workspace_url().starts_with("https://opencode.ai/workspace/"));
        assert!(handle.workspace_url().ends_with("/go"));
    }

    #[test]
    fn only_the_quota_summary_posts_and_only_it_carries_a_body() {
        for endpoint in ProviderEndpoint::ALL {
            let expected_post = endpoint == ProviderEndpoint::AntigravityQuota;
            assert_eq!(endpoint.method() == HttpMethod::Post, expected_post);
            assert_eq!(endpoint.body().is_some(), expected_post);
        }
        assert_eq!(
            ProviderEndpoint::AntigravityQuota.body(),
            Some(ANTIGRAVITY_EMPTY_BODY)
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
            "wrk_évil",
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

    #[tokio::test]
    async fn success_body_comes_back_as_text() {
        let transport = RecordingTransport::replying(200, b"{\"data\":{}}".to_vec(), None);
        let outcome = fetch_endpoint(&transport, ProviderEndpoint::OpenrouterKey, "fake")
            .await
            .expect("fetch");
        assert_eq!(outcome.status, 200);
        assert_eq!(outcome.body.as_deref(), Some("{\"data\":{}}"));
    }

    #[tokio::test]
    async fn failure_body_is_dropped() {
        let transport =
            RecordingTransport::replying(429, b"try later, THE-BODY-MARKER".to_vec(), Some(120));
        let outcome = fetch_endpoint(&transport, ProviderEndpoint::OpenrouterKey, "fake")
            .await
            .expect("fetch");
        assert_eq!(outcome.status, 429);
        assert_eq!(outcome.body, None);
        assert_eq!(outcome.retry_after_seconds, Some(120));
    }

    #[tokio::test]
    async fn oversized_body_is_a_typed_rejection() {
        let transport = RecordingTransport::replying(200, vec![b'x'; MAX_RESPONSE_BYTES + 1], None);
        let outcome = fetch_endpoint(&transport, ProviderEndpoint::OpenrouterKey, "fake").await;
        assert_eq!(outcome, Err(NetError::TooLarge));
    }

    #[tokio::test]
    async fn non_utf8_body_is_a_typed_rejection() {
        let transport = RecordingTransport::replying(200, vec![0xff, 0xfe, 0x00], None);
        let outcome = fetch_endpoint(&transport, ProviderEndpoint::OpenrouterKey, "fake").await;
        assert_eq!(outcome, Err(NetError::Protocol));
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
}
