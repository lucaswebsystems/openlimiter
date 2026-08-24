use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_notification::NotificationExt;

const MAX_EVENTS: usize = 40;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Band {
    Green,
    Yellow,
    Orange,
    Red,
}

impl Band {
    fn for_percent(value: f64) -> Self {
        if value >= 90.0 {
            Self::Red
        } else if value >= 75.0 {
            Self::Orange
        } else if value >= 60.0 {
            Self::Yellow
        } else {
            Self::Green
        }
    }

    fn threshold(self) -> Option<u8> {
        match self {
            Self::Green => None,
            Self::Yellow => Some(60),
            Self::Orange => Some(75),
            Self::Red => Some(90),
        }
    }
}

#[derive(Clone, Debug)]
struct PreviousSample {
    band: Band,
    reset_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotificationSample {
    provider: String,
    window_name: String,
    usage_percent: f64,
    reset_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationEvent {
    id: String,
    provider: String,
    window_name: String,
    kind: String,
    usage_percent: f64,
    created_at: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    pub yellow: bool,
    pub orange: bool,
    pub red: bool,
    pub reset: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            yellow: true,
            orange: true,
            red: true,
            reset: false,
        }
    }
}

#[derive(Default)]
pub struct NotificationState {
    previous: Mutex<HashMap<String, PreviousSample>>,
    events: Mutex<VecDeque<NotificationEvent>>,
    settings: Mutex<NotificationSettings>,
}

fn valid_word(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

fn valid_provider(value: &str) -> bool {
    matches!(
        value,
        "CLAUDE"
            | "CODEX"
            | "ANTIGRAVITY"
            | "GEMINI_CLI"
            | "GROK"
            | "KIMI"
            | "OPENCODE"
            | "OPENROUTER"
            | "MANUAL"
    )
}

fn should_popup(settings: NotificationSettings, band: Band) -> bool {
    match band {
        Band::Green => false,
        Band::Yellow => settings.yellow,
        Band::Orange => settings.orange,
        Band::Red => settings.red,
    }
}

fn crossed_threshold(previous: Band, current: Band) -> Option<u8> {
    let threshold = current.threshold()?;
    (current.threshold() > previous.threshold()).then_some(threshold)
}

fn window_reset(previous: &PreviousSample, reset_at: Option<&str>) -> bool {
    previous.reset_at.as_deref().is_some()
        && reset_at.is_some()
        && previous.reset_at.as_deref() != reset_at
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn push_event(state: &NotificationState, event: NotificationEvent) {
    if let Ok(mut events) = state.events.lock() {
        events.push_front(event);
        events.truncate(MAX_EVENTS);
    }
}

#[tauri::command]
pub fn evaluate_notifications(
    samples: Vec<NotificationSample>,
    app: AppHandle,
    state: State<'_, NotificationState>,
) -> Result<Vec<NotificationEvent>, String> {
    if samples.len() > 256 {
        return Err("invalid_input".to_string());
    }
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state_unavailable")?
        .to_owned();
    let mut previous = state.previous.lock().map_err(|_| "state_unavailable")?;
    let mut created = Vec::new();
    for sample in samples {
        if !valid_provider(&sample.provider)
            || !valid_word(&sample.window_name, 96)
            || !sample.usage_percent.is_finite()
            || !(0.0..=100.0).contains(&sample.usage_percent)
            || sample
                .reset_at
                .as_deref()
                .is_some_and(|value| !valid_word(value, 96))
        {
            return Err("invalid_input".to_string());
        }
        let key = format!("{}:{}", sample.provider, sample.window_name);
        let band = Band::for_percent(sample.usage_percent);
        if let Some(old) = previous.get(&key) {
            if let Some(threshold) = crossed_threshold(old.band, band) {
                let event = NotificationEvent {
                    id: uuid::Uuid::new_v4().to_string(),
                    provider: sample.provider.clone(),
                    window_name: sample.window_name.clone(),
                    kind: format!("threshold_{threshold}"),
                    usage_percent: sample.usage_percent,
                    created_at: now_seconds(),
                };
                if should_popup(settings, band) {
                    let _ = app
                        .notification()
                        .builder()
                        .title(format!("{} usage", sample.provider))
                        .body(format!(
                            "{} reached {} percent.",
                            sample.window_name, threshold
                        ))
                        .show();
                }
                push_event(state.inner(), event.clone());
                created.push(event);
            }
            if settings.reset && window_reset(old, sample.reset_at.as_deref()) {
                let event = NotificationEvent {
                    id: uuid::Uuid::new_v4().to_string(),
                    provider: sample.provider.clone(),
                    window_name: sample.window_name.clone(),
                    kind: "reset".to_string(),
                    usage_percent: sample.usage_percent,
                    created_at: now_seconds(),
                };
                let _ = app
                    .notification()
                    .builder()
                    .title(format!("{} reset", sample.provider))
                    .body(format!("{} reset.", sample.window_name))
                    .show();
                push_event(state.inner(), event.clone());
                created.push(event);
            }
        }
        previous.insert(
            key,
            PreviousSample {
                band,
                reset_at: sample.reset_at,
            },
        );
    }
    Ok(created)
}

#[tauri::command]
pub fn notification_events(state: State<'_, NotificationState>) -> Vec<NotificationEvent> {
    state
        .events
        .lock()
        .map(|events| events.iter().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
pub fn notification_settings(state: State<'_, NotificationState>) -> NotificationSettings {
    state
        .settings
        .lock()
        .map(|value| *value)
        .unwrap_or_default()
}

#[tauri::command]
pub fn set_notification_settings(
    settings: NotificationSettings,
    state: State<'_, NotificationState>,
) -> Result<NotificationSettings, String> {
    *state.settings.lock().map_err(|_| "state_unavailable")? = settings;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thresholds_match_the_published_bands() {
        assert_eq!(Band::for_percent(59.9), Band::Green);
        assert_eq!(Band::for_percent(60.0), Band::Yellow);
        assert_eq!(Band::for_percent(75.0), Band::Orange);
        assert_eq!(Band::for_percent(90.0), Band::Red);
    }

    #[test]
    fn free_local_defaults_enable_transitions_and_disable_reset_noise() {
        let defaults = NotificationSettings::default();
        assert!(defaults.yellow);
        assert!(defaults.orange);
        assert!(defaults.red);
        assert!(!defaults.reset);
    }

    #[test]
    fn only_upward_band_transitions_cross_a_threshold() {
        assert_eq!(crossed_threshold(Band::Green, Band::Yellow), Some(60));
        assert_eq!(crossed_threshold(Band::Green, Band::Red), Some(90));
        assert_eq!(crossed_threshold(Band::Orange, Band::Red), Some(90));
        assert_eq!(crossed_threshold(Band::Red, Band::Orange), None);
        assert_eq!(crossed_threshold(Band::Yellow, Band::Yellow), None);
        assert_eq!(crossed_threshold(Band::Yellow, Band::Green), None);
    }

    #[test]
    fn reset_requires_two_distinct_known_reset_instants() {
        let previous = PreviousSample {
            band: Band::Green,
            reset_at: Some("2026-08-24T20:00:00Z".to_string()),
        };
        assert!(!window_reset(&previous, Some("2026-08-24T20:00:00Z")));
        assert!(window_reset(&previous, Some("2026-08-31T20:00:00Z")));
        assert!(!window_reset(&previous, None));
        let unknown = PreviousSample {
            band: Band::Green,
            reset_at: None,
        };
        assert!(!window_reset(&unknown, Some("2026-08-31T20:00:00Z")));
    }
}
