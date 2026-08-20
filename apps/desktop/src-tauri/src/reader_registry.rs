use std::fmt;

use serde::{Deserialize, Serialize};

use crate::net::ProviderEndpoint;

/// Which provider, which reader, which credential: three closed vocabularies
/// and one function that pairs them.
///
/// The audit's second largest risk was a confused deputy: the webview used to
/// hand a stored secret and a caller chosen endpoint to the same probe, so a
/// person's OpenRouter management key could be pointed at any address in the
/// allowlist. This module removes the choice. A connection record states which
/// provider it belongs to and which kind of credential it holds, and
/// `reader_route` is the only thing in the process that can turn that pair into
/// an address and an authentication scheme.
///
/// Every enum here is closed and serializes as the exact snake case identifier
/// the provider registry publishes in its `collection` block, so the YAML, the
/// Rust, and the TypeScript all spell one identifier one way. A value outside
/// the vocabulary does not deserialize, which is why a tampered connections
/// file is a typed refusal rather than a request to somewhere new.
///
/// The route function is exhaustive by construction: it matches the provider
/// and then matches the credential kind inside each arm, with no wildcard, so
/// adding a variant to either enum stops the build until the new pairing has
/// been decided in review.

/// The providers this build can hold a live connection for.
///
/// Shorter than `PROVIDER_CODES` in `packages/core/src/types.ts:1-8` on
/// purpose: CLAUDE is read from a local statusline payload and MANUAL is a
/// document a person maintains, so neither has a credential or an endpoint and
/// neither belongs in a routing table.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId {
    Openrouter,
    Codex,
    Antigravity,
    Opencode,
    Grok,
    Kimi,
}

impl ProviderId {
    /// The whole vocabulary, for the tests that must exhaust every pairing.
    /* Exhaustive lists and the reverse lookups over them exist for the tests
    that must sweep every pairing. The product itself only ever holds one
    variant at a time, so they are dead code outside a test build and are
    marked as such rather than deleted: the sweep is the security property. */
    #[cfg_attr(not(test), allow(dead_code))]
    pub const ALL: [ProviderId; 6] = [
        ProviderId::Openrouter,
        ProviderId::Codex,
        ProviderId::Antigravity,
        ProviderId::Opencode,
        ProviderId::Grok,
        ProviderId::Kimi,
    ];

    /// The uppercase provider code the TypeScript engine speaks, so a record
    /// and a snapshot row name one provider with one word.
    #[cfg_attr(not(test), allow(dead_code))]
    pub const fn code(self) -> &'static str {
        match self {
            ProviderId::Openrouter => "OPENROUTER",
            ProviderId::Codex => "CODEX",
            ProviderId::Antigravity => "ANTIGRAVITY",
            ProviderId::Opencode => "OPENCODE",
            ProviderId::Grok => "GROK",
            ProviderId::Kimi => "KIMI",
        }
    }
}

/// Which reader carried an observation. The TypeScript side selects its parser
/// by this value and by nothing else, so a body is never handed to a parser
/// that was written for another provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReaderId {
    OpenrouterKey,
    OpenrouterCredits,
    CodexUsage,
    AntigravityQuota,
    OpencodeUsage,
    GrokUsage,
    KimiUsage,
}

/// A source's scheduling shape, without pretending every source has a timer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchedulePolicy {
    EventDriven,
    Interval { base_seconds: u64 },
    ExplicitOnly,
}

impl SchedulePolicy {
    /// The trusted interval only when this policy actually has one.
    pub const fn interval_seconds(self) -> Option<u64> {
        match self {
            SchedulePolicy::EventDriven | SchedulePolicy::ExplicitOnly => None,
            SchedulePolicy::Interval { base_seconds } => Some(base_seconds),
        }
    }
}

/// Every source the native scheduler must reason about.
///
/// Claude has no `ReaderId` and no connection record. Naming it here is how
/// the scheduler can prove that the statusline event never becomes a poll.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CollectionSource {
    #[cfg_attr(not(test), allow(dead_code))]
    ClaudeStatusline,
    Reader(ReaderId),
}

impl CollectionSource {
    pub const fn schedule_policy(self) -> SchedulePolicy {
        match self {
            CollectionSource::ClaudeStatusline => SchedulePolicy::EventDriven,
            CollectionSource::Reader(ReaderId::OpencodeUsage) => SchedulePolicy::ExplicitOnly,
            CollectionSource::Reader(reader) => SchedulePolicy::Interval {
                base_seconds: reader.base_seconds(),
            },
        }
    }
}

