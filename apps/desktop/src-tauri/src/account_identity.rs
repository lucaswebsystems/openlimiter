//! The account identity contract. TypeScript twin: the route materials in
//! `packages/core/src/acquire/identity.ts`, held to the same answers by
//! `packages/core/src/contracts/account-route-vectors.json`.
//!
//! "Only the account signed in now" needs an identity decided from the
//! credential alone, before a reading is taken, and the same in every process.
//! Per route:
//!
//!   api_key        the fingerprint of the key the person holds, never the
//!                  key. Two keys are two accounts, because nothing about a key
//!                  proves otherwise without a request; one key found in two
//!                  places is one account.
//!   account_token  the account the stored credential states (an explicit
//!                  account field, then a token subject), never the token: a
//!                  vendor tool rotates its token and the account stays.
//!   local_cli      the account the vendor's own CLI reports, with its scope.
//!                  Personal and organisation never share an identity, and a
//!                  provider measured for personal use refuses an organisation
//!                  answer rather than showing it as personal.
//!
//! Precedence, strongest first: a key the person saved in this app, then a
//! documented credential in a client configuration proven to be the vendor's,
//! then the vendor tool itself. The same identity from two sources is one
//! account, read through the strongest source only; the existing coordination
//! already does this once identities agree, because the automatic collector
//! skips every identity a saved connection covers.
//!
//! Switching: identities come from credentials, never from how recent a reading
//! is. When the credential behind a provider changes, the new identity is the
//! active one from the next scan or CLI answer (a lane records each answer with
//! `DetectionStore::record_cli_account`), the old identity's rows are held
//! back as `account_not_connected`, and a read that began under the old identity
//! is written under it. The Free plan's one active account per provider is the
//! `limit` below; a saved connection claims the provider outright.

use std::collections::{BTreeSet, HashSet};

use sha2::{Digest, Sha256};

use crate::poll_identity::PollIdentity;
use crate::provider_detection::{opaque_account_id, DetectedProviderId};
use crate::reader_registry::ProviderId;

/// Longest account identifier a vendor CLI may report and still be believed.
const MAX_REPORTED_ACCOUNT_BYTES: usize = 512;

/// How a provider's credential reaches OpenLimiter, which decides its identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccountRoute {
    /// A key the person holds, entered in the app or found in a client
    /// configuration proven to be the vendor's.
    ApiKey,
    /// A token a vendor tool stored for an account.
    AccountToken,
    /// The vendor's own command line client, which answers for its login.
    LocalCli,
}

/// Whose allowance a CLI says it is reporting. Named by the command line
/// lanes; until one is switched on, only tests name an organisation.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccountScope {
    Personal,
    Organization,
}

impl AccountScope {
    const fn word(self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Organization => "organization",
        }
    }
}

/// The route each 2.1 provider's identity follows. The providers that shipped
/// before keep the identity rules they always had, in `provider_detection.rs`
/// and `poll_identity.rs`, so they have none here.
pub(crate) const fn route(provider: DetectedProviderId) -> Option<AccountRoute> {
    match provider {
        DetectedProviderId::Synthetic | DetectedProviderId::Zai | DetectedProviderId::Minimax => {
            Some(AccountRoute::ApiKey)
        }
        DetectedProviderId::Cline => Some(AccountRoute::AccountToken),
        DetectedProviderId::Augment
        | DetectedProviderId::Amp
        | DetectedProviderId::Kilo
        | DetectedProviderId::Copilot => Some(AccountRoute::LocalCli),
        DetectedProviderId::Claude
        | DetectedProviderId::Codex
        | DetectedProviderId::Antigravity
        | DetectedProviderId::GeminiCli
        | DetectedProviderId::Opencode
        | DetectedProviderId::Openrouter
        | DetectedProviderId::Grok
        | DetectedProviderId::Kimi
        | DetectedProviderId::Cursor => None,
    }
}

/// Identity material for a key: a one way fingerprint of the trimmed key.
pub(crate) fn key_fingerprint_material(key: &str) -> String {
    format!("api-key-sha256:{:x}", Sha256::digest(key.trim().as_bytes()))
}

/// The account id of a key, for the provider it belongs to.
pub(crate) fn key_account_id(provider: DetectedProviderId, key: &str) -> String {
    opaque_account_id(provider, &key_fingerprint_material(key))
}

