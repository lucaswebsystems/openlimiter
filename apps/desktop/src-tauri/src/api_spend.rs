use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{ACCEPT, ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_TYPE, RETRY_AFTER};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use time::format_description::well_known::Rfc3339;
use unicode_normalization::UnicodeNormalization as _;
use url::Url;
use zeroize::Zeroizing;

use crate::credentials::{ApiSpendKeyringStore, CredentialError, SecretStore};

const STATE_VERSION: u8 = 1;
const STATE_FILE_NAME: &str = "api-spend-v1.json";
const CONNECT_TIMEOUT_SECONDS: u64 = 5;
const TOTAL_TIMEOUT_SECONDS: u64 = 15;
const MAX_RESPONSE_BYTES: usize = 1_048_576;
const AUTOMATIC_POLL_FLOOR_SECONDS: i64 = 15 * 60;
const MANUAL_POLL_FLOOR_SECONDS: i64 = 60;
const MAX_BACKOFF_SECONDS: i64 = 6 * 60 * 60;
const MAX_PAGES: usize = 32;
const MAX_SOURCES: usize = 100;
const MAX_SAMPLES: usize = 4_096;
/// Months of history kept per source, counted back from its newest sample.
const RETAINED_MONTHS: i64 = 12;
/// Load bound used only so a 2.0.2 file that outgrew the normal cap can be
/// read once and compacted; saving still obeys the normal cap.
const COMPACTION_READ_BYTES: u64 = 8 * 1_048_576;
const MAX_SECRET_BYTES: usize = 8_192;
const MAX_TEAM_ID_BYTES: usize = 128;
const MAX_KEY_LABEL_CHARS: usize = 80;
const MAX_DECIMAL: &str = "1000000000000000";

const OPENAI_BASE: &str = "https://api.openai.com:443/v1/organization/costs";
const ANTHROPIC_BASE: &str = "https://api.anthropic.com:443/v1/organizations/cost_report";
const XAI_PREFIX: &str = "https://management-api.x.ai:443/v1/billing/teams/";
const XAI_SUFFIX: &str = "/usage";
const OPENROUTER_BASE: &str = "https://openrouter.ai:443/api/v1/credits";
const MOONSHOT_BASE: &str = "https://api.moonshot.ai:443/v1/users/me/balance";
const DEEPSEEK_BASE: &str = "https://api.deepseek.com:443/user/balance";

pub struct ApiSpendState {
    gate: tokio::sync::Mutex<()>,
}

