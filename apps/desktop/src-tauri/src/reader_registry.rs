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
    Hermes,
    Commandcode,
    Cline,
    Kilocode,
    Copilot,
    Amp,
    Codebuff,
    Kiro,
    Crush,
}

impl ProviderId {
    /// The whole vocabulary, for the tests that must exhaust every pairing.
    /* Exhaustive lists and the reverse lookups over them exist for the tests
    that must sweep every pairing. The product itself only ever holds one
    variant at a time, so they are dead code outside a test build and are
    marked as such rather than deleted: the sweep is the security property. */
    #[cfg_attr(not(test), allow(dead_code))]
    pub const ALL: [ProviderId; 15] = [
        ProviderId::Openrouter,
        ProviderId::Codex,
        ProviderId::Opencode,
        ProviderId::Grok,
        ProviderId::Kimi,
        ProviderId::Cursor,
        ProviderId::Hermes,
        ProviderId::Commandcode,
        ProviderId::Cline,
        ProviderId::Kilocode,
        ProviderId::Copilot,
        ProviderId::Amp,
        ProviderId::Codebuff,
        ProviderId::Kiro,
        ProviderId::Crush,
    ];

    /// Providers whose current collection path is an HTTP reader.
    pub const HTTP_READER_PROVIDERS: [ProviderId; 15] = [
        ProviderId::Openrouter,
        ProviderId::Codex,
        ProviderId::Opencode,
        ProviderId::Grok,
        ProviderId::Kimi,
        ProviderId::Cursor,
        ProviderId::Hermes,
        ProviderId::Commandcode,
        ProviderId::Cline,
        ProviderId::Kilocode,
        ProviderId::Copilot,
        ProviderId::Amp,
        ProviderId::Codebuff,
        ProviderId::Kiro,
        ProviderId::Crush,
    ];

    /// Providers whose bounded cache rows may be uploaded to account sync.
    pub const SYNC_ELIGIBLE: [ProviderId; 16] = [
        ProviderId::Openrouter,
        ProviderId::Codex,
        ProviderId::Antigravity,
        ProviderId::Opencode,
        ProviderId::Grok,
        ProviderId::Kimi,
        ProviderId::Cursor,
        ProviderId::Hermes,
        ProviderId::Commandcode,
        ProviderId::Cline,
        ProviderId::Kilocode,
        ProviderId::Copilot,
        ProviderId::Amp,
        ProviderId::Codebuff,
        ProviderId::Kiro,
        ProviderId::Crush,
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
            ProviderId::Hermes => "HERMES",
            ProviderId::Commandcode => "COMMANDCODE",
            ProviderId::Cline => "CLINE",
            ProviderId::Kilocode => "KILOCODE",
            ProviderId::Copilot => "COPILOT",
            ProviderId::Amp => "AMP",
            ProviderId::Codebuff => "CODEBUFF",
            ProviderId::Kiro => "KIRO",
            ProviderId::Crush => "CRUSH",
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
    CursorUsage,
    HermesAccount,
    CommandcodeCredits,
    ClineUsage,
    KilocodeBalance,
    CopilotUser,
    AmpBalance,
    CodebuffUsage,
    KiroUsageLimits,
    CrushCredits,
}

/// A source's scheduling shape, without pretending every source has a timer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchedulePolicy {
    EventDriven,
    Interval { base_seconds: u64 },
}