impl ReaderId {
    /* Exhaustive lists and the reverse lookups over them exist for the tests
    that must sweep every pairing. The product itself only ever holds one
    variant at a time, so they are dead code outside a test build and are
    marked as such rather than deleted: the sweep is the security property. */
    #[cfg_attr(not(test), allow(dead_code))]
    pub const ALL: [ReaderId; 7] = [
        ReaderId::OpenrouterKey,
        ReaderId::OpenrouterCredits,
        ReaderId::CodexUsage,
        ReaderId::AntigravityQuota,
        ReaderId::OpencodeUsage,
        ReaderId::GrokUsage,
        ReaderId::KimiUsage,
    ];

    /// Which provider this reader belongs to, so a record's reader and its
    /// provider can be checked against each other rather than trusted.
    #[cfg_attr(not(test), allow(dead_code))]
    pub const fn provider(self) -> ProviderId {
        match self {
            ReaderId::OpenrouterKey | ReaderId::OpenrouterCredits => ProviderId::Openrouter,
            ReaderId::CodexUsage => ProviderId::Codex,
            ReaderId::AntigravityQuota => ProviderId::Antigravity,
            ReaderId::OpencodeUsage => ProviderId::Opencode,
            ReaderId::GrokUsage => ProviderId::Grok,
            ReaderId::KimiUsage => ProviderId::Kimi,
        }
    }

    /// The trusted background cadence for this reader, in seconds.
    ///
    /// Zero is the explicit schedule exemption used by OpenCode. Its session
    /// is browser held and HTTP only, so collection happens only when a person
    /// asks for it. Local Claude observations do not have a `ReaderId` or a
    /// connection record at all: they arrive through the statusline event.
    pub const fn base_seconds(self) -> u64 {
        match self {
            ReaderId::OpenrouterKey
            | ReaderId::OpenrouterCredits
            | ReaderId::CodexUsage
            | ReaderId::GrokUsage
            | ReaderId::KimiUsage => 300,
            ReaderId::AntigravityQuota => 600,
            ReaderId::OpencodeUsage => 0,
        }
    }
}

/// Largest key shaped secret accepted, in bytes. Real provider keys and access
/// tokens are well under two hundred bytes; four kibibytes is generosity.
pub const MAX_KEY_SECRET_BYTES: usize = 4_096;

/// Largest browser session accepted, in bytes. A Cookie header carries several
/// signed values at once, so it is measured in kilobytes rather than hundreds
/// of bytes. See `CredentialKind::max_secret_bytes` for why this is not one
/// number for everything.
pub const MAX_BROWSER_SESSION_BYTES: usize = 16_384;

/// What kind of secret a connection holds.
///
/// The kind is not decoration: it decides the address the secret may be sent
/// to and the header it may be written into. An OpenRouter inference key and
/// an OpenRouter management key read different endpoints; a Codex session is a
/// bearer token for one host and nothing else; an OpenCode browser session is
/// a cookie, which is the least trustworthy credential in the product and is
/// labelled that way on every surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    OpenrouterInferenceKey,
    OpenrouterManagementKey,
    CodexSession,
    AntigravitySession,
    OpencodeBrowserSession,
    GrokSession,
    KimiSession,
}

impl CredentialKind {
    /* Exhaustive lists and the reverse lookups over them exist for the tests
    that must sweep every pairing. The product itself only ever holds one
    variant at a time, so they are dead code outside a test build and are
    marked as such rather than deleted: the sweep is the security property. */
    #[cfg_attr(not(test), allow(dead_code))]
    pub const ALL: [CredentialKind; 7] = [
        CredentialKind::OpenrouterInferenceKey,
        CredentialKind::OpenrouterManagementKey,
        CredentialKind::CodexSession,
        CredentialKind::AntigravitySession,
        CredentialKind::OpencodeBrowserSession,
        CredentialKind::GrokSession,
        CredentialKind::KimiSession,
    ];

