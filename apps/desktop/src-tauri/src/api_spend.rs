use std::collections::HashSet;
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
use crate::pro;

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
const MAX_SECRET_BYTES: usize = 8_192;
const MAX_TEAM_ID_BYTES: usize = 128;
const MAX_KEY_LABEL_CHARS: usize = 80;
const MAX_DECIMAL: &str = "1000000000000000";
/// Founder decision 16, 2026-09-04: free tracking on a capped spend source
/// stops at this many dollars, month to date, inclusive.
const FREE_SPEND_CEILING_USD: &str = "100";

const OPENAI_BASE: &str = "https://api.openai.com:443/v1/organization/costs";
const ANTHROPIC_BASE: &str = "https://api.anthropic.com:443/v1/organizations/cost_report";
const XAI_PREFIX: &str = "https://management-api.x.ai:443/v1/billing/teams/";
const XAI_SUFFIX: &str = "/usage";
const OPENROUTER_BASE: &str = "https://openrouter.ai:443/api/v1/credits";
const MOONSHOT_BASE: &str = "https://api.moonshot.ai:443/v1/users/me/balance";

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
}

impl ApiSpendProvider {
    #[cfg(test)]
    const ALL: [Self; 5] = [
        Self::Openai,
        Self::Anthropic,
        Self::Xai,
        Self::Openrouter,
        Self::Moonshot,
    ];