impl SchedulePolicy {
    /// The trusted interval only when this policy actually has one.
    pub const fn interval_seconds(self) -> Option<u64> {
        match self {
            SchedulePolicy::EventDriven => None,
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
    pub const ALL: [ReaderId; 16] = [
        ReaderId::OpenrouterKey,
        ReaderId::OpenrouterCredits,
        ReaderId::CodexUsage,
        ReaderId::OpencodeUsage,
        ReaderId::GrokUsage,
        ReaderId::KimiUsage,
        ReaderId::CursorUsage,
        ReaderId::HermesAccount,
        ReaderId::CommandcodeCredits,
        ReaderId::ClineUsage,
        ReaderId::KilocodeBalance,
        ReaderId::CopilotUser,
        ReaderId::AmpBalance,
        ReaderId::CodebuffUsage,
        ReaderId::KiroUsageLimits,
        ReaderId::CrushCredits,
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
            ReaderId::HermesAccount => ProviderId::Hermes,
            ReaderId::CommandcodeCredits => ProviderId::Commandcode,
            ReaderId::ClineUsage => ProviderId::Cline,
            ReaderId::KilocodeBalance => ProviderId::Kilocode,
            ReaderId::CopilotUser => ProviderId::Copilot,
            ReaderId::AmpBalance => ProviderId::Amp,
            ReaderId::CodebuffUsage => ProviderId::Codebuff,
            ReaderId::KiroUsageLimits => ProviderId::Kiro,
            ReaderId::CrushCredits => ProviderId::Crush,
        }
    }

    /// The trusted background cadence for this reader, in seconds. Local
    /// Claude observations do not have a `ReaderId` or a connection record at
    /// all: they arrive through the statusline event.
    pub const fn base_seconds(self) -> u64 {
        match self {
            ReaderId::OpenrouterKey
            | ReaderId::OpenrouterCredits
            | ReaderId::CodexUsage
            | ReaderId::GrokUsage
            | ReaderId::KimiUsage
            | ReaderId::OpencodeUsage
            | ReaderId::CursorUsage
            | ReaderId::HermesAccount
            | ReaderId::CommandcodeCredits
            | ReaderId::ClineUsage
            | ReaderId::KilocodeBalance
            | ReaderId::CopilotUser
            | ReaderId::AmpBalance
            | ReaderId::CodebuffUsage
            | ReaderId::KiroUsageLimits
            | ReaderId::CrushCredits => 300,
            ReaderId::AntigravityQuota => 600,
        }
    }
}

/// Largest key shaped secret accepted, in bytes. Real provider keys and access
/// tokens are well under two hundred bytes; four kibibytes is generosity.
pub const MAX_KEY_SECRET_BYTES: usize = 4_096;

/// What kind of secret a connection holds.
///
/// The kind is not decoration: it decides the address the secret may be sent
/// to and the header it may be written into. An OpenRouter inference key and
/// an OpenRouter management key read different endpoints; a Codex session is a
/// bearer token for one host and nothing else; an OpenCode API key reads only
/// OpenCode's usage address.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    OpenrouterInferenceKey,
    OpenrouterManagementKey,
    CodexSession,
    AntigravitySession,
    /// Retired in 2.1.13 with the OpenCode page scrape: kept so a stored record
    /// still parses and can be retired, never routed.
    OpencodeBrowserSession,
    GrokSession,
    KimiSession,
    CursorSession,
    OpencodeApiKey,
    /// Hermes's Nous Portal access token, read from Hermes's own login file.
    HermesSession,
    /// The API key Command Code's CLI saved.
    CommandcodeApiKey,
    /// The `workos:` bearer Cline's CLI saved after `cline auth`.
    ClineSession,
    /// The Kilo Code gateway token Kilo's CLI saved.
    KilocodeSession,
    /// The GitHub Copilot OAuth token the Copilot sign in saved in `apps.json`.
    CopilotSession,
    /// The API key the Amp CLI saved in its `secrets.json`.
    AmpApiKey,
    /// The auth token the Codebuff CLI saved in `credentials.json`.
    CodebuffSession,
    /// The access token the Kiro CLI saved in its `data.sqlite3`.
    KiroSession,
    /// The Charm Hyper token Crush saved in `crush.json`.
    CrushSession,
}

impl CredentialKind {
    /* Exhaustive lists and the reverse lookups over them exist for the tests
    that must sweep every pairing. The product itself only ever holds one
    variant at a time, so they are dead code outside a test build and are
    marked as such rather than deleted: the sweep is the security property. */
    #[cfg_attr(not(test), allow(dead_code))]
    pub const ALL: [CredentialKind; 16] = [
        CredentialKind::OpenrouterInferenceKey,
        CredentialKind::OpenrouterManagementKey,
        CredentialKind::CodexSession,
        CredentialKind::OpencodeApiKey,
        CredentialKind::GrokSession,
        CredentialKind::KimiSession,
        CredentialKind::CursorSession,
        CredentialKind::HermesSession,
        CredentialKind::CommandcodeApiKey,
        CredentialKind::ClineSession,
        CredentialKind::KilocodeSession,
        CredentialKind::CopilotSession,
        CredentialKind::AmpApiKey,
        CredentialKind::CodebuffSession,
        CredentialKind::KiroSession,
        CredentialKind::CrushSession,
    ];

