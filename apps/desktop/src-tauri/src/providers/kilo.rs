//! Kilo Code: registered for the 2.1 providers wave and switched off.
//!
//! Route: the JSON profile of the installed Kilo runtime, balance first,
//! behind the live gate. Identity route: local_cli (see account_identity.rs).
//! Lane P1c owns this module and fills it in, together with its connector in
//! packages/connectors/src and its registry spec; the wiring checklist names
//! every other line it touches.
//!
//! While ENABLED is false nothing here runs: detection skips the provider,
//! the routing table refuses its credentials, the collector never calls
//! run_pass, and a cache row naming it is dropped.

use std::collections::HashSet;

use tauri::AppHandle;

use crate::poll_identity::PollIdentity;
use crate::provider_detection::{ConnectionMode, Footprint};

/// The Rust half of this provider's switch. The TypeScript half is its code in
/// PENDING_PROVIDER_CODES, and the registry half is `enabled` in its spec. A
/// test in packages/core/test/pending-providers.test.ts holds the three
/// together, and another in provider_detection.rs holds this one to core.
pub(crate) const ENABLED: bool = false;

/// Seconds between background reads once switched on. 900 is what every
/// surface assumes for a provider that states no cadence; the lane sets the
/// real one here and beside this provider's code in `desktopIntervals` in
/// packages/core/src/data-rules.ts.
pub(crate) const INTERVAL_SECONDS: u64 = 900;

/// Where detection may look. Nothing yet: the lane states the documented
/// executable, install roots, presence markers and configuration credential
/// rules here, and detection reads them from nowhere else.
pub(crate) const FOOTPRINT: Footprint = Footprint::nothing(ConnectionMode::Automatic);

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
