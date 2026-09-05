use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, NaiveTime, Timelike as _, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_notification::NotificationExt;

const NOTIFICATIONS_FILE_NAME: &str = "notifications-v2.json";
const DOCUMENT_VERSION: u8 = 2;
const CHANNEL: &str = "push";
const THRESHOLDS: [u32; 3] = [60, 80, 90];
const MAX_EVENTS: usize = 40;
const MAX_RECORDS: usize = 512;
const MAX_SAMPLES: usize = 256;
const LOW_RESET_PERCENT: f64 = 10.0;
const RESET_DROP_PERCENT: f64 = 40.0;
const RESET_HIGH_PERCENT: f64 = 60.0;
const RESET_CONFIRM_SECONDS: i64 = 5 * 60;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationMeter {
    ProviderUsagePercent,
    ApiBudgetPercent,
}

impl NotificationMeter {
    fn maximum(self) -> f64 {
        match self {
            Self::ProviderUsagePercent => 100.0,
            Self::ApiBudgetPercent => 100_000.0,
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::ProviderUsagePercent => "provider_usage_percent",
            Self::ApiBudgetPercent => "api_budget_percent",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationSample {
    account_id: String,
    provider: String,
    meter: NotificationMeter,
    window_name: String,
    window_id: String,
    #[serde(default)]
    window_is_authoritative: bool,
    value: f64,
    observed_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationSettings {
    pub enabled: bool,
    pub threshold_60: bool,
    pub threshold_80: bool,
    pub threshold_90: bool,
    pub reset: bool,
    pub time_zone: String,
    pub follow_system_time_zone: bool,
    pub quiet_start: String,
    pub quiet_end: String,
    pub snoozed_until: Option<String>,
    pub channel_epoch: u64,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold_60: true,
            threshold_80: true,
            threshold_90: true,
            reset: true,
            time_zone: "UTC".to_string(),
            follow_system_time_zone: true,
            quiet_start: "00:00".to_string(),
            quiet_end: "00:00".to_string(),
            snoozed_until: None,
            channel_epoch: 1,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationSettingsInput {
    pub enabled: bool,
    pub threshold_60: bool,
    pub threshold_80: bool,
    pub threshold_90: bool,
    pub reset: bool,
    pub time_zone: String,
    pub follow_system_time_zone: bool,
    pub quiet_start: String,
    pub quiet_end: String,
    pub snoozed_until: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LowCandidate {
    observed_at: i64,
    value: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MeterState {
    account_id: String,
    provider: String,
    meter: NotificationMeter,
    window_name: String,
    window_id: String,
    window_is_authoritative: bool,
    reset_id: u64,
    last_observed_at: i64,
    last_value: f64,
    peak_value: f64,
    low_candidate: Option<LowCandidate>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlertRecord {
    uniqueness_key: String,
    event_id: String,
    account_id: String,
    provider: String,
    meter: NotificationMeter,
    window_id: String,
    reset_id: u64,
    threshold: String,
    channel: String,
    status: String,
    observed_at: i64,
    value: f64,
    channel_epoch: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationEvent {
    id: String,
    account_id: String,
    provider: String,
    meter: NotificationMeter,
    window_name: String,
    window_id: String,
    reset_id: u64,
    kind: String,
    channel: String,
    status: String,
    value: f64,
    observed_at: i64,
    created_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NotificationDocument {
    version: u8,
    settings: NotificationSettings,
    meters: BTreeMap<String, MeterState>,
    records: Vec<AlertRecord>,
    events: VecDeque<NotificationEvent>,
}

impl Default for NotificationDocument {
    fn default() -> Self {
        Self {
            version: DOCUMENT_VERSION,
            settings: NotificationSettings::default(),
            meters: BTreeMap::new(),
            records: Vec::new(),
            events: VecDeque::new(),
        }
    }
}

#[derive(Clone)]
struct Popup {
    event_id: String,
    provider: String,
    threshold: String,
}

struct Evaluation {
    created: Vec<NotificationEvent>,
    popups: Vec<Popup>,
}

pub struct NotificationState {
    file: Option<PathBuf>,
    document: Mutex<Option<NotificationDocument>>,
}

impl Default for NotificationState {
    fn default() -> Self {
        Self::at(crate::state::state_directory())
    }
}

impl NotificationState {
    #[cfg_attr(not(test), allow(dead_code))]
    fn at(directory: Option<PathBuf>) -> Self {
        let file = directory.map(|value| value.join(NOTIFICATIONS_FILE_NAME));
        let document = match &file {
            Some(path) if path.exists() => crate::fsx::bounded_read(path)
                .and_then(|text| serde_json::from_str::<NotificationDocument>(&text).ok())
                .filter(valid_document),
            _ => Some(NotificationDocument::default()),
        };
        Self {
            file,
            document: Mutex::new(document),
        }
    }

    fn persist(&self, document: &NotificationDocument) -> Result<(), String> {
        let path = self.file.as_ref().ok_or_else(storage_error)?;
        let parent = path.parent().ok_or_else(storage_error)?;
        crate::fsx::ensure_private_dir(parent).map_err(|_| storage_error())?;
        let encoded = serde_json::to_string(document).map_err(|_| storage_error())?;
        crate::fsx::atomic_write(path, &encoded).map_err(|_| storage_error())
    }
}

fn storage_error() -> String {
    "notification_state_unavailable".to_string()
}

fn valid_document(document: &NotificationDocument) -> bool {
    document.version == DOCUMENT_VERSION
        && document.meters.len() <= MAX_SAMPLES * 4
        && document.records.len() <= MAX_RECORDS
        && document.events.len() <= MAX_EVENTS
        && valid_settings(&document.settings)
        && document.meters.values().all(|state| {
            valid_account(&state.account_id)
                && valid_provider(&state.provider)
                && valid_text(&state.window_name, 96)
                && valid_text(&state.window_id, 128)
                && state.last_value.is_finite()
                && (0.0..=state.meter.maximum()).contains(&state.last_value)
                && state.peak_value.is_finite()
                && state.peak_value >= state.last_value
        })
}

fn valid_text(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.chars().count() <= maximum && !value.chars().any(char::is_control)
}

fn valid_account(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && value.chars().count() <= 64
        && chars.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
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
            | "OPENAI"
            | "ANTHROPIC"
            | "XAI"
            | "MOONSHOT"
            | "MANUAL"
    )
}

fn parse_observed_at(value: &str) -> Option<i64> {
    if value.len() > 64 {
        return None;
    }
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|value| value.unix_timestamp())
}

fn parse_clock(value: &str) -> Option<NaiveTime> {
    let (hour, minute) = value.split_once(':')?;
    if hour.len() != 2 || minute.len() != 2 {
        return None;
    }
    NaiveTime::from_hms_opt(hour.parse().ok()?, minute.parse().ok()?, 0)
}

fn parse_snooze(value: Option<&str>) -> Option<Option<i64>> {
    match value {
        None => Some(None),
        Some(value) if value.len() <= 64 => {
            let parsed =
                time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
                    .ok()?;
            (parsed.offset() == time::UtcOffset::UTC).then_some(Some(parsed.unix_timestamp()))
        }
        Some(_) => None,
    }
}

fn valid_settings(settings: &NotificationSettings) -> bool {
    settings.time_zone.parse::<Tz>().is_ok()
        && parse_clock(&settings.quiet_start).is_some()
        && parse_clock(&settings.quiet_end).is_some()
        && parse_snooze(settings.snoozed_until.as_deref()).is_some()
        && settings.channel_epoch > 0
}

fn in_quiet_hours(settings: &NotificationSettings, now: i64) -> bool {
    let Ok(zone) = settings.time_zone.parse::<Tz>() else {
        return true;
    };
    let (Some(start), Some(end)) = (
        parse_clock(&settings.quiet_start),
        parse_clock(&settings.quiet_end),
    ) else {
        return true;
    };
    if start == end {
        return false;
    }
    let Some(utc) = DateTime::<Utc>::from_timestamp(now, 0) else {
        return true;
    };
    let local = utc.with_timezone(&zone);
    let current = NaiveTime::from_hms_opt(local.hour(), local.minute(), local.second())
        .unwrap_or(NaiveTime::MIN);
    if start < end {
        current >= start && current < end
    } else {
        current >= start || current < end
    }
}

fn is_snoozed(settings: &NotificationSettings, now: i64) -> bool {
    parse_snooze(settings.snoozed_until.as_deref())
        .flatten()
        .is_some_and(|until| now < until)
}

fn threshold_enabled(settings: &NotificationSettings, threshold: u32) -> bool {
    match threshold {
        60 => settings.threshold_60,
        80 => settings.threshold_80,
        90 => settings.threshold_90,
        _ => false,
    }
}

/// Whether a toast may leave the process for this band, right now.
///
/// `entitled` comes first on purpose. Every notification is a Pro capability,
/// so a Free window suppresses the popup before quiet hours, snooze or the per
/// band switches are even consulted. The event is still recorded, because the
/// history a person sees in the bell is a local fact about their own meters
/// and nothing about it is sold. What Pro pays for is the interruption.
fn popup_allowed(
    settings: &NotificationSettings,
    kind: &str,
    now: i64,
    entitled: bool,
) -> bool {
    if !entitled {
        return false;
    }
    let kind_enabled = match kind {
        "reset" => settings.reset,
        "60" => settings.threshold_60,
        "80" => settings.threshold_80,
        "90" => settings.threshold_90,
        _ => false,
    };
    settings.enabled && kind_enabled && !in_quiet_hours(settings, now) && !is_snoozed(settings, now)
}

fn identity(sample: &NotificationSample) -> String {
    serde_json::to_string(&(
        &sample.account_id,
        &sample.provider,
        sample.meter.code(),
        &sample.window_name,
    ))
    .unwrap_or_default()
}

fn uniqueness_key(
    sample: &NotificationSample,
    window_id: &str,
    reset_id: u64,
    threshold: &str,
) -> String {
    serde_json::to_string(&(
        &sample.account_id,
        &sample.provider,
        sample.meter.code(),
        window_id,
        reset_id,
        threshold,
        CHANNEL,
        if threshold == "reset" {
            "reset"
        } else {
            "threshold"
        },
    ))
    .unwrap_or_default()
}

fn authoritative_window_advanced(previous: &MeterState, sample: &NotificationSample) -> bool {
    if !previous.window_is_authoritative
        || !sample.window_is_authoritative
        || previous.window_id == sample.window_id
    {
        return false;
    }
    match (
        parse_observed_at(&previous.window_id),
        parse_observed_at(&sample.window_id),
    ) {
        (Some(old), Some(new)) => new > old,
        _ => false,
    }
}

fn hysteresis_reset(
    previous: &mut MeterState,
    sample: &NotificationSample,
    observed_at: i64,
) -> bool {
    if sample.window_is_authoritative {
        previous.low_candidate = None;
        return false;
    }
    if sample.value > LOW_RESET_PERCENT || previous.peak_value < RESET_HIGH_PERCENT {
        previous.low_candidate = None;
        return false;
    }
    let drop = previous.last_value - sample.value;
    match &previous.low_candidate {
        None if drop >= RESET_DROP_PERCENT => {
            previous.low_candidate = Some(LowCandidate {
                observed_at,
                value: sample.value,
            });
            false
        }
        Some(first)
            if observed_at > first.observed_at
                && observed_at - first.observed_at >= RESET_CONFIRM_SECONDS
                && first.value <= LOW_RESET_PERCENT =>
        {
            true
        }
        _ => false,
    }
}

fn record_event(
    document: &mut NotificationDocument,
    sample: &NotificationSample,
    reset_id: u64,
    threshold: &str,
    status: &str,
    observed_at: i64,
    now: i64,
) -> Option<NotificationEvent> {
    let key = uniqueness_key(sample, &sample.window_id, reset_id, threshold);
    if document
        .records
        .iter()
        .any(|record| record.uniqueness_key == key)
    {
        return None;
    }
    let event_id = uuid::Uuid::new_v4().to_string();
    document.records.push(AlertRecord {
        uniqueness_key: key,
        event_id: event_id.clone(),
        account_id: sample.account_id.clone(),
        provider: sample.provider.clone(),
        meter: sample.meter,
        window_id: sample.window_id.clone(),
        reset_id,
        threshold: threshold.to_string(),
        channel: CHANNEL.to_string(),
        status: status.to_string(),
        observed_at,
        value: sample.value,
        channel_epoch: document.settings.channel_epoch,
    });
    if document.records.len() > MAX_RECORDS {
        let remove = document.records.len() - MAX_RECORDS;
        document.records.drain(0..remove);
    }
    let event = NotificationEvent {
        id: event_id,
        account_id: sample.account_id.clone(),
        provider: sample.provider.clone(),
        meter: sample.meter,
        window_name: sample.window_name.clone(),
        window_id: sample.window_id.clone(),
        reset_id,
        kind: if threshold == "reset" {
            "reset".to_string()
        } else {
            format!("threshold_{threshold}")
        },
        channel: CHANNEL.to_string(),
        status: status.to_string(),
        value: sample.value,
        observed_at,
        created_at: now,
    };
    document.events.push_front(event.clone());
    document.events.truncate(MAX_EVENTS);
    Some(event)
}

/// Evaluate every sample against the stored meter state, for one plan.
///
/// `entitled` says whether this machine currently holds the alerts feature.
/// It decides one thing only: whether a crossing that would have queued a
/// toast queues it or is recorded as suppressed. Band arithmetic, coalescing,
/// hysteresis and the uniqueness ledger are identical either way, so a person
/// who upgrades does not get a backlog of old crossings fired at them.
fn evaluate_document_for_plan(
    document: &mut NotificationDocument,
    samples: Vec<NotificationSample>,
    system_time_zone: &str,
    now: i64,
    entitled: bool,
) -> Result<Evaluation, String> {
    if samples.len() > MAX_SAMPLES {
        return Err("invalid_input".to_string());
    }
    if document.settings.follow_system_time_zone {
        if system_time_zone.parse::<Tz>().is_err() {
            return Err("invalid_input".to_string());
        }
        document.settings.time_zone = system_time_zone.to_string();
    }
    let mut created = Vec::new();
    let mut popups = Vec::new();
    for sample in samples {
        let observed_at = parse_observed_at(&sample.observed_at).ok_or("invalid_input")?;
        if !valid_account(&sample.account_id)
            || !valid_provider(&sample.provider)
            || !valid_text(&sample.window_name, 96)
            || !valid_text(&sample.window_id, 128)
            || !sample.value.is_finite()
            || !(0.0..=sample.meter.maximum()).contains(&sample.value)
        {
            return Err("invalid_input".to_string());
        }
        let key = identity(&sample);
        let Some(mut previous) = document.meters.remove(&key) else {
            document.meters.insert(
                key,
                MeterState {
                    account_id: sample.account_id,
                    provider: sample.provider,
                    meter: sample.meter,
                    window_name: sample.window_name,
                    window_id: sample.window_id,
                    window_is_authoritative: sample.window_is_authoritative,
                    reset_id: 0,
                    last_observed_at: observed_at,
                    last_value: sample.value,
                    peak_value: sample.value,
                    low_candidate: None,
                },
            );
            continue;
        };
        if observed_at <= previous.last_observed_at {
            document.meters.insert(key, previous);
            continue;
        }

        let authoritative_reset = authoritative_window_advanced(&previous, &sample);
        let inferred_reset = hysteresis_reset(&mut previous, &sample, observed_at);
        if authoritative_reset || inferred_reset {
            previous.reset_id = previous.reset_id.saturating_add(1);
            previous.low_candidate = None;
            previous.peak_value = sample.value;
            let status = if popup_allowed(&document.settings, "reset", now, entitled) {
                "queued"
            } else {
                "suppressed"
            };
            if let Some(event) = record_event(
                document,
                &sample,
                previous.reset_id,
                "reset",
                status,
                observed_at,
                now,
            ) {
                if status == "queued" {
                    popups.push(Popup {
                        event_id: event.id.clone(),
                        provider: event.provider.clone(),
                        threshold: "reset".to_string(),
                    });
                }
                created.push(event);
            }
        } else {
            let crossed = THRESHOLDS
                .into_iter()
                .filter(|threshold| {
                    previous.last_value < f64::from(*threshold)
                        && sample.value >= f64::from(*threshold)
                })
                .collect::<Vec<_>>();
            let highest = crossed
                .iter()
                .rev()
                .copied()
                .find(|threshold| threshold_enabled(&document.settings, *threshold));
            for threshold in crossed
                .iter()
                .copied()
                .filter(|value| Some(*value) != highest)
            {
                let status = if threshold_enabled(&document.settings, threshold) {
                    "coalesced"
                } else {
                    "suppressed"
                };
                let _ = record_event(
                    document,
                    &sample,
                    previous.reset_id,
                    &threshold.to_string(),
                    status,
                    observed_at,
                    now,
                );
            }
            if let Some(highest) = highest {
                let highest_text = highest.to_string();
                let status = if popup_allowed(&document.settings, &highest_text, now, entitled) {
                    "queued"
                } else {
                    "suppressed"
                };
                if let Some(event) = record_event(
                    document,
                    &sample,
                    previous.reset_id,
                    &highest_text,
                    status,
                    observed_at,
                    now,
                ) {
                    if status == "queued" {
                        popups.push(Popup {
                            event_id: event.id.clone(),
                            provider: event.provider.clone(),
                            threshold: highest_text,
                        });
                    }
                    created.push(event);
                }
            }
            previous.peak_value = previous.peak_value.max(sample.value);
        }
        previous.window_name = sample.window_name;
        previous.window_id = sample.window_id;
        previous.window_is_authoritative = sample.window_is_authoritative;
        previous.last_observed_at = observed_at;
        previous.last_value = sample.value;
        document.meters.insert(key, previous);
    }
    Ok(Evaluation { created, popups })
}

/// The entitled evaluation, for tests that are about band arithmetic rather
/// than about the plan. Production always names the plan explicitly.
#[cfg(test)]
fn evaluate_document(
    document: &mut NotificationDocument,
    samples: Vec<NotificationSample>,
    system_time_zone: &str,
    now: i64,
) -> Result<Evaluation, String> {
    evaluate_document_for_plan(document, samples, system_time_zone, now, true)
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn mark_popup(document: &mut NotificationDocument, event_id: &str, delivered: bool) {
    let status = if delivered { "complete" } else { "suppressed" };
    if let Some(record) = document
        .records
        .iter_mut()
        .find(|record| record.event_id == event_id)
    {
        record.status = status.to_string();
    }
    if let Some(event) = document
        .events
        .iter_mut()
        .find(|event| event.id == event_id)
    {
        event.status = status.to_string();
    }
}

/// Whether this machine may raise a toast at all, and why not when it may not.
///
/// The window asks for this before it draws the bell, so a Free build says
/// "Alerts are a Pro feature" with an upgrade in reach rather than showing a
/// settings panel whose switches would do nothing.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationGate {
    pub entitled: bool,
}

#[tauri::command]
pub fn notification_gate(store: State<'_, crate::credentials::KeyringStore>) -> NotificationGate {
    NotificationGate {
        entitled: crate::pro::alerts_enabled(store.inner()),
    }
}

#[tauri::command]
pub fn evaluate_notifications(
    samples: Vec<NotificationSample>,
    system_time_zone: String,
    app: AppHandle,
    state: State<'_, NotificationState>,
    store: State<'_, crate::credentials::KeyringStore>,
) -> Result<Vec<NotificationEvent>, String> {
    let entitled = crate::pro::alerts_enabled(store.inner());
    let mut held = state.document.lock().map_err(|_| storage_error())?;
    let current = held.as_ref().ok_or_else(storage_error)?;
    let mut next = current.clone();
    let evaluation = evaluate_document_for_plan(
        &mut next,
        samples,
        &system_time_zone,
        now_seconds(),
        entitled,
    )?;
    state.persist(&next)?;
    *held = Some(next);
    drop(held);

    for popup in evaluation.popups {
        let (title, body) = if popup.threshold == "reset" {
            (
                format!("{} reset", popup.provider),
                "A usage window reset.".to_string(),
            )
        } else {
            (
                format!("{} usage", popup.provider),
                format!("Usage reached {} percent.", popup.threshold),
            )
        };
        let delivered = app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .is_ok();
        let mut held = state.document.lock().map_err(|_| storage_error())?;
        let document = held.as_mut().ok_or_else(storage_error)?;
        mark_popup(document, &popup.event_id, delivered);
        state.persist(document)?;
    }
    let held = state.document.lock().map_err(|_| storage_error())?;
    let document = held.as_ref().ok_or_else(storage_error)?;
    Ok(evaluation
        .created
        .into_iter()
        .map(|mut event| {
            if let Some(saved) = document.events.iter().find(|saved| saved.id == event.id) {
                event.status.clone_from(&saved.status);
            }
            event
        })
        .collect())
}

#[tauri::command]
pub fn notification_events(state: State<'_, NotificationState>) -> Vec<NotificationEvent> {
    state
        .document
        .lock()
        .ok()
        .and_then(|document| {
            document
                .as_ref()
                .map(|value| value.events.iter().cloned().collect())
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn notification_settings(state: State<'_, NotificationState>) -> NotificationSettings {
    state
        .document
        .lock()
        .ok()
        .and_then(|document| document.as_ref().map(|value| value.settings.clone()))
        .unwrap_or_default()
}

#[tauri::command]
pub fn set_notification_settings(
    settings: NotificationSettingsInput,
    state: State<'_, NotificationState>,
) -> Result<NotificationSettings, String> {
    let mut held = state.document.lock().map_err(|_| storage_error())?;
    let current = held.as_ref().ok_or_else(storage_error)?;
    let mut next = current.clone();
    let candidate = NotificationSettings {
        enabled: settings.enabled,
        threshold_60: settings.threshold_60,
        threshold_80: settings.threshold_80,
        threshold_90: settings.threshold_90,
        reset: settings.reset,
        time_zone: settings.time_zone,
        follow_system_time_zone: settings.follow_system_time_zone,
        quiet_start: settings.quiet_start,
        quiet_end: settings.quiet_end,
        snoozed_until: settings.snoozed_until,
        channel_epoch: next.settings.channel_epoch.saturating_add(1),
    };
    if !valid_settings(&candidate) {
        return Err("invalid_input".to_string());
    }
    next.settings = candidate.clone();
    state.persist(&next)?;
    *held = Some(next);
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn sample(value: f64, observed_at: &str) -> NotificationSample {
        NotificationSample {
            account_id: "account-one".to_string(),
            provider: "CODEX".to_string(),
            meter: NotificationMeter::ProviderUsagePercent,
            window_name: "WEEKLY".to_string(),
            window_id: "2026-09-08T00:00:00Z".to_string(),
            window_is_authoritative: true,
            value,
            observed_at: observed_at.to_string(),
        }
    }

    #[test]
    fn thresholds_are_60_80_and_90_and_a_jump_coalesces() {
        let mut document = NotificationDocument::default();
        evaluate_document(
            &mut document,
            vec![sample(50.0, "2026-09-01T10:00:00Z")],
            "UTC",
            1_788_278_400,
        )
        .unwrap();
        let result = evaluate_document(
            &mut document,
            vec![sample(95.0, "2026-09-01T10:01:00Z")],
            "UTC",
            1_788_278_460,
        )
        .unwrap();
        assert_eq!(result.created.len(), 1);
        assert_eq!(result.created[0].kind, "threshold_90");
        assert_eq!(result.created[0].channel, "push");
        assert_eq!(
            document
                .records
                .iter()
                .filter(|record| record.status == "coalesced")
                .map(|record| record.threshold.as_str())
                .collect::<Vec<_>>(),
            vec!["60", "80"]
        );
    }

    #[test]
    fn a_free_machine_queues_no_toast_at_any_band() {
        /* Every notification is Pro. A Free window still keeps its own local
        history, so the crossing is recorded, but nothing may interrupt. */
        let mut document = NotificationDocument::default();
        evaluate_document_for_plan(
            &mut document,
            vec![sample(50.0, "2026-09-01T10:00:00Z")],
            "UTC",
            1_788_278_400,
            false,
        )
        .unwrap();
        let result = evaluate_document_for_plan(
            &mut document,
            vec![sample(95.0, "2026-09-01T10:01:00Z")],
            "UTC",
            1_788_278_460,
            false,
        )
        .unwrap();
        assert!(result.popups.is_empty());
        assert_eq!(result.created.len(), 1);
        assert_eq!(result.created[0].kind, "threshold_90");
        assert_eq!(result.created[0].status, "suppressed");
        assert!(document
            .records
            .iter()
            .all(|record| record.status != "queued"));
    }

    #[test]
    fn an_entitled_machine_queues_the_toast_the_free_one_suppressed() {
        let mut document = NotificationDocument::default();
        evaluate_document_for_plan(
            &mut document,
            vec![sample(50.0, "2026-09-01T10:00:00Z")],
            "UTC",
            1_788_278_400,
            true,
        )
        .unwrap();
        let result = evaluate_document_for_plan(
            &mut document,
            vec![sample(95.0, "2026-09-01T10:01:00Z")],
            "UTC",
            1_788_278_460,
            true,
        )
        .unwrap();
        assert_eq!(result.popups.len(), 1);
        assert_eq!(result.popups[0].threshold, "90");
        assert_eq!(result.created[0].status, "queued");
    }

    #[test]
    fn a_free_machine_raises_no_reset_toast_either() {
        /* The reset band ships on now, so it is the band most likely to fire
        on a machine that never chose it. It obeys the same plan gate. */
        let mut document = NotificationDocument::default();
        for (value, observed, now) in [
            (80.0, "2026-09-01T10:00:00Z", 1_788_278_400),
            (5.0, "2026-09-01T10:01:00Z", 1_788_278_460),
            (4.0, "2026-09-01T10:06:00Z", 1_788_278_760),
        ] {
            let mut reading = sample(value, observed);
            reading.window_is_authoritative = false;
            reading.window_id = "weekly".to_string();
            let result = evaluate_document_for_plan(
                &mut document,
                vec![reading],
                "UTC",
                now,
                false,
            )
            .unwrap();
            assert!(result.popups.is_empty());
        }
        assert!(document
            .records
            .iter()
            .any(|record| record.threshold == "reset" && record.status == "suppressed"));
    }

    #[test]
    fn the_reset_band_ships_on_so_an_entitled_machine_hears_the_window_turn_over() {
        /* The reset is the one alert a person acts on happily rather than
        anxiously, and it shipped off by default, which meant nobody ever met
        it. It is on now, and the plan gate above is what keeps it quiet on a
        Free machine rather than a switch nobody found. */
        let settings = NotificationSettings::default();
        assert!(settings.reset);
        assert!(settings.threshold_60);
        assert!(settings.threshold_80);
        assert!(settings.threshold_90);
    }

    #[test]
    fn a_disabled_high_band_coalesces_to_the_highest_enabled_band() {
        let mut document = NotificationDocument::default();
        document.settings.threshold_90 = false;
        evaluate_document(
            &mut document,
            vec![sample(50.0, "2026-09-01T10:00:00Z")],
            "UTC",
            1_788_278_400,
        )
        .unwrap();
        let result = evaluate_document(
            &mut document,
            vec![sample(95.0, "2026-09-01T10:01:00Z")],
            "UTC",
            1_788_278_460,
        )
        .unwrap();
        assert_eq!(result.created.len(), 1);
        assert_eq!(result.created[0].kind, "threshold_80");
        assert!(document
            .records
            .iter()
            .any(|record| { record.threshold == "90" && record.status == "suppressed" }));
    }

    #[test]
    fn out_of_order_samples_cannot_change_state() {
        let mut document = NotificationDocument::default();
        evaluate_document(
            &mut document,
            vec![sample(50.0, "2026-09-01T10:00:00Z")],
            "UTC",
            1_788_278_400,
        )
        .unwrap();
        let result = evaluate_document(
            &mut document,
            vec![sample(95.0, "2026-09-01T09:59:59Z")],
            "UTC",
            1_788_278_460,
        )
        .unwrap();
        assert!(result.created.is_empty());
        assert_eq!(document.meters.values().next().unwrap().last_value, 50.0);
    }

    #[test]
    fn persisted_delivery_survives_restart_without_duplicates() {
        let dir = TempDir::new();
        let state = NotificationState::at(Some(dir.path().to_path_buf()));
        let mut document = state.document.lock().unwrap().clone().unwrap();
        evaluate_document(
            &mut document,
            vec![sample(50.0, "2026-09-01T10:00:00Z")],
            "UTC",
            1_788_278_400,
        )
        .unwrap();
        evaluate_document(
            &mut document,
            vec![sample(95.0, "2026-09-01T10:01:00Z")],
            "UTC",
            1_788_278_460,
        )
        .unwrap();
        state.persist(&document).unwrap();
        let restarted = NotificationState::at(Some(dir.path().to_path_buf()));
        let mut loaded = restarted.document.lock().unwrap().clone().unwrap();
        let result = evaluate_document(
            &mut loaded,
            vec![sample(96.0, "2026-09-01T10:02:00Z")],
            "UTC",
            1_788_278_520,
        )
        .unwrap();
        assert!(result.created.is_empty());
    }

    #[test]
    fn reset_without_window_identity_requires_two_low_samples() {
        let mut document = NotificationDocument::default();
        let mut high = sample(80.0, "2026-09-01T10:00:00Z");
        high.window_is_authoritative = false;
        high.window_id = "weekly".to_string();
        evaluate_document(&mut document, vec![high], "UTC", 1_788_278_400).unwrap();
        let mut first = sample(5.0, "2026-09-01T10:01:00Z");
        first.window_is_authoritative = false;
        first.window_id = "weekly".to_string();
        assert!(
            evaluate_document(&mut document, vec![first], "UTC", 1_788_278_460)
                .unwrap()
                .created
                .is_empty()
        );
        let mut second = sample(4.0, "2026-09-01T10:06:00Z");
        second.window_is_authoritative = false;
        second.window_id = "weekly".to_string();
        let result = evaluate_document(&mut document, vec![second], "UTC", 1_788_278_760).unwrap();
        assert_eq!(result.created.len(), 1);
        assert_eq!(result.created[0].kind, "reset");
    }

    #[test]
    fn quiet_hours_and_snooze_are_terminal_suppression() {
        let mut document = NotificationDocument::default();
        document.settings.time_zone = "America/Sao_Paulo".to_string();
        document.settings.follow_system_time_zone = false;
        document.settings.quiet_start = "22:00".to_string();
        document.settings.quiet_end = "07:00".to_string();
        evaluate_document(
            &mut document,
            vec![sample(50.0, "2026-09-02T01:00:00Z")],
            "UTC",
            1_788_332_400,
        )
        .unwrap();
        let result = evaluate_document(
            &mut document,
            vec![sample(80.0, "2026-09-02T01:01:00Z")],
            "UTC",
            1_788_332_460,
        )
        .unwrap();
        assert_eq!(result.created[0].status, "suppressed");
        assert!(result.popups.is_empty());
    }

    #[test]
    fn snooze_requires_an_explicit_utc_instant() {
        let mut settings = NotificationSettings::default();
        settings.snoozed_until = Some("2026-09-02T04:00:00Z".to_string());
        assert!(valid_settings(&settings));
        settings.snoozed_until = Some("2026-09-02T01:00:00-03:00".to_string());
        assert!(!valid_settings(&settings));
    }
}