impl Default for ApiSpendState {
    fn default() -> Self {
        Self {
            gate: tokio::sync::Mutex::new(()),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApiSpendProvider {
    Openai,
    Anthropic,
    Xai,
    Openrouter,
    Moonshot,
    #[serde(rename = "deepseek")]
    DeepSeek,
}

impl ApiSpendProvider {
    #[cfg(test)]
    const ALL: [Self; 6] = [
        Self::Openai,
        Self::Anthropic,
        Self::Xai,
        Self::Openrouter,
        Self::Moonshot,
        Self::DeepSeek,
    ];

    const fn credential_class(self) -> &'static str {
        match self {
            Self::Openai => "organization_admin_key",
            Self::Anthropic => "organization_admin_key",
            Self::Xai => "management_key",
            Self::Openrouter => "management_key",
            Self::Moonshot | Self::DeepSeek => "server_api_key",
        }
    }

    const fn metric_kind(self) -> ApiSpendMetricKind {
        match self {
            Self::Moonshot | Self::DeepSeek => ApiSpendMetricKind::Balance,
            _ => ApiSpendMetricKind::Spend,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApiSpendMetricKind {
    Spend,
    Balance,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ApiSpendFailure {
    InvalidInput,
    NotFound,
    KeyringUnavailable,
    Storage,
    TooSoon,
    Network,
    Unauthorized,
    RateLimited,
    ProviderUnavailable,
    InvalidResponse,
    UnsafeDestination,
}

#[derive(Clone, Copy, Debug)]
struct FetchFailure {
    kind: ApiSpendFailure,
    retry_after_seconds: Option<i64>,
}

impl From<ApiSpendFailure> for FetchFailure {
    fn from(kind: ApiSpendFailure) -> Self {
        Self {
            kind,
            retry_after_seconds: None,
        }
    }
}

type FetchResult<T> = Result<T, FetchFailure>;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SaveApiSpendSourceInput {
    provider: ApiSpendProvider,
    key_label: String,
    secret: String,
    #[serde(default)]
    team_id: Option<String>,
    #[serde(default)]
    budget_usd: Option<String>,
    consent_version: u32,
    confirmed: bool,
    /// Present, the key of this existing source is replaced: the source keeps
    /// its identity and starts over, with no samples or counters from the old
    /// key, which may belong to another account. Absent, a new source is added, so a
    /// second key of one provider is a second account rather than a rotation.
    #[serde(default)]
    source_id: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RefreshApiSpendInput {
    source_id: String,
    #[serde(default)]
    manual: bool,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RemoveApiSpendSourceInput {
    source_id: String,
    #[serde(default)]
    delete_samples: bool,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SetApiSpendBudgetInput {
    source_id: String,
    budget_usd: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ApiSpendSource {
    id: String,
    credential_id: String,
    provider: ApiSpendProvider,
    key_label: String,
    last_four: Option<String>,
    eligibility_class: String,
    enabled: bool,
    consent_version: u32,
    team_id: Option<String>,
    budget_usd: Option<String>,
    created_at: String,
    updated_at: String,
    last_observed_at: Option<String>,
    next_allowed_at: i64,
    consecutive_failures: u32,
    status: String,
    next_sequence: u64,
    counter_baseline_usd: Option<String>,
    counter_baseline_at: Option<String>,
    last_counter_usd: Option<String>,
    last_counter_at: Option<String>,
    counter_gap: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ApiSpendSourceView {
    pub id: String,
    pub provider: ApiSpendProvider,
    pub key_label: String,
    pub last_four: Option<String>,
    pub eligibility_class: String,
    pub enabled: bool,
    pub consent_version: u32,
    pub team_id: Option<String>,
    pub budget_usd: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_observed_at: Option<String>,
    pub next_allowed_at: i64,
    pub status: String,
    pub metric_kind: ApiSpendMetricKind,
}

impl From<&ApiSpendSource> for ApiSpendSourceView {
    fn from(source: &ApiSpendSource) -> Self {
        Self {
            id: source.id.clone(),
            provider: source.provider,
            key_label: source.key_label.clone(),
            last_four: source.last_four.clone(),
            eligibility_class: source.eligibility_class.clone(),
            enabled: source.enabled,
            consent_version: source.consent_version,
            team_id: source.team_id.clone(),
            budget_usd: source.budget_usd.clone(),
            created_at: source.created_at.clone(),
            updated_at: source.updated_at.clone(),
            last_observed_at: source.last_observed_at.clone(),
            next_allowed_at: source.next_allowed_at,
            status: source.status.clone(),
            metric_kind: source.provider.metric_kind(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ApiSpendSample {
    pub id: String,
    pub source_id: String,
    pub event_id: String,
    pub sequence: u64,
    pub provider: ApiSpendProvider,
    pub key_label: String,
    pub metric_kind: ApiSpendMetricKind,
    pub month: String,
    pub spend_usd: Option<String>,
    pub balance_usd: Option<String>,
    pub budget_usd: Option<String>,
    pub observed_at: String,
    pub source_period: String,
    pub forecast_date: Option<String>,
    pub currency_source: String,
    pub raw_unit_scale: String,
    pub completeness: String,
    pub created_at: String,
}

/// The one sample shape that crosses to the UI.
///
/// Everything here comes from `ApiSpendSample`, minus `spend_usd` and
/// `balance_usd` themselves: `display_state` is the only place an amount can
/// appear. The disk document keeps the raw fields as this module's source of
/// truth, while `snapshot` projects them into the local display shape.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSpendSampleView {
    pub id: String,
    pub source_id: String,
    pub provider: ApiSpendProvider,
    pub key_label: String,
    pub metric_kind: ApiSpendMetricKind,
    pub month: String,
    pub display_state: ApiSpendDisplayState,
    pub observed_at: String,
    pub source_period: String,
    pub forecast_date: Option<String>,
    pub completeness: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ApiSpendDocument {
    version: u8,
    sources: Vec<ApiSpendSource>,
    samples: Vec<ApiSpendSample>,
}

impl Default for ApiSpendDocument {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            sources: Vec::new(),
            samples: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSpendSnapshot {
    pub version: u8,
    pub local_display_is_free: bool,
    pub disclosure: &'static str,
    pub sources: Vec<ApiSpendSourceView>,
    pub samples: Vec<ApiSpendSampleView>,
}

/// What a spend source shows. Never what it measured.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ApiSpendDisplayState {
    /// The real reading. `percent_of_budget` is absent when the source carries
    /// no user configured budget.
    Tracked {
        amount_usd: String,
        percent_of_budget: Option<String>,
    },
    /// A balance reading. It is never converted into spend.
    Balance { amount_usd: String },
    /// A balance the provider reported only in yuan. Currencies are never
    /// converted, so there is no amount to show, and never a zero either.
    ReportedInCny,
}

/// Derives what a spend source should show, from a month to date amount,
/// its currency, which provider it is, its own budget if any, and now.
///
/// Pure and total: the same five inputs always answer the same way, and
/// nothing here reads a clock, a file or an entitlement store. `now` is
/// validated the same way `month_bounds` validates it elsewhere in this
/// file, rather than read and silently ignored.
///
/// Currency is refused, never converted, matching `parse_openai` and
/// `parse_anthropic`, which already reject a non USD bucket before a value
/// ever reaches a stored sample.
fn spend_display_state(
    provider: ApiSpendProvider,
    month_to_date_usd: &str,
    currency: &str,
    budget_usd: Option<&str>,
    now: i64,
) -> Result<ApiSpendDisplayState, ApiSpendFailure> {
    month_bounds(now)?;
    if !currency.eq_ignore_ascii_case("usd") {
        return Err(ApiSpendFailure::InvalidResponse);
    }
    let amount = decimal(month_to_date_usd)?;
    if provider.metric_kind() == ApiSpendMetricKind::Balance {
        return Ok(ApiSpendDisplayState::Balance {
            amount_usd: decimal_text(amount),
        });
    }
    let percent_of_budget = budget_usd
        .map(decimal)
        .transpose()?
        .filter(|budget| !budget.is_zero())
        .map(|budget| decimal_text((amount / budget * Decimal::from(100)).round_dp(2)));
    Ok(ApiSpendDisplayState::Tracked {
        amount_usd: decimal_text(amount),
        percent_of_budget,
    })
}

/// Builds the one sample shape the UI ever sees. `source` is the source's
/// CURRENT row when one still exists, so a budget edited after the last
/// observation is reflected immediately, exactly as the existing bar already
/// does; a sample whose source was removed with its history kept falls back
/// to the budget the sample itself observed.
fn sample_view(
    sample: &ApiSpendSample,
    source: Option<&ApiSpendSource>,
    now: i64,
) -> Result<ApiSpendSampleView, ApiSpendFailure> {
    let display_state = match sample
        .spend_usd
        .as_deref()
        .or(sample.balance_usd.as_deref())
    {
        Some(amount) => {
            let budget = source
                .map(|source| source.budget_usd.as_deref())
                .unwrap_or_else(|| sample.budget_usd.as_deref());
            spend_display_state(sample.provider, amount, "usd", budget, now)?
        }
        /* validate_document admits a sample without an amount only as a
        yuan balance. */
        None => ApiSpendDisplayState::ReportedInCny,
    };
    Ok(ApiSpendSampleView {
        id: sample.id.clone(),
        source_id: sample.source_id.clone(),
        provider: sample.provider,
        key_label: sample.key_label.clone(),
        metric_kind: sample.metric_kind,
        month: sample.month.clone(),
        display_state,
        observed_at: sample.observed_at.clone(),
        source_period: sample.source_period.clone(),
        forecast_date: sample.forecast_date.clone(),
        completeness: sample.completeness.clone(),
    })
}

fn snapshot(document: &ApiSpendDocument, now: i64) -> Result<ApiSpendSnapshot, ApiSpendFailure> {
    let samples = document
        .samples
        .iter()
        .map(|sample| {
            let source = document
                .sources
                .iter()
                .find(|source| source.id == sample.source_id);
            sample_view(sample, source, now)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ApiSpendSnapshot {
        version: STATE_VERSION,
        local_display_is_free: true,
        disclosure: "Best effort provider observation. Missing periods remain gaps. Moonshot and DeepSeek are balance, not spend.",
        sources: document.sources.iter().map(ApiSpendSourceView::from).collect(),
        samples,
    })
}

fn state_path() -> Result<PathBuf, ApiSpendFailure> {
    crate::state::state_directory()
        .map(|directory| directory.join(STATE_FILE_NAME))
        .ok_or(ApiSpendFailure::Storage)
}

fn normalized_label(value: &str) -> Result<String, ApiSpendFailure> {
    let normalized: String = value.trim().nfc().collect();
    if normalized.is_empty()
        || normalized.chars().count() > MAX_KEY_LABEL_CHARS
        || normalized.chars().any(char::is_control)
    {
        return Err(ApiSpendFailure::InvalidInput);
    }
    Ok(normalized)
}

fn decimal(value: &str) -> Result<Decimal, ApiSpendFailure> {
    let parsed = Decimal::from_str(value).map_err(|_| ApiSpendFailure::InvalidInput)?;
    let maximum = Decimal::from_str(MAX_DECIMAL).expect("constant decimal");
    if parsed.is_sign_negative() || parsed > maximum {
        return Err(ApiSpendFailure::InvalidInput);
    }
    Ok(parsed)
}

fn decimal_text(value: Decimal) -> String {
    value.normalize().to_string()
}

fn json_decimal(value: &Value) -> Result<Decimal, ApiSpendFailure> {
    match value {
        Value::String(text) => decimal(text).map_err(|_| ApiSpendFailure::InvalidResponse),
        Value::Number(number) => {
            decimal(&number.to_string()).map_err(|_| ApiSpendFailure::InvalidResponse)
        }
        _ => Err(ApiSpendFailure::InvalidResponse),
    }
}

fn valid_team_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TEAM_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn now_seconds() -> Result<i64, ApiSpendFailure> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|value| i64::try_from(value.as_secs()).ok())
        .ok_or(ApiSpendFailure::Storage)
}

fn timestamp(seconds: i64) -> Result<String, ApiSpendFailure> {
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .map_err(|_| ApiSpendFailure::InvalidInput)?
        .format(&Rfc3339)
        .map_err(|_| ApiSpendFailure::InvalidInput)
}

fn parse_timestamp(value: &str) -> Result<i64, ApiSpendFailure> {
    time::OffsetDateTime::parse(value, &Rfc3339)
        .map(|time| time.unix_timestamp())
        .map_err(|_| ApiSpendFailure::Storage)
}

fn month_bounds(now: i64) -> Result<(i64, i64, String), ApiSpendFailure> {
    let instant = time::OffsetDateTime::from_unix_timestamp(now)
        .map_err(|_| ApiSpendFailure::InvalidInput)?;
    let date = time::Date::from_calendar_date(instant.year(), instant.month(), 1)
        .map_err(|_| ApiSpendFailure::InvalidInput)?;
    let start = date.midnight().assume_utc().unix_timestamp();
    Ok((start, now, date.to_string()))
}

fn validate_document(document: &ApiSpendDocument) -> Result<(), ApiSpendFailure> {
    if document.version != STATE_VERSION
        || document.sources.len() > MAX_SOURCES
        || document.samples.len() > MAX_SAMPLES
    {
        return Err(ApiSpendFailure::Storage);
    }
    let mut ids = HashSet::new();
    let mut credential_ids = HashSet::new();
    for source in &document.sources {
        if uuid::Uuid::parse_str(&source.id).is_err()
            || !ids.insert(source.id.as_str())
            || uuid::Uuid::parse_str(&source.credential_id).is_err()
            || source.credential_id == source.id
            || !credential_ids.insert(source.credential_id.as_str())
            || normalized_label(&source.key_label).as_deref() != Ok(source.key_label.as_str())
            || source
                .budget_usd
                .as_deref()
                .is_some_and(|value| decimal(value).is_err())
            || source.provider == ApiSpendProvider::Xai
                && !source.team_id.as_deref().is_some_and(valid_team_id)
            || source.provider != ApiSpendProvider::Xai && source.team_id.is_some()
            || parse_timestamp(&source.created_at).is_err()
            || parse_timestamp(&source.updated_at).is_err()
        {
            return Err(ApiSpendFailure::Storage);
        }
    }
    if document.samples.iter().any(|sample| {
        uuid::Uuid::parse_str(&sample.id).is_err()
            || uuid::Uuid::parse_str(&sample.event_id).is_err()
            || uuid::Uuid::parse_str(&sample.source_id).is_err()
            || sample.sequence == 0
            || sample
                .spend_usd
                .as_deref()
                .is_some_and(|value| decimal(value).is_err())
            || sample
                .balance_usd
                .as_deref()
                .is_some_and(|value| decimal(value).is_err())
            /* Yuan is stored without an amount and an amount is never yuan:
            nothing is converted, and nothing missing reads as zero. */
            || (sample.currency_source == "provider_cny")
                != (sample.spend_usd.is_none() && sample.balance_usd.is_none())
    }) {
        return Err(ApiSpendFailure::Storage);
    }
    Ok(())
}

/// The dollar totals this device would sync, newest observation per source.
///
/// Decision D4 for 1.3: the keys stay in the device keyring and the totals
/// travel. Nothing here reads a key, and a document that cannot be read at
/// all is no totals rather than an error, because a spend meter that has
/// never been set up must not stop the percentages from syncing.
pub(crate) fn synced_spend_samples(limit: usize) -> Vec<crate::account::ApiSpendSample> {
    let Ok(path) = state_path() else {
        return Vec::new();
    };
    let Ok(document) = load_at(&path) else {
        return Vec::new();
    };
    contract_spend_samples(&document, limit)
}

/// The newest spend observation of each source, in the hosted contract's
/// shape, bounded by what is left of the envelope's row budget.
///
/// The server refuses a whole envelope that carries two rows with the same
/// account and provider, so a label that slugs into one already taken is
/// given the source identifier as a suffix rather than dropped.
fn contract_spend_samples(
    document: &ApiSpendDocument,
    limit: usize,
) -> Vec<crate::account::ApiSpendSample> {
    let mut newest: HashMap<&str, &ApiSpendSample> = HashMap::new();
    for sample in &document.samples {
        if !matches!(sample.metric_kind, ApiSpendMetricKind::Spend) {
            continue;
        }
        match newest.get(sample.source_id.as_str()) {
            Some(current) if current.observed_at >= sample.observed_at => {}
            _ => {
                newest.insert(sample.source_id.as_str(), sample);
            }
        }
    }
    let mut chosen = newest.into_values().collect::<Vec<_>>();
    chosen.sort_by(|left, right| {
        right
            .observed_at
            .cmp(&left.observed_at)
            .then_with(|| left.source_id.cmp(&right.source_id))
    });
    let mut rows = Vec::new();
    let mut identities = HashSet::new();
    for sample in chosen {
        if rows.len() >= limit {
            break;
        }
        let source = document
            .sources
            .iter()
            .find(|candidate| candidate.id == sample.source_id);
        let Some(mut row) = contract_spend_sample(source, sample) else {
            continue;
        };
        if !identities.insert((row.account_id.clone(), row.provider.clone())) {
            let suffix = sample.source_id.chars().take(8).collect::<String>();
            row.account_id.truncate(70);
            row.account_id = format!("{}-{suffix}", row.account_id.trim_end_matches('-'));
            if !identities.insert((row.account_id.clone(), row.provider.clone())) {
                continue;
            }
        }
        rows.push(row);
    }
    rows
}

/// One stored observation in the hosted contract's own shape, field by
/// field, because the two models were built for different jobs.
///
/// * `account_id` has no counterpart here. The contract wants a slug, so the
///   key label becomes one, and the source identifier keeps two labels that
///   slug alike apart.
/// * `raw_unit_scale` is a unit name on this side and a number on that one:
///   `usd_cents` is a hundred raw units to the dollar, every other unit this
///   window reads is one.
/// * `source_period` is stored as the Postgres range text it was written
///   with and travels as the two instants inside it.
/// * `period_complete` is the completeness word: only `complete` is a
///   complete period, `period_incomplete` and `since_connected` are not.
/// * `forecast_date` and `forecast_input` travel as nothing, because this
///   window derives no forecast yet and the contract requires the date and
///   the input to be present together or absent together. Both are nullable
///   there, so the row is complete without them.
/// * Moonshot and DeepSeek are absent: they report a balance rather than
///   spend, and the contract carries balances in a list this envelope does
///   not send. DeepSeek has no hosted contract at all and stays local.
fn contract_spend_sample(
    source: Option<&ApiSpendSource>,
    sample: &ApiSpendSample,
) -> Option<crate::account::ApiSpendSample> {
    let provider = contract_provider(sample.provider)?;
    let spend_usd = contract_amount(sample.spend_usd.as_deref()?)?;
    let budget_usd = match source
        .and_then(|value| value.budget_usd.as_deref())
        .or(sample.budget_usd.as_deref())
    {
        Some(text) => Some(contract_amount(text)?),
        None => None,
    };
    let key_label = source
        .map(|value| value.key_label.as_str())
        .unwrap_or(sample.key_label.as_str());
    let labelled = key_label.chars().count();
    let month_shaped = sample.month.len() == 10
        && sample.month.ends_with("-01")
        && sample
            .month
            .chars()
            .all(|character| character.is_ascii_digit() || character == '-');
    if labelled == 0
        || labelled > 80
        || !month_shaped
        || uuid::Uuid::parse_str(&sample.source_id).is_err()
    {
        return None;
    }
    let currency_source = sample.currency_source.to_ascii_uppercase();
    if currency_source.is_empty()
        || currency_source.len() > 32
        || !currency_source.chars().all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
    {
        return None;
    }
    Some(crate::account::ApiSpendSample {
        source_id: sample.source_id.to_ascii_lowercase(),
        account_id: account_slug(key_label, &sample.source_id),
        provider: provider.to_string(),
        key_label: key_label.to_string(),
        month: sample.month.clone(),
        spend_usd,
        budget_usd,
        source_period: contract_period(&sample.source_period)?,
        currency_source,
        raw_unit_scale: contract_unit_scale(&sample.raw_unit_scale)?,
        forecast_date: None,
        forecast_input: None,
        period_complete: sample.completeness == "complete",
    })
}

fn contract_provider(provider: ApiSpendProvider) -> Option<&'static str> {
    match provider {
        ApiSpendProvider::Openai => Some("OPENAI"),
        ApiSpendProvider::Anthropic => Some("ANTHROPIC"),
        ApiSpendProvider::Xai => Some("XAI"),
        ApiSpendProvider::Openrouter => Some("OPENROUTER"),
        ApiSpendProvider::Moonshot | ApiSpendProvider::DeepSeek => None,
    }
}

fn contract_amount(value: &str) -> Option<f64> {
    let amount = decimal_text(decimal(value).ok()?).parse::<f64>().ok()?;
    (0.0..100_000_000_000_000.0)
        .contains(&amount)
        .then_some(amount)
}

fn contract_unit_scale(raw: &str) -> Option<f64> {
    match raw {
        "usd" | "lifetime_usd" | "current_balance_usd" => Some(1.0),
        "usd_cents" => Some(100.0),
        _ => None,
    }
}

fn contract_period(range: &str) -> Option<[String; 2]> {
    let (start, end) = range
        .strip_prefix('[')?
        .strip_suffix(')')?
        .split_once(", ")?;
    let opened = time::OffsetDateTime::parse(start, &Rfc3339).ok()?;
    let closed = time::OffsetDateTime::parse(end, &Rfc3339).ok()?;
    (opened < closed).then(|| [start.to_string(), end.to_string()])
}

fn account_slug(label: &str, source_id: &str) -> String {
    let mut slug = String::new();
    let mut separated = false;
    for character in label.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            separated = false;
        } else if !slug.is_empty() && !separated {
            slug.push('-');
            separated = true;
        }
    }
    slug.truncate(70);
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        return source_id.chars().take(8).collect();
    }
    slug
}

/// Year and month of a sample's `month` field (`2026-09-01`) as one count.
fn month_index(sample: &ApiSpendSample) -> Option<i64> {
    let year: i64 = sample.month.get(0..4)?.parse().ok()?;
    let month: i64 = sample.month.get(5..7)?.parse().ok()?;
    (1..=12).contains(&month).then_some(year * 12 + month)
}

/// Bounds the sample history so the state file can never reach its size cap.
///
/// Per source, counted from its newest sample: the newest month keeps its
/// first and newest samples, each older month of the last
/// `RETAINED_MONTHS` keeps only its newest, and the rest go. The newest
/// sample of a source is never dropped, and the OpenRouter month to date
/// amount does not read samples (it reads the counter fields on the source),
/// so nothing here changes a derived amount. Samples with an unreadable month
/// are kept as they are.
fn compact_samples(document: &mut ApiSpendDocument) {
    let mut keep = vec![true; document.samples.len()];
    let mut by_source: HashMap<&str, Vec<(usize, i64, i64)>> = HashMap::new();
    for (position, sample) in document.samples.iter().enumerate() {
        let (Some(month), Ok(at)) = (month_index(sample), parse_timestamp(&sample.observed_at))
        else {
            continue;
        };
        by_source
            .entry(sample.source_id.as_str())
            .or_default()
            .push((position, month, at));
    }
    for entries in by_source.values_mut() {
        // Position breaks ties so equal timestamps stay in written order.
        entries.sort_by_key(|&(position, _, at)| (at, position));
        let newest_month = entries
            .iter()
            .map(|&(_, month, _)| month)
            .max()
            .unwrap_or(0);
        let mut months: HashMap<i64, (usize, usize)> = HashMap::new();
        for &(position, month, _) in entries.iter() {
            months
                .entry(month)
                .and_modify(|range| range.1 = position)
                .or_insert((position, position));
        }
        for &(position, month, _) in entries.iter() {
            let (first, newest) = months[&month];
            let wanted = month >= newest_month - RETAINED_MONTHS
                && (position == newest || (month == newest_month && position == first));
            keep[position] = wanted;
        }
    }
    let mut index = 0;
    document.samples.retain(|_| {
        index += 1;
        keep[index - 1]
    });
}

fn load_at(path: &Path) -> Result<ApiSpendDocument, ApiSpendFailure> {
    if !path.exists() {
        return Ok(ApiSpendDocument::default());
    }
    let text = crate::fsx::bounded_read_up_to(path, COMPACTION_READ_BYTES)
        .ok_or(ApiSpendFailure::Storage)?;
    let mut document: ApiSpendDocument =
        serde_json::from_str(&text).map_err(|_| ApiSpendFailure::Storage)?;
    compact_samples(&mut document);
    validate_document(&document)?;
    Ok(document)
}

fn save_at(path: &Path, document: &ApiSpendDocument) -> Result<(), ApiSpendFailure> {
    let mut document = document.clone();
    compact_samples(&mut document);
    let document = &document;
    validate_document(document)?;
    let parent = path.parent().ok_or(ApiSpendFailure::Storage)?;
    crate::fsx::ensure_private_dir(parent).map_err(|_| ApiSpendFailure::Storage)?;
    let text = serde_json::to_string(document).map_err(|_| ApiSpendFailure::Storage)?;
    if text.len() > MAX_RESPONSE_BYTES {
        return Err(ApiSpendFailure::Storage);
    }
    crate::fsx::atomic_write(path, &text).map_err(|_| ApiSpendFailure::Storage)
}

fn last_four(secret: &str) -> Option<String> {
    let characters: Vec<char> = secret.chars().collect();
    (characters.len() >= 4).then(|| characters[characters.len() - 4..].iter().collect())
}

fn save_source_core(
    path: &Path,
    store: &dyn SecretStore,
    input: SaveApiSpendSourceInput,
    now: i64,
) -> Result<ApiSpendSnapshot, ApiSpendFailure> {
    let secret = Zeroizing::new(input.secret);
    if !input.confirmed
        || input.consent_version == 0
        || secret.is_empty()
        || secret.len() > MAX_SECRET_BYTES
        || secret.chars().any(char::is_control)
    {
        return Err(ApiSpendFailure::InvalidInput);
    }
    let key_label = normalized_label(&input.key_label)?;
    let team_id = match input.provider {
        ApiSpendProvider::Xai => Some(
            input
                .team_id
                .filter(|value| valid_team_id(value))
                .ok_or(ApiSpendFailure::InvalidInput)?,
        ),
        _ if input.team_id.is_some() => return Err(ApiSpendFailure::InvalidInput),
        _ => None,
    };
    let budget_usd = input
        .budget_usd
        .as_deref()
        .map(decimal)
        .transpose()?
        .map(decimal_text);
    let mut document = load_at(path)?;
    let replacing = match input.source_id.as_deref() {
        Some(id) => {
            uuid::Uuid::parse_str(id).map_err(|_| ApiSpendFailure::InvalidInput)?;
            let index = document
                .sources
                .iter()
                .position(|source| source.id == id)
                .ok_or(ApiSpendFailure::NotFound)?;
            if document.sources[index].provider != input.provider {
                return Err(ApiSpendFailure::InvalidInput);
            }
            Some(index)
        }
        None if document.sources.len() >= MAX_SOURCES => return Err(ApiSpendFailure::Storage),
        None => None,
    };
    let credential_id = uuid::Uuid::new_v4().to_string();
    let observed_last_four = last_four(&secret);
    store
        .store_secret(&credential_id, &secret)
        .map_err(|_| ApiSpendFailure::KeyringUnavailable)?;
    let now_text = timestamp(now)?;
    let replaced_credential = if let Some(index) = replacing {
        let source = &mut document.sources[index];
        let previous = std::mem::replace(&mut source.credential_id, credential_id.clone());
        source.key_label = key_label;
        source.last_four = observed_last_four;
        source.consent_version = input.consent_version;
        source.team_id = team_id;
        /* A replacement is about the key. The budget changes only when one
        is given; set_budget is how it is cleared. */
        if budget_usd.is_some() {
            source.budget_usd = budget_usd;
        }
        source.updated_at = now_text;
        source.last_observed_at = None;
        source.next_allowed_at = 0;
        source.consecutive_failures = 0;
        source.status = "pending_validation".to_string();
        /* The new key may belong to another account, so no lifetime counter
        delta is ever taken across it. */
        source.counter_baseline_usd = None;
        source.counter_baseline_at = None;
        source.last_counter_usd = None;
        source.last_counter_at = None;
        source.counter_gap = false;
        /* Its money leaves with the old key for the same reason: every reader
        selects samples by this source id, so nothing is shown here until the
        new key's first good reading. */
        let id = source.id.clone();
        document.samples.retain(|sample| sample.source_id != id);
        Some(previous)
    } else {
        document.sources.push(ApiSpendSource {
            id: uuid::Uuid::new_v4().to_string(),
            credential_id: credential_id.clone(),
            provider: input.provider,
            key_label,
            last_four: observed_last_four,
            eligibility_class: input.provider.credential_class().to_string(),
            enabled: true,
            consent_version: input.consent_version,
            team_id,
            budget_usd,
            created_at: now_text.clone(),
            updated_at: now_text,
            last_observed_at: None,
            next_allowed_at: 0,
            consecutive_failures: 0,
            status: "pending_validation".to_string(),
            next_sequence: 1,
            counter_baseline_usd: None,
            counter_baseline_at: None,
            last_counter_usd: None,
            last_counter_at: None,
            counter_gap: false,
        });
        None
    };
    if let Err(error) = save_at(path, &document) {
        let _ = store.delete_secret(&credential_id);
        return Err(error);
    }
    if let Some(previous) = replaced_credential {
        /* The state no longer names the old key. A keyring that refuses this
        delete leaves an entry nothing reads, never a source on the old key. */
        let _ = store.delete_secret(&previous);
    }
    snapshot(&document, now)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RequestMethod {
    Get,
    Post,
}

#[derive(Clone, Debug)]
struct RequestSpec {
    method: RequestMethod,
    url: Url,
    body: Option<Vec<u8>>,
    auth_header: &'static str,
}

fn request_spec(
    source: &ApiSpendSource,
    start: i64,
    end: i64,
    page: Option<&str>,
) -> Result<RequestSpec, ApiSpendFailure> {
    if page.is_some_and(|value| {
        value.is_empty() || value.len() > 512 || value.chars().any(char::is_control)
    }) {
        return Err(ApiSpendFailure::InvalidResponse);
    }
    let (method, mut url, body, auth_header) = match source.provider {
        ApiSpendProvider::Openai => (
            RequestMethod::Get,
            Url::parse(OPENAI_BASE).map_err(|_| ApiSpendFailure::UnsafeDestination)?,
            None,
            "authorization",
        ),
        ApiSpendProvider::Anthropic => (
            RequestMethod::Get,
            Url::parse(ANTHROPIC_BASE).map_err(|_| ApiSpendFailure::UnsafeDestination)?,
            None,
            "x-api-key",
        ),
        ApiSpendProvider::Xai => {
            let team = source
                .team_id
                .as_deref()
                .filter(|value| valid_team_id(value))
                .ok_or(ApiSpendFailure::InvalidInput)?;
            let url = Url::parse(&format!("{XAI_PREFIX}{team}{XAI_SUFFIX}"))
                .map_err(|_| ApiSpendFailure::UnsafeDestination)?;
            let start_text = time::OffsetDateTime::from_unix_timestamp(start)
                .map_err(|_| ApiSpendFailure::InvalidInput)?
                .format(&time::macros::format_description!(
                    "[year]-[month]-[day] [hour]:[minute]:[second]"
                ))
                .map_err(|_| ApiSpendFailure::InvalidInput)?;
            let end_text = time::OffsetDateTime::from_unix_timestamp(end)
                .map_err(|_| ApiSpendFailure::InvalidInput)?
                .format(&time::macros::format_description!(
                    "[year]-[month]-[day] [hour]:[minute]:[second]"
                ))
                .map_err(|_| ApiSpendFailure::InvalidInput)?;
            (
                RequestMethod::Post,
                url,
                Some(
                    serde_json::to_vec(&json!({
                        "analyticsRequest": {
                            "timeRange": {
                                "startTime": start_text,
                                "endTime": end_text,
                                "timezone": "Etc/GMT"
                            },
                            "timeUnit": "TIME_UNIT_DAY",
                            "values": [{"name": "usd", "aggregation": "AGGREGATION_SUM"}],
                            "groupBy": [],
                            "filters": []
                        }
                    }))
                    .map_err(|_| ApiSpendFailure::InvalidInput)?,
                ),
                "authorization",
            )
        }
        ApiSpendProvider::Openrouter => (
            RequestMethod::Get,
            Url::parse(OPENROUTER_BASE).map_err(|_| ApiSpendFailure::UnsafeDestination)?,
            None,
            "authorization",
        ),
        ApiSpendProvider::Moonshot => (
            RequestMethod::Get,
            Url::parse(MOONSHOT_BASE).map_err(|_| ApiSpendFailure::UnsafeDestination)?,
            None,
            "authorization",
        ),
        ApiSpendProvider::DeepSeek => (
            RequestMethod::Get,
            Url::parse(DEEPSEEK_BASE).map_err(|_| ApiSpendFailure::UnsafeDestination)?,
            None,
            "authorization",
        ),
    };
    match source.provider {
        ApiSpendProvider::Openai => {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("start_time", &start.to_string())
                .append_pair("end_time", &end.to_string())
                .append_pair("bucket_width", "1d")
                .append_pair("limit", "180");
            if let Some(page) = page {
                query.append_pair("page", page);
            }
        }
        ApiSpendProvider::Anthropic => {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("starting_at", &timestamp(start)?)
                .append_pair("ending_at", &timestamp(end)?)
                .append_pair("bucket_width", "1d")
                .append_pair("limit", "31");
            if let Some(page) = page {
                query.append_pair("page", page);
            }
        }
        _ if page.is_some() => return Err(ApiSpendFailure::InvalidResponse),
        _ => {}
    }
    validate_fixed_destination(source.provider, &url)?;
    Ok(RequestSpec {
        method,
        url,
        body,
        auth_header,
    })
}

fn validate_fixed_destination(
    provider: ApiSpendProvider,
    url: &Url,
) -> Result<(), ApiSpendFailure> {
    let expected_host = match provider {
        ApiSpendProvider::Openai => "api.openai.com",
        ApiSpendProvider::Anthropic => "api.anthropic.com",
        ApiSpendProvider::Xai => "management-api.x.ai",
        ApiSpendProvider::Openrouter => "openrouter.ai",
        ApiSpendProvider::Moonshot => "api.moonshot.ai",
        ApiSpendProvider::DeepSeek => "api.deepseek.com",
    };
    let path_ok = match provider {
        ApiSpendProvider::Openai => url.path() == "/v1/organization/costs",
        ApiSpendProvider::Anthropic => url.path() == "/v1/organizations/cost_report",
        ApiSpendProvider::Xai => {
            url.path().starts_with("/v1/billing/teams/") && url.path().ends_with("/usage")
        }
        ApiSpendProvider::Openrouter => url.path() == "/api/v1/credits",
        ApiSpendProvider::Moonshot => url.path() == "/v1/users/me/balance",
        ApiSpendProvider::DeepSeek => url.path() == "/user/balance",
    };
    if url.scheme() != "https"
        || url.host_str() != Some(expected_host)
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || !path_ok
        || url.path().split('/').any(|part| matches!(part, "." | ".."))
    {
        return Err(ApiSpendFailure::UnsafeDestination);
    }
    Ok(())
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => public_ipv4(value),
        IpAddr::V6(value) => public_ipv6(value),
    }
}

fn public_ipv4(value: Ipv4Addr) -> bool {
    let [a, b, c, d] = value.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || (a == 255 && b == 255 && c == 255 && d == 255))
}

fn public_ipv6(value: Ipv6Addr) -> bool {
    if let Some(mapped) = value.to_ipv4_mapped() {
        return public_ipv4(mapped);
    }
    let segments = value.segments();
    !(value.is_unspecified()
        || value.is_loopback()
        || value.is_multicast()
        || segments[0] & 0xfe00 == 0xfc00
        || segments[0] & 0xffc0 == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

async fn resolved_public_addresses(host: &str) -> Result<Vec<SocketAddr>, ApiSpendFailure> {
    let addresses = tokio::time::timeout(
        Duration::from_secs(CONNECT_TIMEOUT_SECONDS),
        tokio::net::lookup_host((host, 443)),
    )
    .await
    .map_err(|_| ApiSpendFailure::Network)?
    .map_err(|_| ApiSpendFailure::Network)?
    .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err(ApiSpendFailure::UnsafeDestination);
    }
    Ok(addresses)
}

fn retry_after_seconds(
    value: Option<&reqwest::header::HeaderValue>,
    now: SystemTime,
) -> Option<i64> {
    let text = value?.to_str().ok()?;
    if let Ok(seconds) = text.parse::<i64>() {
        return Some(seconds.clamp(1, MAX_BACKOFF_SECONDS));
    }
    let deadline = httpdate::parse_http_date(text).ok()?;
    let seconds = deadline.duration_since(now).ok()?.as_secs();
    Some(i64::try_from(seconds).ok()?.clamp(1, MAX_BACKOFF_SECONDS))
}

async fn send_request(
    provider: ApiSpendProvider,
    spec: RequestSpec,
    secret: Zeroizing<String>,
) -> FetchResult<Value> {
    validate_fixed_destination(provider, &spec.url)?;
    let host = spec
        .url
        .host_str()
        .ok_or(ApiSpendFailure::UnsafeDestination)?;
    let addresses = resolved_public_addresses(host).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TOTAL_TIMEOUT_SECONDS))
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECONDS))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| ApiSpendFailure::Network)?;
    let mut builder = match spec.method {
        RequestMethod::Get => client.get(spec.url.clone()),
        RequestMethod::Post => client.post(spec.url.clone()),
    }
    .header(ACCEPT, "application/json")
    .header(ACCEPT_ENCODING, "identity")
    .header("user-agent", crate::net::OPENLIMITER_USER_AGENT);
    builder = if spec.auth_header == "x-api-key" {
        builder.header("x-api-key", secret.as_str())
    } else {
        builder.bearer_auth(secret.as_str())
    };
    if provider == ApiSpendProvider::Anthropic {
        builder = builder.header("anthropic-version", "2023-06-01");
    }
    if let Some(body) = spec.body {
        builder = builder.header(CONTENT_TYPE, "application/json").body(body);
    }
    let request = builder.build().map_err(|_| ApiSpendFailure::Network)?;
    drop(secret);
    let expected = request.url().clone();
    let response = client
        .execute(request)
        .await
        .map_err(|_| ApiSpendFailure::Network)?;
    if response.url() != &expected || response.status().is_redirection() {
        return Err(ApiSpendFailure::UnsafeDestination.into());
    }
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(ApiSpendFailure::Unauthorized.into());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(FetchFailure {
            kind: ApiSpendFailure::RateLimited,
            retry_after_seconds: retry_after_seconds(
                response.headers().get(RETRY_AFTER),
                SystemTime::now(),
            ),
        });
    }
    if status.is_server_error() {
        return Err(ApiSpendFailure::ProviderUnavailable.into());
    }
    if !status.is_success() {
        return Err(ApiSpendFailure::InvalidResponse.into());
    }
    if response
        .headers()
        .get(CONTENT_ENCODING)
        .is_some_and(|value| value.as_bytes() != b"identity")
        || response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(ApiSpendFailure::InvalidResponse.into());
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ApiSpendFailure::Network)?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(ApiSpendFailure::InvalidResponse.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ApiSpendFailure::InvalidResponse.into())
}

#[derive(Clone, Debug)]
struct ParsedProviderValue {
    /// `None` only for a balance reported in yuan alone, which is never
    /// converted and so has no amount here.
    value: Option<Decimal>,
    raw_unit_scale: &'static str,
    incomplete: bool,
    next_page: Option<String>,
    /// The state a balance source carries beyond its amount, as its status.
    note: Option<&'static str>,
}

fn page_cursor(value: &Value) -> Result<Option<String>, ApiSpendFailure> {
    let has_more = value
        .get("has_more")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let cursor = value
        .get("next_page")
        .and_then(Value::as_str)
        .map(str::to_string);
    if has_more && cursor.as_deref().is_none_or(str::is_empty) {
        return Err(ApiSpendFailure::InvalidResponse);
    }
    Ok(has_more.then_some(cursor).flatten())
}

fn parse_openai(value: &Value) -> Result<ParsedProviderValue, ApiSpendFailure> {
    let buckets = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or(ApiSpendFailure::InvalidResponse)?;
    let mut total = Decimal::ZERO;
    for bucket in buckets {
        let results = bucket
            .get("results")
            .and_then(Value::as_array)
            .ok_or(ApiSpendFailure::InvalidResponse)?;
        for result in results {
            let amount = result
                .get("amount")
                .and_then(Value::as_object)
                .ok_or(ApiSpendFailure::InvalidResponse)?;
            if !amount
                .get("currency")
                .and_then(Value::as_str)
                .is_some_and(|currency| currency.eq_ignore_ascii_case("usd"))
            {
                return Err(ApiSpendFailure::InvalidResponse);
            }
            total = total
                .checked_add(json_decimal(
                    amount
                        .get("value")
                        .ok_or(ApiSpendFailure::InvalidResponse)?,
                )?)
                .ok_or(ApiSpendFailure::InvalidResponse)?;
        }
    }
    Ok(ParsedProviderValue {
        value: Some(total),
        raw_unit_scale: "usd",
        incomplete: false,
        next_page: page_cursor(value)?,
        note: None,
    })
}

fn parse_anthropic(value: &Value) -> Result<ParsedProviderValue, ApiSpendFailure> {
    let buckets = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or(ApiSpendFailure::InvalidResponse)?;
    let mut cents = Decimal::ZERO;
    for bucket in buckets {
        let results = bucket
            .get("results")
            .and_then(Value::as_array)
            .ok_or(ApiSpendFailure::InvalidResponse)?;
        for result in results {
            if !result
                .get("currency")
                .and_then(Value::as_str)
                .is_some_and(|currency| currency.eq_ignore_ascii_case("usd"))
            {
                return Err(ApiSpendFailure::InvalidResponse);
            }
            cents = cents
                .checked_add(json_decimal(
                    result
                        .get("amount")
                        .ok_or(ApiSpendFailure::InvalidResponse)?,
                )?)
                .ok_or(ApiSpendFailure::InvalidResponse)?;
        }
    }
    Ok(ParsedProviderValue {
        value: Some(cents / Decimal::from(100)),
        raw_unit_scale: "usd_cents",
        incomplete: false,
        next_page: page_cursor(value)?,
        note: None,
    })
}

fn parse_xai(value: &Value) -> Result<ParsedProviderValue, ApiSpendFailure> {
    let series = value
        .get("timeSeries")
        .and_then(Value::as_array)
        .ok_or(ApiSpendFailure::InvalidResponse)?;
    let mut total = Decimal::ZERO;
    for row in series {
        for point in row
            .get("dataPoints")
            .and_then(Value::as_array)
            .ok_or(ApiSpendFailure::InvalidResponse)?
        {
            for amount in point
                .get("values")
                .and_then(Value::as_array)
                .ok_or(ApiSpendFailure::InvalidResponse)?
            {
                total = total
                    .checked_add(json_decimal(amount)?)
                    .ok_or(ApiSpendFailure::InvalidResponse)?;
            }
        }
    }
    Ok(ParsedProviderValue {
        value: Some(total),
        raw_unit_scale: "usd",
        incomplete: value
            .get("limitReached")
            .and_then(Value::as_bool)
            .ok_or(ApiSpendFailure::InvalidResponse)?,
        next_page: None,
        note: None,
    })
}

fn parse_openrouter(value: &Value) -> Result<ParsedProviderValue, ApiSpendFailure> {
    let data = value
        .get("data")
        .and_then(Value::as_object)
        .ok_or(ApiSpendFailure::InvalidResponse)?;
    let _credits = json_decimal(
        data.get("total_credits")
            .ok_or(ApiSpendFailure::InvalidResponse)?,
    )?;
    Ok(ParsedProviderValue {
        value: Some(json_decimal(
            data.get("total_usage")
                .ok_or(ApiSpendFailure::InvalidResponse)?,
        )?),
        raw_unit_scale: "lifetime_usd",
        incomplete: false,
        next_page: None,
        note: None,
    })
}

fn parse_moonshot(value: &Value) -> Result<ParsedProviderValue, ApiSpendFailure> {
    if value.get("status").and_then(Value::as_bool) != Some(true) {
        return Err(ApiSpendFailure::InvalidResponse);
    }
    let data = value
        .get("data")
        .and_then(Value::as_object)
        .ok_or(ApiSpendFailure::InvalidResponse)?;
    let available = json_decimal(
        data.get("available_balance")
            .ok_or(ApiSpendFailure::InvalidResponse)?,
    )?;
    let cash = json_decimal(
        data.get("cash_balance")
            .ok_or(ApiSpendFailure::InvalidResponse)?,
    )?;
    let voucher = json_decimal(
        data.get("voucher_balance")
            .ok_or(ApiSpendFailure::InvalidResponse)?,
    )?;
    if cash.checked_add(voucher).is_none() {
        return Err(ApiSpendFailure::InvalidResponse);
    }
    Ok(ParsedProviderValue {
        value: Some(available),
        raw_unit_scale: "current_balance_usd",
        incomplete: false,
        next_page: None,
        note: None,
    })
}

/// One documented string amount: digits with an optional fraction and
/// nothing else, so no sign, exponent, separator or space, within the bound
/// every other amount here has.
fn decimal_string(value: Option<&Value>) -> Result<Decimal, ApiSpendFailure> {
    let text = value
        .and_then(Value::as_str)
        .ok_or(ApiSpendFailure::InvalidResponse)?;
    let (whole, fraction) = text.split_once('.').unwrap_or((text, "0"));
    if whole.is_empty()
        || fraction.is_empty()
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|byte| byte.is_ascii_digit())
    {
        return Err(ApiSpendFailure::InvalidResponse);
    }
    decimal(text).map_err(|_| ApiSpendFailure::InvalidResponse)
}

/// DeepSeek's `GET /user/balance`. The USD entry's `total_balance` is the
/// amount. With no USD entry the source says `reported_in_cny` and has no
/// amount, because a currency is refused, never converted. `is_available`
/// false keeps the amount and says `too_low_for_api_calls`. Every amount on
/// every entry must be a plain decimal string, or the whole answer is refused.
fn parse_deepseek(value: &Value) -> Result<ParsedProviderValue, ApiSpendFailure> {
    let available = value
        .get("is_available")
        .and_then(Value::as_bool)
        .ok_or(ApiSpendFailure::InvalidResponse)?;
    let entries = value
        .get("balance_infos")
        .and_then(Value::as_array)
        .filter(|entries| !entries.is_empty())
        .ok_or(ApiSpendFailure::InvalidResponse)?;
    let mut usd = None;
    for entry in entries {
        let total = decimal_string(entry.get("total_balance"))?;
        decimal_string(entry.get("granted_balance"))?;
        decimal_string(entry.get("topped_up_balance"))?;
        let currency = entry
            .get("currency")
            .and_then(Value::as_str)
            .map(str::to_ascii_uppercase);
        match currency.as_deref() {
            Some("USD") if usd.is_none() => usd = Some(total),
            Some("CNY") => {}
            _ => return Err(ApiSpendFailure::InvalidResponse),
        }
    }
    Ok(ParsedProviderValue {
        value: usd,
        raw_unit_scale: if usd.is_some() {
            "current_balance_usd"
        } else {
            "current_balance_cny"
        },
        incomplete: false,
        next_page: None,
        note: if !available {
            Some("too_low_for_api_calls")
        } else if usd.is_none() {
            Some("reported_in_cny")
        } else {
            None
        },
    })
}

fn parse_provider(
    provider: ApiSpendProvider,
    value: &Value,
) -> Result<ParsedProviderValue, ApiSpendFailure> {
    match provider {
        ApiSpendProvider::Openai => parse_openai(value),
        ApiSpendProvider::Anthropic => parse_anthropic(value),
        ApiSpendProvider::Xai => parse_xai(value),
        ApiSpendProvider::Openrouter => parse_openrouter(value),
        ApiSpendProvider::Moonshot => parse_moonshot(value),
        ApiSpendProvider::DeepSeek => parse_deepseek(value),
    }
}

async fn fetch_provider(
    source: &ApiSpendSource,
    store: &dyn SecretStore,
    start: i64,
    end: i64,
) -> FetchResult<ParsedProviderValue> {
    let mut page = None;
    let mut total = Decimal::ZERO;
    let mut incomplete = false;
    for index in 0..MAX_PAGES {
        let spec = request_spec(source, start, end, page.as_deref())?;
        let secret = store
            .read_secret(&source.credential_id)
            .map_err(|_| ApiSpendFailure::KeyringUnavailable)?;
        let response = send_request(source.provider, spec, secret).await?;
        let parsed = parse_provider(source.provider, &response)?;
        let Some(value) = parsed.value else {
            /* An answer without an amount is a whole reading on its own,
            never one page of a sum. */
            return if index == 0 && parsed.next_page.is_none() {
                Ok(parsed)
            } else {
                Err(ApiSpendFailure::InvalidResponse.into())
            };
        };
        total = total
            .checked_add(value)
            .ok_or(ApiSpendFailure::InvalidResponse)?;
        incomplete |= parsed.incomplete;
        let raw_unit_scale = parsed.raw_unit_scale;
        page = parsed.next_page;
        if page.is_none() {
            return Ok(ParsedProviderValue {
                value: Some(total),
                raw_unit_scale,
                incomplete,
                next_page: None,
                note: parsed.note,
            });
        }
    }
    Err(ApiSpendFailure::InvalidResponse.into())
}

fn jittered_backoff(failures: u32, now: i64) -> i64 {
    let exponent = failures.saturating_sub(1).min(10);
    let ceiling = (30_i64.saturating_mul(1_i64 << exponent)).min(MAX_BACKOFF_SECONDS);
    let entropy = (uuid::Uuid::new_v4().as_u128() ^ now as u128) % (ceiling as u128 + 1);
    i64::try_from(entropy).unwrap_or(ceiling)
}

fn mark_failure(source: &mut ApiSpendSource, failure: FetchFailure, now: i64) {
    source.consecutive_failures = source.consecutive_failures.saturating_add(1);
    source.next_allowed_at = now
        + failure
            .retry_after_seconds
            .unwrap_or_else(|| jittered_backoff(source.consecutive_failures, now));
    source.updated_at = timestamp(now).unwrap_or_else(|_| source.updated_at.clone());
    source.status = match failure.kind {
        ApiSpendFailure::Unauthorized => "ineligible_or_revoked",
        ApiSpendFailure::RateLimited => "rate_limited",
        ApiSpendFailure::KeyringUnavailable => "keyring_unavailable",
        ApiSpendFailure::UnsafeDestination => "unsafe_destination",
        ApiSpendFailure::InvalidResponse => "response_drift",
        _ => "temporarily_unavailable",
    }
    .to_string();
}

fn openrouter_spend(
    source: &mut ApiSpendSource,
    lifetime: Decimal,
    month_start: i64,
    now: i64,
) -> Result<(Decimal, &'static str), ApiSpendFailure> {
    let previous = if let (Some(last), Some(last_at)) = (
        source.last_counter_usd.as_deref(),
        source.last_counter_at.as_deref(),
    ) {
        Some((decimal(last)?, parse_timestamp(last_at)?))
    } else {
        None
    };

    let reset_baseline = |source: &mut ApiSpendSource,
                          incomplete: bool|
     -> Result<(Decimal, &'static str), ApiSpendFailure> {
        source.counter_baseline_usd = Some(decimal_text(lifetime));
        source.counter_baseline_at = Some(timestamp(now)?);
        source.counter_gap = incomplete;
        source.last_counter_usd = Some(decimal_text(lifetime));
        source.last_counter_at = Some(timestamp(now)?);
        Ok((
            Decimal::ZERO,
            if incomplete {
                "period_incomplete"
            } else {
                "since_connected"
            },
        ))
    };

    let Some((last_value, last_time)) = previous else {
        return reset_baseline(source, false);
    };
    if now <= last_time || lifetime < last_value || now - last_time > 24 * 60 * 60 {
        return reset_baseline(source, true);
    }

    if (last_time <= month_start && month_start - last_time <= 24 * 60 * 60)
        || source.counter_baseline_usd.is_none()
        || source.counter_baseline_at.is_none()
    {
        source.counter_baseline_usd = Some(decimal_text(last_value));
        source.counter_baseline_at = Some(timestamp(last_time)?);
        source.counter_gap = false;
    }

    let baseline = source
        .counter_baseline_usd
        .as_deref()
        .map(decimal)
        .transpose()?
        .ok_or(ApiSpendFailure::Storage)?;
    let baseline_at = source
        .counter_baseline_at
        .as_deref()
        .map(parse_timestamp)
        .transpose()?
        .ok_or(ApiSpendFailure::Storage)?;
    if lifetime < baseline || baseline_at < month_start - 24 * 60 * 60 {
        return reset_baseline(source, true);
    }
    let completeness = if source.counter_gap {
        "period_incomplete"
    } else if baseline_at <= month_start {
        "complete"
    } else {
        "since_connected"
    };
    let spend = lifetime - baseline;
    source.last_counter_usd = Some(decimal_text(lifetime));
    source.last_counter_at = Some(timestamp(now)?);
    Ok((spend, completeness))
}

async fn refresh_core(
    path: &Path,
    store: &dyn SecretStore,
    input: RefreshApiSpendInput,
    now: i64,
) -> Result<ApiSpendSnapshot, ApiSpendFailure> {
    if uuid::Uuid::parse_str(&input.source_id).is_err() {
        return Err(ApiSpendFailure::InvalidInput);
    }
    let mut document = load_at(path)?;
    let index = document
        .sources
        .iter()
        .position(|source| source.id == input.source_id)
        .ok_or(ApiSpendFailure::NotFound)?;
    let floor = if input.manual {
        MANUAL_POLL_FLOOR_SECONDS
    } else {
        AUTOMATIC_POLL_FLOOR_SECONDS
    };
    let last_observed = document.sources[index]
        .last_observed_at
        .as_deref()
        .map(parse_timestamp)
        .transpose()?;
    if (document.sources[index].consecutive_failures > 0
        && now < document.sources[index].next_allowed_at)
        || last_observed.is_some_and(|last| now - last < floor)
    {
        return Err(ApiSpendFailure::TooSoon);
    }
    if !document.sources[index].enabled {
        return Err(ApiSpendFailure::InvalidInput);
    }
    let source = document.sources[index].clone();
    let (month_start, end, _) = month_bounds(now)?;
    let fetched = fetch_provider(&source, store, month_start, end).await;
    let parsed = match fetched {
        Ok(value) => value,
        Err(failure) => {
            mark_failure(&mut document.sources[index], failure, now);
            save_at(path, &document)?;
            return Err(failure.kind);
        }
    };
    record_observation(&mut document, index, parsed, now)?;
    save_at(path, &document)?;
    snapshot(&document, now)
}

/// Writes one successful reading into its own source and that source's own
/// samples, and touches nothing else. Refresh calls it after the fixed read;
/// it reads no clock, file or network itself.
fn record_observation(
    document: &mut ApiSpendDocument,
    index: usize,
    parsed: ParsedProviderValue,
    now: i64,
) -> Result<(), ApiSpendFailure> {
    let (month_start, _, month) = month_bounds(now)?;
    let source = document
        .sources
        .get_mut(index)
        .ok_or(ApiSpendFailure::NotFound)?;
    let (spend, balance, completeness) = match source.provider {
        ApiSpendProvider::Openrouter => {
            let lifetime = parsed.value.ok_or(ApiSpendFailure::InvalidResponse)?;
            let (spend, completeness) = openrouter_spend(source, lifetime, month_start, now)?;
            (Some(decimal_text(spend)), None, completeness.to_string())
        }
        ApiSpendProvider::Moonshot | ApiSpendProvider::DeepSeek => (
            None,
            parsed.value.map(decimal_text),
            "current_balance".to_string(),
        ),
        _ => (
            Some(decimal_text(
                parsed.value.ok_or(ApiSpendFailure::InvalidResponse)?,
            )),
            None,
            if parsed.incomplete {
                "period_incomplete"
            } else {
                "complete"
            }
            .to_string(),
        ),
    };
    let observed_at = timestamp(now)?;
    let sequence = source.next_sequence;
    source.next_sequence = source.next_sequence.saturating_add(1);
    source.last_observed_at = Some(observed_at.clone());
    source.next_allowed_at = now + AUTOMATIC_POLL_FLOOR_SECONDS;
    source.consecutive_failures = 0;
    source.status = parsed
        .note
        .unwrap_or(if parsed.incomplete {
            "observed_incomplete"
        } else {
            "eligible"
        })
        .to_string();
    source.updated_at = observed_at.clone();
    let sample = ApiSpendSample {
        id: uuid::Uuid::new_v4().to_string(),
        source_id: source.id.clone(),
        event_id: uuid::Uuid::new_v4().to_string(),
        sequence,
        provider: source.provider,
        key_label: source.key_label.clone(),
        metric_kind: source.provider.metric_kind(),
        month,
        spend_usd: spend,
        balance_usd: balance,
        budget_usd: source.budget_usd.clone(),
        observed_at: observed_at.clone(),
        source_period: format!("[{}, {})", timestamp(month_start)?, observed_at),
        forecast_date: None,
        currency_source: if parsed.value.is_some() {
            "provider_usd"
        } else {
            "provider_cny"
        }
        .to_string(),
        raw_unit_scale: parsed.raw_unit_scale.to_string(),
        completeness,
        created_at: observed_at,
    };
    document.samples.retain(|existing| {
        existing.source_id != sample.source_id || existing.source_period != sample.source_period
    });
    document.samples.push(sample);
    if document.samples.len() > MAX_SAMPLES {
        let overflow = document.samples.len() - MAX_SAMPLES;
        document.samples.drain(0..overflow);
    }
    Ok(())
}

fn remove_source_core(
    path: &Path,
    store: &dyn SecretStore,
    input: RemoveApiSpendSourceInput,
    now: i64,
) -> Result<ApiSpendSnapshot, ApiSpendFailure> {
    if uuid::Uuid::parse_str(&input.source_id).is_err() {
        return Err(ApiSpendFailure::InvalidInput);
    }
    let mut document = load_at(path)?;
    if !document
        .sources
        .iter()
        .any(|source| source.id == input.source_id)
    {
        return Err(ApiSpendFailure::NotFound);
    }
    let credential_id = document
        .sources
        .iter()
        .find(|source| source.id == input.source_id)
        .map(|source| source.credential_id.clone())
        .ok_or(ApiSpendFailure::NotFound)?;
    match store.delete_secret(&credential_id) {
        Ok(()) | Err(CredentialError::NotFound) => {}
        Err(CredentialError::Store) => return Err(ApiSpendFailure::KeyringUnavailable),
    }
    document
        .sources
        .retain(|source| source.id != input.source_id);
    if input.delete_samples {
        document
            .samples
            .retain(|sample| sample.source_id != input.source_id);
    }
    save_at(path, &document)?;
    snapshot(&document, now)
}

fn set_budget_core(
    path: &Path,
    input: SetApiSpendBudgetInput,
    now: i64,
) -> Result<ApiSpendSnapshot, ApiSpendFailure> {
    let budget = input
        .budget_usd
        .as_deref()
        .map(decimal)
        .transpose()?
        .map(decimal_text);
    let mut document = load_at(path)?;
    let source = document
        .sources
        .iter_mut()
        .find(|source| source.id == input.source_id)
        .ok_or(ApiSpendFailure::NotFound)?;
    source.budget_usd = budget;
    source.updated_at = timestamp(now)?;
    save_at(path, &document)?;
    snapshot(&document, now)
}

fn due_source_ids(document: &ApiSpendDocument, now: i64) -> Vec<String> {
    document
        .sources
        .iter()
        .filter(|source| {
            if !source.enabled || now < source.next_allowed_at {
                return false;
            }
            match source.last_observed_at.as_deref().map(parse_timestamp) {
                None => true,
                Some(Ok(last)) => now.saturating_sub(last) >= AUTOMATIC_POLL_FLOOR_SECONDS,
                Some(Err(_)) => false,
            }
        })
        .map(|source| source.id.clone())
        .collect()
}

async fn refresh_due_sources(app: &AppHandle) {
    let due = {
        let state = app.state::<ApiSpendState>();
        let _guard = state.gate.lock().await;
        let (Ok(path), Ok(now)) = (state_path(), now_seconds()) else {
            return;
        };
        let Ok(document) = load_at(&path) else {
            return;
        };
        due_source_ids(&document, now)
    };

    for source_id in due {
        let state = app.state::<ApiSpendState>();
        let keyring = app.state::<ApiSpendKeyringStore>();
        let _guard = state.gate.lock().await;
        let (Ok(path), Ok(now)) = (state_path(), now_seconds()) else {
            continue;
        };
        let _ = refresh_core(
            &path,
            &*keyring,
            RefreshApiSpendInput {
                source_id,
                manual: false,
            },
            now,
        )
        .await;
    }
}

/// Polls only explicitly saved, enabled sources. The native process owns the
/// cadence so webview suspension cannot create gaps or bypass the fixed floor.
pub fn spawn_polling(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            refresh_due_sources(&app).await;
        }
    });
}

