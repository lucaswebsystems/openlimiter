//! MiniMax: registered for the 2.1 providers wave and switched off.
//!
//! Route: its documented Token Plan quota endpoint, with a subscription key
//! entered in the app or found in a client configuration proven to be MiniMax's
//! own. Identity route: api_key (see account_identity.rs). Lane P1b owns this
//! module and fills it in, together with its connector in
//! packages/connectors/src, its descriptor in packages/core/src/providers, its
//! registry spec, its fixtures and its tests; no shared file changes.
//!
//! While ENABLED is false nothing here runs: detection skips the provider,
//! the routing table refuses its credentials, the collector never calls
//! run_pass, and a cache row naming it is dropped.

use std::collections::HashSet;

use tauri::AppHandle;

use crate::native_snapshot::Snapshot;
use crate::poll_identity::PollIdentity;
use crate::provider_detection::{ConnectionMode, Footprint};

/// The Rust half of this provider's switch. The TypeScript half is `enabled` in
/// its descriptor in packages/core/src/providers, and the registry half is
/// `enabled` in its spec. A test in
/// packages/core/test/pending-providers.test.ts holds the three together, and
/// another in provider_detection.rs holds this module to its descriptor.
pub(crate) const ENABLED: bool = false;

/// Seconds between background reads once switched on. 900 is what every
/// surface assumes for a provider that states no cadence; the lane sets the
/// real one here and as `intervalSeconds` in its descriptor, and a test in
/// provider_detection.rs holds the two equal.
pub(crate) const INTERVAL_SECONDS: u64 = 900;

/// Where detection may look. Nothing yet: the lane states the documented
/// executable, install roots, presence markers and configuration credential
/// rules here, and detection reads them from nowhere else.
pub(crate) const FOOTPRINT: Footprint = Footprint::nothing(ConnectionMode::ApiKey);

/// The documented read: its one https address, its verb, how the key is
/// presented and, when the address names an account, where the account comes
/// from. `net.rs` applies exactly this. Empty, and so closed, until the lane
/// writes the documented values.
pub(crate) const ENDPOINT: crate::net::HttpDescriptor = crate::net::HttpDescriptor {
    url: "",
    method: crate::net::HttpMethod::Get,
    key: crate::net::KeyHeader::BEARER,
    account: crate::net::AccountLookup::None,
};

/// Parse one answer from this provider's endpoint into readings under the
/// meter contract. Unsupported until the lane lands: nothing is ever read, so
/// nothing can be invented. `native_readers::parse_body` already dispatches
/// here.
pub(crate) fn parse(_body: &str, _now_ms: u64, _account_id: &str) -> Option<Vec<Snapshot>> {
    None
}

/// One automatic collection pass over this provider's detected accounts,
/// bounded by `limit` (the plan's one active account on Free) and skipping
/// every identity a saved connection already covers. Nothing to do until the
/// lane lands; `account_identity::automatic_account_ids` is the selection it
/// starts from.
pub(crate) async fn run_pass(
    _app: &AppHandle,
    _covered: &HashSet<PollIdentity>,
    _limit: usize,
) -> bool {
    true
}
