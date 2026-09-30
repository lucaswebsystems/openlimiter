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
    Cursor,
    /* The 2.1 HTTP providers, routed below and refused while switched off. The
    command line providers (Augment, Amp, Kilo, Copilot) hold no credential and
    call no endpoint, so like Claude they have no entry here. */
    Synthetic,
    Zai,
    Minimax,
    Cline,
}

impl ProviderId {
    /// The whole vocabulary, for the tests that must exhaust every pairing.
    /* Exhaustive lists and the reverse lookups over them exist for the tests
    that must sweep every pairing. The product itself only ever holds one
    variant at a time, so they are dead code outside a test build and are
    marked as such rather than deleted: the sweep is the security property. */
    #[cfg_attr(not(test), allow(dead_code))]
    pub const ALL: [ProviderId; 11] = [
        ProviderId::Openrouter,
        ProviderId::Codex,
        ProviderId::Antigravity,
        ProviderId::Opencode,
        ProviderId::Grok,
        ProviderId::Kimi,
        ProviderId::Cursor,
        ProviderId::Synthetic,
        ProviderId::Zai,
        ProviderId::Minimax,
        ProviderId::Cline,
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
            ProviderId::Cursor => "CURSOR",
            ProviderId::Synthetic => "SYNTHETIC",
            ProviderId::Zai => "ZAI",
            ProviderId::Minimax => "MINIMAX",
            ProviderId::Cline => "CLINE",
        }
    }

    /// Whether this build has switched the provider on. One switch, read from
    /// the detected provider it is, so the route table and detection agree.
    pub const fn enabled(self) -> bool {
        crate::poll_identity::detected_provider(self).enabled()
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
    CursorUsage,
    SyntheticQuotas,
    ZaiQuota,
    MinimaxTokenPlan,
    ClineBalance,
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
    pub const ALL: [ReaderId; 12] = [
        ReaderId::OpenrouterKey,
        ReaderId::OpenrouterCredits,
        ReaderId::CodexUsage,
        ReaderId::AntigravityQuota,
        ReaderId::OpencodeUsage,
        ReaderId::GrokUsage,
        ReaderId::KimiUsage,
        ReaderId::CursorUsage,
        ReaderId::SyntheticQuotas,
        ReaderId::ZaiQuota,
        ReaderId::MinimaxTokenPlan,
        ReaderId::ClineBalance,
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
            ReaderId::CursorUsage => ProviderId::Cursor,
            ReaderId::SyntheticQuotas => ProviderId::Synthetic,
            ReaderId::ZaiQuota => ProviderId::Zai,
            ReaderId::MinimaxTokenPlan => ProviderId::Minimax,
            ReaderId::ClineBalance => ProviderId::Cline,
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
            | ReaderId::KimiUsage
            | ReaderId::CursorUsage => 300,
            ReaderId::AntigravityQuota => 600,
            ReaderId::OpencodeUsage => 0,
            /* Each 2.1 reader keeps the cadence its own module states. */
            ReaderId::SyntheticQuotas => crate::providers::synthetic::INTERVAL_SECONDS,
            ReaderId::ZaiQuota => crate::providers::zai::INTERVAL_SECONDS,
            ReaderId::MinimaxTokenPlan => crate::providers::minimax::INTERVAL_SECONDS,
            ReaderId::ClineBalance => crate::providers::cline::INTERVAL_SECONDS,
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
    CursorSession,
    SyntheticKey,
    ZaiKey,
    MinimaxKey,
    ClineAccountToken,
}

impl CredentialKind {
    /* Exhaustive lists and the reverse lookups over them exist for the tests
    that must sweep every pairing. The product itself only ever holds one
    variant at a time, so they are dead code outside a test build and are
    marked as such rather than deleted: the sweep is the security property. */
    #[cfg_attr(not(test), allow(dead_code))]
    pub const ALL: [CredentialKind; 12] = [
        CredentialKind::OpenrouterInferenceKey,
        CredentialKind::OpenrouterManagementKey,
        CredentialKind::CodexSession,
        CredentialKind::AntigravitySession,
        CredentialKind::OpencodeBrowserSession,
        CredentialKind::GrokSession,
        CredentialKind::KimiSession,
        CredentialKind::CursorSession,
        CredentialKind::SyntheticKey,
        CredentialKind::ZaiKey,
        CredentialKind::MinimaxKey,
        CredentialKind::ClineAccountToken,
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
            CredentialKind::CursorSession => 32_768,
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::SyntheticKey
            | CredentialKind::ZaiKey
            | CredentialKind::MinimaxKey
            | CredentialKind::ClineAccountToken => MAX_KEY_SECRET_BYTES,
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
            CredentialKind::CursorSession => ProviderId::Cursor,
            CredentialKind::SyntheticKey => ProviderId::Synthetic,
            CredentialKind::ZaiKey => ProviderId::Zai,
            CredentialKind::MinimaxKey => ProviderId::Minimax,
            CredentialKind::ClineAccountToken => ProviderId::Cline,
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
    CursorSessionCookie,
    /// Gemini CLI's Google OAuth bearer token with JSON request headers and
    /// the OpenLimiter identity. This scheme is used only by the two constant
    /// Code Assist quota addresses in `net.rs`.
    GeminiCliBearer,
    /// `Cookie: <secret>` with the OpenLimiter identity. The authenticated page
    /// path, and the reason OpenCode is permanently labelled an authenticated
    /// scrape.
    BrowserSessionCookie,
    /* The 2.1 schemes, typed and closed. `net.rs` refuses each one before a
    request is built until its provider's lane writes the documented header
    shape there; Z.ai in particular keeps its own documented authorization
    format rather than a borrowed bearer. */
    SyntheticKey,
    ZaiKey,
    MinimaxKey,
    ClineAccountToken,
}

impl AuthApplication {
    /// Whether this scheme belongs to a provider this build has not switched
    /// on. `net.rs` refuses a pending scheme before anything is built.
    pub const fn pending(self) -> bool {
        match self {
            AuthApplication::SyntheticKey => !ProviderId::Synthetic.enabled(),
            AuthApplication::ZaiKey => !ProviderId::Zai.enabled(),
            AuthApplication::MinimaxKey => !ProviderId::Minimax.enabled(),
            AuthApplication::ClineAccountToken => !ProviderId::Cline.enabled(),
            AuthApplication::BearerAuthorization
            | AuthApplication::ClaudeOauthBearer
            | AuthApplication::CodexSessionBearer
            | AuthApplication::AntigravitySessionBearer
            | AuthApplication::GrokSessionBearer
            | AuthApplication::KimiSessionBearer
            | AuthApplication::CursorSessionCookie
            | AuthApplication::GeminiCliBearer
            | AuthApplication::BrowserSessionCookie => false,
        }
    }
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
    /// The provider is registered and this build has not switched it on.
    ProviderNotEnabled,
}

impl fmt::Display for RouteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            RouteError::CredentialProviderMismatch => {
                "this credential kind does not belong to this provider"
            }
            RouteError::ProviderNotEnabled => "this provider is not switched on in this build",
        })
    }
}