/// Identity material for the account a vendor CLI reports, or nothing when the
/// report is not an identity anybody can trust.
pub(crate) fn cli_account_material(reported: &str, scope: AccountScope) -> Option<String> {
    let reported = reported.trim();
    (!reported.is_empty()
        && reported.len() <= MAX_REPORTED_ACCOUNT_BYTES
        && !reported.chars().any(char::is_control))
    .then(|| format!("cli-{}:{reported}", scope.word()))
}

/// The account id a CLI answer belongs to. A provider measured for personal use
/// only refuses an organisation answer, so it can never be shown as personal.
/// Called by the command line lanes; until one is switched on, only tests do.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn cli_account_id(
    provider: DetectedProviderId,
    reported: &str,
    scope: AccountScope,
    personal_only: bool,
) -> Option<String> {
    if personal_only && scope != AccountScope::Personal {
        return None;
    }
    cli_account_material(reported, scope).map(|material| opaque_account_id(provider, &material))
}

/// The provider a saved connection for this detected provider is filed under,
/// when it can have one at all. Command line providers cannot.
const fn connection_provider(provider: DetectedProviderId) -> Option<ProviderId> {
    match provider {
        DetectedProviderId::Openrouter => Some(ProviderId::Openrouter),
        DetectedProviderId::Codex => Some(ProviderId::Codex),
        DetectedProviderId::Antigravity => Some(ProviderId::Antigravity),
        DetectedProviderId::Opencode => Some(ProviderId::Opencode),
        DetectedProviderId::Grok => Some(ProviderId::Grok),
        DetectedProviderId::Kimi => Some(ProviderId::Kimi),
        DetectedProviderId::Cursor => Some(ProviderId::Cursor),
        DetectedProviderId::Synthetic => Some(ProviderId::Synthetic),
        DetectedProviderId::Zai => Some(ProviderId::Zai),
        DetectedProviderId::Minimax => Some(ProviderId::Minimax),
        DetectedProviderId::Cline => Some(ProviderId::Cline),
        DetectedProviderId::Claude
        | DetectedProviderId::GeminiCli
        | DetectedProviderId::Augment
        | DetectedProviderId::Amp
        | DetectedProviderId::Kilo
        | DetectedProviderId::Copilot => None,
    }
}