    /// The largest secret of this kind that will be accepted, in bytes.
    ///
    /// Per kind, because the kinds are not the same shape of thing. An API key
    /// or an access token is a compact string and four kibibytes is already
    /// generous for one. A browser session is a whole Cookie header, which
    /// carries several signed values at once and is routinely several
    /// kilobytes, so holding it to a key's bound would refuse perfectly
    /// ordinary real sessions.
    ///
    /// Sixteen kibibytes is a bound, not a target. Anything above it is refused
    /// with the ordinary fixed error and NEVER truncated: half a cookie is not
    /// a smaller cookie, it is a credential that fails authentication in a way
    /// nobody can debug, and a silently shortened secret is the worst outcome
    /// available here.
    pub const fn max_secret_bytes(self) -> usize {
        match self {
            CredentialKind::OpencodeBrowserSession => MAX_BROWSER_SESSION_BYTES,
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession => MAX_KEY_SECRET_BYTES,
        }
    }

    /// The one provider this kind of credential can ever belong to.
    #[cfg_attr(not(test), allow(dead_code))]
    pub const fn provider(self) -> ProviderId {
        match self {
            CredentialKind::OpenrouterInferenceKey | CredentialKind::OpenrouterManagementKey => {
                ProviderId::Openrouter
            }
            CredentialKind::CodexSession => ProviderId::Codex,
            CredentialKind::AntigravitySession => ProviderId::Antigravity,
            CredentialKind::OpencodeBrowserSession => ProviderId::Opencode,
            CredentialKind::GrokSession => ProviderId::Grok,
            CredentialKind::KimiSession => ProviderId::Kimi,
        }
    }
}

/// How the stored secret is applied to a request.
///
/// Named schemes rather than a header map, because a header map is a hole: it
/// would let a caller, a YAML file, or a provider response decide where a
/// secret is written. Each variant is implemented once, in `net.rs`, against
/// constants that live in `net.rs`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthApplication {
    /// `Authorization: Bearer <secret>` with the OpenLimiter identity and JSON
    /// response preference. The OpenRouter path.
    BearerAuthorization,
    /// A bearer token plus the fixed OAuth usage contract headers Claude Code uses.
    ClaudeOauthBearer,
    /// A bearer token plus the fixed account header the ChatGPT backend
    /// requires, while identifying the request as OpenLimiter.
    CodexSessionBearer,
    /// A bearer token plus a non empty user agent. Not optional: the Google
    /// metadata plane answers 403 to a valid token when the header is absent,
    /// which was measured on 2026-08-07 and cost an hour of blaming the login.
    AntigravitySessionBearer,
    /// A bearer token plus the Grok user identity and fixed client marker.
    GrokSessionBearer,
    /// A bearer token read from the official Kimi CLI credential file.
    KimiSessionBearer,
    /// Gemini CLI's Google OAuth bearer token with JSON request headers and
    /// the OpenLimiter identity. This scheme is used only by the two constant
    /// Code Assist quota addresses in `net.rs`.
    GeminiCliBearer,
    /// `Cookie: <secret>` with the OpenLimiter identity. The authenticated page
    /// path, and the reason OpenCode is permanently labelled an authenticated
    /// scrape.
    BrowserSessionCookie,
}

/// Everything a probe needs, and nothing it could be talked out of.
///
/// There is no URL field and no header map here on purpose. `endpoint` is a
/// closed enum whose addresses are constants, and `auth` is a closed scheme
/// implemented against constants, so the whole reachable surface of one probe
/// is decided in this file and in `net.rs`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ReaderRoute {
    pub reader_id: ReaderId,
    pub endpoint: ProviderEndpoint,
    pub auth: AuthApplication,
}

/// The one way routing can fail: a credential that does not belong to the
/// provider it was filed under. Payload free, one fixed sentence, because a
/// routing error is exactly where a URL or a credential would leak if it could.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RouteError {
    CredentialProviderMismatch,
}

impl fmt::Display for RouteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("this credential kind does not belong to this provider")
    }
}