/// The only function in the process that turns identity into an address.
///
/// A provider this build has not switched on routes nowhere: every pairing is
/// refused before the table is read, so a 2.1 provider's credential can be
/// neither stored as a connection nor sent while its lane has not enabled it.
pub const fn reader_route(
    provider: ProviderId,
    credential: CredentialKind,
) -> Result<ReaderRoute, RouteError> {
    if !provider.enabled() {
        return Err(RouteError::ProviderNotEnabled);
    }
    route_table(provider, credential)
}

/// Every pairing, decided, including the providers that are switched off.
///
/// Exhaustive with no wildcard arm: the provider is matched, and inside each
/// arm every credential kind is named, so every wrong pairing is refused by a
/// match arm somebody wrote rather than by a default nobody read. Adding a
/// provider or a credential kind fails the build here first. The switched off
/// providers are decided now so their lanes only switch them on.
pub(crate) const fn route_table(
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
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::SyntheticKey
            | CredentialKind::ZaiKey
            | CredentialKind::MinimaxKey
            | CredentialKind::ClineAccountToken => mismatch,
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
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::SyntheticKey
            | CredentialKind::ZaiKey
            | CredentialKind::MinimaxKey
            | CredentialKind::ClineAccountToken => mismatch,
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
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::SyntheticKey
            | CredentialKind::ZaiKey
            | CredentialKind::MinimaxKey
            | CredentialKind::ClineAccountToken => mismatch,
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
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::SyntheticKey
            | CredentialKind::ZaiKey
            | CredentialKind::MinimaxKey
            | CredentialKind::ClineAccountToken => mismatch,
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
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::SyntheticKey
            | CredentialKind::ZaiKey
            | CredentialKind::MinimaxKey
            | CredentialKind::ClineAccountToken => mismatch,
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
            | CredentialKind::GrokSession
            | CredentialKind::CursorSession
            | CredentialKind::SyntheticKey
            | CredentialKind::ZaiKey
            | CredentialKind::MinimaxKey
            | CredentialKind::ClineAccountToken => mismatch,
        },
        ProviderId::Cursor => match credential {
            CredentialKind::CursorSession => Ok(ReaderRoute {
                reader_id: ReaderId::CursorUsage,
                endpoint: ProviderEndpoint::CursorUsage,
                auth: AuthApplication::CursorSessionCookie,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::SyntheticKey
            | CredentialKind::ZaiKey
            | CredentialKind::MinimaxKey
            | CredentialKind::ClineAccountToken => mismatch,
        },
        ProviderId::Synthetic => match credential {
            CredentialKind::SyntheticKey => Ok(ReaderRoute {
                reader_id: ReaderId::SyntheticQuotas,
                endpoint: ProviderEndpoint::SyntheticQuotas,
                auth: AuthApplication::SyntheticKey,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::ZaiKey
            | CredentialKind::MinimaxKey
            | CredentialKind::ClineAccountToken => mismatch,
        },
        ProviderId::Zai => match credential {
            CredentialKind::ZaiKey => Ok(ReaderRoute {
                reader_id: ReaderId::ZaiQuota,
                endpoint: ProviderEndpoint::ZaiQuota,
                auth: AuthApplication::ZaiKey,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::SyntheticKey
            | CredentialKind::MinimaxKey
            | CredentialKind::ClineAccountToken => mismatch,
        },
        ProviderId::Minimax => match credential {
            CredentialKind::MinimaxKey => Ok(ReaderRoute {
                reader_id: ReaderId::MinimaxTokenPlan,
                endpoint: ProviderEndpoint::MinimaxTokenPlan,
                auth: AuthApplication::MinimaxKey,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::SyntheticKey
            | CredentialKind::ZaiKey
            | CredentialKind::ClineAccountToken => mismatch,
        },
        ProviderId::Cline => match credential {
            CredentialKind::ClineAccountToken => Ok(ReaderRoute {
                reader_id: ReaderId::ClineBalance,
                endpoint: ProviderEndpoint::ClineBalance,
                auth: AuthApplication::ClineAccountToken,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::SyntheticKey
            | CredentialKind::ZaiKey
            | CredentialKind::MinimaxKey => mismatch,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_and_credential_pairing_is_decided() {
        /* Every pairing has exactly one right answer in the table, the
        switched off providers included: one route per reader, every other
        pairing refused. A pairing that neither routed nor was refused would
        mean a wildcard arm had crept in. */
        let mut routed = 0usize;
        let mut refused = 0usize;
        for provider in ProviderId::ALL {
            for credential in CredentialKind::ALL {
                match route_table(provider, credential) {
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
        assert_eq!(routed, ReaderId::ALL.len());
        assert_eq!(refused, ProviderId::ALL.len() * CredentialKind::ALL.len() - routed);
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
                if let Ok(route) = route_table(provider, credential) {
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
                if let Ok(route) = route_table(provider, credential) {
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
    fn session_pairs_and_browser_sessions_have_explicit_bounds() {
        for credential in CredentialKind::ALL {
            let expected = if credential == CredentialKind::OpencodeBrowserSession {
                MAX_BROWSER_SESSION_BYTES
            } else if credential == CredentialKind::CursorSession {
                32_768
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
    fn a_switched_off_provider_routes_nowhere_and_a_switched_on_one_reads_the_table() {
        for provider in ProviderId::ALL {
            for credential in CredentialKind::ALL {
                if provider.enabled() {
                    assert_eq!(
                        reader_route(provider, credential),
                        route_table(provider, credential)
                    );
                } else {
                    assert_eq!(
                        reader_route(provider, credential),
                        Err(RouteError::ProviderNotEnabled)
                    );
                }
            }
        }
    }

    #[test]
    fn the_route_error_sentence_is_fixed_and_redacted() {
        assert_eq!(
            RouteError::ProviderNotEnabled.to_string(),
            "this provider is not switched on in this build"
        );
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