/// The accounts one automatic pass may read, in one decision.
///
/// Duplicates collapse, because one identity found in two places is one
/// account. An identity a saved connection covers is left to that connection,
/// because the key a person saved is the stronger source. What remains is
/// bounded by `limit`, the plan's answer from `automatic_account_limit`: one on
/// Free, none on Free once a saved connection holds the provider, and every
/// account on Pro. The order is stable, so the same account keeps the slot.
/// Called by each lane's `run_pass`; until one is switched on, only tests do.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn automatic_account_ids(
    provider: DetectedProviderId,
    detected: impl IntoIterator<Item = String>,
    covered: &HashSet<PollIdentity>,
    limit: usize,
) -> Vec<String> {
    let saved = connection_provider(provider);
    detected
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|account| {
            saved.is_none_or(|provider_id| {
                !covered.contains(&PollIdentity::detected(provider_id, account.clone()))
            })
        })
        .take(limit)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn detected(code: &str) -> DetectedProviderId {
        DetectedProviderId::from_code(code).expect("a provider code")
    }

    #[test]
    fn every_route_matches_the_typescript_vectors() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/contracts/account-route-vectors.json"
        ))
        .expect("vectors");
        for vector in vectors.as_array().expect("a list") {
            let provider = detected(vector["provider"].as_str().expect("provider"));
            let input = vector["input"].as_str().expect("input");
            let material = match vector["route"].as_str().expect("route") {
                "api_key" => key_fingerprint_material(input),
                "local_cli" => cli_account_material(
                    input,
                    match vector["scope"].as_str() {
                        Some("organization") => AccountScope::Organization,
                        _ => AccountScope::Personal,
                    },
                )
                .expect("a believable report"),
                _ => input.to_string(),
            };
            assert_eq!(material, vector["material"].as_str().expect("material"));
            assert_eq!(
                opaque_account_id(provider, &material),
                vector["expected"].as_str().expect("expected")
            );
        }
    }

    #[test]
    fn every_provider_states_its_route_and_only_the_wave_has_one() {
        for provider in DetectedProviderId::ALL {
            assert_eq!(route(provider).is_some(), provider.footprint().is_some());
        }
        assert_eq!(route(DetectedProviderId::Synthetic), Some(AccountRoute::ApiKey));
        assert_eq!(route(DetectedProviderId::Cline), Some(AccountRoute::AccountToken));
        assert_eq!(route(DetectedProviderId::Copilot), Some(AccountRoute::LocalCli));
    }

    #[test]
    fn a_key_is_its_fingerprint_and_one_key_is_one_account() {
        let key = "sk-fixture-secret-value";
        let material = key_fingerprint_material(key);
        assert!(!material.contains(key));
        assert_eq!(
            key_account_id(DetectedProviderId::Synthetic, key),
            key_account_id(DetectedProviderId::Synthetic, "  sk-fixture-secret-value\n")
        );
        assert_ne!(
            key_account_id(DetectedProviderId::Synthetic, key),
            key_account_id(DetectedProviderId::Synthetic, "sk-fixture-other-value")
        );
        assert_ne!(
            key_account_id(DetectedProviderId::Synthetic, key),
            key_account_id(DetectedProviderId::Zai, key)
        );
    }

    #[test]
    fn a_cli_report_names_an_account_only_in_the_scope_it_was_measured_for() {
        let personal = cli_account_id(
            DetectedProviderId::Augment,
            "fixture-user-1",
            AccountScope::Personal,
            true,
        )
        .expect("personal");
        let organization = cli_account_id(
            DetectedProviderId::Amp,
            "fixture-user-1",
            AccountScope::Organization,
            false,
        )
        .expect("organization allowed where the provider measures it");
        assert_ne!(
            personal,
            cli_account_id(
                DetectedProviderId::Augment,
                "fixture-user-1",
                AccountScope::Organization,
                false
            )
            .expect("scoped")
        );
        assert!(organization.starts_with("amp-"));
        /* Personal use only refuses the organisation answer outright. */
        assert_eq!(
            cli_account_id(
                DetectedProviderId::Augment,
                "fixture-user-1",
                AccountScope::Organization,
                true
            ),
            None
        );
        for untrusted in ["", "   ", "user\u{7}name"] {
            assert_eq!(cli_account_material(untrusted, AccountScope::Personal), None);
        }
        assert_eq!(
            cli_account_material(&"a".repeat(MAX_REPORTED_ACCOUNT_BYTES + 1), AccountScope::Personal),
            None
        );
    }

    #[test]
    fn duplicate_sources_collapse_and_a_saved_key_wins() {
        let key_a = key_account_id(DetectedProviderId::Synthetic, "fixture-key-a");
        let key_b = key_account_id(DetectedProviderId::Synthetic, "fixture-key-b");
        /* The same key in two client configurations is one account. */
        let found = automatic_account_ids(
            DetectedProviderId::Synthetic,
            [key_a.clone(), key_a.clone(), key_b.clone()],
            &HashSet::new(),
            usize::MAX,
        );
        assert_eq!(found.len(), 2);
        /* The key a person saved covers the same key found in a configuration:
        the saved connection reads it, the automatic pass does not. */
        let covered = HashSet::from([PollIdentity::detected(ProviderId::Synthetic, key_a.clone())]);
        assert_eq!(
            automatic_account_ids(
                DetectedProviderId::Synthetic,
                [key_a.clone(), key_b.clone()],
                &covered,
                usize::MAX
            ),
            vec![key_b.clone()]
        );
        /* A command line provider has no saved connections to defer to. */
        assert_eq!(
            automatic_account_ids(DetectedProviderId::Copilot, [key_a.clone()], &covered, 1).len(),
            1
        );
    }

    #[test]
    fn the_plan_bounds_the_active_accounts_and_keeps_the_same_one() {
        let accounts = ["synthetic-b", "synthetic-a", "synthetic-c"].map(String::from);
        let free = automatic_account_ids(
            DetectedProviderId::Synthetic,
            accounts.clone(),
            &HashSet::new(),
            1,
        );
        assert_eq!(free, vec!["synthetic-a".to_string()]);
        /* Asked again in another order, the same account keeps the one slot. */
        let mut reversed = accounts.clone();
        reversed.reverse();
        assert_eq!(
            automatic_account_ids(DetectedProviderId::Synthetic, reversed, &HashSet::new(), 1),
            free
        );
        assert!(automatic_account_ids(DetectedProviderId::Synthetic, accounts.clone(), &HashSet::new(), 0).is_empty());
        assert_eq!(
            automatic_account_ids(DetectedProviderId::Synthetic, accounts, &HashSet::new(), usize::MAX).len(),
            3
        );
    }
}