    const fn credential_class(self) -> &'static str {
        match self {
            Self::Openai => "organization_admin_key",
            Self::Anthropic => "organization_admin_key",
            Self::Xai => "management_key",
            Self::Openrouter => "management_key",
            Self::Moonshot => "server_api_key",
        }
    }

    const fn metric_kind(self) -> ApiSpendMetricKind {
        match self {
            Self::Moonshot => ApiSpendMetricKind::Balance,
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
/// appear, and a capped source's variant has no field to carry one in. The
/// disk document keeps the raw fields, because they are this module's own
/// source of truth (Pro upgrading mid month must not need a re observation),
/// but nothing built from `snapshot` ever repeats them.
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

/// Whether a provider's own reading is the kind founder decision 16 caps.
///
/// Only the three admin or management key billing totals are named: OpenAI,
/// Anthropic and xAI. OpenRouter's monthly figure is a derived delta over a
/// lifetime counter shown as credits, and Moonshot's is a balance, so
/// neither is the admin billing total the ceiling was written for. Excluding
/// OpenRouter by provider rather than by `metric_kind` matters: it reports as
/// `Spend`, not `Balance`, and a kind based rule would have capped it by
/// accident.
const fn provider_capped_when_free(provider: ApiSpendProvider) -> bool {
    matches!(
        provider,
        ApiSpendProvider::Openai | ApiSpendProvider::Anthropic | ApiSpendProvider::Xai
    )
}

/// What a spend source shows. Never what it measured.
///
/// A capped reading has no field the real amount could hide in, so wiring
/// this in front of the wire is a structural guarantee, not a promise to
/// remember to blank a field.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ApiSpendDisplayState {
    /// The real reading, free under the ceiling or Pro past it.
    /// `percent_of_budget` is absent when the source carries no budget.
    Tracked {
        amount_usd: String,
        percent_of_budget: Option<String>,
    },
    /// A free machine crossed the ceiling on a capped provider.
    Capped { ceiling_usd: &'static str },
    /// A balance reading. Never capped, whatever entitlement says.
    Balance { amount_usd: String },
}

/// Derives what a spend source should show, from a month to date amount,
/// its currency, which provider it is, its own budget if any, whether this
/// machine is entitled, and now.
///
/// Pure and total: the same six inputs always answer the same way, and
/// nothing here reads a clock, a file or an entitlement store. `now` is
/// validated the same way `month_bounds` validates it elsewhere in this
/// file, rather than read and silently ignored: a caller that built
/// `month_to_date_usd` from `month_bounds(now)`, which every refresh does,
/// already guarantees the free ceiling clears the instant a new month's own
/// reading replaces the old one, so this function only ever has to compare
/// that reading against a constant.
///
/// Currency is refused, never converted, matching `parse_openai` and
/// `parse_anthropic`, which already reject a non USD bucket before a value
/// ever reaches a stored sample.
fn spend_display_state(
    provider: ApiSpendProvider,
    month_to_date_usd: &str,
    currency: &str,
    budget_usd: Option<&str>,
    entitled: bool,
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
    if !entitled && provider_capped_when_free(provider) {
        let ceiling = Decimal::from_str(FREE_SPEND_CEILING_USD).expect("constant decimal");
        if amount > ceiling {
            return Ok(ApiSpendDisplayState::Capped {
                ceiling_usd: FREE_SPEND_CEILING_USD,
            });
        }
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
    entitled: bool,
    now: i64,
) -> Result<ApiSpendSampleView, ApiSpendFailure> {
    let amount = sample
        .spend_usd
        .as_deref()
        .or(sample.balance_usd.as_deref())
        .unwrap_or("0");
    let budget = source
        .map(|source| source.budget_usd.as_deref())
        .unwrap_or_else(|| sample.budget_usd.as_deref());
    let display_state = spend_display_state(sample.provider, amount, "usd", budget, entitled, now)?;
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

fn snapshot(
    document: &ApiSpendDocument,
    entitled: bool,
    now: i64,
) -> Result<ApiSpendSnapshot, ApiSpendFailure> {
    let samples = document
        .samples
        .iter()
        .map(|sample| {
            let source = document
                .sources
                .iter()
                .find(|source| source.id == sample.source_id);
            sample_view(sample, source, entitled, now)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ApiSpendSnapshot {
        version: STATE_VERSION,
        local_display_is_free: true,
        disclosure: "Best effort provider observation. Missing periods remain gaps. Moonshot is balance, not spend.",
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
    }) {
        return Err(ApiSpendFailure::Storage);
    }
    Ok(())
}

fn load_at(path: &Path) -> Result<ApiSpendDocument, ApiSpendFailure> {
    if !path.exists() {
        return Ok(ApiSpendDocument::default());
    }
    let text = crate::fsx::bounded_read(path).ok_or(ApiSpendFailure::Storage)?;
    let document: ApiSpendDocument =
        serde_json::from_str(&text).map_err(|_| ApiSpendFailure::Storage)?;
    validate_document(&document)?;
    Ok(document)
}

fn save_at(path: &Path, document: &ApiSpendDocument) -> Result<(), ApiSpendFailure> {
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
    if document.sources.len() >= MAX_SOURCES {
        return Err(ApiSpendFailure::Storage);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let credential_id = uuid::Uuid::new_v4().to_string();
    let observed_last_four = last_four(&secret);
    store
        .store_secret(&credential_id, &secret)
        .map_err(|_| ApiSpendFailure::KeyringUnavailable)?;
    let now_text = timestamp(now)?;
    document.sources.push(ApiSpendSource {
        id: id.clone(),
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
    if let Err(error) = save_at(path, &document) {
        let _ = store.delete_secret(&credential_id);
        return Err(error);
    }
    snapshot(&document, pro::api_spend_cap_lifted(), now)
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
    };
    let path_ok = match provider {
        ApiSpendProvider::Openai => url.path() == "/v1/organization/costs",
        ApiSpendProvider::Anthropic => url.path() == "/v1/organizations/cost_report",
        ApiSpendProvider::Xai => {
            url.path().starts_with("/v1/billing/teams/") && url.path().ends_with("/usage")
        }
        ApiSpendProvider::Openrouter => url.path() == "/api/v1/credits",
        ApiSpendProvider::Moonshot => url.path() == "/v1/users/me/balance",
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
    .header("user-agent", "OpenLimiter/1.1.0 (+https://openlimiter.com)");
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
    value: Decimal,
    raw_unit_scale: &'static str,
    incomplete: bool,
    next_page: Option<String>,
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
        value: total,
        raw_unit_scale: "usd",
        incomplete: false,
        next_page: page_cursor(value)?,
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
        value: cents / Decimal::from(100),
        raw_unit_scale: "usd_cents",
        incomplete: false,
        next_page: page_cursor(value)?,
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
        value: total,
        raw_unit_scale: "usd",
        incomplete: value
            .get("limitReached")
            .and_then(Value::as_bool)
            .ok_or(ApiSpendFailure::InvalidResponse)?,
        next_page: None,
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
        value: json_decimal(
            data.get("total_usage")
                .ok_or(ApiSpendFailure::InvalidResponse)?,
        )?,
        raw_unit_scale: "lifetime_usd",
        incomplete: false,
        next_page: None,
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
        value: available,
        raw_unit_scale: "current_balance_usd",
        incomplete: false,
        next_page: None,
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
    for _ in 0..MAX_PAGES {
        let spec = request_spec(source, start, end, page.as_deref())?;
        let secret = store
            .read_secret(&source.credential_id)
            .map_err(|_| ApiSpendFailure::KeyringUnavailable)?;
        let response = send_request(source.provider, spec, secret).await?;
        let parsed = parse_provider(source.provider, &response)?;
        total = total
            .checked_add(parsed.value)
            .ok_or(ApiSpendFailure::InvalidResponse)?;
        incomplete |= parsed.incomplete;
        let raw_unit_scale = parsed.raw_unit_scale;
        page = parsed.next_page;
        if page.is_none() {
            return Ok(ParsedProviderValue {
                value: total,
                raw_unit_scale,
                incomplete,
                next_page: None,
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
    let (month_start, end, month) = month_bounds(now)?;
    let fetched = fetch_provider(&source, store, month_start, end).await;
    let parsed = match fetched {
        Ok(value) => value,
        Err(failure) => {
            mark_failure(&mut document.sources[index], failure, now);
            save_at(path, &document)?;
            return Err(failure.kind);
        }
    };
    let source = &mut document.sources[index];
    let (spend, balance, completeness) = match source.provider {
        ApiSpendProvider::Openrouter => {
            let (spend, completeness) = openrouter_spend(source, parsed.value, month_start, now)?;
            (Some(decimal_text(spend)), None, completeness.to_string())
        }
        ApiSpendProvider::Moonshot => (
            None,
            Some(decimal_text(parsed.value)),
            "current_balance".to_string(),
        ),
        _ => (
            Some(decimal_text(parsed.value)),
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
    source.status = if parsed.incomplete {
        "observed_incomplete"
    } else {
        "eligible"
    }
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
        currency_source: "provider_usd".to_string(),
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
    save_at(path, &document)?;
    snapshot(&document, pro::api_spend_cap_lifted(), now)
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
    snapshot(&document, pro::api_spend_cap_lifted(), now)
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
    snapshot(&document, pro::api_spend_cap_lifted(), now)
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

#[tauri::command]
pub async fn api_spend_status(
    state: State<'_, ApiSpendState>,
) -> Result<ApiSpendSnapshot, ApiSpendFailure> {
    let _guard = state.gate.lock().await;
    let document = load_at(&state_path()?)?;
    snapshot(&document, pro::api_spend_cap_lifted(), now_seconds()?)
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
    fn all_five_adapters_have_closed_hosts_methods_and_units() {
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
        assert_eq!(decimal_text(moonshot.value), "49.58894");
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
        assert_eq!(decimal_text(openai.value), "1.25");
        assert_eq!(openai.next_page.as_deref(), Some("page_2"));

        let anthropic = parse_anthropic(&json!({
            "data": [{"results": [{"amount": "123.78912", "currency": "USD"}]}],
            "has_more": false,
            "next_page": null
        }))
        .expect("Anthropic cents");
        assert_eq!(decimal_text(anthropic.value), "1.2378912");
        assert_eq!(anthropic.raw_unit_scale, "usd_cents");

        let xai = parse_xai(&json!({
            "timeSeries": [{"dataPoints": [{"timestamp": "2026-09-01T00:00:00Z", "values": [0.75973725]}]}],
            "limitReached": true
        }))
        .expect("xAI series");
        assert!(xai.incomplete);
        assert_eq!(decimal_text(xai.value), "0.75973725");

        let openrouter = parse_openrouter(&json!({
            "data": {"total_credits": 100.5, "total_usage": 25.75}
        }))
        .expect("OpenRouter lifetime counter");
        assert_eq!(decimal_text(openrouter.value), "25.75");
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

    /* ------------------------------------------------- the free spend ceiling
     *
     * Founder decision 16, 2026-09-04. `spend_display_state` is pure: every
     * test below hands it literals and reads back one of its three variants,
     * with no clock, no store and no keyring anywhere in the loop.
     */

    #[test]
    fn only_the_three_admin_billing_providers_are_subject_to_the_free_ceiling() {
        for provider in [
            ApiSpendProvider::Openai,
            ApiSpendProvider::Anthropic,
            ApiSpendProvider::Xai,
        ] {
            assert!(provider_capped_when_free(provider), "{provider:?}");
        }
        /* OpenRouter reports as Spend, not Balance, so a kind based rule would
           have capped it by accident. It is excluded by name instead, same as
           Moonshot, because neither is the admin billing total the ceiling
           was written for. */
        for provider in [ApiSpendProvider::Openrouter, ApiSpendProvider::Moonshot] {
            assert!(!provider_capped_when_free(provider), "{provider:?}");
        }
    }

    #[test]
    fn a_free_machine_tracks_up_to_and_including_one_hundred_exactly() {
        let now = 1_777_593_600;
        for reading in ["99.99", "100.00"] {
            let state =
                spend_display_state(ApiSpendProvider::Openai, reading, "usd", None, false, now)
                    .unwrap_or_else(|error| panic!("{reading} should track free: {error:?}"));
            match state {
                ApiSpendDisplayState::Tracked {
                    amount_usd,
                    percent_of_budget,
                } => {
                    assert_eq!(decimal(&amount_usd).unwrap(), decimal(reading).unwrap());
                    assert_eq!(percent_of_budget, None);
                }
                other => panic!("{reading} should track free, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_free_machine_caps_the_instant_the_ceiling_is_crossed() {
        let now = 1_777_593_600;
        let state = spend_display_state(
            ApiSpendProvider::Anthropic,
            "100.01",
            "usd",
            None,
            false,
            now,
        )
        .expect("capped, not an error");
        assert!(matches!(
            state,
            ApiSpendDisplayState::Capped {
                ceiling_usd: "100"
            }
        ));
    }

    #[test]
    fn an_entitled_machine_tracks_the_real_amount_past_the_ceiling() {
        let now = 1_777_593_600;
        let state = spend_display_state(
            ApiSpendProvider::Anthropic,
            "100.01",
            "usd",
            None,
            true,
            now,
        )
        .expect("tracked, not an error");
        match state {
            ApiSpendDisplayState::Tracked { amount_usd, .. } => {
                assert_eq!(decimal(&amount_usd).unwrap(), decimal("100.01").unwrap());
            }
            other => panic!("entitled should track past the ceiling, got {other:?}"),
        }
    }

    #[test]
    fn a_balance_source_is_never_capped_free_or_entitled_and_openrouter_is_excluded_too() {
        let now = 1_777_593_600;
        for entitled in [false, true] {
            let state = spend_display_state(
                ApiSpendProvider::Moonshot,
                "5000.00",
                "usd",
                None,
                entitled,
                now,
            )
            .expect("a balance is always Ok");
            match state {
                ApiSpendDisplayState::Balance { amount_usd } => {
                    assert_eq!(decimal(&amount_usd).unwrap(), decimal("5000.00").unwrap());
                }
                other => panic!("balance should never cap, got {other:?}"),
            }
        }
        let openrouter = spend_display_state(
            ApiSpendProvider::Openrouter,
            "5000.00",
            "usd",
            None,
            false,
            now,
        )
        .expect("OpenRouter tracks uncapped even on a free machine");
        assert!(matches!(openrouter, ApiSpendDisplayState::Tracked { .. }));
    }

    #[test]
    fn the_free_ceiling_clears_when_a_new_months_reading_replaces_the_old_one() {
        let end_of_august = parse_timestamp("2026-08-31T23:00:00Z").expect("timestamp");
        let capped = spend_display_state(
            ApiSpendProvider::Openai,
            "150.00",
            "usd",
            None,
            false,
            end_of_august,
        )
        .expect("capped in August");
        assert!(matches!(capped, ApiSpendDisplayState::Capped { .. }));

        /* The month rolled over. refresh_core always recomputes month to date
           from month_bounds(now), never from what the prior month measured,
           so a fresh September reading is small again and the ceiling clears
           on its own, with no state carried inside this function. */
        let start_of_september = parse_timestamp("2026-09-01T00:05:00Z").expect("timestamp");
        let cleared = spend_display_state(
            ApiSpendProvider::Openai,
            "4.20",
            "usd",
            None,
            false,
            start_of_september,
        )
        .expect("tracked in September");
        assert!(matches!(cleared, ApiSpendDisplayState::Tracked { .. }));
    }

    #[test]
    fn non_usd_is_refused_not_converted_matching_parse_openai_and_parse_anthropic() {
        let now = 1_777_593_600;
        assert!(matches!(
            spend_display_state(ApiSpendProvider::Openai, "50.00", "eur", None, false, now),
            Err(ApiSpendFailure::InvalidResponse)
        ));
        /* Case only. parse_openai and parse_anthropic both compare with
           eq_ignore_ascii_case, and this refuses the same way they do. */
        assert!(matches!(
            spend_display_state(ApiSpendProvider::Openai, "50.00", "USD", None, false, now),
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

    #[test]
    fn a_capped_sample_carries_no_real_amount_anywhere_on_the_wire() {
        let now = 1_777_593_600;
        let spend_source = source(ApiSpendProvider::Openai);
        let mut document = ApiSpendDocument::default();
        document.sources.push(spend_source.clone());
        document
            .samples
            .push(spend_sample(ApiSpendProvider::Openai, &spend_source.id, "473.22"));

        let snap = snapshot(&document, false, now).expect("capped snapshot");
        let wire = serde_json::to_string(&snap).expect("wire JSON");
        assert!(!wire.contains("473.22"), "{wire}");
        assert!(
            matches!(
                snap.samples[0].display_state,
                ApiSpendDisplayState::Capped {
                    ceiling_usd: "100"
                }
            ),
            "{:?}",
            snap.samples[0].display_state
        );
    }

    #[test]
    fn an_entitled_snapshot_carries_the_real_amount_past_the_ceiling() {
        let now = 1_777_593_600;
        let spend_source = source(ApiSpendProvider::Openai);
        let mut document = ApiSpendDocument::default();
        document.sources.push(spend_source.clone());
        document
            .samples
            .push(spend_sample(ApiSpendProvider::Openai, &spend_source.id, "473.22"));

        let snap = snapshot(&document, true, now).expect("entitled snapshot");
        match &snap.samples[0].display_state {
            ApiSpendDisplayState::Tracked { amount_usd, .. } => {
                assert_eq!(decimal(amount_usd).unwrap(), decimal("473.22").unwrap());
            }
            other => panic!("entitled should track, got {other:?}"),
        }
    }

    #[test]
    fn a_balance_sample_in_a_snapshot_is_never_capped_either() {
        let now = 1_777_593_600;
        let balance_source = source(ApiSpendProvider::Moonshot);
        let mut document = ApiSpendDocument::default();
        document.sources.push(balance_source.clone());
        document.samples.push(spend_sample(
            ApiSpendProvider::Moonshot,
            &balance_source.id,
            "5000.00",
        ));

        let snap = snapshot(&document, false, now).expect("balance snapshot");
        match &snap.samples[0].display_state {
            ApiSpendDisplayState::Balance { amount_usd } => {
                assert_eq!(decimal(amount_usd).unwrap(), decimal("5000.00").unwrap());
            }
            other => panic!("balance should never cap, got {other:?}"),
        }
    }
}