/// No gate: the read is bounded and handle first, and every writer replaces
/// the file atomically, so a refresh in flight never holds the window back.
#[tauri::command]
pub async fn api_spend_status() -> Result<ApiSpendSnapshot, ApiSpendFailure> {
    let document = load_at(&state_path()?)?;
    snapshot(&document, now_seconds()?)
}

#[tauri::command]
pub async fn api_spend_save_source(
    input: SaveApiSpendSourceInput,
    state: State<'_, ApiSpendState>,
    keyring: State<'_, ApiSpendKeyringStore>,
) -> Result<ApiSpendSnapshot, ApiSpendFailure> {
    let _guard = state.gate.lock().await;
    save_source_core(&state_path()?, &*keyring, input, now_seconds()?)
}

#[tauri::command]
pub async fn api_spend_refresh(
    input: RefreshApiSpendInput,
    state: State<'_, ApiSpendState>,
    keyring: State<'_, ApiSpendKeyringStore>,
) -> Result<ApiSpendSnapshot, ApiSpendFailure> {
    let _guard = state.gate.lock().await;
    refresh_core(&state_path()?, &*keyring, input, now_seconds()?).await
}

#[tauri::command]
pub async fn api_spend_remove_source(
    input: RemoveApiSpendSourceInput,
    state: State<'_, ApiSpendState>,
    keyring: State<'_, ApiSpendKeyringStore>,
) -> Result<ApiSpendSnapshot, ApiSpendFailure> {
    let _guard = state.gate.lock().await;
    remove_source_core(&state_path()?, &*keyring, input, now_seconds()?)
}