    /// The largest secret of this kind that will be accepted, in bytes.
    ///
    /// Per kind, because the kinds are not the same shape of thing. An API key
    /// or an access token is a compact string and four kibibytes is already
    /// generous for one; Cursor's session is larger. Anything above the bound
    /// is refused with the ordinary fixed error and NEVER truncated: a
    /// silently shortened secret is the worst outcome available here.
    pub const fn max_secret_bytes(self) -> usize {
        match self {
            CredentialKind::CursorSession => 32_768,
            CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpencodeApiKey
            | CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::HermesSession
            | CredentialKind::CommandcodeApiKey
            | CredentialKind::ClineSession
            | CredentialKind::KilocodeSession
            | CredentialKind::CopilotSession
            | CredentialKind::AmpApiKey
            | CredentialKind::CodebuffSession
            | CredentialKind::KiroSession
            | CredentialKind::CrushSession => MAX_KEY_SECRET_BYTES,
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
            CredentialKind::OpencodeBrowserSession | CredentialKind::OpencodeApiKey => {
                ProviderId::Opencode
            }
            CredentialKind::GrokSession => ProviderId::Grok,
            CredentialKind::KimiSession => ProviderId::Kimi,
            CredentialKind::CursorSession => ProviderId::Cursor,
            CredentialKind::HermesSession => ProviderId::Hermes,
            CredentialKind::CommandcodeApiKey => ProviderId::Commandcode,
            CredentialKind::ClineSession => ProviderId::Cline,
            CredentialKind::KilocodeSession => ProviderId::Kilocode,
            CredentialKind::CopilotSession => ProviderId::Copilot,
            CredentialKind::AmpApiKey => ProviderId::Amp,
            CredentialKind::CodebuffSession => ProviderId::Codebuff,
            CredentialKind::KiroSession => ProviderId::Kiro,
            CredentialKind::CrushSession => ProviderId::Crush,
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
    /// response preference. The OpenRouter and OpenCode path.
    BearerAuthorization,
    /// A bearer token plus the fixed OAuth usage contract headers Claude Code uses.
    ClaudeOauthBearer,
    /// Retired Codex route marker retained for stored record compatibility.
    /// It has no HTTP endpoint, and `net.rs` refuses it before transport.
    CodexSessionBearer,
    /// A bearer token plus the Grok user identity and fixed client marker.
    GrokSessionBearer,
    /// A bearer token read from the official Kimi CLI credential file.
    KimiSessionBearer,
    CursorSessionCookie,
    /// Gemini CLI's Google OAuth bearer token with JSON request headers and
    /// the OpenLimiter identity. This scheme is used only by the two constant
    /// Code Assist quota addresses in `net.rs`.
    GeminiCliBearer,
    /// `Authorization: token <secret>`, GitHub's OAuth token scheme, with the
    /// OpenLimiter identity. Used only by the constant Copilot quota address,
    /// and with no editor or plugin header: no request claims to be an editor.
    GithubTokenAuthorization,
    /// A bearer token plus the CodeWhisperer JSON protocol header and target
    /// for the constant Kiro usage limits address. Its body is built only by
    /// `net.rs`, from one validated profile.
    KiroUsageBearer,
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
    pub endpoint: Option<ProviderEndpoint>,
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
/// arm every credential kind is named, so every wrong pairing is
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
                endpoint: Some(ProviderEndpoint::OpenrouterKey),
                auth: AuthApplication::BearerAuthorization,
            }),
            CredentialKind::OpenrouterManagementKey => Ok(ReaderRoute {
                reader_id: ReaderId::OpenrouterCredits,
                endpoint: Some(ProviderEndpoint::OpenrouterCredits),
                auth: AuthApplication::BearerAuthorization,
            }),
            CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpencodeApiKey
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::HermesSession
            | CredentialKind::CommandcodeApiKey
            | CredentialKind::ClineSession
            | CredentialKind::KilocodeSession
            | CredentialKind::CopilotSession
            | CredentialKind::AmpApiKey
            | CredentialKind::CodebuffSession
            | CredentialKind::KiroSession
            | CredentialKind::CrushSession => mismatch,
        },
        ProviderId::Codex => match credential {
            CredentialKind::CodexSession => Ok(ReaderRoute {
                reader_id: ReaderId::CodexUsage,
                endpoint: None,
                auth: AuthApplication::CodexSessionBearer,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpencodeApiKey
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::HermesSession
            | CredentialKind::CommandcodeApiKey
            | CredentialKind::ClineSession
            | CredentialKind::KilocodeSession
            | CredentialKind::CopilotSession
            | CredentialKind::AmpApiKey
            | CredentialKind::CodebuffSession
            | CredentialKind::KiroSession
            | CredentialKind::CrushSession => mismatch,
        },
        ProviderId::Antigravity => mismatch,
        ProviderId::Opencode => match credential {
            CredentialKind::OpencodeApiKey => Ok(ReaderRoute {
                reader_id: ReaderId::OpencodeUsage,
                endpoint: Some(ProviderEndpoint::OpencodeUsage),
                auth: AuthApplication::BearerAuthorization,
            }),
            CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::HermesSession
            | CredentialKind::CommandcodeApiKey
            | CredentialKind::ClineSession
            | CredentialKind::KilocodeSession
            | CredentialKind::CopilotSession
            | CredentialKind::AmpApiKey
            | CredentialKind::CodebuffSession
            | CredentialKind::KiroSession
            | CredentialKind::CrushSession => mismatch,
        },
        ProviderId::Grok => match credential {
            CredentialKind::GrokSession => Ok(ReaderRoute {
                reader_id: ReaderId::GrokUsage,
                endpoint: Some(ProviderEndpoint::GrokUsage),
                auth: AuthApplication::GrokSessionBearer,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpencodeApiKey
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::HermesSession
            | CredentialKind::CommandcodeApiKey
            | CredentialKind::ClineSession
            | CredentialKind::KilocodeSession
            | CredentialKind::CopilotSession
            | CredentialKind::AmpApiKey
            | CredentialKind::CodebuffSession
            | CredentialKind::KiroSession
            | CredentialKind::CrushSession => mismatch,
        },
        ProviderId::Kimi => match credential {
            CredentialKind::KimiSession => Ok(ReaderRoute {
                reader_id: ReaderId::KimiUsage,
                endpoint: Some(ProviderEndpoint::KimiUsage),
                auth: AuthApplication::KimiSessionBearer,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpencodeApiKey
            | CredentialKind::GrokSession
            | CredentialKind::CursorSession
            | CredentialKind::HermesSession
            | CredentialKind::CommandcodeApiKey
            | CredentialKind::ClineSession
            | CredentialKind::KilocodeSession
            | CredentialKind::CopilotSession
            | CredentialKind::AmpApiKey
            | CredentialKind::CodebuffSession
            | CredentialKind::KiroSession
            | CredentialKind::CrushSession => mismatch,
        },
        ProviderId::Cursor => match credential {
            CredentialKind::CursorSession => Ok(ReaderRoute {
                reader_id: ReaderId::CursorUsage,
                endpoint: Some(ProviderEndpoint::CursorUsage),
                auth: AuthApplication::CursorSessionCookie,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpencodeApiKey
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::HermesSession
            | CredentialKind::CommandcodeApiKey
            | CredentialKind::ClineSession
            | CredentialKind::KilocodeSession
            | CredentialKind::CopilotSession
            | CredentialKind::AmpApiKey
            | CredentialKind::CodebuffSession
            | CredentialKind::KiroSession
            | CredentialKind::CrushSession => mismatch,
        },
        ProviderId::Hermes => match credential {
            CredentialKind::HermesSession => Ok(ReaderRoute {
                reader_id: ReaderId::HermesAccount,
                endpoint: Some(ProviderEndpoint::HermesAccount),
                auth: AuthApplication::BearerAuthorization,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpencodeApiKey
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::CommandcodeApiKey
            | CredentialKind::ClineSession
            | CredentialKind::KilocodeSession
            | CredentialKind::CopilotSession
            | CredentialKind::AmpApiKey
            | CredentialKind::CodebuffSession
            | CredentialKind::KiroSession
            | CredentialKind::CrushSession => mismatch,
        },
        ProviderId::Commandcode => match credential {
            CredentialKind::CommandcodeApiKey => Ok(ReaderRoute {
                reader_id: ReaderId::CommandcodeCredits,
                endpoint: Some(ProviderEndpoint::CommandcodeCredits),
                auth: AuthApplication::BearerAuthorization,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpencodeApiKey
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::HermesSession
            | CredentialKind::ClineSession
            | CredentialKind::KilocodeSession
            | CredentialKind::CopilotSession
            | CredentialKind::AmpApiKey
            | CredentialKind::CodebuffSession
            | CredentialKind::KiroSession
            | CredentialKind::CrushSession => mismatch,
        },
        ProviderId::Cline => match credential {
            CredentialKind::ClineSession => Ok(ReaderRoute {
                reader_id: ReaderId::ClineUsage,
                endpoint: Some(ProviderEndpoint::ClineUsage),
                auth: AuthApplication::BearerAuthorization,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpencodeApiKey
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::HermesSession
            | CredentialKind::CommandcodeApiKey
            | CredentialKind::KilocodeSession
            | CredentialKind::CopilotSession
            | CredentialKind::AmpApiKey
            | CredentialKind::CodebuffSession
            | CredentialKind::KiroSession
            | CredentialKind::CrushSession => mismatch,
        },
        ProviderId::Kilocode => match credential {
            CredentialKind::KilocodeSession => Ok(ReaderRoute {
                reader_id: ReaderId::KilocodeBalance,
                endpoint: Some(ProviderEndpoint::KilocodeBalance),
                auth: AuthApplication::BearerAuthorization,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpencodeApiKey
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::HermesSession
            | CredentialKind::CommandcodeApiKey
            | CredentialKind::ClineSession
            | CredentialKind::CopilotSession
            | CredentialKind::AmpApiKey
            | CredentialKind::CodebuffSession
            | CredentialKind::KiroSession
            | CredentialKind::CrushSession => mismatch,
        },
        ProviderId::Copilot => match credential {
            CredentialKind::CopilotSession => Ok(ReaderRoute {
                reader_id: ReaderId::CopilotUser,
                endpoint: Some(ProviderEndpoint::CopilotUser),
                auth: AuthApplication::GithubTokenAuthorization,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpencodeApiKey
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::HermesSession
            | CredentialKind::CommandcodeApiKey
            | CredentialKind::ClineSession
            | CredentialKind::KilocodeSession
            | CredentialKind::AmpApiKey
            | CredentialKind::CodebuffSession
            | CredentialKind::KiroSession
            | CredentialKind::CrushSession => mismatch,
        },
        ProviderId::Amp => match credential {
            CredentialKind::AmpApiKey => Ok(ReaderRoute {
                reader_id: ReaderId::AmpBalance,
                endpoint: Some(ProviderEndpoint::AmpBalance),
                auth: AuthApplication::BearerAuthorization,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpencodeApiKey
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::HermesSession
            | CredentialKind::CommandcodeApiKey
            | CredentialKind::ClineSession
            | CredentialKind::KilocodeSession
            | CredentialKind::CopilotSession
            | CredentialKind::CodebuffSession
            | CredentialKind::KiroSession
            | CredentialKind::CrushSession => mismatch,
        },
        ProviderId::Codebuff => match credential {
            CredentialKind::CodebuffSession => Ok(ReaderRoute {
                reader_id: ReaderId::CodebuffUsage,
                endpoint: Some(ProviderEndpoint::CodebuffUsage),
                auth: AuthApplication::BearerAuthorization,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpencodeApiKey
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::HermesSession
            | CredentialKind::CommandcodeApiKey
            | CredentialKind::ClineSession
            | CredentialKind::KilocodeSession
            | CredentialKind::CopilotSession
            | CredentialKind::AmpApiKey
            | CredentialKind::KiroSession
            | CredentialKind::CrushSession => mismatch,
        },
        ProviderId::Kiro => match credential {
            CredentialKind::KiroSession => Ok(ReaderRoute {
                reader_id: ReaderId::KiroUsageLimits,
                endpoint: Some(ProviderEndpoint::KiroUsageLimits),
                auth: AuthApplication::KiroUsageBearer,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpencodeApiKey
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::HermesSession
            | CredentialKind::CommandcodeApiKey
            | CredentialKind::ClineSession
            | CredentialKind::KilocodeSession
            | CredentialKind::CopilotSession
            | CredentialKind::AmpApiKey
            | CredentialKind::CodebuffSession
            | CredentialKind::CrushSession => mismatch,
        },
        ProviderId::Crush => match credential {
            CredentialKind::CrushSession => Ok(ReaderRoute {
                reader_id: ReaderId::CrushCredits,
                endpoint: Some(ProviderEndpoint::CrushCredits),
                auth: AuthApplication::BearerAuthorization,
            }),
            CredentialKind::OpenrouterInferenceKey
            | CredentialKind::OpenrouterManagementKey
            | CredentialKind::CodexSession
            | CredentialKind::AntigravitySession
            | CredentialKind::OpencodeBrowserSession
            | CredentialKind::OpencodeApiKey
            | CredentialKind::GrokSession
            | CredentialKind::KimiSession
            | CredentialKind::CursorSession
            | CredentialKind::HermesSession
            | CredentialKind::CommandcodeApiKey
            | CredentialKind::ClineSession
            | CredentialKind::KilocodeSession
            | CredentialKind::CopilotSession
            | CredentialKind::AmpApiKey
            | CredentialKind::CodebuffSession
            | CredentialKind::KiroSession => mismatch,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_and_credential_pairing_is_decided() {
        /* Every pairing has exactly one right answer: it routes or it is
        refused. A pairing that neither routed nor was
        refused would mean a wildcard arm had crept in. */
        let mut routed = 0usize;
        let mut refused = 0usize;
        for provider in ProviderId::HTTP_READER_PROVIDERS {
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
        assert_eq!(routed, ReaderId::ALL.len());
        assert_eq!(
            refused,
            ProviderId::HTTP_READER_PROVIDERS.len() * CredentialKind::ALL.len() - routed
        );
        assert_eq!(
            routed + refused,
            ProviderId::HTTP_READER_PROVIDERS.len() * CredentialKind::ALL.len()
        );
    }

    #[test]
    fn every_reader_is_reachable_exactly_once() {
        /* No reader is orphaned and no two pairings land on the same reader:
        that is what makes the reader id a usable parser selector. */
        let mut seen: Vec<ReaderId> = Vec::new();
        for provider in ProviderId::HTTP_READER_PROVIDERS {
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
        for provider in ProviderId::HTTP_READER_PROVIDERS {
            for credential in CredentialKind::ALL {
                if let Ok(route) = reader_route(provider, credential) {
                    if let Some(endpoint) = route.endpoint {
                        assert!(
                            !seen.contains(&endpoint),
                            "two credentials reached one endpoint"
                        );
                        seen.push(endpoint);
                    }
                }
            }
        }
        assert_eq!(seen.len(), ReaderId::ALL.len() - 1);
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
            (ProviderId::Hermes, "HERMES"),
            (ProviderId::Commandcode, "COMMANDCODE"),
            (ProviderId::Cline, "CLINE"),
            (ProviderId::Kilocode, "KILOCODE"),
            (ProviderId::Copilot, "COPILOT"),
            (ProviderId::Amp, "AMP"),
            (ProviderId::Codebuff, "CODEBUFF"),
            (ProviderId::Kiro, "KIRO"),
            (ProviderId::Crush, "CRUSH"),
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
            (ReaderId::OpencodeUsage, 300),
            (ReaderId::HermesAccount, 300),
            (ReaderId::CommandcodeCredits, 300),
            (ReaderId::ClineUsage, 300),
            (ReaderId::KilocodeBalance, 300),
            (ReaderId::CopilotUser, 300),
            (ReaderId::AmpBalance, 300),
            (ReaderId::CodebuffUsage, 300),
            (ReaderId::KiroUsageLimits, 300),
            (ReaderId::CrushCredits, 300),
        ];
        for (reader, seconds) in expected {
            assert_eq!(reader.base_seconds(), seconds);
        }
    }

    #[test]
    fn codex_refresh_is_a_local_read_surface_and_never_an_http_endpoint() {
        let route = reader_route(ProviderId::Codex, CredentialKind::CodexSession)
            .expect("Codex session route");
        assert_eq!(route.reader_id, ReaderId::CodexUsage);
        assert_eq!(route.endpoint, None);
    }

    #[test]
    fn session_pairs_have_explicit_bounds() {
        for credential in CredentialKind::ALL {
            let expected = if credential == CredentialKind::CursorSession {
                32_768
            } else {
                MAX_KEY_SECRET_BYTES
            };
            assert_eq!(credential.max_secret_bytes(), expected);
        }
    }

    #[test]
    fn the_retired_opencode_cookie_never_routes() {
        assert!(reader_route(ProviderId::Opencode, CredentialKind::OpencodeBrowserSession).is_err());
        let route = reader_route(ProviderId::Opencode, CredentialKind::OpencodeApiKey).expect("key route");
        assert_eq!(route.endpoint, Some(ProviderEndpoint::OpencodeUsage));
        assert_eq!(route.auth, AuthApplication::BearerAuthorization);
        assert!(!CredentialKind::ALL.contains(&CredentialKind::OpencodeBrowserSession));
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