/// The only function in the process that turns identity into an address.
///
/// Exhaustive with no wildcard arm: the provider is matched, and inside each
/// arm every credential kind is named, so the fifteen wrong pairings are
/// refused by a match arm somebody wrote rather than by a default nobody read.
/// Adding a provider or a credential kind fails the build here first.
pub const fn reader_route(
    provider: ProviderId,
    credential: CredentialKind,
) -> Result<ReaderRoute, RouteError> {
    let mismatch = Err(RouteError::CredentialProviderMismatch);
    match provider {
        ProviderId::Openrouter => match credential {
            CredentialKind::OpenrouterInferenceKey => Ok(ReaderRoute {
                reader_id: ReaderId::OpenrouterKey,
                endpoint: ProviderEndpoint::OpenrouterKey,
                auth: AuthApplication::BearerAuthorization,
            }),
            CredentialKind::OpenrouterManagementKey => Ok(ReaderRoute {
                reader_id: ReaderId::OpenrouterCredits,
                endpoint: ProviderEndpoint::OpenrouterCredits,
                auth: AuthApplication::BearerAuthorization,
            }),
            CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession => mismatch,
        },
        ProviderId::Codex => match credential {
            CredentialKind::CodexSession => Ok(ReaderRoute {
                reader_id: ReaderId::CodexUsage,
                endpoint: ProviderEndpoint::CodexUsage,
                auth: AuthApplication::CodexSessionBearer,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession => mismatch,
        },
        ProviderId::Antigravity => match credential {
            CredentialKind::AntigravitySession => Ok(ReaderRoute {
                reader_id: ReaderId::AntigravityQuota,
                endpoint: ProviderEndpoint::AntigravityQuota,
                auth: AuthApplication::AntigravitySessionBearer,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession => mismatch,
        },
        ProviderId::Opencode => match credential {
            CredentialKind::OpencodeBrowserSession => Ok(ReaderRoute {
                reader_id: ReaderId::OpencodeUsage,
                endpoint: ProviderEndpoint::OpencodeUsage,
                auth: AuthApplication::BrowserSessionCookie,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession => mismatch,
        },
        ProviderId::Grok => match credential {
            CredentialKind::GrokSession => Ok(ReaderRoute {
                reader_id: ReaderId::GrokUsage,
                endpoint: ProviderEndpoint::GrokUsage,
                auth: AuthApplication::GrokSessionBearer,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::KimiSession => mismatch,
        },
        ProviderId::Kimi => match credential {
            CredentialKind::KimiSession => Ok(ReaderRoute {
                reader_id: ReaderId::KimiUsage,
                endpoint: ProviderEndpoint::KimiUsage,
                auth: AuthApplication::KimiSessionBearer,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::GrokSession => mismatch,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_and_credential_pairing_is_decided() {
        /* Twenty pairings, and each one has exactly one right answer: five
        route, fifteen are refused. A pairing that neither routed nor was
        refused would mean a wildcard arm had crept in. */
        let mut routed = 0usize;
        let mut refused = 0usize;
        for provider in ProviderId::ALL {
            for credential in CredentialKind::ALL {
                match reader_route(provider, credential) {
                    Ok(route) => {
                        routed += 1;
                        assert_eq!(
                            credential.provider(),
                            provider,
                            "a route may only exist when the credential belongs to the provider"
                        );
                        assert_eq!(
                            route.reader_id.provider(),
                            provider,
                            "a route's reader must belong to the routed provider"
                        );
                    }
                    Err(error) => {
                        refused += 1;
                        assert_eq!(error, RouteError::CredentialProviderMismatch);
                        assert_ne!(credential.provider(), provider);
                    }
                }
            }
        }
        assert_eq!(routed, 7);
        assert_eq!(refused, 35);
        assert_eq!(
            routed + refused,
            ProviderId::ALL.len() * CredentialKind::ALL.len()
        );
    }

    #[test]
    fn every_reader_is_reachable_exactly_once() {
        /* No reader is orphaned and no two pairings land on the same reader:
        that is what makes the reader id a usable parser selector. */
        let mut seen: Vec<ReaderId> = Vec::new();
        for provider in ProviderId::ALL {
            for credential in CredentialKind::ALL {
                if let Ok(route) = reader_route(provider, credential) {
                    assert!(
                        !seen.contains(&route.reader_id),
                        "a reader was routed twice"
                    );
                    seen.push(route.reader_id);
                }
            }
        }
        for reader in ReaderId::ALL {
            assert!(seen.contains(&reader), "a reader is unreachable");
        }
    }

    #[test]
    fn every_route_endpoint_is_distinct() {
        let mut seen: Vec<ProviderEndpoint> = Vec::new();
        for provider in ProviderId::ALL {
            for credential in CredentialKind::ALL {
                if let Ok(route) = reader_route(provider, credential) {
                    assert!(
                        !seen.contains(&route.endpoint),
                        "two credentials reached one endpoint"
                    );
                    seen.push(route.endpoint);
                }
            }
        }
        assert_eq!(seen.len(), ReaderId::ALL.len());
    }

    #[test]
    fn identifiers_serialize_as_the_registry_spells_them() {
        /* The provider registry's `collection` block publishes these exact
        strings. One spelling, three languages. */
        let pairs = [
            (
                serde_json::to_string(&ProviderId::Openrouter).unwrap(),
                "\"openrouter\"",
            ),
            (
                serde_json::to_string(&ReaderId::CodexUsage).unwrap(),
                "\"codex_usage\"",
            ),
            (
                serde_json::to_string(&ReaderId::AntigravityQuota).unwrap(),
                "\"antigravity_quota\"",
            ),
            (
                serde_json::to_string(&ReaderId::OpencodeUsage).unwrap(),
                "\"opencode_usage\"",
            ),
            (
                serde_json::to_string(&CredentialKind::OpencodeBrowserSession).unwrap(),
                "\"opencode_browser_session\"",
            ),
            (
                serde_json::to_string(&CredentialKind::OpenrouterManagementKey).unwrap(),
                "\"openrouter_management_key\"",
            ),
        ];
        for (actual, expected) in pairs {
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn the_uppercase_codes_are_the_ones_the_engine_speaks() {
        /* The desktop window uppercases a record's provider id to reach the
        engine's PROVIDER_CODES vocabulary, so the two spellings have to be one
        another exactly. A mismatch here is a provider whose rows key under a
        name no surface looks for. */
        let pairs = [
            (ProviderId::Openrouter, "OPENROUTER"),
            (ProviderId::Codex, "CODEX"),
            (ProviderId::Antigravity, "ANTIGRAVITY"),
            (ProviderId::Opencode, "OPENCODE"),
        ];
        for (provider, code) in pairs {
            assert_eq!(provider.code(), code);
            let wire = serde_json::to_string(&provider).expect("serializable");
            assert_eq!(wire.to_uppercase(), format!("\"{code}\""));
        }
    }

    #[test]
    fn every_reader_has_the_frozen_cadence() {
        let expected = [
            (ReaderId::OpenrouterKey, 300),
            (ReaderId::OpenrouterCredits, 300),
            (ReaderId::CodexUsage, 300),
            (ReaderId::AntigravityQuota, 600),
            (ReaderId::OpencodeUsage, 0),
        ];
        for (reader, seconds) in expected {
            assert_eq!(reader.base_seconds(), seconds);
        }
    }

    #[test]
    fn codex_refresh_is_a_read_surface_and_never_inference() {
        let route = reader_route(ProviderId::Codex, CredentialKind::CodexSession)
            .expect("Codex session route");
        assert_eq!(route.reader_id, ReaderId::CodexUsage);
        assert_eq!(route.endpoint, ProviderEndpoint::CodexUsage);
        assert_eq!(route.endpoint.method(), crate::net::HttpMethod::Get);
        assert_eq!(route.endpoint.body(), None);
    }

    #[test]
    fn only_a_browser_session_gets_the_larger_bound() {
        for credential in CredentialKind::ALL {
            let expected = if credential == CredentialKind::OpencodeBrowserSession {
                MAX_BROWSER_SESSION_BYTES
            } else {
                MAX_KEY_SECRET_BYTES
            };
            assert_eq!(credential.max_secret_bytes(), expected);
        }
        assert!(MAX_BROWSER_SESSION_BYTES > MAX_KEY_SECRET_BYTES);
    }

    #[test]
    fn an_identifier_outside_the_vocabulary_does_not_deserialize() {
        assert!(serde_json::from_str::<ProviderId>("\"evilcorp\"").is_err());
        assert!(serde_json::from_str::<ReaderId>("\"arbitrary_url\"").is_err());
        assert!(serde_json::from_str::<CredentialKind>("\"browser_cookie\"").is_err());
    }

    #[test]
    fn the_route_function_carries_no_wildcard_arm() {
        /* The exhaustiveness claim, checked against the source: a wildcard in
        this file would let a future variant route somewhere by accident
        instead of failing the build. */
        let source = include_str!("reader_registry.rs");
        let head = source
            .split("mod tests")
            .next()
            .expect("the module has a body before its tests");
        assert!(!head.contains("_ =>"));
        assert!(!head.contains("_ if"));
    }

    #[test]
    fn the_route_error_sentence_is_fixed_and_redacted() {
        let sentence = RouteError::CredentialProviderMismatch.to_string();
        for marker in [
            "SECRET-MARKER-4f9a-do-not-echo-1234",
            "https://",
            "Authorization",
            "Cookie",
        ] {
            assert!(!sentence.contains(marker));
        }
    }
}
