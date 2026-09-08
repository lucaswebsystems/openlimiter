use std::{collections::BTreeSet, path::PathBuf, sync::Mutex};

use crate::provider_detection::DetectedProviderId;

/// User removals are independent of detection and collection state.
pub struct ProviderSwitches {
    file: Option<PathBuf>,
    disabled: Mutex<BTreeSet<DetectedProviderId>>,
}

impl ProviderSwitches {
    pub fn at(directory: Option<PathBuf>) -> Self {
        let file = directory.map(|dir| dir.join("provider-switches.json"));
        let disabled = file.as_ref().map_or_else(BTreeSet::new, |path| {
            if path.try_exists().is_ok_and(|exists| !exists) {
                return BTreeSet::new();
            }
            crate::fsx::bounded_read(path)
                .and_then(|text| serde_json::from_str(&text).ok())
                .unwrap_or_else(|| DetectedProviderId::ALL.into_iter().collect())
        });
        Self {
            file,
            disabled: Mutex::new(disabled),
        }
    }

    pub fn disabled(&self) -> Vec<DetectedProviderId> {
        self.disabled
            .lock()
            .map(|held| held.iter().copied().collect())
            .unwrap_or_else(|_| DetectedProviderId::ALL.to_vec())
    }

    pub fn enabled(&self, provider: DetectedProviderId) -> bool {
        self.disabled
            .lock()
            .map(|held| !held.contains(&provider))
            .unwrap_or(false)
    }

    pub fn set(&self, provider: DetectedProviderId, enabled: bool) -> Result<(), String> {
        let error = || "Provider settings could not be saved. Try again.".to_string();
        let mut held = self.disabled.lock().map_err(|_| error())?;
        let mut next = held.clone();
        if enabled {
            next.remove(&provider);
        } else {
            next.insert(provider);
        }
        let path = self.file.as_ref().ok_or_else(error)?;
        crate::fsx::ensure_private_dir(path.parent().ok_or_else(error)?).map_err(|_| error())?;
        let text = serde_json::to_string(&next).map_err(|_| error())?;
        crate::fsx::atomic_write(path, &text).map_err(|_| error())?;
        *held = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switches_default_on_and_remember_each_provider_across_restarts() {
        let dir = crate::test_support::TempDir::new();
        let switches = ProviderSwitches::at(Some(dir.path().into()));
        for provider in DetectedProviderId::ALL {
            assert!(switches.enabled(provider));
            switches.set(provider, false).unwrap();
            assert!(!ProviderSwitches::at(Some(dir.path().into())).enabled(provider));
            switches.set(provider, true).unwrap();
            assert!(ProviderSwitches::at(Some(dir.path().into())).enabled(provider));
        }
    }

    #[test]
    fn failed_write_keeps_the_previous_state_and_unreadable_state_stops_reads() {
        let switches = ProviderSwitches::at(None);
        assert!(switches.set(DetectedProviderId::Codex, false).is_err());
        assert!(switches.enabled(DetectedProviderId::Codex));
        let dir = crate::test_support::TempDir::new();
        std::fs::write(dir.path().join("provider-switches.json"), "invalid").unwrap();
        assert_eq!(
            ProviderSwitches::at(Some(dir.path().into()))
                .disabled()
                .len(),
            8
        );
    }
}