#[tauri::command]
pub async fn api_spend_set_budget(
    input: SetApiSpendBudgetInput,
    state: State<'_, ApiSpendState>,
) -> Result<ApiSpendSnapshot, ApiSpendFailure> {
    let _guard = state.gate.lock().await;
    set_budget_core(&state_path()?, input, now_seconds()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{InMemorySecrets, TempDir};

    fn source(provider: ApiSpendProvider) -> ApiSpendSource {
        ApiSpendSource {
            id: "00000000-0000-4000-8000-000000000001".to_string(),
            credential_id: "10000000-0000-4000-8000-000000000001".to_string(),
            provider,
            key_label: "billing admin".to_string(),
            last_four: Some("cdef".to_string()),
            eligibility_class: provider.credential_class().to_string(),
            enabled: true,
            consent_version: 1,
            team_id: (provider == ApiSpendProvider::Xai).then(|| "team_123".to_string()),
            budget_usd: Some("100".to_string()),
            created_at: "2026-09-01T00:00:00Z".to_string(),
            updated_at: "2026-09-01T00:00:00Z".to_string(),
            last_observed_at: None,
            next_allowed_at: 0,
            consecutive_failures: 0,
            status: "pending_validation".to_string(),
            next_sequence: 1,
            counter_baseline_usd: None,
            counter_baseline_at: None,
            last_counter_usd: None,
            last_counter_at: None,
            counter_gap: false,
        }
    }

    /// A refresh holds the gate across its network round trip. The status
    /// read, invoked through its registered command like the window does,
    /// answers while that gate is held.
    #[test]
    fn status_answers_through_its_command_while_a_refresh_holds_the_gate() {
        use tauri::{
            ipc::{CallbackFn, InvokeBody},
            test::{get_ipc_response, mock_builder, INVOKE_KEY},
            webview::InvokeRequest,
            WebviewWindowBuilder,
        };
        let app = mock_builder()
            .manage(ApiSpendState::default())
            .invoke_handler(tauri::generate_handler![api_spend_status])
            .build(tauri::generate_context!(test = true))
            .expect("mock app");
        let window = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("window");
        let state = app.state::<ApiSpendState>();
        let refresh = state.gate.blocking_lock();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let response = get_ipc_response(
                &window,
                InvokeRequest {
                    cmd: "api_spend_status".into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: if cfg!(any(windows, target_os = "android")) {
                        "http://tauri.localhost"
                    } else {
                        "tauri://localhost"
                    }
                    .parse()
                    .expect("origin"),
                    body: InvokeBody::default(),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            );
            let _ = sender.send(response.map(|body| body.deserialize::<Value>()));
        });
        let snapshot = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("the status read waited for the refresh")
            .expect("the status command succeeded")
            .expect("a snapshot");
        drop(refresh);
        assert_eq!(snapshot["version"], STATE_VERSION);
        assert_eq!(snapshot["localDisplayIsFree"], true);
        assert!(snapshot["sources"].is_array() && snapshot["samples"].is_array());
    }

    #[test]
    fn automatic_polling_selects_only_enabled_sources_past_the_fixed_floor() {
        let mut document = ApiSpendDocument::default();
        let mut due = source(ApiSpendProvider::Openai);
        due.last_observed_at = Some("2026-09-01T00:00:00Z".to_string());
        due.next_allowed_at = 0;
        let mut disabled = source(ApiSpendProvider::Anthropic);
        disabled.id = "00000000-0000-4000-8000-000000000002".to_string();
        disabled.credential_id = "10000000-0000-4000-8000-000000000002".to_string();
        disabled.enabled = false;
        let mut waiting = source(ApiSpendProvider::Moonshot);
        waiting.id = "00000000-0000-4000-8000-000000000003".to_string();
        waiting.credential_id = "10000000-0000-4000-8000-000000000003".to_string();
        waiting.next_allowed_at = parse_timestamp("2026-09-01T01:00:00Z").unwrap();
        document.sources = vec![due.clone(), disabled, waiting];

        let now = parse_timestamp("2026-09-01T00:15:00Z").unwrap();
        assert_eq!(due_source_ids(&document, now), vec![due.id]);
    }

    #[test]
    fn all_six_adapters_have_closed_hosts_methods_and_units() {
        let start = 1_777_593_600;
        let end = start + 86_400;
        for provider in ApiSpendProvider::ALL {
            let spec = request_spec(&source(provider), start, end, None).expect("request spec");
            validate_fixed_destination(provider, &spec.url).expect("fixed destination");
            assert_eq!(spec.url.scheme(), "https");
            assert_eq!(spec.url.port_or_known_default(), Some(443));
            assert_eq!(
                spec.method,
                if provider == ApiSpendProvider::Xai {
                    RequestMethod::Post
                } else {
                    RequestMethod::Get
                }
            );
        }
        let moonshot = parse_moonshot(&json!({
            "status": true,
            "data": {"available_balance": 49.58894, "voucher_balance": 46.58893, "cash_balance": 3.00001}
        }))
        .expect("balance");
        assert_eq!(
            moonshot.value.map(decimal_text).as_deref(),
            Some("49.58894")
        );
        assert_eq!(moonshot.raw_unit_scale, "current_balance_usd");
        assert_eq!(
            ApiSpendProvider::Moonshot.metric_kind(),
            ApiSpendMetricKind::Balance
        );
    }

    #[test]
    fn provider_fixtures_preserve_exact_decimal_and_incomplete_semantics() {
        let openai = parse_openai(&json!({
            "data": [{"results": [{"amount": {"value": "1.25", "currency": "usd"}}]}],
            "has_more": true,
            "next_page": "page_2"
        }))
        .expect("OpenAI costs");
        assert_eq!(openai.value.map(decimal_text).as_deref(), Some("1.25"));
        assert_eq!(openai.next_page.as_deref(), Some("page_2"));

        let anthropic = parse_anthropic(&json!({
            "data": [{"results": [{"amount": "123.78912", "currency": "USD"}]}],
            "has_more": false,
            "next_page": null
        }))
        .expect("Anthropic cents");
        assert_eq!(
            anthropic.value.map(decimal_text).as_deref(),
            Some("1.2378912")
        );
        assert_eq!(anthropic.raw_unit_scale, "usd_cents");

        let xai = parse_xai(&json!({
            "timeSeries": [{"dataPoints": [{"timestamp": "2026-09-01T00:00:00Z", "values": [0.75973725]}]}],
            "limitReached": true
        }))
        .expect("xAI series");
        assert!(xai.incomplete);
        assert_eq!(xai.value.map(decimal_text).as_deref(), Some("0.75973725"));

        let openrouter = parse_openrouter(&json!({
            "data": {"total_credits": 100.5, "total_usage": 25.75}
        }))
        .expect("OpenRouter lifetime counter");
        assert_eq!(openrouter.value.map(decimal_text).as_deref(), Some("25.75"));
        assert_eq!(openrouter.raw_unit_scale, "lifetime_usd");
    }

    #[test]
    fn private_and_special_addresses_are_refused_before_a_request() {
        for refused in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.1.1",
            "192.168.1.1",
            "198.51.100.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            assert!(
                !public_ip(refused.parse().expect("IP literal")),
                "{refused}"
            );
        }
        assert!(public_ip("1.1.1.1".parse().expect("public IP")));
        assert!(public_ip(
            "2606:4700:4700::1111".parse().expect("public IP")
        ));
    }

    #[test]
    fn keyring_failure_aborts_save_without_a_plaintext_state_file() {
        struct FailingStore;
        impl SecretStore for FailingStore {
            fn store_secret(&self, _: &str, _: &str) -> Result<(), CredentialError> {
                Err(CredentialError::Store)
            }
            fn read_secret(&self, _: &str) -> Result<Zeroizing<String>, CredentialError> {
                Err(CredentialError::Store)
            }
            fn delete_secret(&self, _: &str) -> Result<(), CredentialError> {
                Err(CredentialError::Store)
            }
        }
        let directory = TempDir::new();
        let path = directory.path().join(STATE_FILE_NAME);
        let result = save_source_core(
            &path,
            &FailingStore,
            SaveApiSpendSourceInput {
                provider: ApiSpendProvider::Openai,
                key_label: "admin".to_string(),
                secret: "secret-canary-never-persist-123456".to_string(),
                team_id: None,
                budget_usd: None,
                consent_version: 1,
                confirmed: true,
                source_id: None,
            },
            1_777_593_600,
        );
        assert!(matches!(result, Err(ApiSpendFailure::KeyringUnavailable)));
        assert!(!path.exists());
    }

    #[test]
    fn saved_state_exposes_only_label_and_last_four_and_revoke_deletes_key() {
        let directory = TempDir::new();
        let path = directory.path().join(STATE_FILE_NAME);
        let store = InMemorySecrets::new();
        let snapshot = save_source_core(
            &path,
            &store,
            SaveApiSpendSourceInput {
                provider: ApiSpendProvider::Moonshot,
                key_label: "balance key".to_string(),
                secret: "moonshot-secret-canary-abcdef".to_string(),
                team_id: None,
                budget_usd: None,
                consent_version: 1,
                confirmed: true,
                source_id: None,
            },
            1_777_593_600,
        )
        .expect("save");
        let id = snapshot.sources[0].id.clone();
        let document = load_at(&path).expect("private state");
        let credential_id = document.sources[0].credential_id.clone();
        assert_ne!(credential_id, id);
        let text = std::fs::read_to_string(&path).expect("state file");
        assert!(!text.contains("moonshot-secret-canary"));
        assert_eq!(snapshot.sources[0].last_four.as_deref(), Some("cdef"));
        let wire = serde_json::to_string(&snapshot).expect("IPC snapshot");
        assert!(!wire.contains(&credential_id));
        remove_source_core(
            &path,
            &store,
            RemoveApiSpendSourceInput {
                source_id: id,
                delete_samples: true,
            },
            1_777_593_600,
        )
        .expect("revoke");
        assert_eq!(store.stored_count(), 0);
    }

    #[test]
    fn openrouter_never_infers_across_a_gap() {
        let month_start = 1_777_593_600;
        let mut source = source(ApiSpendProvider::Openrouter);
        source.last_counter_usd = Some("20".to_string());
        source.last_counter_at = Some(timestamp(month_start - 60).expect("timestamp"));
        let (spend, completeness) = openrouter_spend(
            &mut source,
            Decimal::from(25),
            month_start,
            month_start + 60,
        )
        .expect("delta");
        assert_eq!(spend, Decimal::from(5));
        assert_eq!(completeness, "complete");
        source.last_counter_at = Some(timestamp(month_start + 60).expect("timestamp"));
        let (_, completeness) = openrouter_spend(
            &mut source,
            Decimal::from(30),
            month_start,
            month_start + 25 * 60 * 60,
        )
        .expect("gap");
        assert_eq!(completeness, "period_incomplete");
    }

    #[test]
    fn openrouter_first_observation_starts_a_visible_continuous_delta() {
        let month_start = 1_777_593_600;
        let mut source = source(ApiSpendProvider::Openrouter);
        let (first, first_completeness) = openrouter_spend(
            &mut source,
            Decimal::from(100),
            month_start,
            month_start + 60,
        )
        .expect("first observation");
        assert_eq!(first, Decimal::ZERO);
        assert_eq!(first_completeness, "since_connected");

        let (second, second_completeness) = openrouter_spend(
            &mut source,
            Decimal::from(103),
            month_start,
            month_start + 15 * 60,
        )
        .expect("continuous delta");
        assert_eq!(second, Decimal::from(3));
        assert_eq!(second_completeness, "since_connected");

        let (after_gap, after_gap_completeness) = openrouter_spend(
            &mut source,
            Decimal::from(150),
            month_start,
            month_start + 26 * 60 * 60,
        )
        .expect("gap reset");
        assert_eq!(after_gap, Decimal::ZERO);
        assert_eq!(after_gap_completeness, "period_incomplete");
    }

    #[test]
    fn failures_are_payload_free_and_poll_floors_are_fixed() {
        assert_eq!(AUTOMATIC_POLL_FLOOR_SECONDS, 900);
        assert_eq!(MANUAL_POLL_FLOOR_SECONDS, 60);
        assert_eq!(CONNECT_TIMEOUT_SECONDS, 5);
        assert_eq!(TOTAL_TIMEOUT_SECONDS, 15);
        assert_eq!(MAX_RESPONSE_BYTES, 1_048_576);
        for failure in [
            ApiSpendFailure::Network,
            ApiSpendFailure::Unauthorized,
            ApiSpendFailure::UnsafeDestination,
        ] {
            let serialized = serde_json::to_string(&failure).expect("failure JSON");
            assert!(!serialized.contains("http"));
            assert!(!serialized.contains("secret"));
        }
    }

    /* ---------------------------------------------------------- local display
     *
     * `spend_display_state` is pure: every test below hands it literals and
     * reads back a local display variant, with no store or keyring involved.
     */

    #[test]
    fn every_spend_provider_shows_the_full_amount_past_the_former_ceiling() {
        let now = 1_777_593_600;
        for provider in [
            ApiSpendProvider::Openai,
            ApiSpendProvider::Anthropic,
            ApiSpendProvider::Xai,
            ApiSpendProvider::Openrouter,
        ] {
            let state = spend_display_state(provider, "473.22", "usd", None, now)
                .unwrap_or_else(|error| panic!("{provider:?} should track: {error:?}"));
            match state {
                ApiSpendDisplayState::Tracked { amount_usd, .. } => {
                    assert_eq!(decimal(&amount_usd).unwrap(), decimal("473.22").unwrap());
                }
                other => panic!("{provider:?} should track the full amount, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_free_snapshot_carries_the_full_amount_past_the_former_ceiling() {
        let now = 1_777_593_600;
        let spend_source = source(ApiSpendProvider::Openai);
        let mut document = ApiSpendDocument::default();
        document.sources.push(spend_source.clone());
        document.samples.push(spend_sample(
            ApiSpendProvider::Openai,
            &spend_source.id,
            "473.22",
        ));

        let snap = snapshot(&document, now).expect("free snapshot");
        let wire = serde_json::to_string(&snap).expect("wire JSON");
        assert!(wire.contains("473.22"), "{wire}");
        assert!(matches!(
            &snap.samples[0].display_state,
            ApiSpendDisplayState::Tracked { amount_usd, .. } if amount_usd == "473.22"
        ));
    }

    #[test]
    fn a_balance_source_remains_a_balance() {
        let now = 1_777_593_600;
        let state = spend_display_state(ApiSpendProvider::Moonshot, "5000.00", "usd", None, now)
            .expect("a balance is always Ok");
        match state {
            ApiSpendDisplayState::Balance { amount_usd } => {
                assert_eq!(decimal(&amount_usd).unwrap(), decimal("5000.00").unwrap());
            }
            other => panic!("balance should remain a balance, got {other:?}"),
        }
    }

    #[test]
    fn non_usd_is_refused_not_converted_matching_parse_openai_and_parse_anthropic() {
        let now = 1_777_593_600;
        assert!(matches!(
            spend_display_state(ApiSpendProvider::Openai, "50.00", "eur", None, now),
            Err(ApiSpendFailure::InvalidResponse)
        ));
        /* Case only. parse_openai and parse_anthropic both compare with
        eq_ignore_ascii_case, and this refuses the same way they do. */
        assert!(matches!(
            spend_display_state(ApiSpendProvider::Openai, "50.00", "USD", None, now),
            Ok(ApiSpendDisplayState::Tracked { .. })
        ));
    }

    fn spend_sample(provider: ApiSpendProvider, source_id: &str, reading: &str) -> ApiSpendSample {
        let is_balance = provider.metric_kind() == ApiSpendMetricKind::Balance;
        ApiSpendSample {
            id: "20000000-0000-4000-8000-000000000001".to_string(),
            source_id: source_id.to_string(),
            event_id: "30000000-0000-4000-8000-000000000001".to_string(),
            sequence: 1,
            provider,
            key_label: "billing admin".to_string(),
            metric_kind: provider.metric_kind(),
            month: "2026-09-01".to_string(),
            spend_usd: (!is_balance).then(|| reading.to_string()),
            balance_usd: is_balance.then(|| reading.to_string()),
            budget_usd: None,
            observed_at: "2026-09-01T12:00:00Z".to_string(),
            source_period: "[2026-09-01T00:00:00Z, 2026-09-01T12:00:00Z)".to_string(),
            forecast_date: None,
            currency_source: "provider_usd".to_string(),
            raw_unit_scale: "usd".to_string(),
            completeness: "complete".to_string(),
            created_at: "2026-09-01T12:00:00Z".to_string(),
        }
    }

    /// The shared envelope the desktop, the server and the hub all test on.
    const SYNC_FIXTURE: &str =
        include_str!("../../../../packages/core/fixtures/sync-envelope-v2.json");

    fn openrouter_document() -> ApiSpendDocument {
        let mut document = ApiSpendDocument::default();
        let mut spend_source = source(ApiSpendProvider::Openrouter);
        spend_source.id = "b28c9d51-7f0a-4c3e-9d64-5a1b8e2f7c03".to_string();
        spend_source.key_label = "OpenRouter key".to_string();
        spend_source.budget_usd = Some("100".to_string());
        let mut sample = spend_sample(ApiSpendProvider::Openrouter, &spend_source.id, "40.9");
        sample.metric_kind = ApiSpendMetricKind::Spend;
        sample.key_label = spend_source.key_label.clone();
        sample.month = "2026-09-01".to_string();
        sample.observed_at = "2026-09-07T12:00:00.000Z".to_string();
        sample.created_at = sample.observed_at.clone();
        sample.source_period = "[2026-09-01T00:00:00.000Z, 2026-09-07T12:00:00.000Z)".to_string();
        sample.completeness = "period_incomplete".to_string();
        document.sources.push(spend_source);
        document.samples.push(sample);
        document
    }

    #[test]
    fn a_stored_observation_becomes_the_row_the_shared_fixture_carries() {
        /* Decision D4: the totals sync and the keys never do. This is the
        whole mapping in one assertion, against the same file the desktop's
        envelope test and the server's contract test read. */
        let fixture: serde_json::Value =
            serde_json::from_str(SYNC_FIXTURE).expect("the shared fixture");
        let expected: crate::account::ApiSpendSample =
            serde_json::from_value(fixture["api_spend_samples"][0].clone())
                .expect("the fixture row is this contract");

        let rows = contract_spend_samples(&openrouter_document(), 8);
        assert_eq!(rows, vec![expected]);
        /* The label became the slug the contract wants, and no key, secret or
        credential identifier travelled with it. */
        assert_eq!(rows[0].account_id, "openrouter-key");
        let wire = serde_json::to_string(&rows).expect("the wire form");
        assert!(!wire.contains("credential"));
        assert!(!wire.to_ascii_lowercase().contains("token"));
    }

    #[test]
    fn the_mapping_refuses_what_it_cannot_carry_and_keeps_two_alike_labels_apart() {
        /* A balance is not spend, and the contract carries balances in a list
        this envelope does not send. */
        let mut balances = ApiSpendDocument::default();
        let balance_source = source(ApiSpendProvider::Moonshot);
        balances.samples.push(spend_sample(
            ApiSpendProvider::Moonshot,
            &balance_source.id,
            "5000.00",
        ));
        balances.sources.push(balance_source);
        assert!(contract_spend_samples(&balances, 8).is_empty());
        assert_eq!(contract_provider(ApiSpendProvider::Moonshot), None);

        /* A unit name becomes the number of raw units to the dollar, and a
        unit this window does not know is refused rather than guessed. */
        assert_eq!(contract_unit_scale("usd"), Some(1.0));
        assert_eq!(contract_unit_scale("usd_cents"), Some(100.0));
        assert_eq!(contract_unit_scale("tokens"), None);

        /* The range text becomes the two instants inside it, and a range that
        runs backwards is not a period. */
        assert_eq!(
            contract_period("[2026-09-01T00:00:00Z, 2026-09-07T12:00:00Z)"),
            Some([
                "2026-09-01T00:00:00Z".to_string(),
                "2026-09-07T12:00:00Z".to_string()
            ])
        );
        assert_eq!(
            contract_period("[2026-09-07T12:00:00Z, 2026-09-01T00:00:00Z)"),
            None
        );
        assert_eq!(contract_period("2026-09-01, 2026-09-07"), None);

        /* Anything that is not a letter or a digit becomes one separator, and
        a label with nothing usable in it falls back to the source. */
        assert_eq!(account_slug("Ola's Key!!", "b28c9d51-7f0a"), "ola-s-key");
        assert_eq!(account_slug("!!!", "b28c9d51-7f0a"), "b28c9d51");

        /* Two sources of one provider whose labels slug alike would be one
        row to the server, which refuses the whole envelope for it, so the
        second carries its source identifier. */
        let mut document = openrouter_document();
        let mut second = document.sources[0].clone();
        second.id = "c39dae62-8f1b-4d4f-8e75-6b2c9f3a8d14".to_string();
        second.credential_id = "d40ebf73-9f2c-4e5a-9f86-7c3daf4b9e25".to_string();
        let mut sample = document.samples[0].clone();
        sample.id = "21000000-0000-4000-8000-000000000002".to_string();
        sample.source_id = second.id.clone();
        sample.observed_at = "2026-09-07T11:00:00.000Z".to_string();
        document.sources.push(second);
        document.samples.push(sample);

        let rows = contract_spend_samples(&document, 8);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].account_id, "openrouter-key");
        assert_eq!(rows[1].account_id, "openrouter-key-c39dae62");
        /* And the row budget the envelope has left is honoured. */
        assert_eq!(contract_spend_samples(&document, 1).len(), 1);
    }

    /* ------------------------------------------------------------- DeepSeek
     *
     * The documented shape of `GET /user/balance`, amounts as strings.
     */

    fn deepseek_entry(currency: &str, total: &str) -> Value {
        json!({
            "currency": currency,
            "total_balance": total,
            "granted_balance": "0.25",
            "topped_up_balance": "1.00"
        })
    }

    fn deepseek_usd() -> Value {
        json!({
            "is_available": true,
            "balance_infos": [deepseek_entry("CNY", "110.00"), deepseek_entry("USD", "15.25")]
        })
    }

    fn deepseek_cny_only() -> Value {
        json!({"is_available": true, "balance_infos": [deepseek_entry("CNY", "110.00")]})
    }

    fn deepseek_unavailable() -> Value {
        json!({"is_available": false, "balance_infos": [deepseek_entry("USD", "0.40")]})
    }

    #[test]
    fn deepseek_reads_the_usd_total_balance_and_never_the_yuan_one() {
        let parsed = parse_deepseek(&deepseek_usd()).expect("a USD balance");
        assert_eq!(parsed.value.map(decimal_text).as_deref(), Some("15.25"));
        assert_eq!(parsed.note, None);
        assert_eq!(parsed.raw_unit_scale, "current_balance_usd");
        assert_eq!(
            ApiSpendProvider::DeepSeek.metric_kind(),
            ApiSpendMetricKind::Balance
        );
        assert_eq!(
            ApiSpendProvider::DeepSeek.credential_class(),
            "server_api_key"
        );
    }

    #[test]
    fn deepseek_in_yuan_only_says_so_and_carries_no_amount() {
        let parsed = parse_deepseek(&deepseek_cny_only()).expect("a CNY only balance");
        assert_eq!(parsed.value, None);
        assert_eq!(parsed.note, Some("reported_in_cny"));
        /* Both at once: still no amount, and the state a person can act on. */
        let mut blocked = deepseek_cny_only();
        blocked["is_available"] = json!(false);
        let parsed = parse_deepseek(&blocked).expect("a blocked CNY only balance");
        assert_eq!(parsed.value, None);
        assert_eq!(parsed.note, Some("too_low_for_api_calls"));
    }

    #[test]
    fn deepseek_not_available_keeps_the_amount_and_says_too_low() {
        let parsed = parse_deepseek(&deepseek_unavailable()).expect("a low balance");
        assert_eq!(parsed.value.map(decimal_text).as_deref(), Some("0.4"));
        assert_eq!(parsed.note, Some("too_low_for_api_calls"));
    }

    #[test]
    fn deepseek_malformed_answers_reject_the_sample() {
        let mut refused = Vec::new();
        for total in [
            json!(15.25),
            json!("-1.00"),
            json!("NaN"),
            json!("inf"),
            json!("1e3"),
            json!("+1.00"),
            json!(" 1.00"),
            json!("1,00"),
            json!("1_000"),
            json!("1."),
            json!(".5"),
            json!(""),
            json!(null),
            json!("99999999999999999999999999999999"),
        ] {
            let mut answer = deepseek_usd();
            answer["balance_infos"][1]["total_balance"] = total;
            refused.push(answer);
        }
        for field in ["granted_balance", "topped_up_balance"] {
            let mut answer = deepseek_usd();
            answer["balance_infos"][1][field] = json!("-0.25");
            refused.push(answer);
        }
        /* The yuan entry is never shown, but a malformed one still means the
        answer is not the documented shape. */
        let mut answer = deepseek_usd();
        answer["balance_infos"][0]["total_balance"] = json!("abc");
        refused.push(answer);
        refused.extend([
            json!({"balance_infos": [deepseek_entry("USD", "1.00")]}),
            json!({"is_available": "true", "balance_infos": [deepseek_entry("USD", "1.00")]}),
            json!({"is_available": true}),
            json!({"is_available": true, "balance_infos": {}}),
            json!({"is_available": true, "balance_infos": []}),
            json!({"is_available": true, "balance_infos": [deepseek_entry("EUR", "1.00")]}),
            json!({"is_available": true, "balance_infos": [{"total_balance": "1.00"}]}),
            json!({
                "is_available": true,
                "balance_infos": [deepseek_entry("USD", "1.00"), deepseek_entry("USD", "2.00")]
            }),
            json!([]),
        ]);
        for answer in refused {
            assert!(
                matches!(
                    parse_deepseek(&answer),
                    Err(ApiSpendFailure::InvalidResponse)
                ),
                "{answer}"
            );
        }
    }

    #[test]
    fn deepseek_is_bound_to_its_one_host_and_path() {
        let spec = request_spec(
            &source(ApiSpendProvider::DeepSeek),
            1_777_593_600,
            1_777_680_000,
            None,
        )
        .expect("request spec");
        assert_eq!(spec.url.as_str(), "https://api.deepseek.com/user/balance");
        assert_eq!(spec.method, RequestMethod::Get);
        assert_eq!(spec.auth_header, "authorization");
        assert!(spec.body.is_none());
        assert!(request_spec(
            &source(ApiSpendProvider::DeepSeek),
            1_777_593_600,
            1_777_680_000,
            Some("page_2"),
        )
        .is_err());
        for refused in [
            "https://api.deepseek.com.evil.example/user/balance",
            "https://evil.example/user/balance",
            "https://deepseek.com/user/balance",
            "https://platform.deepseek.com/user/balance",
            "https://api.moonshot.ai/user/balance",
            "http://api.deepseek.com/user/balance",
            "https://api.deepseek.com:8443/user/balance",
            "https://user:pass@api.deepseek.com/user/balance",
            "https://api.deepseek.com/user/balance/",
            "https://api.deepseek.com/user/balances",
            "https://api.deepseek.com/v1/user/balance",
            "https://api.deepseek.com/v1/users/me/balance",
            "https://api.deepseek.com/",
        ] {
            let url = Url::parse(refused).expect("URL literal");
            assert!(
                matches!(
                    validate_fixed_destination(ApiSpendProvider::DeepSeek, &url),
                    Err(ApiSpendFailure::UnsafeDestination)
                ),
                "{refused}"
            );
        }
        /* Neither balance adapter accepts the other's address. */
        let moonshot = Url::parse("https://api.deepseek.com/v1/users/me/balance").expect("URL");
        assert!(validate_fixed_destination(ApiSpendProvider::Moonshot, &moonshot).is_err());
        let deepseek = Url::parse("https://api.moonshot.ai/v1/users/me/balance").expect("URL");
        assert!(validate_fixed_destination(ApiSpendProvider::DeepSeek, &deepseek).is_err());
    }

    fn save_input(
        provider: ApiSpendProvider,
        key_label: &str,
        secret: &str,
        source_id: Option<&str>,
    ) -> SaveApiSpendSourceInput {
        SaveApiSpendSourceInput {
            provider,
            key_label: key_label.to_string(),
            secret: secret.to_string(),
            team_id: None,
            budget_usd: None,
            consent_version: 1,
            confirmed: true,
            source_id: source_id.map(str::to_string),
        }
    }

    fn index_of(document: &ApiSpendDocument, id: &str) -> usize {
        document
            .sources
            .iter()
            .position(|source| source.id == id)
            .expect("the source exists")
    }

    /// What a source's card shows: its own newest sample, matched by id.
    fn newest_for<'a>(snapshot: &'a ApiSpendSnapshot, id: &str) -> &'a ApiSpendSampleView {
        snapshot
            .samples
            .iter()
            .filter(|sample| sample.source_id == id)
            .max_by(|left, right| left.observed_at.cmp(&right.observed_at))
            .expect("the source has a sample")
    }

    fn amount(view: &ApiSpendSampleView) -> &str {
        match &view.display_state {
            ApiSpendDisplayState::Tracked { amount_usd, .. }
            | ApiSpendDisplayState::Balance { amount_usd } => amount_usd,
            other => panic!("no amount in {other:?}"),
        }
    }

    #[test]
    fn a_deepseek_source_round_trips_and_stays_on_this_device() {
        let directory = TempDir::new();
        let path = directory.path().join(STATE_FILE_NAME);
        let store = InMemorySecrets::new();
        let now = 1_777_593_600 + 6 * 86_400;
        let saved = save_source_core(
            &path,
            &store,
            save_input(
                ApiSpendProvider::DeepSeek,
                "DeepSeek key",
                "sk-deepseek-canary-0000abcd",
                None,
            ),
            now,
        )
        .expect("save");
        let id = saved.sources[0].id.clone();
        assert_eq!(saved.sources[0].provider, ApiSpendProvider::DeepSeek);
        assert_eq!(saved.sources[0].metric_kind, ApiSpendMetricKind::Balance);
        assert_eq!(saved.sources[0].eligibility_class, "server_api_key");
        assert_eq!(saved.sources[0].last_four.as_deref(), Some("abcd"));
        let text = std::fs::read_to_string(&path).expect("state file");
        assert!(text.contains("\"provider\":\"deepseek\""), "{text}");
        assert!(!text.contains("canary"));

        /* A USD reading, exactly as refresh records it after the fixed read. */
        let mut document = load_at(&path).expect("load");
        let index = index_of(&document, &id);
        record_observation(
            &mut document,
            index,
            parse_deepseek(&deepseek_usd()).expect("parse"),
            now,
        )
        .expect("record");
        save_at(&path, &document).expect("save state");
        let mut document = load_at(&path).expect("reload");
        let view = snapshot(&document, now).expect("snapshot");
        assert_eq!(view.sources[0].status, "eligible");
        assert_eq!(
            newest_for(&view, &id).display_state,
            ApiSpendDisplayState::Balance {
                amount_usd: "15.25".to_string()
            }
        );

        /* Yuan only: the source says so and no amount exists anywhere. */
        record_observation(
            &mut document,
            index,
            parse_deepseek(&deepseek_cny_only()).expect("parse"),
            now + 900,
        )
        .expect("record");
        save_at(&path, &document).expect("save state");
        let mut document = load_at(&path).expect("reload");
        let view = snapshot(&document, now + 900).expect("snapshot");
        assert_eq!(view.sources[0].status, "reported_in_cny");
        assert_eq!(
            newest_for(&view, &id).display_state,
            ApiSpendDisplayState::ReportedInCny
        );
        let stored = document.samples.last().expect("sample");
        assert_eq!(stored.balance_usd, None);
        assert_eq!(stored.spend_usd, None);
        assert_eq!(stored.currency_source, "provider_cny");

        /* Not available for API calls: the amount stays, and so does the note. */
        record_observation(
            &mut document,
            index,
            parse_deepseek(&deepseek_unavailable()).expect("parse"),
            now + 1_800,
        )
        .expect("record");
        save_at(&path, &document).expect("save state");
        let document = load_at(&path).expect("reload");
        let view = snapshot(&document, now + 1_800).expect("snapshot");
        assert_eq!(view.sources[0].status, "too_low_for_api_calls");
        assert_eq!(amount(newest_for(&view, &id)), "0.4");

        /* A balance never syncs, and DeepSeek has no hosted contract at all. */
        assert!(contract_spend_samples(&document, 8).is_empty());
        assert_eq!(contract_provider(ApiSpendProvider::DeepSeek), None);
    }

    #[test]
    fn an_amountless_sample_is_only_ever_a_yuan_balance() {
        let balance_source = source(ApiSpendProvider::DeepSeek);
        let mut document = ApiSpendDocument::default();
        let mut sample = spend_sample(ApiSpendProvider::DeepSeek, &balance_source.id, "1");
        sample.balance_usd = None;
        document.sources.push(balance_source);
        document.samples.push(sample.clone());
        /* Without the yuan marker an empty sample would read as zero. */
        assert!(matches!(
            validate_document(&document),
            Err(ApiSpendFailure::Storage)
        ));
        document.samples[0].currency_source = "provider_cny".to_string();
        validate_document(&document).expect("a yuan balance has no amount");
        /* And a yuan sample that carries an amount would be a conversion. */
        document.samples[0].balance_usd = Some("15".to_string());
        assert!(matches!(
            validate_document(&document),
            Err(ApiSpendFailure::Storage)
        ));
    }

    #[test]
    fn two_openrouter_sources_keep_their_own_samples_and_a_new_key_replaces_only_its_own() {
        let directory = TempDir::new();
        let path = directory.path().join(STATE_FILE_NAME);
        let store = InMemorySecrets::new();
        let now = 1_777_593_600 + 6 * 86_400;
        let first = save_source_core(
            &path,
            &store,
            save_input(
                ApiSpendProvider::Openrouter,
                "Personal",
                "sk-or-first-aaaa",
                None,
            ),
            now,
        )
        .expect("first key")
        .sources[0]
            .id
            .clone();
        /* A second key of the same provider is a second source. */
        let added = save_source_core(
            &path,
            &store,
            save_input(
                ApiSpendProvider::Openrouter,
                "Work",
                "sk-or-second-bbbb",
                None,
            ),
            now,
        )
        .expect("second key");
        assert_eq!(added.sources.len(), 2);
        let second = added.sources[1].id.clone();
        assert_ne!(first, second);

        let mut document = load_at(&path).expect("load");
        for (id, lifetime, at) in [
            (&first, json!(60), now),
            (&second, json!(500), now),
            (&first, json!(63.33), now + 900),
            (&second, json!(522.2), now + 900),
        ] {
            let index = index_of(&document, id);
            let parsed = parse_openrouter(&json!({
                "data": {"total_credits": 1000, "total_usage": lifetime}
            }))
            .expect("lifetime counter");
            record_observation(&mut document, index, parsed, at).expect("record");
        }
        save_at(&path, &document).expect("save state");
        let view = snapshot(&load_at(&path).expect("reload"), now + 900).expect("snapshot");
        assert_eq!(amount(newest_for(&view, &first)), "3.33");
        assert_eq!(amount(newest_for(&view, &second)), "22.2");

        /* Replacing the first key keeps its source, and only its source. */
        let before = load_at(&path).expect("load");
        let old_credential = before.sources[index_of(&before, &first)]
            .credential_id
            .clone();
        let untouched = before.sources[index_of(&before, &second)].clone();
        let replaced = save_source_core(
            &path,
            &store,
            save_input(
                ApiSpendProvider::Openrouter,
                "Personal",
                "sk-or-rotated-cccc",
                Some(&first),
            ),
            now + 1_000,
        )
        .expect("replace");
        assert_eq!(replaced.sources.len(), 2);
        let after = load_at(&path).expect("load");
        let rotated = &after.sources[index_of(&after, &first)];
        assert_ne!(rotated.credential_id, old_credential);
        assert_eq!(rotated.last_four.as_deref(), Some("cccc"));
        assert_eq!(rotated.status, "pending_validation");
        assert_eq!(rotated.last_observed_at, None);
        /* A new key may be another account, so no lifetime delta crosses it. */
        assert_eq!(rotated.last_counter_usd, None);
        assert_eq!(rotated.counter_baseline_usd, None);
        assert!(store.read_secret(&old_credential).is_err());
        assert_eq!(
            store
                .read_secret(&rotated.credential_id)
                .expect("new key")
                .as_str(),
            "sk-or-rotated-cccc"
        );
        let kept = &after.sources[index_of(&after, &second)];
        assert_eq!(kept.credential_id, untouched.credential_id);
        assert_eq!(kept.last_counter_usd, untouched.last_counter_usd);
        assert_eq!(store.stored_count(), 2);
        assert!(samples_of(&after, &first).is_empty());
        assert_eq!(
            samples_of(&after, &second).len(),
            samples_of(&before, &second).len()
        );
        let view = snapshot(&after, now + 1_000).expect("snapshot");
        assert_eq!(amount(newest_for(&view, &second)), "22.2");

        /* A replacement names a real source of the same provider. */
        for (provider, source_id, expected) in [
            (
                ApiSpendProvider::DeepSeek,
                second.as_str(),
                ApiSpendFailure::InvalidInput,
            ),
            (
                ApiSpendProvider::Openrouter,
                "00000000-0000-4000-8000-00000000ffff",
                ApiSpendFailure::NotFound,
            ),
            (
                ApiSpendProvider::Openrouter,
                "not a source",
                ApiSpendFailure::InvalidInput,
            ),
        ] {
            let result = save_source_core(
                &path,
                &store,
                save_input(provider, "Work", "sk-refused-dddd", Some(source_id)),
                now + 1_100,
            );
            assert_eq!(result.err(), Some(expected), "{source_id}");
        }
        assert_eq!(store.stored_count(), 2);
        assert_eq!(load_at(&path).expect("load").sources.len(), 2);
    }

    /// A state file exactly as 2.0.2 wrote it: two OpenRouter keys, an xAI
    /// team and a disabled Moonshot balance, with history.
    const STATE_2_0_2: &str = include_str!("../tests/fixtures/api-spend-v1-2.0.2.json");

    #[test]
    fn a_2_0_2_state_file_loads_unchanged() {
        let directory = TempDir::new();
        let path = directory.path().join(STATE_FILE_NAME);
        std::fs::write(&path, STATE_2_0_2).expect("fixture");
        let expected: Value = serde_json::from_str(STATE_2_0_2).expect("fixture JSON");

        let document = load_at(&path).expect("the 2.0.2 schema loads");
        assert_eq!(serde_json::to_value(&document).expect("JSON"), expected);
        let view = snapshot(&document, 1_788_782_400).expect("snapshot");
        assert_eq!(view.sources.len(), 4);
        assert_eq!(
            amount(newest_for(&view, "b28c9d51-7f0a-4c3e-9d64-5a1b8e2f7c03")),
            "3.33"
        );
        assert_eq!(
            amount(newest_for(&view, "c39dae62-8f1b-4d4f-8e75-6b2c9f3a8d14")),
            "22.2"
        );
        assert_eq!(
            newest_for(&view, "e5bfc084-a03d-4f6b-8a97-8d4eb05caf36").display_state,
            ApiSpendDisplayState::Balance {
                amount_usd: "49.58894".to_string()
            }
        );

        /* Saving it again writes the same schema back. */
        save_at(&path, &document).expect("save");
        assert_eq!(
            serde_json::to_value(load_at(&path).expect("reload")).expect("JSON"),
            expected
        );
    }

    /// The 2.0.2 state above, right after its xAI key was replaced at noon on
    /// 7 September. The command line status row test reads this same file.
    const STATE_REPLACED_KEY: &str =
        include_str!("../tests/fixtures/api-spend-v1-replaced-key.json");

    #[test]
    fn a_replaced_key_shows_no_money_until_its_own_first_reading() {
        let directory = TempDir::new();
        let path = directory.path().join(STATE_FILE_NAME);
        std::fs::write(&path, STATE_2_0_2).expect("fixture");
        let store = InMemorySecrets::new();
        let xai = "d4aebf73-9f2c-4e5a-9f86-7c3daf4b9e25";
        let now = 1_788_782_400; // 2026-09-07T12:00:00Z
        let mut input = save_input(
            ApiSpendProvider::Xai,
            "Team billing",
            "xai-rotated-key-wxyz",
            Some(xai),
        );
        input.team_id = Some("team_123".to_string());
        let replaced = save_source_core(&path, &store, input, now).expect("replace");

        /* The new key may be another account, so the old key's money leaves
        with it and the row checks the key. */
        assert!(replaced
            .samples
            .iter()
            .all(|sample| sample.source_id != xai));
        let source = replaced.sources.iter().find(|source| source.id == xai);
        assert_eq!(source.expect("source").status, "pending_validation");
        /* Every other source keeps its own. */
        let work = "c39dae62-8f1b-4d4f-8e75-6b2c9f3a8d14";
        assert_eq!(amount(newest_for(&replaced, work)), "22.2");

        /* On disk it is exactly the state the status row fixture carries,
        apart from the new key's random credential id. */
        let mut written = serde_json::to_value(load_at(&path).expect("reload")).expect("JSON");
        assert_ne!(
            written["sources"][2]["credentialId"],
            "a73b12a6-c25f-4b8d-8cb9-af60d27ecb58"
        );
        written["sources"][2]["credentialId"] = json!("a73b12a6-c25f-4b8d-8cb9-af60d27ecb59");
        let expected: Value = serde_json::from_str(STATE_REPLACED_KEY).expect("fixture JSON");
        assert_eq!(written, expected);

        /* The new key's first good reading is the first amount it shows. */
        let mut document = load_at(&path).expect("reload");
        let index = index_of(&document, xai);
        let reading = ParsedProviderValue {
            value: Some(Decimal::new(42, 2)),
            raw_unit_scale: "usd",
            incomplete: false,
            next_page: None,
            note: None,
        };
        record_observation(&mut document, index, reading, now + 60).expect("record");
        let view = snapshot(&document, now + 60).expect("snapshot");
        assert_eq!(amount(newest_for(&view, xai)), "0.42");
        assert_eq!(samples_of(&document, xai).len(), 1);
    }

    const SEPTEMBER_START: i64 = 1_788_220_800; // 2026-09-01T00:00:00Z

    fn parsed(lifetime: u32) -> ParsedProviderValue {
        ParsedProviderValue {
            value: Some(Decimal::from(lifetime)),
            raw_unit_scale: "lifetime_usd",
            incomplete: false,
            next_page: None,
            note: None,
        }
    }

    fn openrouter_named(id: &str, credential: &str, label: &str) -> ApiSpendSource {
        let mut named = source(ApiSpendProvider::Openrouter);
        named.id = id.to_string();
        named.credential_id = credential.to_string();
        named.key_label = label.to_string();
        named
    }

    fn samples_of(document: &ApiSpendDocument, id: &str) -> Vec<ApiSpendSample> {
        document
            .samples
            .iter()
            .filter(|sample| sample.source_id == id)
            .cloned()
            .collect()
    }

    #[test]
    fn two_thousand_observations_keep_saving_and_the_month_amount_is_unchanged() {
        let directory = TempDir::new();
        let path = directory.path().join(STATE_FILE_NAME);
        let mut reference = ApiSpendDocument::default();
        reference.sources.push(source(ApiSpendProvider::Openrouter));
        save_at(&path, &reference).expect("empty save");
        let id = reference.sources[0].id.clone();

        for step in 0..2_000_i64 {
            let now = SEPTEMBER_START + 3_600 + step * 1_728; // about 40 days
            let lifetime = 100 + step as u32;
            record_observation(&mut reference, 0, parsed(lifetime), now).expect("reference");

            let mut live = load_at(&path).expect("load");
            record_observation(&mut live, 0, parsed(lifetime), now).expect("record");
            save_at(&path, &live).unwrap_or_else(|_| panic!("save failed at step {step}"));
        }

        let size = std::fs::metadata(&path).expect("file").len();
        assert!(size < 20_000, "file stayed small, got {size}");
        let live = load_at(&path).expect("reload");
        let kept = samples_of(&live, &id);
        let all = samples_of(&reference, &id);
        let october: Vec<_> = kept.iter().filter(|s| s.month == "2026-10-01").collect();
        let first_october = all.iter().find(|s| s.month == "2026-10-01").expect("first");
        assert_eq!(october.len(), 2);
        // Ids are random per run, so the two documents are matched by observation time.
        assert_eq!(october[0].observed_at, first_october.observed_at);
        assert_eq!(
            kept.last().expect("newest").observed_at,
            all.last().expect("newest").observed_at
        );
        assert_eq!(kept.iter().filter(|s| s.month == "2026-09-01").count(), 1);
        assert_eq!(
            kept.last().unwrap().spend_usd,
            all.last().unwrap().spend_usd,
            "month to date amount matches the uncompacted reference"
        );
        assert_eq!(
            live.sources[0].counter_baseline_usd,
            reference.sources[0].counter_baseline_usd
        );
    }

    #[test]
    fn an_openrouter_month_rollover_keeps_the_baseline_and_the_derived_spend() {
        let mut document = ApiSpendDocument::default();
        document.sources.push(source(ApiSpendProvider::Openrouter));
        let id = document.sources[0].id.clone();
        let october = SEPTEMBER_START + 30 * 86_400;
        for step in 0..60_i64 {
            let now = october - 30 * 3_600 + step * 3_600; // spans the rollover
            record_observation(&mut document, 0, parsed(200 + step as u32), now).expect("record");
        }
        let before = document.clone();
        let mut after = document;
        compact_samples(&mut after);

        let kept = samples_of(&after, &id);
        let all = samples_of(&before, &id);
        let last_september = all.iter().rev().find(|s| s.month == "2026-09-01").unwrap();
        let first_october = all.iter().find(|s| s.month == "2026-10-01").unwrap();
        let september: Vec<_> = kept.iter().filter(|s| s.month == "2026-09-01").collect();
        let october_kept: Vec<_> = kept.iter().filter(|s| s.month == "2026-10-01").collect();
        assert_eq!(september.len(), 1);
        assert_eq!(september[0].id, last_september.id);
        assert_eq!(october_kept.len(), 2);
        assert_eq!(october_kept[0].id, first_october.id);
        assert_eq!(kept.last().unwrap().id, all.last().unwrap().id);
        assert_eq!(
            kept.last().unwrap().spend_usd,
            all.last().unwrap().spend_usd
        );
        assert_eq!(
            after.sources[0].counter_baseline_usd,
            before.sources[0].counter_baseline_usd
        );
        assert_eq!(
            after.sources[0].last_counter_usd,
            before.sources[0].last_counter_usd
        );
    }

    #[test]
    fn a_state_file_over_the_old_cap_loads_compacts_and_saves() {
        let directory = TempDir::new();
        let path = directory.path().join(STATE_FILE_NAME);
        let mut document = ApiSpendDocument::default();
        let ids = [
            (
                "00000000-0000-4000-8000-0000000000a1",
                "10000000-0000-4000-8000-0000000000a1",
            ),
            (
                "00000000-0000-4000-8000-0000000000a2",
                "10000000-0000-4000-8000-0000000000a2",
            ),
        ];
        for (n, (id, credential)) in ids.iter().enumerate() {
            document
                .sources
                .push(openrouter_named(id, credential, &format!("Key {n}")));
        }
        for step in 0..2_000_i64 {
            let now = SEPTEMBER_START + 3_600 + step * 1_728;
            let id = ids[(step % 2) as usize].0;
            let mut sample = spend_sample(ApiSpendProvider::Openrouter, id, "1");
            sample.observed_at = timestamp(now).unwrap();
            sample.created_at = sample.observed_at.clone();
            sample.month = month_bounds(now).unwrap().2;
            sample.source_period = format!(
                "[{}, {})",
                timestamp(SEPTEMBER_START).unwrap(),
                sample.observed_at
            );
            document.samples.push(sample);
        }
        // Written raw, the way 2.0.2 did, bypassing save_at.
        let text = serde_json::to_string(&document).unwrap();
        assert!(
            text.len() as u64 > crate::fsx::MAX_STATE_FILE_BYTES,
            "fixture is oversized"
        );
        std::fs::write(&path, &text).unwrap();

        let healed = load_at(&path).expect("an oversized 2.0.2 file loads");
        for (id, _) in ids {
            let newest = document
                .samples
                .iter()
                .rev()
                .find(|s| s.source_id == id)
                .unwrap();
            let kept = samples_of(&healed, id);
            assert_eq!(kept.last().unwrap().id, newest.id, "newest sample kept");
            assert!(kept.len() <= 3);
        }
        save_at(&path, &healed).expect("save");
        assert!(std::fs::metadata(&path).unwrap().len() < crate::fsx::MAX_STATE_FILE_BYTES);
        assert_eq!(load_at(&path).unwrap().samples.len(), healed.samples.len());
    }

    #[test]
    fn two_sources_of_one_provider_are_compacted_independently() {
        let mut document = ApiSpendDocument::default();
        let ids = [
            "00000000-0000-4000-8000-0000000000b1",
            "00000000-0000-4000-8000-0000000000b2",
        ];
        // One key observed through September, the other only on the 1st.
        for (n, id) in ids.iter().enumerate() {
            document.sources.push(openrouter_named(
                id,
                &format!("10000000-0000-4000-8000-0000000000b{}", n + 1),
                &format!("Key {n}"),
            ));
        }
        for day in 0..10_i64 {
            for (n, id) in ids.iter().enumerate() {
                if n == 1 && day > 0 {
                    continue;
                }
                let mut sample = spend_sample(ApiSpendProvider::Openrouter, id, "1");
                sample.observed_at = timestamp(SEPTEMBER_START + day * 86_400 + 60).unwrap();
                sample.month = "2026-09-01".to_string();
                document.samples.push(sample);
            }
        }
        compact_samples(&mut document);
        let first = samples_of(&document, ids[0]);
        let second = samples_of(&document, ids[1]);
        assert_eq!(first.len(), 2);
        assert_eq!(
            first[0].observed_at,
            timestamp(SEPTEMBER_START + 60).unwrap()
        );
        assert_eq!(
            first[1].observed_at,
            timestamp(SEPTEMBER_START + 9 * 86_400 + 60).unwrap()
        );
        assert_eq!(second.len(), 1, "a lone sample is both first and newest");
    }

    #[test]
    fn six_sources_over_thirteen_months_stay_far_under_the_cap() {
        let mut document = ApiSpendDocument::default();
        for n in 0..6_u32 {
            let id = format!("00000000-0000-4000-8000-00000000c{n:03}");
            document.sources.push(openrouter_named(
                &id,
                &format!("10000000-0000-4000-8000-00000000c{n:03}"),
                &format!("Key {n}"),
            ));
            for month in 0..16_i64 {
                for day in 0..28_i64 {
                    let now = SEPTEMBER_START - 400 * 86_400 + month * 30 * 86_400 + day * 86_400;
                    let mut sample = spend_sample(ApiSpendProvider::Openrouter, &id, "1");
                    sample.observed_at = timestamp(now).unwrap();
                    sample.month = month_bounds(now).unwrap().2;
                    document.samples.push(sample);
                }
            }
        }
        compact_samples(&mut document);
        assert!(
            document.samples.len() <= 6 * 14,
            "got {}",
            document.samples.len()
        );
        let bytes = serde_json::to_string(&document).unwrap().len();
        assert!(
            (bytes as u64) < crate::fsx::MAX_STATE_FILE_BYTES / 8,
            "got {bytes}"
        );
    }

    #[test]
    fn the_2_0_2_fixture_is_already_within_the_rules_and_survives_compaction() {
        let mut document: ApiSpendDocument = serde_json::from_str(STATE_2_0_2).unwrap();
        let before = serde_json::to_value(&document).unwrap();
        compact_samples(&mut document);
        assert_eq!(serde_json::to_value(&document).unwrap(), before);
    }
}
