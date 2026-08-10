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

/// Every address this process may speak to. Adding a provider means adding a
/// variant here, in code, in review; nothing at runtime can.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderEndpoint {
    OpenrouterKey,
    OpenrouterCredits,
}

impl ProviderEndpoint {
    /// The whole allowlist, for the tests that prove it closed. The product
    /// itself never needs the list, only a variant at a time.
    #[cfg(test)]
    pub const ALL: [ProviderEndpoint; 2] = [
        ProviderEndpoint::OpenrouterKey,
        ProviderEndpoint::OpenrouterCredits,
    ];

    pub const fn url(self) -> &'static str {
        match self {
            ProviderEndpoint::OpenrouterKey => OPENROUTER_KEY_URL,
            ProviderEndpoint::OpenrouterCredits => OPENROUTER_CREDITS_URL,
        }
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
    Protocol,
    TooLarge,
}

impl fmt::Display for NetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sentence = match self {
            NetError::Timeout => "the provider did not answer within the time allowed",
            NetError::Connect => "the provider could not be reached",
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
    if error.is_connect() {
        return TransportFailure::Connect;
    }
    TransportFailure::Protocol
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
            vec![OPENROUTER_KEY_URL, OPENROUTER_CREDITS_URL]
        );
    }

    #[test]
    fn every_allowlisted_url_is_https_openrouter() {
        for endpoint in ProviderEndpoint::ALL {
            assert!(endpoint.url().starts_with("https://openrouter.ai/"));
        }
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
