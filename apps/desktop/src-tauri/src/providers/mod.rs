//! The 2.1 providers, one module each, every one registered and switched off.
//!
//! A provider lane writes only its own module here, its connector, its
//! TypeScript descriptor in packages/core/src/providers, its registry spec, its
//! fixtures and its tests. Every closed list and every shared function already
//! names it and reads the provider specific answer from its module or its
//! descriptor, so parallel lanes never edit the same line.
//! `lanes/P1-wiring-checklist.md` in the launch workspace lists what a lane
//! writes, in order.

pub(crate) mod amp;
pub(crate) mod augment;
pub(crate) mod cline;
pub(crate) mod copilot;
pub(crate) mod kilo;
pub(crate) mod minimax;
pub(crate) mod synthetic;
pub(crate) mod zai;

use std::collections::HashSet;

use tauri::AppHandle;

use crate::poll_identity::PollIdentity;
use crate::provider_detection::DetectedProviderId;

/// Run one provider's automatic pass. A provider that shipped before the wave
/// has its own collector module and never reaches this.
pub(crate) async fn run_pass(
    provider: DetectedProviderId,
    app: &AppHandle,
    covered: &HashSet<PollIdentity>,
    limit: usize,
) -> bool {
    match provider {
        DetectedProviderId::Synthetic => synthetic::run_pass(app, covered, limit).await,
        DetectedProviderId::Zai => zai::run_pass(app, covered, limit).await,
        DetectedProviderId::Minimax => minimax::run_pass(app, covered, limit).await,
        DetectedProviderId::Cline => cline::run_pass(app, covered, limit).await,
        DetectedProviderId::Augment => augment::run_pass(app, covered, limit).await,
        DetectedProviderId::Amp => amp::run_pass(app, covered, limit).await,
        DetectedProviderId::Kilo => kilo::run_pass(app, covered, limit).await,
        DetectedProviderId::Copilot => copilot::run_pass(app, covered, limit).await,
        DetectedProviderId::Claude
        | DetectedProviderId::Codex
        | DetectedProviderId::Antigravity
        | DetectedProviderId::GeminiCli
        | DetectedProviderId::Opencode
        | DetectedProviderId::Openrouter
        | DetectedProviderId::Grok
        | DetectedProviderId::Kimi
        | DetectedProviderId::Cursor => true,
    }
}
